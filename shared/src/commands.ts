/**
 * The slash-command WIRE types (Task 7, pi parity) — the client-facing
 * half of `src/server/commands.ts` (which owns the catalog runtime).
 *
 * This module is part of the shared leaf package (`@sigrun/shared`): the
 * tui and webui import these shapes from here, never from server source
 * (the load-bearing decoupling — the tui is a pure client of the wire).
 *
 * PURE module: no imports at all (the views-purity guard enforces this
 * across `shared/src`).
 *
 * Registry header (from the server module — the catalog itself lives
 * there): a THIN registry of command METADATA — name, description, args
 * hint, and the §5 endpoint each command drives. Deliberately NO
 * server-side `execute` indirection: the composer owns the client calls,
 * the registry only tells it what exists and where it goes. Scope
 * (controller rulings): ONLY commands mapping to EXISTING endpoints.
 * `/login`/`/logout` are core-spec §6.4 exclusions (credentials never
 * cross the API), `/skill:name` has no endpoint (deferred), and prompt
 * templates are a separate slice. `/model` and `/thinking` ARE included:
 * both map cleanly onto `POST .../configure`'s existing
 * `{model?, thinking?}` body (each sends exactly one of the two fields).
 */

/** The HTTP method + literal route path a command drives. */
export interface SlashCommandEndpoint {
	readonly method: "GET" | "POST" | "PATCH";
	/**
	 * The REGISTERED route path (Fastify `:param` form, e.g.
	 * `/v1/conversations/:id/fork`) — the composer substitutes the active
	 * conversation id; `server-commands.test.ts` asserts every entry
	 * resolves against the live route table.
	 */
	readonly path: string;
}

/** One slash command's catalog entry. */
export interface SlashCommand {
	/** The bare name (no leading slash) — the `Map` key. */
	readonly name: string;
	readonly description: string;
	/** Argument shape shown in the menu/usage errors; absent = no args. */
	readonly argsHint?: string;
	readonly endpoint: SlashCommandEndpoint;
}

/** The `GET /v1/commands` response (spec §5 response conventions). */
export interface CommandsResponse {
	readonly commands: readonly SlashCommand[];
}
