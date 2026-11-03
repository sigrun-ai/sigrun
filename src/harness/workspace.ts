/** Resolve each conversation's ExecutionEnv: single-user, jailed, or fail-closed. */

import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentReader, HarnessOptions } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { isAbsolute, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { LocalWorkspace } from "../config.js";
import type { ManagedPaths } from "../sandbox/grants.js";
import { IsolationState } from "../sandbox/isolation.js";
import { buildUserPolicy, validateUserPath } from "../sandbox/policy.js";
import type { WorkerPool } from "../sandbox/pool.js";
import { SandboxedExecutionEnv } from "../sandbox/sandboxed-env.js";
import { UnavailableExecutionEnv } from "../sandbox/unavailable-env.js";
import { selfPackageRoot } from "./packages.js";
import { defaultModuleTrees } from "../sandbox/policy.js";
import type { DirectoryUser, UserDirectory } from "./identity/users.js";
import { primaryAdmin } from "./identity/primary-admin.js";
import { AgentExecutionEnv } from "./agent-env.js";
import type { OsUsersAvailability } from "../sandbox/availability.js";
import { lookupOsAccount } from "../sandbox/os-account.js";

export interface WorkspacePreferences { readonly defaultWorkspace: LocalWorkspace }
export interface WorkspaceConversation { readonly id: ConversationId }

/** The live owner's record, falling back to the primary admin. */
export function selectRecord(
	records: readonly DirectoryUser[],
	owner: string | undefined,
): DirectoryUser | undefined {
	return records.find((record) => record.user === owner) ?? primaryAdmin(records);
}

export interface WorkspaceService {
	/** The selected owner's persistent job-state root, if one can be used. */
	jobsRoot(owner: string | undefined): string | undefined;
	/**
	 * The selected owner's workspace root for the HISTORY selection
	 * (tabs+skills Task 10). `forConversation` cannot be reused: it needs
	 * prefs plus an env; this selection is
	 *   1. ≤1 directory record and isolation inactive → deps.defaultWorkspacePath
	 *   2. >1 record and isolation inactive → undefined
	 *   3. record is osUser and osUsers unavailable/lookup fails → undefined
	 *   4. else record.workspace ?? osAccount?.home ?? <userArea>/workspace
	 *      (the buildUserPolicy precedence), validateUserPath-checked —
	 *      an invalid resolution is undefined, never a fallback.
	 */
	workspaceRoot(owner: string | undefined): string | undefined;
	forConversation(
		conversation: WorkspaceConversation,
		prefs: WorkspacePreferences,
		read?: DocumentReader,
		ctx?: Context,
	): Promise<ExecutionEnv>;
}

export type EnvBuilder = NonNullable<HarnessOptions["env"]>;

export interface WorkspaceServiceDeps {
	isolation: IsolationState;
	/** Boot's probed uid-switch capability; absent means the feature is off. */
	osUsers?: OsUsersAvailability;
	/** Account-file lookup seam; production reads /etc/passwd and /etc/group. */
	lookupAccount?: typeof lookupOsAccount;
	pool: WorkerPool;
	directory: UserDirectory;
	managed: ManagedPaths;
	/** The configured default workspace (config.workspace.path) — rule 1's selection. */
	defaultWorkspacePath: string;
	ownerOf(conversationId: ConversationId, read: DocumentReader, ctx: Context): Promise<string | undefined>;
}

export function createWorkspaceService(deps?: WorkspaceServiceDeps): WorkspaceService {
	return {
		jobsRoot(owner) {
			if (deps === undefined) return undefined;
			const { directory, managed } = deps;
			const records = directory.list();
			const record = selectRecord(records, owner);
			if (record === undefined) return join(managed.roots.dataDir, "jobs");
			if (record.osUser !== undefined) {
				if (deps.osUsers?.available !== true) return undefined;
				try {
					const account = (deps.lookupAccount ?? lookupOsAccount)(record.osUser);
					return account === undefined
						? undefined
						: join(account.home, ".local", "state", "sigrun", "jobs");
				} catch {
					return undefined;
				}
			}
			return join(managed.userAreas(record.user), "jobs");
		},
		workspaceRoot(owner) {
			if (deps === undefined) return undefined;
			const { directory, managed, isolation } = deps;
			const records = directory.list();
			const record = selectRecord(records, owner);
			const active = isolation.active();
			let osAccount: ReturnType<typeof lookupOsAccount>;
			if (record?.osUser !== undefined) {
				if (deps.osUsers?.available !== true) return undefined;
				try {
					osAccount = (deps.lookupAccount ?? lookupOsAccount)(record.osUser);
				} catch {
					return undefined;
				}
				if (osAccount === undefined) return undefined;
			}
			// Rules 1+2: without active isolation a workspace root exists
			// only in the single-record posture — forConversation resolves
			// the same default there (and is unavailable with more users).
			if (osAccount === undefined && !active) {
				return records.length <= 1 ? deps.defaultWorkspacePath : undefined;
			}
			if (record === undefined) return undefined;
			const candidate =
				record.workspace ??
				osAccount?.home ??
				join(managed.userAreas(record.user), "workspace");
			return validateUserPath(candidate, record, managed).ok ? candidate : undefined;
		},
		async forConversation(conversation, prefs, read, ctx) {
			const workspace = prefs.defaultWorkspace;
			if (workspace.type !== "local") {
				throw new Error(`Unsupported workspace type: ${JSON.stringify(workspace.type)}`);
			}
			if (deps === undefined) return new AgentExecutionEnv({ cwd: workspace.path });
			const { directory, isolation } = deps;
			const records = directory.list();
			const owner = read === undefined
				? undefined
				: await deps.ownerOf(conversation.id, read, ctx ?? BACKGROUND_CONTEXT);
			const record = selectRecord(records, owner);
			let osAccount: ReturnType<typeof lookupOsAccount>;
			if (record?.osUser !== undefined) {
				if (deps.osUsers?.available !== true) {
					return new UnavailableExecutionEnv("osUser requires CAP_SETUID");
				}
				try {
					osAccount = (deps.lookupAccount ?? lookupOsAccount)(record.osUser);
				} catch {
					return new UnavailableExecutionEnv(`OS account not found: ${record.osUser}`);
				}
				if (osAccount === undefined) {
					return new UnavailableExecutionEnv(`OS account not found: ${record.osUser}`);
				}
			}
			const active = isolation.active();
			if (osAccount === undefined) {
				if (records.length <= 1 && !active) {
					return new AgentExecutionEnv({ cwd: workspace.path });
				}
				if (!active) {
					return new UnavailableExecutionEnv(isolation.reason() ?? "isolation is not active");
				}
			}
			if (record === undefined) return new UnavailableExecutionEnv("conversation owner is not in the user directory");
			const coreRoot = selfPackageRoot();
			if (coreRoot === undefined) return new UnavailableExecutionEnv("sigrun package root not found");
			const policy = buildUserPolicy(record, {
				managed: deps.managed,
				nodeBinDir: process.execPath,
				moduleTrees: defaultModuleTrees(coreRoot),
				...(osAccount === undefined ? {} : { osAccount }),
			});
			if (!policy.ok) return new UnavailableExecutionEnv(policy.reason);
			return new SandboxedExecutionEnv(deps.pool.client(policy.policy), policy.policy.workspace);
		},
	};
}

export function defaultWorkspacePrefs(workspacePath: string): WorkspacePreferences {
	return { defaultWorkspace: { type: "local", path: workspacePath } };
}

export function toHarnessEnv(service: WorkspaceService, prefs: WorkspacePreferences): EnvBuilder {
	return async (target, context) => {
		const env = await service.forConversation({ id: target.conversationId }, prefs, target.read, context);
		if (target.cwd != null) {
			env.cwd = isAbsolute(target.cwd) ? target.cwd : resolve(env.cwd, target.cwd);
		}
		return env;
	};
}
