/**
 * Task 3 (build-and-webui): the core builds to a runnable `dist/`.
 *
 * `npm run build` compiles src → dist (the `sigrun` bin and the deploy
 * entry become PLAIN NODE entrypoints — no tsx), the package manifest
 * ships the built tree (`dist` + `webui/dist`, source dropped), the
 * DEFAULT webui bundle resolves from the PACKAGE ROOT (an installed CLI
 * run from any cwd finds its shipped bundle), and a `.ts` extension
 * entry no longer resolves implicitly (BREAKING: npm/git/path sources
 * must ship built entries — a `.ts` entry quarantines with a clear
 * error under plain node).
 *
 * The spawn tests boot the BUILT `dist/cli.js` under the repo's node
 * binary in a hermetic tmpdir env (the deploy-entry pattern: a model
 * that is never called, storage/workspace/config under tmpdir, nothing
 * inherited but PATH/HOME — the built server never touches user state).
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { webuiBundleDir } from "../src/server/static.js";
import { findExtEntry } from "../src/harness/packages.js";

/** Repo root (test/ → ..): where `npm run build` emits dist/. */
const REPO_ROOT = realpathSync(join(import.meta.dirname, ".."));

/** Run the root build (the real script: the shared workspace build, then
 * the root tsc). Called per-test — a fresh tsc pass over unchanged
 * sources is cheap, and each test proves the CURRENT tree builds. */
function build(): void {
	execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
}

/** Reserve an OS-ephemeral port (listen 0, read the port, close). */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("no ephemeral port"));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

/** Minimal hermetic env for the built entry — nothing inherited but PATH/HOME. */
function childEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME,
		// W1 Task 3 spawned-process pattern: the env service token gets a
		// caller past the unclaimed setup gate; requests send it as Bearer.
		SIGRUN_API_TOKEN: "sgr_test_env",
		...overrides,
	};
}

/** The Bearer header every spawned-entry request sends (W1 Task 3). */
const SERVICE_BEARER = { authorization: "Bearer sgr_test_env" };

interface BuiltEntry {
	child: ReturnType<typeof spawn>;
	exited: Promise<{ code: number | null }>;
	listening: Promise<number>;
	getStderr(): string;
}

/** Spawn the built CLI (`node dist/cli.js serve`) and resolve once it
 * prints its listening line — from an ARBITRARY cwd (the installed-CLI
 * shape: nothing may resolve against the repo). */
function spawnBuiltCli(args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): BuiltEntry {
	const child = spawn(process.execPath, [join(REPO_ROOT, "dist", "cli.js"), ...args], {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const exited = new Promise<{ code: number | null }>((resolve) => {
		child.on("exit", (code) => resolve({ code }));
	});
	const listening = new Promise<number>((resolve, reject) => {
		const startedAt = Date.now();
		const poll = (): void => {
			const match = /listening on http:\/\/(?:\[[^\]]*\]|[^:\/]+):(\d+)/.exec(stdout);
			if (match) {
				resolve(Number(match[1]));
				return;
			}
			if (Date.now() - startedAt > 30_000) {
				reject(new Error(`entry never reported listening; stdout=${stdout}; stderr=${stderr}`));
				return;
			}
			void exited.then(() =>
				reject(new Error(`entry exited before listening; code=${child.exitCode}; stderr=${stderr}`)),
			);
			setTimeout(poll, 100);
		};
		poll();
	});
	return { child, exited, listening, getStderr: () => stderr };
}

// ---------------------------------------------------------------------------
// The build itself
// ---------------------------------------------------------------------------

describe("npm run build", () => {
	test("emits dist/cli.js and dist/index.js (node entrypoints, bin shebang)", () => {
		rmSync(join(REPO_ROOT, "dist"), { recursive: true, force: true });
		build();
		expect(existsSync(join(REPO_ROOT, "dist", "cli.js"))).toBe(true);
		expect(existsSync(join(REPO_ROOT, "dist", "index.js"))).toBe(true);
		// The bin's shebang survives the compile (npm bin executables exec
		// the file directly — no shebang, no bin).
		const head = readFileSync(join(REPO_ROOT, "dist", "cli.js"), "utf8");
		expect(head.startsWith("#!/usr/bin/env node")).toBe(true);
	}, 120_000);

	test("node dist/cli.js serve boots with no tsx (arbitrary cwd)", async () => {
		build();
		const dir = await mkdtemp(join(tmpdir(), "sigrun-build-serve-"));
		const port = await freePort();
		// cwd = the tmpdir: the installed-CLI shape — nothing resolves
		// against the repo, and tsx is nowhere in the invocation.
		const entry = spawnBuiltCli(
			["serve"],
			childEnv({
				SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
				OPENAI_API_KEY: "smoke-test-key-never-sent",
				OPENAI_BASE_URL: "http://127.0.0.1:9",
				SIGRUN_PORT: String(port),
				SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
				SIGRUN_WORKSPACE_PATH: dir,
				SIGRUN_CONFIG_DIR: join(dir, "config"),
				// HOME keeps the durable roots hermetic: the gateway
				// built-in's start-time state-dir mkdir would otherwise
				// land under the operator's real ~/.local/state/sigrun.
				HOME: dir,
			}),
			dir,
		);
		try {
			expect(await entry.listening).toBe(port);
			const response = await fetch(`http://127.0.0.1:${port}/healthz`);
			expect(response.status).toBe(200);
		} finally {
			entry.child.kill("SIGTERM");
			const exit = await entry.exited;
			expect(exit.code).toBe(0);
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);
});

// ---------------------------------------------------------------------------
// The packaging surface
// ---------------------------------------------------------------------------

describe("the package manifest ships the built tree", () => {
	test("bin → dist/cli.js; files carry dist + webui/dist, no source", () => {
		const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
			bin?: Record<string, string>;
			files?: string[];
			optionalDependencies?: Record<string, string>;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			scripts?: Record<string, string>;
		};
		expect(manifest.bin?.sigrun).toBe("dist/cli.js");
		expect(manifest.files).toContain("dist");
		expect(manifest.files).toContain("webui/dist");
		// Source ships NO LONGER: the tarball is the built tree.
		expect(manifest.files).not.toContain("src");
		expect(manifest.files).not.toContain("webui/src");
		// The tui is OPTIONAL (server-only installs must work) and tsx is
		// dev-only (production runs plain node).
		expect(manifest.optionalDependencies?.["@sigrun/tui"]).toBeDefined();
		expect(manifest.devDependencies?.tsx).toBeDefined();
		expect(manifest.dependencies?.tsx).toBeUndefined();
		expect(manifest.scripts?.prepublishOnly).toMatch(/build/);
	});

	test("runs the CLI when invoked through a symlinked .bin entry (regression)", () => {
		// npm bin entries are SYMLINKS (…/.bin/sigrun → dist/cli.js). Node
		// realpaths the main module (import.meta.url is the REAL path) while
		// process.argv[1] keeps the INVOKED symlink path — a raw comparison
		// mismatches, main never runs, and the bin exits 0 SILENTLY (the
		// published bin's canonical invocation — the same class T2 fixed in
		// the tui). Spawn through a symlink and prove main ran: the unknown
		// flag prints usage and exits 1, which only happens if the entry
		// detection matched.
		build();
		const dir = mkdtempSync(join(tmpdir(), "sigrun-bin-"));
		try {
			const link = join(dir, "sigrun");
			symlinkSync(join(REPO_ROOT, "dist", "cli.js"), link);
			const result = spawnSync(process.execPath, [link, "--nonsense"], {
				encoding: "utf8",
			});
			// Silent exit 0 (status 0, empty stderr) is the regression.
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("unknown argument");
			expect(result.stderr).toContain("usage: sigrun");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});

// ---------------------------------------------------------------------------
// The default webui bundle anchors to the package root
// ---------------------------------------------------------------------------

describe("the default webui bundle resolves from the package root", () => {
	test("regardless of cwd; explicit paths stay cwd-relative", () => {
		const expected = join(REPO_ROOT, "webui", "dist");
		const prev = process.cwd();
		const elsewhere = mkdtempSync(join(tmpdir(), "sigrun-bundle-cwd-"));
		try {
			process.chdir(elsewhere);
			const config = loadConfig({ SIGRUN_DEFAULT_MODEL: "openai/gpt-4o" });
			expect(config.webui.bundle).toBeUndefined();
			// The DEFAULT anchors to the package that ships the bundle —
			// never the process cwd.
			expect(webuiBundleDir(config)).toBe(expected);
			// An EXPLICIT path means what the operator wrote: cwd-relative.
			// ("bundles/ui" contains a slash — a PATH selector, not a name.)
			const explicit = loadConfig({
				SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
				SIGRUN_WEBUI_BUNDLE: "bundles/ui",
			});
			expect(explicit.webui.bundle).toBe("bundles/ui");
			expect(webuiBundleDir(explicit)).toBe(join(elsewhere, "bundles/ui"));
			// A value EQUAL to the default is the bootstrap's own mirror of
			// the default — it stays default-anchored (second boots keep the
			// package-root anchor and the API-only fallback); an operator
			// wanting cwd-relative writes a different path.
			const mirrored = loadConfig(
				{ SIGRUN_DEFAULT_MODEL: "openai/gpt-4o" },
			{ server: { webuiBundle: "webui/dist" } },
			);
			expect(mirrored.webui.bundle).toBe("webui/dist");
			expect(webuiBundleDir(mirrored)).toBe(expected);
		} finally {
			process.chdir(prev);
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// .ts extension entries no longer resolve
// ---------------------------------------------------------------------------

describe("a .ts extension entry is a clear error (no implicit fallback)", () => {
	test("a git checkout with only index.ts discovers no entry (the sync decides)", () => {
		// W5 Task 4 (spec §9.4): findExtEntry returns undefined for a
		// .ts-only checkout — the CALLER downgrades to skills-only when the
		// package declared skills, else keeps today's loud throw (the
		// sync-level contract is covered in test/packages.test.ts: "declares
		// neither" → GitSyncError, skills-only → ok).
		const bare = mkdtempSync(join(tmpdir(), "sigrun-tsentry-"));
		try {
			writeFileSync(join(bare, "index.ts"), "export default 1;\n");
			expect(findExtEntry(bare, undefined)).toBeUndefined();
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	test("a .ts-entry extension quarantines with a clear error under plain node", async () => {
		// The built server runs under PLAIN node: importing a .ts entry
		// fails (ERR_UNKNOWN_FILE_EXTENSION) and the loader QUARANTINES —
		// boot continues, and /v1/meta surfaces the quarantine.
		build();
		const dir = await mkdtemp(join(tmpdir(), "sigrun-build-ts-"));
		const configDir = join(dir, "config");
		await mkdir(configDir, { recursive: true });
		const tsEntry = join(dir, "ext-entry.ts");
		await writeFile(
			tsEntry,
			"export default () => ({ extension: { name: \"ts-fixture\" } });\n",
			"utf8",
		);
		await writeFile(
			join(configDir, "settings.json"),
			// builtins off via settings (the spawn-world equivalent of
			// openHarness's `builtins: false`): this test asserts ONE
			// quarantined extension row, not the built-in surface.
			JSON.stringify({
				extensions: [tsEntry],
				builtinExtensions: {
				codemode: false,
				mcp: false,
				toolSearch: false,
				gateway: false,
			},
			}) + "\n",
			"utf8",
		);
		const port = await freePort();
		const entry = spawnBuiltCli(
			["serve"],
			childEnv({
				SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
				OPENAI_API_KEY: "smoke-test-key-never-sent",
				OPENAI_BASE_URL: "http://127.0.0.1:9",
				SIGRUN_PORT: String(port),
				SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
				SIGRUN_WORKSPACE_PATH: dir,
				SIGRUN_CONFIG_DIR: configDir,
			}),
			dir,
		);
		try {
			// Boot SURVIVED the quarantine (the loader never throws).
			expect(await entry.listening).toBe(port);
			const meta = (await (
				await fetch(`http://127.0.0.1:${port}/v1/meta`, {
					headers: SERVICE_BEARER,
				})
			).json()) as {
				extensions: readonly { name: string; status: string; error?: string }[];
			};
			expect(meta.extensions).toHaveLength(1);
			expect(meta.extensions[0]?.status).toBe("quarantined");
			// The error names the entry (node's unknown-extension failure).
			expect(meta.extensions[0]?.error).toContain("ext-entry.ts");
		} finally {
			entry.child.kill("SIGTERM");
			const exit = await entry.exited;
			expect(exit.code).toBe(0);
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);
});
