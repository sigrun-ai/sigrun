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
 * The server's slash-command catalog, fetched once and cached (the server
 * treats it as a boot constant — `GET /v1/commands`). A failed fetch is NOT
 * cached: the rejected promise is dropped so the next `/` retries.
 */
export class SlashCatalog {
	readonly #client: SigrunClient;
	#cache: Promise<CommandsResponse> | undefined;

	constructor(client: SigrunClient) {
		this.#client = client;
	}

	/** The catalog entry for `name` (bare, lowercased), or undefined. */
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
		return detail === undefined
			? `${action} failed (${error.status})`
			: `${action} failed (${error.status}): ${detail}`;
	}
	const message = error instanceof Error ? error.message : String(error);
	return `${action} failed: ${message}`;
}
