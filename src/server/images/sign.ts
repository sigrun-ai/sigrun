/**
 * The signing half of the image proxy (UI-blocks U7 Task 1, spec §11.2
 * verbatim):
 *
 * - `s` is HMAC-SHA256 (hex) over the exact bytes `u + "\n" + e`, where
 *   `u` is the URL string as it appeared in the tree — the server never
 *   re-parses or re-encodes it between verifying and fetching.
 * - `e` is an expiry 24 hours after signing (epoch milliseconds).
 * - The key is 32 random bytes at `<stateDir>/image-proxy.key`, mode
 *   0600, created at first boot and reused after. Deleting the file
 *   rotates it: old signatures fail and channels re-fetch the surface,
 *   which re-signs.
 * - Signatures are not bound to a user; a copied signed URL works for
 *   any signed-in user until it expires (spec: that reveals nothing the
 *   URL didn't already).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** The key file's name under the state dir. */
export const IMAGE_PROXY_KEY_FILE = "image-proxy.key";

/** The signature lifetime (spec §11.2): 24 hours. */
export const SIGNATURE_TTL_MS = 24 * 60 * 60 * 1000;

/** The proxy path every signed URL is rooted at. */
const PROXY_PATH = "/v1/image";

/** Load (or create) the proxy key at `<stateDir>/image-proxy.key`. */
export async function loadOrCreateKey(stateDir: string): Promise<Buffer> {
	const path = join(stateDir, IMAGE_PROXY_KEY_FILE);
	try {
		return await readFile(path);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
	}
	// First boot: create the key atomically (stage + chmod + rename, the
	// same discipline as the stores' `writeFileAtomic` — chmod BEFORE the
	// rename so there is no window at the wrong mode, and a chmod beats
	// writeFile's `mode` option because umask masks the latter).
	await mkdir(stateDir, { recursive: true });
	const key = randomBytes(32);
	const staged = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(staged, key, { mode: 0o600 });
		await chmod(staged, 0o600);
		await rename(staged, path);
	} catch (cause) {
		await rm(staged, { force: true });
		throw cause;
	}
	return key;
}

/** Sign one URL at time `now`: `/v1/image?u=…&e=…&s=…`. */
export function signUrl(key: Buffer, u: string, now: number): string {
	const e = String(now + SIGNATURE_TTL_MS);
	const s = signature(key, u, e);
	return `${PROXY_PATH}?u=${encodeURIComponent(u)}&e=${e}&s=${s}`;
}

/**
 * Verify a signed URL's parts at time `now`: the HMAC matches (constant
 * time) AND `now <= e`. Malformed parts (a non-numeric `e`, a wrong-length
 * or non-hex `s`) reject instead of throwing.
 */
export function verify(
	key: Buffer,
	u: string,
	e: string,
	s: string,
	now: number,
): boolean {
	if (!/^\d+$/.test(e)) return false;
	if (!/^[0-9a-f]+$/.test(s)) return false;
	const expected = signature(key, u, e);
	// Constant-time over the fixed 64-byte hex digests; the length check
	// first because timingSafeEqual throws on a length mismatch.
	if (s.length !== expected.length) return false;
	if (!timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(s, "utf8"))) {
		return false;
	}
	return now <= Number(e);
}

/** The HMAC hex digest over the exact bytes `u + "\n" + e`. */
function signature(key: Buffer, u: string, e: string): string {
	return createHmac("sha256", key).update(`${u}\n${e}`, "utf8").digest("hex");
}
