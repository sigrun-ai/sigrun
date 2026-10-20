/**
 * The slash-command catalog (Task 7, pi parity): a THIN registry of command
 * METADATA — name, description, args hint, and the §5 endpoint each command
 * drives. Deliberately NO server-side `execute` indirection: the composer
 * owns the client calls, the registry only tells it what exists and where
 * it goes (the task plan's "thin catalog over the endpoints Tasks 4–6
 * built").
 *
 * SPLIT (build-and-webui Task 1): the WIRE types (`SlashCommandEndpoint`,
 * `SlashCommand`, `CommandsResponse`) live in the `@sigrun/shared` package
 * (`shared/src/commands.ts` — the canonical declarations both clients
 * import); this module owns the CATALOG runtime and re-exports the types
 * for server-side importers.
 *
 * Scope (controller rulings): ONLY commands mapping to EXISTING endpoints.
 * `/login`/`/logout` are core-spec §6.4 exclusions (credentials never cross
 * the API), `/skill:name` has no endpoint (deferred), and prompt templates
 * are a separate slice. `/model` and `/thinking` ARE included: both map
 * cleanly onto `POST .../configure`'s existing `{model?, thinking?}` body
 * (each sends exactly one of the two fields).
 *
 * EXTENSION COMMANDS (core hardening W5 Task 3, spec §9.3): the core
 * table below stays untouched; `buildCommandCatalog` merges the
 * loader-collected extension declarations into the served list.
 * Extension entries carry the contributing `extension` slug and the ONE
 * server-side invoke endpoint (`POST /v1/conversations/:id/commands/
 * <name>`) — for those, unlike core commands, the composer is a pure
 * POST-and-render client.
 */

import type { SlashCommand } from "@sigrun/shared/commands";
import type { ExtensionCommandContribution } from "../extension.js";
import type { ExtensionCommandBinding } from "../harness/loader.js";

export type {
	CommandRunResponse,
	CommandsResponse,
	SlashCommand,
	SlashCommandEndpoint,
} from "@sigrun/shared/commands";

/** The catalog, keyed by bare name. */
export const SLASH_COMMANDS: ReadonlyMap<string, SlashCommand> = new Map(
	(
		[
			{
				name: "new",
				description: "Start a new conversation",
				endpoint: { method: "POST", path: "/v1/conversations" },
			},
			{
				name: "fork",
				description: "Fork this conversation at an entry (default: newest)",
				argsHint: "[at]",
				endpoint: {
					method: "POST",
					path: "/v1/conversations/:id/fork",
				},
			},
			{
				name: "compact",
				description: "Compact this conversation's history",
				argsHint: "[instructions]",
				endpoint: {
					method: "POST",
					path: "/v1/conversations/:id/compact",
				},
			},
			{
				name: "export",
				description: "Download this conversation as JSONL",
				endpoint: { method: "GET", path: "/v1/conversations/:id/export" },
			},
			{
				name: "import",
				description: "Create a conversation from pasted JSONL",
				argsHint: "<jsonl>",
				endpoint: {
					method: "POST",
					path: "/v1/conversations/import",
				},
			},
			{
				name: "name",
				description: "Name this conversation",
				argsHint: "<name>",
				endpoint: {
					method: "PATCH",
					path: "/v1/conversations/:id/meta",
				},
			},
			{
				name: "model",
				description: "Switch this conversation's model",
				argsHint: "<provider/model>",
				endpoint: {
					method: "POST",
					path: "/v1/conversations/:id/configure",
				},
			},
			{
				name: "thinking",
				description: "Set this conversation's thinking level",
				argsHint: "<level>",
				endpoint: {
					method: "POST",
					path: "/v1/conversations/:id/configure",
				},
			},
			{
				name: "jobs",
				description: "List jobs (name, next run, last outcome)",
				endpoint: { method: "GET", path: "/v1/jobs" },
			},
		] as const
	).map((command) => [command.name, command]),
);

// ─── The extension merge (core hardening W5 Task 3, spec §9.3) ─────────────

/** One extension-command collision (ext-vs-ext; last-registered-wins). */
export interface CommandCollision {
	readonly kind: "command";
	/** The command name that collided. */
	readonly name: string;
	/** Extension slug that previously owned the name. */
	readonly previous: string;
	/** Extension slug whose contribution won. */
	readonly contributor: string;
}

/**
 * One MERGED, invokable command: the wire catalog entry (with its
 * `extension` slug) plus the winning `run` — the invoke route's entire
 * resolution. Server-internal by design: the wire `SlashCommand` carries
 * metadata only; `run` never crosses the API.
 */
export interface MergedCommand {
	readonly command: SlashCommand;
	/** The winning contributor's slug. */
	readonly extension: string;
	readonly run: ExtensionCommandContribution["run"];
}

/** What `buildCommandCatalog` yields: the served list + the collision record + the invoke map. */
export interface CommandCatalog {
	/**
	 * The merged list `GET /v1/commands` serves: the core table (in its
	 * own order) followed by extension entries, each carrying its
	 * `extension` slug and invoke endpoint. A core-name collision is
	 * ABSENT (dropped); an ext-vs-ext loser is replaced in place by the
	 * winner.
	 */
	readonly commands: readonly SlashCommand[];
	/**
	 * The ext-vs-ext collision records for `/v1/meta` `collisions.commands`
	 * — operator visibility into a co-installed replacement, never an
	 * error. Core-name drops are deliberately NOT here (warned at build).
	 */
	readonly collisions: readonly CommandCollision[];
	/**
	 * The invoke route's resolution: bare name → the winning merged
	 * command. Dropped (core-colliding) and replaced (ext-vs-ext loser)
	 * declarations are absent — invoking their names is 404.
	 */
	readonly runnable: ReadonlyMap<string, MergedCommand>;
}

/**
 * Merge the core slash-command table with every extension's `commands`
 * declaration (spec §9.3). Called ONCE per server (the catalog is a boot
 * constant, like the model catalog); the two collision rules:
 *
 * - CORE names are reserved: an extension command naming one is DROPPED
 *   with one console warning and NOT recorded in `collisions` — a core
 *   command is not replaceable, so there is no winner to report. The
 *   dropped name never reaches the served list NOR `runnable` (invoking
 *   it is 404 `command_not_found`, never the extension's run).
 * - ext-vs-ext collisions are LAST-REGISTERED-WINS (the load order the
 *   loader collected): warned, recorded in `collisions`, and the winner
 *   replaces the loser's catalog entry and `runnable` binding in place.
 */
export function buildCommandCatalog(
	core: ReadonlyMap<string, SlashCommand>,
	bindings: readonly ExtensionCommandBinding[],
): CommandCatalog {
	const commands: SlashCommand[] = [...core.values()];
	const collisions: CommandCollision[] = [];
	const runnable = new Map<string, MergedCommand>();
	for (const binding of bindings) {
		for (const contribution of binding.commands) {
			if (core.has(contribution.name)) {
				console.warn(
					`extension command dropped: "${binding.extension}" declares ` +
						`command "${contribution.name}" — core command names are reserved`,
				);
				continue;
			}
			const command: SlashCommand = {
				name: contribution.name,
				description: contribution.description,
				...(contribution.args === undefined
					? {}
					: { argsHint: contribution.args }),
				extension: binding.extension,
				endpoint: {
					method: "POST",
					path: `/v1/conversations/:id/commands/${contribution.name}`,
				},
			};
			const previous = runnable.get(contribution.name);
			if (previous !== undefined) {
				collisions.push({
					kind: "command",
					name: contribution.name,
					previous: previous.extension,
					contributor: binding.extension,
				});
				console.warn(
					`extension command collision: "${binding.extension}" replaces ` +
						`"${previous.extension}" command "${contribution.name}" ` +
						"(last-registered-wins)",
				);
				// Replace in place: the loser's position in the served list
				// is the winner's (stable ordering, one entry per name).
				const index = commands.findIndex(
					(entry) => entry.name === contribution.name,
				);
				if (index !== -1) commands[index] = command;
			} else {
				commands.push(command);
			}
			runnable.set(contribution.name, {
				command,
				extension: binding.extension,
				run: contribution.run,
			});
		}
	}
	return { commands, collisions, runnable };
}
