/** Resolve each conversation's ExecutionEnv: single-user, jailed, or fail-closed. */

import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentReader, HarnessOptions } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { isAbsolute, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { LocalWorkspace } from "../config.js";
import type { ManagedPaths } from "../sandbox/grants.js";
import { IsolationState } from "../sandbox/isolation.js";
import { buildUserPolicy } from "../sandbox/policy.js";
import type { WorkerPool } from "../sandbox/pool.js";
import { SandboxedExecutionEnv } from "../sandbox/sandboxed-env.js";
import { UnavailableExecutionEnv } from "../sandbox/unavailable-env.js";
import { selfPackageRoot } from "./packages.js";
import { defaultModuleTrees } from "../sandbox/policy.js";
import type { UserDirectory } from "./identity/users.js";
import { AgentExecutionEnv } from "./agent-env.js";

export interface WorkspacePreferences { readonly defaultWorkspace: LocalWorkspace }
export interface WorkspaceConversation { readonly id: ConversationId }

export interface WorkspaceService {
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
	pool: WorkerPool;
	directory: UserDirectory;
	managed: ManagedPaths;
	ownerOf(conversationId: ConversationId, read: DocumentReader, ctx: Context): Promise<string | undefined>;
}

export function createWorkspaceService(deps?: WorkspaceServiceDeps): WorkspaceService {
	return {
		async forConversation(conversation, prefs, read, ctx) {
			const workspace = prefs.defaultWorkspace;
			if (workspace.type !== "local") {
				throw new Error(`Unsupported workspace type: ${JSON.stringify(workspace.type)}`);
			}
			if (deps === undefined) return new AgentExecutionEnv({ cwd: workspace.path });
			const { directory, isolation } = deps;
			const active = isolation.active();
			if (directory.list().length <= 1 && !active) {
				return new AgentExecutionEnv({ cwd: workspace.path });
			}
			if (!active) {
				return new UnavailableExecutionEnv(isolation.reason() ?? "isolation is not active");
			}
			const owner = read === undefined
				? undefined
				: await deps.ownerOf(conversation.id, read, ctx ?? BACKGROUND_CONTEXT);
			const record = directory.list().find((candidate) => candidate.user === owner)
				?? directory.list().find((candidate) => candidate.admin);
			if (record === undefined) return new UnavailableExecutionEnv("conversation owner is not in the user directory");
			const coreRoot = selfPackageRoot();
			if (coreRoot === undefined) return new UnavailableExecutionEnv("sigrun package root not found");
			const policy = buildUserPolicy(record, {
				managed: deps.managed,
				nodeBinDir: process.execPath,
				moduleTrees: defaultModuleTrees(coreRoot),
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
