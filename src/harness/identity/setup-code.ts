/**
 * The setup code (core hardening W1 Task 2, spec §5.8): the one-shot
 * onboarding credential an unclaimed server accepts — `XXXX-XXXX`,
 * eight characters from a 32-char unambiguous alphabet (no `I`/`O`/`0`/
 * `1` — readable over a pod log or a phone).
 *
 - pinned by `SIGRUN_SETUP_CODE` (env only — the k8s Secret shape) or
   generated fresh at each unclaimed boot;
 - written to `<cacheDir>/setup-code`, mode `0600`, atomically — the
   CACHE root is pod-local and never a backup section, so the code
   never lands in a backup, while `kubectl exec … cat` retrieves it;
 - the cache root is deliberately NOT assumed to exist (the wiped-
   `emptyDir` posture, stores.ts Review Focus 5): every write recreates
   it at call time;
 - deleted at claim (`clearSetupCode`), idempotently.
 *
 * The code is NOT an `InviteStore` row (see invites.ts): it is compared
 * directly by the onboarding route — "the first invite" is a behavioral
 * equivalence, not a storage fact.
 */

import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { randomInt } from "node:crypto";
import { join } from "node:path";
import type { Env } from "../../config.js";
import { writeFileAtomic } from "../stores.js";

/** The unambiguous alphabet (spec §5.8): 32 chars, no `I`/`O`/`0`/`1`. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** The code file name under the cache root. */
const SETUP_CODE_FILE = "setup-code";

/** The env var that pins the code (k8s Secret shape; env only). */
const SETUP_CODE_ENV = "SIGRUN_SETUP_CODE";

/** `<cacheDir>/setup-code`. */
export function setupCodePath(cacheDir: string): string {
	return join(cacheDir, SETUP_CODE_FILE);
}

/**
 * Draw one code: `XXXX-XXXX`, 8 characters from {@link CODE_ALPHABET}
 * (`randomInt` — unbiased over the 32-symbol space). Invites reuse this
 * draw for their code shape.
 */
export function generateCode(): string {
	const pick = (): string => CODE_ALPHABET.charAt(randomInt(CODE_ALPHABET.length));
	return `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`;
}

/**
 * Ensure the setup code exists and return it: the `SIGRUN_SETUP_CODE`
 * pin wins (trimmed; an empty value counts as unset, the module-wide
 * ""-means-unset reading), else a fresh code is drawn. The code is
 * (re)written to `<cacheDir>/setup-code` mode `0600` atomically every
 * call — each unclaimed boot refreshes the file, and a pinned code
 * self-heals a wiped cache root.
 */
export async function ensureSetupCode(
	cacheDir: string,
	env: Env,
): Promise<string> {
	const pinned = env[SETUP_CODE_ENV];
	const code = pinned !== undefined && pinned !== "" ? pinned.trim() : generateCode();
	await mkdir(cacheDir, { recursive: true });
	await writeFileAtomic(setupCodePath(cacheDir), `${code}\n`, 0o600);
	return code;
}

/**
 * Read the persisted code; absent file → undefined. Whitespace is
 * trimmed (the file carries one trailing newline); an empty file reads
 * as undefined.
 */
export function readSetupCode(cacheDir: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(setupCodePath(cacheDir), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const code = text.trim();
	return code === "" ? undefined : code;
}

/** Delete the code file (the claim step); absent file is a no-op. */
export async function clearSetupCode(cacheDir: string): Promise<void> {
	await rm(setupCodePath(cacheDir), { force: true });
}
