/**
 * UI-blocks U7 Task 1: the signing half of the image proxy (spec
 * §11.2, verbatim rules). The key file lives at
 * `<stateDir>/image-proxy.key` (32 random bytes, mode 0600, created at
 * first boot, reused after; deleting it rotates); `signUrl` produces
 * `/v1/image?u=…&e=…&s=…` where `s` is hex HMAC-SHA256 over the exact
 * bytes `u + "\n" + e` and `e` is 24 hours after signing; `verify`
 * compares in constant time and rejects expired URLs, a modified `u`
 * (one byte), a modified `e`, and a signature from a different key.
 *
 * Literals are synthetic (`example.invalid`); tests own their values.
 */

import { createHmac } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { loadOrCreateKey, signUrl, verify } from "../src/server/images/sign.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** A temp state dir, removed at teardown. */
async function stateDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-images-sign-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

const KEY_A = Buffer.alloc(32, 0x11);
const KEY_B = Buffer.alloc(32, 0x22);
const URL = "https://images.example.invalid/acme/pic.png";
const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The expected HMAC hex over the exact bytes `u + "\n" + e`. */
function expectedSig(key: Buffer, u: string, e: string): string {
	return createHmac("sha256", key).update(`${u}\n${e}`, "utf8").digest("hex");
}

/** Parse a signed proxy URL back into its `u`/`e`/`s` params. */
function parseSigned(signed: string): { u: string; e: string; s: string } {
	expect(signed.startsWith("/v1/image?")).toBe(true);
	const query = new URLSearchParams(signed.slice("/v1/image?".length));
	const u = query.get("u");
	const e = query.get("e");
	const s = query.get("s");
	expect(u).not.toBeNull();
	expect(e).not.toBeNull();
	expect(s).not.toBeNull();
	return { u: u ?? "", e: e ?? "", s: s ?? "" };
}

describe("loadOrCreateKey", () => {
	test("creates a 32-byte key file with mode 0600 at <stateDir>/image-proxy.key", async () => {
		const dir = await stateDir();
		const key = await loadOrCreateKey(dir);
		expect(key.byteLength).toBe(32);
		const info = await stat(join(dir, "image-proxy.key"));
		expect(info.mode & 0o777).toBe(0o600);
	});

	test("reuses the same key on the next call", async () => {
		const dir = await stateDir();
		const first = await loadOrCreateKey(dir);
		const second = await loadOrCreateKey(dir);
		expect(second.equals(first)).toBe(true);
	});

	test("deleting the file rotates the key", async () => {
		const dir = await stateDir();
		const first = await loadOrCreateKey(dir);
		await rm(join(dir, "image-proxy.key"));
		const rotated = await loadOrCreateKey(dir);
		expect(rotated.equals(first)).toBe(false);
		expect(rotated.byteLength).toBe(32);
	});
});

describe("signUrl", () => {
	test("produces /v1/image?u=…&e=…&s=… with e 24 h out and s over the exact u + newline + e bytes", () => {
		const signed = signUrl(KEY_A, URL, NOW);
		const { u, e, s } = parseSigned(signed);
		expect(u).toBe(URL);
		expect(e).toBe(String(NOW + DAY_MS));
		expect(s).toBe(expectedSig(KEY_A, URL, e));
		expect(s).toMatch(/^[0-9a-f]{64}$/);
	});

	test("the signed u round-trips a URL with query and fragment bytes", () => {
		const fancy = "https://images.example.invalid/a.png?w=64&x=%20#frag";
		const { u } = parseSigned(signUrl(KEY_A, fancy, NOW));
		expect(u).toBe(fancy);
	});
});

describe("verify", () => {
	test("accepts a fresh signature at signing time and at the expiry instant", () => {
		const signed = signUrl(KEY_A, URL, NOW);
		const { u, e, s } = parseSigned(signed);
		expect(verify(KEY_A, u, e, s, NOW)).toBe(true);
		expect(verify(KEY_A, u, e, s, Number(e))).toBe(true);
	});

	test("rejects an expired signature (now > e) and accepts one second before", () => {
		const signed = signUrl(KEY_A, URL, NOW);
		const { u, e, s } = parseSigned(signed);
		const expiry = Number(e);
		expect(verify(KEY_A, u, e, s, expiry + 1)).toBe(false);
		expect(verify(KEY_A, u, e, s, expiry - 1000)).toBe(true);
	});

	test("rejects a modified u (one byte flipped)", () => {
		const signed = signUrl(KEY_A, URL, NOW);
		const { u, e, s } = parseSigned(signed);
		const tampered = u.replace("pic", "pick");
		expect(tampered).not.toBe(u);
		expect(verify(KEY_A, tampered, e, s, NOW)).toBe(false);
	});

	test("rejects a modified e", () => {
		const signed = signUrl(KEY_A, URL, NOW);
		const { u, e, s } = parseSigned(signed);
		const tampered = String(Number(e) + 1000);
		expect(verify(KEY_A, u, tampered, s, NOW)).toBe(false);
	});

	test("rejects a signature from a different key", () => {
		const signed = signUrl(KEY_A, URL, NOW);
		const { u, e, s } = parseSigned(signed);
		expect(verify(KEY_B, u, e, s, NOW)).toBe(false);
	});

	test("rejects a malformed e or s instead of throwing", () => {
		const signed = signUrl(KEY_A, URL, NOW);
		const { u, e, s } = parseSigned(signed);
		expect(verify(KEY_A, u, "not-a-number", s, NOW)).toBe(false);
		expect(verify(KEY_A, u, e, "0".repeat(64), NOW)).toBe(false);
		// A short signature must not throw from the length guard.
		expect(verify(KEY_A, u, e, "deadbeef", NOW)).toBe(false);
	});
});
