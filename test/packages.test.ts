/**
 * The pi-style packages dir: boot-time extension install (`syncPackages`)
 * plus packages-dir-first extension resolution (`resolveExtensionEntry`).
 *
 * Hermetic: installs use a `file:` specifier against the on-disk fixture
 * package (test/fixtures/fixture-pkg) — no network. The fixture's own
 * dependencies (`@earendil-works/pi-durable`, `@earendil-works/pi-ai`,
 * both "*") resolve from the caller's node_modules — sigrun's own — so
 * `npm install --prefix <tmp>` hard-links them from the local store
 * instead of fetching.
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import {
	PackageSyncError,
	packagesDirOf,
	packagesManifestPath,
	parsePackageSpecifier,
	planSync,
	resolveExtensionEntry,
	syncPackages,
} from "../src/harness/packages.js";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A fresh tmp dir (recorded for afterAll teardown). */
function freshDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** The fixture package source dir (installed via `file:`). */
const FIXTURE_PKG_DIR = join(import.meta.dirname, "fixtures", "fixture-pkg");
/** A `file:` specifier pointing at the fixture package. */
const FIXTURE_PKG_SPEC = `file:${FIXTURE_PKG_DIR}`;

/** Read the packages dir's root manifest. */
function readManifest(packagesDir: string): {
	dependencies?: Record<string, string>;
} {
	return JSON.parse(readFileSync(packagesManifestPath(packagesDir), "utf8")) as {
		dependencies?: Record<string, string>;
	};
}

/** The packages dir's root manifest mtime (the fast-path assertion). */
function manifestMtimeMs(packagesDir: string): number {
	return statSync(packagesManifestPath(packagesDir)).mtimeMs;
}

describe("parsePackageSpecifier", () => {
	test("bare name, ranged, and scoped forms", () => {
		expect(parsePackageSpecifier("sigrun-ext-approvals")).toEqual({
			name: "sigrun-ext-approvals",
			range: "",
		});
		expect(parsePackageSpecifier("sigrun-ext-approvals@^0.1.0")).toEqual({
			name: "sigrun-ext-approvals",
			range: "^0.1.0",
		});
		expect(parsePackageSpecifier("@sigrun/ext-approvals@^0.1.0")).toEqual({
			name: "@sigrun/ext-approvals",
			range: "^0.1.0",
		});
		expect(parsePackageSpecifier("@sigrun/ext-approvals")).toEqual({
			name: "@sigrun/ext-approvals",
			range: "",
		});
		// A file: specifier carries no @range → the name part is the whole
		// specifier (npm keys the entry by the package's OWN manifest name).
		expect(parsePackageSpecifier(FIXTURE_PKG_SPEC).range).toBe("");
	});
});

describe("syncPackages", () => {
	test("installs a wanted file: package into a fresh packages dir", async () => {
		const packagesDir = join(freshDir("sigrun-pkg-"), "packages");
		await syncPackages([FIXTURE_PKG_SPEC], packagesDir, { log: false });
		// The synthetic private root exists and npm recorded the dep
		// (relativized against the packages dir — npm's file: form).
		const manifest = readManifest(packagesDir);
		expect(manifest.dependencies?.["fixture-pkg"]).toBe(
			`file:${relative(packagesDir, FIXTURE_PKG_DIR)}`,
		);
		// The package itself materialized (npm keys file: entries by the
		// package's own manifest name).
		expect(
			existsSync(join(packagesDir, "node_modules", "fixture-pkg", "package.json")),
		).toBe(true);
	}, 60_000);

	test("a matching declaration is a no-op fast path (no subprocess, manifest untouched)", async () => {
		const packagesDir = join(freshDir("sigrun-pkg-"), "packages");
		await syncPackages([FIXTURE_PKG_SPEC], packagesDir, { log: false });
		const before = manifestMtimeMs(packagesDir);
		// A second sync with the same declaration must not touch anything.
		await syncPackages([FIXTURE_PKG_SPEC], packagesDir, { log: false });
		expect(manifestMtimeMs(packagesDir)).toBe(before);
	}, 60_000);

	test("a .tgz tarball specifier identifies as the packed package's name", async () => {
		// npm pack the fixture into a tarball and install it: the packed
		// manifest's name keys the entry (registry-install shape — a real
		// copy, not the file:-directory symlink).
		const dir = freshDir("sigrun-pkg-tgz-");
		const { stdout } = await new Promise<{ stdout: string }>(
			(resolvePack, rejectPack) => {
				execFile(
					"npm",
					["pack", "--pack-destination", dir, FIXTURE_PKG_DIR],
					(error: Error | null, out: string) =>
						error === null ? resolvePack({ stdout: out }) : rejectPack(error),
				);
			},
		);
		const tarball = join(dir, stdout.trim().split("\n").pop() ?? "");
		const packagesDir = join(freshDir("sigrun-pkg-"), "packages");
		await syncPackages([`file:${tarball}`], packagesDir, { log: false });
		expect(
			existsSync(join(packagesDir, "node_modules", "fixture-pkg", "package.json")),
		).toBe(true);
		// Tarball installs are REAL copies (no symlink): steady state is a
		// no-op, and resolution lands INSIDE the packages dir.
		const before = manifestMtimeMs(packagesDir);
		await syncPackages([`file:${tarball}`], packagesDir, { log: false });
		expect(manifestMtimeMs(packagesDir)).toBe(before);
		expect(resolveExtensionEntry("fixture-pkg", packagesDir)).toContain(
			pathToFileURL(packagesDir).href,
		);
	}, 60_000);

	test("a declaration removed from settings uninstalls the package", async () => {
		const packagesDir = join(freshDir("sigrun-pkg-"), "packages");
		await syncPackages([FIXTURE_PKG_SPEC], packagesDir, { log: false });
		expect(existsSync(join(packagesDir, "node_modules", "fixture-pkg"))).toBe(true);
		await syncPackages([], packagesDir, { log: false });
		expect(existsSync(join(packagesDir, "node_modules", "fixture-pkg"))).toBe(false);
		expect(readManifest(packagesDir).dependencies ?? {}).not.toHaveProperty(
			"fixture-pkg",
		);
	}, 60_000);

	test("a changed file: path (same package name) reinstalls", async () => {
		// npm keys a file: entry by the target package's OWN name and
		// relativizes the recorded path against the packages dir — the sync
		// must compare canonical absolute paths, or a path change would
		// no-op (and a steady state would reinstall every boot).
		const packagesDir = join(freshDir("sigrun-pkg-"), "packages");
		await syncPackages([FIXTURE_PKG_SPEC], packagesDir, { log: false });
		// npm recorded the entry relativized against the packages dir.
		expect(readManifest(packagesDir).dependencies?.["fixture-pkg"]).toBe(
			`file:${relative(packagesDir, FIXTURE_PKG_DIR)}`,
		);
		// A copy of the same package (same name) at a NEW path: the
		// declaration changed → reinstall, manifest re-records the new path.
		const movedDir = join(freshDir("sigrun-pkg-moved-"), "fixture-pkg");
		cpSync(FIXTURE_PKG_DIR, movedDir, { recursive: true });
		await syncPackages([`file:${movedDir}`], packagesDir, { log: false });
		expect(readManifest(packagesDir).dependencies?.["fixture-pkg"]).toBe(
			`file:${relative(packagesDir, movedDir)}`,
		);
	}, 60_000);

	test("planSync diff rules (unit): missing, range change, removal, steady state", () => {
		const packagesDir = "/pkgs";
		// Missing → install; extra → uninstall.
		expect(planSync(["a@^1"], {}, packagesDir)).toEqual({
			install: ["a@^1"],
			uninstall: [],
		});
		expect(planSync([], { a: "^1" }, packagesDir)).toEqual({
			install: [],
			uninstall: ["a"],
		});
		// Steady state: matching range, or a rangeless declaration over any
		// recorded range → no changes.
		expect(planSync(["a@^1"], { a: "^1" }, packagesDir)).toEqual({
			install: [],
			uninstall: [],
		});
		expect(planSync(["a"], { a: "^1" }, packagesDir)).toEqual({
			install: [],
			uninstall: [],
		});
		// Range changed → reinstall; scoped names parse correctly.
		expect(planSync(["a@^2"], { a: "^1" }, packagesDir)).toEqual({
			install: ["a@^2"],
			uninstall: [],
		});
		expect(
			planSync(["@scope/b@2.0.0"], { "@scope/b": "^1" }, packagesDir),
		).toEqual({ install: ["@scope/b@2.0.0"], uninstall: [] });
	});

	test("an uninstallable declaration fails loud, naming the specifier", async () => {
		const packagesDir = join(freshDir("sigrun-pkg-"), "packages");
		await expect(
			syncPackages(
				["file:/nonexistent/definitely-not-a-package"],
				packagesDir,
				{ log: false },
			),
		).rejects.toThrow(PackageSyncError);
		await expect(
			syncPackages(
				["file:/nonexistent/definitely-not-a-package"],
				join(freshDir("sigrun-pkg-"), "packages"),
				{ log: false },
			),
		).rejects.toThrow(/npm install/);
	}, 60_000);

	test("a corrupt root manifest fails loud (sigrun-owned dir)", async () => {
		const packagesDir = join(freshDir("sigrun-pkg-"), "packages");
		mkdirSync(packagesDir, { recursive: true });
		writeFileSync(packagesManifestPath(packagesDir), "{not json", "utf8");
		await expect(
			syncPackages([], packagesDir, { log: false }),
		).rejects.toThrow(/not valid JSON/);
	});
});

describe("resolveExtensionEntry", () => {
	test("a bare name resolves through the packages dir to the installed package", async () => {
		const packagesDir = join(freshDir("sigrun-pkg-"), "packages");
		await syncPackages([FIXTURE_PKG_SPEC], packagesDir, { log: false });
		const entry = resolveExtensionEntry("fixture-pkg", packagesDir);
		expect(entry).toBeDefined();
		// npm file: installs SYMLINK node_modules/fixture-pkg → the source
		// dir, so resolution lands on the real fixture (pi's dev-checkout
		// shape); the assertion is that the packages dir OWNS the
		// resolution — the same name without the packages dir fails.
		expect(entry).toContain("fixture-pkg");
		expect(
			resolveExtensionEntry(
				"fixture-pkg",
				join(freshDir("sigrun-pkg-empty-"), "packages"),
			),
		).toBeUndefined();
	}, 60_000);

	test("a path/file: specifier falls back to bare resolution", () => {
		const packagesDir = join(freshDir("sigrun-pkg-"), "packages");
		const specifier = pathToFileURL(
			join(import.meta.dirname, "fixtures", "fixture-ext", "index.js"),
		).href;
		expect(resolveExtensionEntry(specifier, packagesDir)).toBe(specifier);
	});

	test("an unresolvable name returns undefined (the loader quarantines)", () => {
		const packagesDir = join(freshDir("sigrun-pkg-"), "packages");
		expect(
			resolveExtensionEntry("definitely-not-installed-anywhere", packagesDir),
		).toBeUndefined();
	});
});

describe("loader + packages dir integration", () => {
	test("a packages-dir-installed bare name LOADS through openHarness", async () => {
		const configDir = freshDir("sigrun-config-");
		const packagesDir = packagesDirOf(configDir);
		await syncPackages([FIXTURE_PKG_SPEC], packagesDir, { log: false });
		const dir = freshDir("sigrun-loader-pkg-");
		const config = loadConfig({
			SIGRUN_MODEL: "openai/gpt-4o",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
		});
		const opened = await openHarness(config, {
			env: {},
			settingsDir: configDir,
			// The LOAD list names the package BARE — resolution must come from
			// the packages dir (nothing named fixture-pkg exists in the app tree).
			extensionSpecifiers: ["fixture-pkg"],
		});
		try {
			const snapshot = opened.registry.snapshot();
			expect(snapshot.extension("sigrun.fixture-ext")).toBeDefined();
			expect(
				snapshot.tools().some((entry) => entry.tool.name === "fixture_marker"),
			).toBe(true);
			expect(opened.extensionOutcomes).toEqual([
				{ name: "sigrun.fixture-ext", status: "ok" },
			]);
			expect(opened.packagesDir).toBe(packagesDir);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	}, 60_000);

	test("bare app-tree/file: specifiers still load with the packages dir present (fallback)", async () => {
		const configDir = freshDir("sigrun-config-");
		const dir = freshDir("sigrun-loader-pkg-");
		const config = loadConfig({
			SIGRUN_MODEL: "openai/gpt-4o",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
		});
		const opened = await openHarness(config, {
			env: {},
			settingsDir: configDir,
			extensionSpecifiers: [
				pathToFileURL(
					join(import.meta.dirname, "fixtures", "fixture-ext", "index.js"),
				).href,
			],
		});
		try {
			expect(
				opened.registry.snapshot().extension("sigrun.fixture-ext"),
			).toBeDefined();
			expect(opened.extensionOutcomes).toEqual([
				{ name: "sigrun.fixture-ext", status: "ok" },
			]);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	}, 60_000);
});

describe("settings.packages validation", () => {
	// The settings-level assertions live with the store tests in
	// test/settings.test.ts style: parse-through SettingsStore.
	test("packages must be an array of non-empty strings", async () => {
		const { SettingsStore, SettingsValidationError } = await import(
			"../src/harness/settings.js"
		);
		const dir = freshDir("sigrun-settings-");
		const store = new SettingsStore({ dir });
		writeFileSync(
			join(dir, "settings.json"),
			'{"packages": "sigrun-ext-approvals"}',
			"utf8",
		);
		expect(() => store.read()).toThrow(SettingsValidationError);
		writeFileSync(
			join(dir, "settings.json"),
			'{"packages": ["ok", ""]}',
			"utf8",
		);
		expect(() => store.read()).toThrow(/packages/);
		writeFileSync(
			join(dir, "settings.json"),
			'{"packages": ["sigrun-ext-approvals@^0.1.0"]}',
			"utf8",
		);
		expect(store.read().packages).toEqual(["sigrun-ext-approvals@^0.1.0"]);
		// PATCH round-trips wholesale (arrays replace, null clears), and the
		// bootstrap never seeds the key.
		store.update({ packages: ["a@^1", "@scope/b"] });
		expect(store.read().packages).toEqual(["a@^1", "@scope/b"]);
		store.update({ packages: ["c"] });
		expect(store.read().packages).toEqual(["c"]);
		store.update({ packages: null });
		expect(store.read().packages).toBeUndefined();
	});
});

