/**
 * Task 2: store-root lifecycle — `ensureStoreRoots` (boot ensure) and
 * `ensureCacheDir` (per-call repair) in `src/harness/stores.ts`, plus the
 * one `openHarness` wiring of the ensure.
 *
 * Review Focus 5 (plan §"Review Focus" 5): a wiped cache root (the
 * container `emptyDir` case) must never break boot — the cache root is
 * NOT ensured at boot, and every cache-path consumer repairs it at CALL
 * time (mkdir -p). No other root is ever recreated mid-session by the
 * cache path, and cache never falls back under the data root.
 *
 * Boot-level tests go through `openHarness` with an injected fake env
 * (`options.env` — the same seam the provider collector reads), pinning
 * every root under a synthetic tmpdir: no real user paths are touched.
 */

import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import {
	ensureCacheDir,
	ensureStoreRoots,
	resolveStoreRoots,
	type StoreRoots,
} from "../src/harness/stores.js";
import { seededIdentity } from "./helpers/identity.js";

/** A fake env pinning all four roots under one synthetic tmpdir base. */
const fakeEnv = (base: string) => ({
	SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
	SIGRUN_STORAGE_PATH: join(base, "sigrun.db"),
	SIGRUN_CONFIG_DIR: join(base, "config"),
	SIGRUN_DATA_DIR: join(base, "data"),
	SIGRUN_CACHE_DIR: join(base, "cache"),
	SIGRUN_STATE_DIR: join(base, "state"),
});

/** Assert `path` is a directory. */
const expectDir = async (path: string): Promise<void> => {
	expect((await stat(path)).isDirectory(), path).toBe(true);
};

/** Assert `path` does not exist (ENOENT — not merely not-a-directory). */
const expectMissing = async (path: string): Promise<void> => {
	await expect(stat(path), path).rejects.toMatchObject({ code: "ENOENT" });
};

test("boot ensures config/data/state roots (+ settings/) from the injected env; the cache root is NOT ensured at boot", async () => {
	const base = await mkdtemp(join(tmpdir(), "sigrun-stores-"));
	const env = fakeEnv(base);
	try {
		// Claimed identity (seeded OUTSIDE the asserted roots): the generic
		// rule under test is `ensureStoreRoots`' cache skip; an unclaimed
		// boot would additionally run the W1 Task 4 setup-code write — the
		// one sanctioned boot-time cache consumer — and materialize the
		// root. Seeding claimed keeps this test on the generic rule.
		const opened = await openHarness(loadConfig(env), {
			env,
			identity: await seededIdentity(join(base, "seed")),
		});
		await opened.harness.close(BACKGROUND_CONTEXT);

		await expectDir(join(base, "config"));
		await expectDir(join(base, "config", "settings"));
		await expectDir(join(base, "data"));
		await expectDir(join(base, "state"));
		// Review Focus 5: the cache root is deliberately not a boot-time
		// ensure — a wiped emptyDir must never break boot, and nothing
		// regenerates cache eagerly.
		await expectMissing(join(base, "cache"));
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("ensureCacheDir recreates a deleted cache root on every call, and never recreates (or falls back under) the data root", async () => {
	const base = await mkdtemp(join(tmpdir(), "sigrun-stores-"));
	try {
		const roots: StoreRoots = resolveStoreRoots({
			SIGRUN_CONFIG_DIR: join(base, "config"),
			SIGRUN_DATA_DIR: join(base, "data"),
			SIGRUN_CACHE_DIR: join(base, "cache"),
			SIGRUN_STATE_DIR: join(base, "state"),
		});
		await ensureStoreRoots(roots);

		const cachePath = await ensureCacheDir(roots, "acme-ext");
		expect(cachePath).toBe(join(roots.cacheDir, "acme-ext"));
		await expectDir(cachePath);

		// The emptyDir-wipe case: the WHOLE cache root disappears, not
		// just the extension subdir. The next call must recreate it —
		// mkdir -p at call time (never boot, never a data-root fallback).
		await rm(roots.cacheDir, { recursive: true, force: true });
		await expectMissing(roots.cacheDir);
		const repaired = await ensureCacheDir(roots, "acme-ext");
		expect(repaired).toBe(cachePath);
		await expectDir(repaired);

		// Review Focus 5's no-fallback pin: the cache path never lives
		// under the data root...
		expect(cachePath.startsWith(`${roots.dataDir}/`)).toBe(false);
		// ...and repairing cache recreates nothing there (the data root
		// stayed empty) — nor does it resurrect a deleted sibling root.
		expect(await readdir(roots.dataDir)).toEqual([]);
		await rm(roots.dataDir, { recursive: true, force: true });
		await ensureCacheDir(roots, "acme-ext");
		await expectMissing(roots.dataDir);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

// chmod 0500 does not stop a root-uid process — the EACCES fixture is
// only honest unprivileged.
test.skipIf(process.getuid?.() === 0)(
	"boot fails loud naming the config root when it cannot be created (EACCES)",
	async () => {
		const base = await mkdtemp(join(tmpdir(), "sigrun-readonly-"));
		const env = fakeEnv(base);
		await chmod(base, 0o500); // read+traverse, no write → mkdir under it EACCES
		try {
			await expect(openHarness(loadConfig(env), { env })).rejects.toThrow(
				env.SIGRUN_CONFIG_DIR,
			);
		} finally {
			// Restore write permission FIRST so the recursive rm can clean up.
			await chmod(base, 0o700);
			await rm(base, { recursive: true, force: true });
		}
	},
);
