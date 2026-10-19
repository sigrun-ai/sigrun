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
 * The `Map<string, SlashCommand>` shape leaves room for future extension
 * registration (an extension would add entries before the catalog is
 * served); no extension wiring exists yet.
 */

import type { SlashCommand } from "@sigrun/shared/commands";

export type {
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
		] as const
	).map((command) => [command.name, command]),
);
