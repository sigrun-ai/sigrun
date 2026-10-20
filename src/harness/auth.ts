/**
 * The auth store (the 2026-10-13 config-surface ruling): a pi-style
 * credentials file at `<config-dir>/auth.json` — the same directory the
 * settings store lives in (`SIGRUN_CONFIG_DIR` / `~/.config/sigrun`).
 *
 * Shape: `{ "<provider>": { "apiKey": "..." } }`, one entry per provider
 * id, plus the magic key `"default"` naming the DEFAULT provider's key —
 * so a deployment that does not know the resolved provider id up front
 * can still hand the env-driven OpenAI-compatible provider its key.
 *
 * The file is created with mode 0o600 (owner-only) whenever a write
 * happens. Key material is NEVER logged or echoed: validation errors
 * name the key path, never the value; callers must not interpolate
 * resolved keys into messages.
 *
 * Absent file = no stored keys (the `OPENAI_API_KEY` env fallback still
 * applies). A malformed file (bad JSON, non-object, a key present but not
 * a non-empty string) fails loud on read, like a bad `SIGRUN_*` value.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultSettingsDir } from "./settings.js";
import { writeFileAtomic } from "./stores.js";

/** The magic provider key meaning "the resolved default provider's key". */
export const DEFAULT_AUTH_KEY = "default";

/** One provider's credentials entry. */
export interface AuthEntry {
	readonly apiKey?: string;
}

/** The persisted auth file shape, keyed by provider name. */
export type AuthFile = Readonly<Record<string, AuthEntry>>;

/** Default file path: `<dir>/auth.json`. */
export function authPath(dir: string): string {
	return join(dir, "auth.json");
}

/** A field-level validation error; names the key path, never the value. */
export class AuthValidationError extends Error {
	constructor(readonly field: string, reason: string) {
		super(`auth: ${field} ${reason}`);
	}
}

/**
 * A file-backed auth store. Reads are fresh per call (same discipline as
 * the settings store). The store is permissive about unknown fields inside
 * an entry (future auth kinds — token refresh, base-url pins — may add
 * some) but strict about `apiKey`: when present it must be a non-empty
 * string.
 */
export class AuthStore {
	readonly path: string;

	constructor(options: { readonly dir?: string } = {}) {
		this.path = authPath(options.dir ?? defaultSettingsDir());
	}

	/** The current auth file; absent file = `{}` (no stored keys). */
	read(): AuthFile {
		if (!existsSync(this.path)) return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.path, "utf8"));
		} catch (cause) {
			throw new Error(
				`auth: ${this.path} is not valid JSON (${
					cause instanceof Error ? cause.message : String(cause)
				})`,
			);
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error(`auth: ${this.path} must contain a JSON object`);
		}
		const file = parsed as Record<string, unknown>;
		for (const [provider, entry] of Object.entries(file)) {
			if (
				typeof entry !== "object" ||
				entry === null ||
				Array.isArray(entry)
			) {
				throw new AuthValidationError(provider, "must be an object");
			}
			const apiKey = (entry as Record<string, unknown>).apiKey;
			if (
				apiKey !== undefined &&
				(typeof apiKey !== "string" || apiKey === "")
			) {
				throw new AuthValidationError(
					`${provider}.apiKey`,
					"must be a non-empty string",
				);
			}
		}
		return file as AuthFile;
	}

	/**
	 * Persist `file` wholesale, creating the file mode 0o600 (owner-only —
	 * the file carries key material). An existing file is chmod'd to
	 * 0o600 as well: a hand-created world-readable auth file is tightened
	 * on the first write.
	 */
	write(file: AuthFile): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${JSON.stringify(file, null, "\t")}\n`, {
			mode: 0o600,
		});
	}

	/**
	 * Set one key's api key (core hardening W3 Task 6, spec §7.6): the
	 * server's credential ROUTE writes through this — read-modify-write
	 * over the current file (other entries untouched), staged through
	 * {@link writeFileAtomic} at 0600 so a crash or concurrent reader only
	 * ever sees the old or new complete file. `key` is the auth.json
	 * provider key (`<id>`, or the magic `"default"` for the default
	 * model's provider); `apiKey` must be a non-empty string — anything
	 * else is refused HERE rather than written as a file the store's own
	 * `read()` would reject. The pi-ai bridge stays read-only; this method
	 * is the server's single write seam.
	 */
	async setApiKey(key: string, apiKey: string): Promise<void> {
		if (typeof apiKey !== "string" || apiKey === "") {
			throw new AuthValidationError(
				`${key}.apiKey`,
				"must be a non-empty string",
			);
		}
		const file = { ...this.read() };
		file[key] = { ...file[key], apiKey };
		await mkdir(dirname(this.path), { recursive: true });
		await writeFileAtomic(
			this.path,
			`${JSON.stringify(file, null, "\t")}\n`,
			0o600,
		);
	}

	/**
	 * Remove one key's entry entirely (spec §7.6: "DELETE removes the
	 * entry") — atomic and 0600 like every write. Idempotent: an absent
	 * key writes nothing (DELETE of a never-set credential is a no-op,
	 * not an error).
	 */
	async deleteApiKey(key: string): Promise<void> {
		const file = this.read();
		if (file[key] === undefined) return;
		const next = { ...file };
		delete next[key];
		await mkdir(dirname(this.path), { recursive: true });
		await writeFileAtomic(
			this.path,
			`${JSON.stringify(next, null, "\t")}\n`,
			0o600,
		);
	}
}
