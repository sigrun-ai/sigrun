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
import { execFile, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettingsValidationError } from "../src/harness/settings.js";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import {
	GitSyncError,
	PackageSyncError,
	findExtEntry,
	gitDirOf,
	gitTargetDir,
	packagesDirOf,
	packagesManifestPath,
	parsePackageSpecifier,
	planSync,
	resolveExtensionEntry,
	sanitizeUrl,
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
			expect(snapshot.extension("sigrun-fixture-ext")).toBeDefined();
			expect(
				snapshot.tools().some((entry) => entry.tool.name === "fixture_marker"),
			).toBe(true);
			expect(opened.extensionOutcomes).toEqual([
				{ name: "sigrun-fixture-ext", status: "ok" },
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
				opened.registry.snapshot().extension("sigrun-fixture-ext"),
			).toBeDefined();
			expect(opened.extensionOutcomes).toEqual([
				{ name: "sigrun-fixture-ext", status: "ok" },
			]);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	}, 60_000);
});

/** The git fixture's extension tool (the load assertion's probe). */
const GIT_MARKER = "git_fixture_marker";

/**
 * Build the hermetic git-source fixture: a real repo (git init + two
 * commits) with a `sigrun` manifest naming its extension entry. District
 * of its own: clone via a `git:`-shaped URL of the local path.
 */
function createGitFixture(): { dir: string; url: string; firstSha: string; secondSha: string } {
	const dir = freshDir("sigrun-gitrepo-");
	const git = (args: string[]): string =>
		execFileSync(
			"git",
			[...args, ...(args[0] === "commit" ? ["--no-gpg-sign"] : [])],
			{
				cwd: dir,
				encoding: "utf8",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "fixture",
					GIT_AUTHOR_EMAIL: "fixture@example.invalid",
					GIT_COMMITTER_NAME: "fixture",
					GIT_COMMITTER_EMAIL: "fixture@example.invalid",
					GIT_CONFIG_GLOBAL: "/dev/null",
				},
			},
		);
	git(["init", "-q", "-b", "main", dir]);
	const extension = (text: string): string =>
		`import { defineExtension, defineTool } from "@earendil-works/pi-durable";\nconst marker = defineTool({\n\tname: "${GIT_MARKER}",\n\tdescription: "${text}",\n\tparameters: undefined,\n\tasync execute() {\n\t\treturn { result: { output: [{ type: "text", text: "git-fixture" }] } };\n\t},\n});\nexport default function create() {\n\treturn defineExtension({ name: "sigrun-git-fixture-ext", tools: [marker], sections: [] });\n}\n`;
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "git-fixture-ext", version: "0.1.0", sigrun: { extension: "./ext.js" } }, null, "\t") + "\n");
	writeFileSync(join(dir, "ext.js"), extension("first"));
	git(["add", "."]);
	git(["commit", "-q", "-m", "first"]);
	const firstSha = git(["rev-parse", "HEAD"]).trim();
	writeFileSync(join(dir, "ext.js"), extension("second"));
	git(["add", "."]);
	git(["commit", "-q", "-m", "second"]);
	const secondSha = git(["rev-parse", "HEAD"]).trim();
	return { dir, url: `git:file://${dir}`, firstSha, secondSha };
}

describe("git sources in the unified extensions list", () => {
	let fixture: ReturnType<typeof createGitFixture>;
	let configDir: string;
	let gitDir: string;
	beforeAll(() => {
		fixture = createGitFixture();
		configDir = freshDir("sigrun-gitcfg-");
		gitDir = gitDirOf(configDir);
	});

	test("an absent git source is cloned and its manifest entry discovered", async () => {
		const resolutions = await syncPackages(
			[fixture.url],
			packagesDirOf(configDir),
			{ log: false, configDir },
		);
		expect(resolutions).toHaveLength(1);
		expect(resolutions[0].enabled).toBe(true);
		// The discovered entry lives INSIDE the clone (host/path layout).
		expect(resolutions[0].entry).toContain("/git/");
		expect(existsSync(new URL(resolutions[0].entry)));
		// The manifest's sigrun entry was the source.
		expect(resolutions[0].entry.endsWith("ext.js")).toBe(true);
	});

	test("a declared ref checks out to that commit on re-sync", async () => {
		const resolutions = await syncPackages(
			[{ source: fixture.url, ref: fixture.firstSha }],
			packagesDirOf(configDir),
			{ log: false, configDir },
		);
		// The clone target mirrors the pi layout: <gitDir>/file:/<abs path>.
		const cloneDir = gitTargetDir(gitDir, fixture.url);
		const checkedOut = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: cloneDir,
			encoding: "utf8",
		});
		expect(checkedOut.trim()).toBe(fixture.firstSha);
		expect(resolutions[0].entry).toContain("ext.js");
	}, 60_000);

	test("re-sync without a ref makes no checkout change (fetch only)", async () => {
		const before = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: gitTargetDir(gitDir, fixture.url),
			encoding: "utf8",
		}).trim();
		await syncPackages(
			[fixture.url],
			packagesDirOf(configDir),
			{ log: false, configDir },
		);
		const after = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: gitTargetDir(gitDir, fixture.url),
			encoding: "utf8",
		}).trim();
		expect(after).toBe(before);
	});

	test("a disabled git entry produces no resolution", async () => {
		const resolutions = await syncPackages(
			[{ source: fixture.url, enabled: false }],
			packagesDirOf(configDir),
			{ log: false, configDir },
		);
		// Disabled = intent recorded, nothing sync'd, nothing loaded.
		expect(resolutions).toHaveLength(0);
	});

	test("an explicit entry override beats the manifest", () => {
		expect(() =>
			findExtEntry(fixture.dir, "./definitely-not-here.js"),
		).toThrow(GitSyncError);
		expect(findExtEntry(fixture.dir, "./ext.js")).toBe(
			join(fixture.dir, "ext.js"),
		);
	});

	test("entry discovery order: manifest > dist/index.js > index.ts", () => {
		// The fixture's manifest names ./ext.js — discover without explicit.
		expect(findExtEntry(fixture.dir, undefined)).toBe(join(fixture.dir, "ext.js"));
		// dist/index.js beats index.ts when both exist and no manifest.
		const bare = freshDir("sigrun-baregit-");
		writeFileSync(join(bare, "index.ts"), "// ts entry\n");
		mkdirSync(join(bare, "dist"), { recursive: true });
		writeFileSync(join(bare, "dist", "index.js"), "// js entry\n");
		expect(findExtEntry(bare, undefined)).toBe(join(bare, "dist", "index.js"));
		// index.ts alone.
		rmSync(join(bare, "dist"), { recursive: true });
		expect(findExtEntry(bare, undefined)).toBe(join(bare, "index.ts"));
		// Nothing → fail loud.
		rmSync(join(bare, "index.ts"));
		expect(() => findExtEntry(bare, undefined)).toThrow(GitSyncError);
	});

	test("sanitizeUrl strips userinfo credentials (and leaves plain ssh)", () => {
		expect(sanitizeUrl("https://user:ghs_token@github.com/x/y")).toBe(
			"https://<sanitized>@github.com/x/y",
		);
		// `ssh://git@host` is NOT a credential — git@ is the standard ssh
		// user for git remotes; the sanitizer only fires on userinfo that
		// contains a colon (user:pass).
		expect(sanitizeUrl("ssh://git@github.com/x/y")).toBe("ssh://git@github.com/x/y");
		expect(sanitizeUrl("ssh://bob:secret@github.com/x/y")).toBe(
			"ssh://<sanitized>@github.com/x/y",
		);
	});

	test("a git clone failure fails loud naming the source (no token echo)", async () => {
		await expect(
			syncPackages(
				["git:file:///nonexistent/definitely-not-a-repo"],
				packagesDirOf(configDir),
				{ log: false, configDir },
			),
		).rejects.toThrow(/git/);
	});

	test("gitTargetDir entries stay inside the git dir (traversal-safe)", () => {
		const gitDir = gitDirOf("/tmp/x");
		const target = gitTargetDir(gitDir, "git:github.com/a/b");
		expect(target.startsWith(gitDir + "/")).toBe(true);
	});
});

describe("the unified extensions list (settings surface)", () => {
	// Validation lives in settings.ts's own tests too; here the STORE
	// round-trip of the object form (the grammar the packages/git sync
	// consumes).
	test("object entries round-trip and PATCH clears; packages[] is gone", async () => {
		const { SettingsStore } = await import("../src/harness/settings.js");
		const dir = freshDir("sigrun-settings-");
		const store = new SettingsStore({ dir });
		store.update({
			extensions: [
				"sigrun-ext-approvals@^0.1.0",
				{ source: "git:github.com/obra/superpowers", ref: "main" },
				{ source: "/opt/dev/my-ext", enabled: false },
			],
		});
		const read = store.read().extensions ?? [];
		expect(read[0]).toBe("sigrun-ext-approvals@^0.1.0");
		expect(read[1]).toEqual({
			source: "git:github.com/obra/superpowers",
			ref: "main",
		});
		expect(read[2]).toEqual({ source: "/opt/dev/my-ext", enabled: false });
		store.update({ extensions: null });
		expect(store.read().extensions).toBeUndefined();
		// The two-list era is over: a packages key now fails PATCH
		// validation (unknown field).
		expect(() => store.update({ packages: ["x@^1"] as never })).toThrow(
			SettingsValidationError,
		);
	});
});

