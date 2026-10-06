/**
 * Static workspace resolution (spec §4.5) — the the-work-fabric-scrubbed-swap seam.
 *
 * pi-durable calls `HarnessOptions.env` per tool call to build the
 * conversation's `ExecutionEnv`. sigrun routes that through
 * `workspaceService.forConversation(conversation, prefs)`, a thin wrapper
 * whose signature survives the swap from static config to dynamic the-work-fabric-scrubbed
 * resolution: v1 answers from the static local workspace path carried in
 * `prefs`; the the-work-fabric-scrubbed era replaces the *implementation* (`registry.resolve`)
 * and nothing downstream changes.
 *
 * v1 is deliberately static: every conversation resolves to the same local
 * workspace. Per-conversation `agent.cwd` is applied by pi-durable itself —
 * the harness reads the conversation's committed `pi.agent` document and
 * passes `cwd` through `EnvTarget`; relative paths inside the env resolve
 * against it — so this service must not re-derive it.
 */

import type {
	ConversationId,
	HarnessOptions,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { LocalWorkspace } from "../config.js";

/**
 * What `forConversation` resolves a workspace from: the spec's static
 * `{ defaultWorkspace: { type: "local", path } }` shape. The the-work-fabric-scrubbed era swaps
 * this for registry-backed preferences without changing the method signature.
 */
export interface WorkspacePreferences {
	readonly defaultWorkspace: LocalWorkspace;
}

/**
 * The conversation input of the seam. pi-durable's full `Conversation`
 * satisfies it; the static resolver only needs the id, and accepting the
 * minimal shape keeps the service testable and forward-compatible with the
 * dynamic resolver's handle types.
 */
export interface WorkspaceConversation {
	readonly id: ConversationId;
}

/** The workspace-resolution surface (spec §4.5); the the-work-fabric-scrubbed swap lands here. */
export interface WorkspaceService {
	/**
	 * Resolve the conversation's `ExecutionEnv`. Called per tool call by the
	 * harness env builder, and directly by core surfaces that read workspace
	 * files (context files, skills, file endpoints) so remote workspaces stay
	 * correct after the swap.
	 */
	forConversation(
		conversation: WorkspaceConversation,
		prefs: WorkspacePreferences,
	): Promise<ExecutionEnv>;
}

/** The `HarnessOptions.env` builder shape pi-durable invokes per tool call. */
export type EnvBuilder = NonNullable<HarnessOptions["env"]>;

/**
 * Build the static workspace service.
 *
 * v1 resolves every conversation from `prefs.defaultWorkspace` — the spec's
 * static configuration — so the service carries no state of its own. The
 * returned env is an upstream `NodeExecutionEnv` (pi-durable's local Node
 * `ExecutionEnv`): its `FileSystem.id` is the stable `"node:local"` (every
 * local environment sees the same files), and its `Shell` runs commands
 * rooted at the workspace `cwd`. A fresh instance per call matches how
 * upstream builds envs; equal ids see the same files whatever their `cwd`.
 */
export function createWorkspaceService(): WorkspaceService {
	return {
		async forConversation(_conversation, prefs) {
			const workspace = prefs.defaultWorkspace;
			if (workspace.type !== "local") {
				// Fail loud: v1 knows only the static local workspace; any other
				// type reaching here means the preferences are not v1's.
				throw new Error(
					`Unsupported workspace type: ${JSON.stringify(workspace.type)}`,
				);
			}
			return new NodeExecutionEnv({ cwd: workspace.path });
		},
	};
}

/**
 * The default workspace preferences for a configured local workspace path:
 * exactly the spec §4.5 static shape.
 */
export function defaultWorkspacePrefs(
	workspacePath: string,
): WorkspacePreferences {
	return { defaultWorkspace: { type: "local", path: workspacePath } };
}

/**
 * Adapt the service to the `HarnessOptions.env` builder pi-durable invokes
 * per tool call. The target carries the conversation id (and the agent's
 * `cwd`, which upstream applies through relative-path resolution); the
 * static service resolves from preferences, not from the target.
 */
export function toHarnessEnv(
	service: WorkspaceService,
	prefs: WorkspacePreferences,
): EnvBuilder {
	return (target, _context) =>
		service.forConversation({ id: target.conversationId }, prefs);
}