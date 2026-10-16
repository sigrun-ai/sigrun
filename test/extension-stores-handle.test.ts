/**
 * Task 5: the scoped extension-stores handle (`ExtensionStores`,
 * src/harness/stores.ts) threaded onto the factory host (SeamHost).
 *
 * The handle is the ONLY store surface extension code ever sees:
 * secrets as get/set on this slug's `secrets.json` SECTION (the
 * extension cannot name another slug), settings as get/set on this
 * slug's `settings/<slug>.json`, and raw per-slug data/cache/state
 * paths (data/state resolved plain — their roots are boot-ensured;
 * cache NOT ensured at boot, only at first access, Review Focus 5).
 * No path-style access to secrets/settings anywhere on the handle.
 *
 * The rekey-coherence pin (the M2 lesson): the fixture captures its
 * host during the loader's "" phase; every assertion then runs through
 * that PRE-rekey capture — the host object boot filed under the slug
 * must BE that same instance, and its stores must serve the rekeyed
 * slug (scoped views re-pointed in place, never a second host).
 *
 * Hermetic pattern (stores-lifecycle.test.ts): every root pinned under
 * one synthetic tmpdir via the injected fake env; the fixture loads
 * through the REAL loader inside `openHarness`.
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import {
	resolveStoreRoots,
	sharedExtensionStores,
	type StoreRoots,
} from "../src/harness/stores.js";

/** Fixture: arity-1 factory capturing its host (the ""-phase object). */
const FIXTURE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-stores", "index.js"),
).href;

/** A fake env pinning all four roots under one synthetic tmpdir base. */
const fakeEnv = (base: string) => ({
	SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
	SIGRUN_STORAGE_PATH: join(base, "sigrun.db"),
	SIGRUN_CONFIG_DIR: join(base, "config"),
	SIGRUN_DATA_DIR: join(base, "data"),
	SIGRUN_CACHE_DIR: join(base, "cache"),
	SIGRUN_STATE_DIR: join(base, "state"),
});

/** The captured host (set by the fixture at load; undefined until then). */
type Captured = { __fixtureStoresHost?: SeamHost };

interface Booted {
	readonly opened: OpenedHarness;
	readonly roots: StoreRoots;
	readonly base: string;
}

/**
 * Boot with the stores fixture under a fresh tmpdir, then run `body`
 * against the host the FIXTURE captured (the pre-rekey object). The
 * wrapper asserts the capture exists (a quarantined fixture fails
 * here) and always closes the harness + removes the tmpdir.
 */
async function withCapturedHost(
	body: (host: SeamHost, booted: Booted) => Promise<void>,
): Promise<void> {
	(globalThis as Captured).__fixtureStoresHost = undefined;
	let booted: Booted | undefined;
	try {
		const base = await mkdtemp(join(tmpdir(), "sigrun-stores-handle-"));
		const env = fakeEnv(base);
		const opened = await openHarness(loadConfig(env), {
			env,
			extensionSpecifiers: [FIXTURE_SPECIFIER],
		});
		booted = { opened, roots: resolveStoreRoots(env), base };
		const host = (globalThis as Captured).__fixtureStoresHost;
		expect(host).toBeDefined();
		if (host === undefined) throw new Error("fixture host missing");
		await body(host, booted);
	} finally {
		await booted?.opened.harness.close(BACKGROUND_CONTEXT);
		(globalThis as Captured).__fixtureStoresHost = undefined;
		if (booted !== undefined) {
			await rm(booted.base, { recursive: true, force: true });
		}
	}
}

test("secrets and settings are scoped to the extension's slug, never a sibling's", async () => {
	await withCapturedHost(async (host, { opened, roots, base }) => {
		// Rekey coherence, stated first: the host the factory captured
		// during the "" phase IS the host boot filed under the slug —
		// the same object, never a second instance.
		expect(host).toBe(opened.seamHosts.get("acme-tool"));
		expect(opened.extensionOutcomes).toContainEqual({
			name: "acme-tool",
			status: "ok",
		});

		// A FOREIGN section carrying the same key: the handle must not
		// see it (scoped to this slug's section — the extension cannot
		// name another slug).
		const shared = sharedExtensionStores(roots);
		await shared.secrets.writeSection("other-ext", { k: "foreign-value" });
		expect(await host.stores.secrets.get("k")).toBeUndefined();

		// secrets.set persists under THIS slug and preserves the sibling.
		await host.stores.secrets.set("k", "own-value");
		expect(await host.stores.secrets.get("k")).toBe("own-value");
		const secretsFile = JSON.parse(
			await readFile(join(base, "config", "secrets.json"), "utf8"),
		);
		expect(secretsFile).toEqual({
			"acme-tool": { k: "own-value" },
			"other-ext": { k: "foreign-value" },
		});

		// settings: absent file reads as {}; set lands in this slug's
		// settings/<slug>.json and round-trips.
		expect(await host.stores.settings.get()).toEqual({});
		await host.stores.settings.set({ interval: 30, label: "alpha" });
		expect(await host.stores.settings.get()).toEqual({
			interval: 30,
			label: "alpha",
		});
		const settingsFile = JSON.parse(
			await readFile(
				join(base, "config", "settings", "acme-tool.json"),
				"utf8",
			),
		);
		expect(settingsFile).toEqual({ interval: 30, label: "alpha" });
	});
});

test("paths: per-slug data/state; cache exists on disk after FIRST access only", async () => {
	await withCapturedHost(async (host, { roots, base }) => {
		// Raw paths are per-slug (their roots were ensured at boot; the
		// subdirs are the extension's own to create — raw-directory
		// semantics, the server never mediates data/state I/O).
		expect(host.stores.paths.data).toBe(join(roots.dataDir, "acme-tool"));
		expect(host.stores.paths.state).toBe(join(roots.stateDir, "acme-tool"));

		// Review Focus 5 through the handle: boot created NO cache dir;
		// the first access both resolves and materializes it.
		await expect(stat(join(base, "cache"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(host.stores.paths.cache).toBe(join(roots.cacheDir, "acme-tool"));
		expect(
			(await stat(host.stores.paths.cache)).isDirectory(),
			host.stores.paths.cache,
		).toBe(true);
	});
});
