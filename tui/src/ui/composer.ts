/**
 * The composer's pure pieces (Task 7): slash-input parsing, the fetch-once
 * command catalog, and error-line formatting. The composer itself is NOT
 * its own component — it is the pi-tui `Editor` the shell owns plus the
 * wiring in `app.ts` (busy tracking, the dispatch); these are the parts
 * that carry no app state.
 */

import type { CommandsResponse, SlashCommand, SigrunClient } from "../api.js";
import { SigrunApiError } from "../api.js";

/** A parsed `/name args…` line. */
export interface SlashInput {
	/** The bare command name (no slash), lowercased. */
	readonly name: string;
	/** Everything after the first space, trimmed ("" when absent). */
	readonly args: string;
}

/** Whether a command name is the skills channel (`/skill:name`, Task 2c):
 *  expansion is server-side at admission, and an UNKNOWN skill passes
 *  through unchanged — so a `skill:`-prefixed line is ALWAYS a submission,
 *  never an endpoint command or a local error. (Checked on the LOWERCASED
 *  parse; the line itself is submitted verbatim either way.) */
export function isSkillCommandName(name: string): boolean {
	return name.startsWith("skill:");
}

/** The text a command-picker selection inserts into the composer: an
 *  EXPAND entry (Task 2c — a prompt template or a skill) inserts
 *  `/name ` ALWAYS (args are its whole point; a skill carries no argsHint
 *  but takes them), an arg-taking endpoint command inserts `/name ` for
 *  its args, and an argless endpoint command inserts bare `/name` for
 *  immediate execution. */
export function commandInsertText(command: SlashCommand): string {
	return command.kind === "expand" || command.argsHint !== undefined
		? `/${command.name} `
		: `/${command.name}`;
}

/**
 * Parse a slash-prefixed composer line; `undefined` when the input is not
 * a command (only a LEADING slash routes — "look at /etc" stays a message).
 * A bare "/" parses to an empty name (the caller renders the empty-command
 * error).
 */
export function parseSlashInput(input: string): SlashInput | undefined {
	if (!input.startsWith("/")) return undefined;
	const space = input.indexOf(" ");
	if (space === -1) return { name: input.slice(1).toLowerCase(), args: "" };
	return {
		name: input.slice(1, space).toLowerCase(),
		args: input.slice(space + 1).trim(),
	};
}

/**
 * The server's slash-command catalog, cached per session. The server
 * re-scans its skill/template roots on every `GET /v1/commands` request —
 * the cache is a SESSION SNAPSHOT, not a boot constant — so a lookup
 * that misses ({@link SlashCatalog.get}) can re-check the live catalog
 * via {@link SlashCatalog.getFresh} before declaring a name unknown. A
 * failed fetch is NOT cached: the rejected promise is dropped so the
 * next `/` retries.
 */
export class SlashCatalog {
	readonly #client: SigrunClient;
	#cache: Promise<CommandsResponse> | undefined;

	constructor(client: SigrunClient) {
		this.#client = client;
	}

	/** The catalog entry for `name` (bare, lowercased) from the CACHED
	 *  snapshot, or undefined. */
	async get(name: string): Promise<SlashCommand | undefined> {
		try {
			this.#cache ??= this.#client.getCommands();
			const response = await this.#cache;
			return response.commands.find((command) => command.name === name);
		} catch (error) {
			this.#cache = undefined;
			throw error;
		}
	}

	/** The live-catalog re-check: refetch NOW (replacing the cache with the
	 *  fresh response) and look `name` up again — the one retry a dispatch
	 *  makes when the cached snapshot lacks a name (the server re-scans
	 *  per request, so a template added mid-session becomes submittable
	 *  without a restart). Throws through on a failed fetch, like `get`. */
	async getFresh(name: string): Promise<SlashCommand | undefined> {
		this.#cache = undefined;
		return await this.get(name);
	}

	/** Every catalog name (the vim `:` Tab completion's source, C4). */
	async names(): Promise<string[]> {
		try {
			this.#cache ??= this.#client.getCommands();
			return (await this.#cache).commands.map((command) => command.name);
		} catch (error) {
			this.#cache = undefined;
			throw error;
		}
	}
}

/**
 * Format a failed composer action for the pane's error line. A
 * {@link SigrunApiError} renders the status plus the server's own
 * `{error: …}` body (Review Focus 2 — the server's words, never a generic
 * "something failed"); anything else renders its message.
 */
export function describeCommandError(action: string, error: unknown): string {
	if (error instanceof SigrunApiError) {
		const body = error.body;
		const detail =
			typeof body === "object" &&
			body !== null &&
			"error" in body &&
			typeof (body as { readonly error?: unknown }).error === "string"
				? (body as { readonly error: string }).error
				: undefined;
		// A failed extension command/run names its contributor (W5 Task 3's
		// `command_failed` + `extension` body) — the slug is what the operator
		// needs next, so it rides the same line.
		const extension =
			typeof body === "object" &&
			body !== null &&
			"extension" in body &&
			typeof (body as { readonly extension?: unknown }).extension === "string"
				? (body as { readonly extension: string }).extension
				: undefined;
		const suffix = extension === undefined ? "" : ` (${extension})`;
		return detail === undefined
			? `${action} failed (${error.status})`
			: `${action} failed (${error.status}): ${detail}${suffix}`;
	}
	const message = error instanceof Error ? error.message : String(error);
	return `${action} failed: ${message}`;
}
