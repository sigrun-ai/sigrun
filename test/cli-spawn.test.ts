/**
 * Task 2: the CLI spawns the TUI as a CHILD PROCESS — `node <resolved
 * @sigrun/tui bin>` — instead of importing tui/src/launch.ts in-process
 * (the in-process import coupled the core install to the tui workspace;
 * an installed core must be able to run server-only, spawning the TUI
 * only when the companion package is present).
 *
 * These tests drive the spawn seam through `cliMain` (fake `spawn` +
 * `resolveTuiBin` injected via CliDeps — the same dependency-injection
 * style test/cli.test.ts uses for boot/serve/launchTui):
 *
 * - `run` and `attach` spawn `process.execPath` + the resolved bin, with
 *   the resolved server URL and user on the child's argv;
 * - a package-resolution failure surfaces as the actionable
 *   "install @sigrun/tui" message (exit 1), not a module-not-found crash;
 * - the parent shuts the server down when the child exits (the
 *   agent-dies-with-tui lifecycle, now across the process boundary).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	cliMain,
	launchTuiProcess,
	resolveTuiBin,
	type CliDeps,
	type TuiChildProcess,
	type TuiSpawnFn,
} from "../src/cli.js";

const tmpDirs: string[] = [];

afterEach(async () => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	}
});

/** A hermetic env: an empty config dir (no tui.json to read). */
async function hermeticEnv(): Promise<NodeJS.ProcessEnv> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-cli-spawn-"));
	tmpDirs.push(dir);
	return { SIGRUN_CONFIG_DIR: dir };
}

/**
 * A fake child: records `exit`/`error` listeners so tests can retire
 * the child the way a real TUI process would (emit exit → the launch
 * resolves; emit error → the launch rejects — the spawn-failure path).
 */
function fakeChild(): TuiChildProcess & {
	exit(code: number | null): void;
	fail(error: Error): void;
} {
	const exits: ((code: number | null) => void)[] = [];
	const errors: ((error: Error) => void)[] = [];
	return {
		on: (event, listener) => {
			if (event === "exit") exits.push(listener as (code: number | null) => void);
			if (event === "error") errors.push(listener as (error: Error) => void);
		},
		kill: () => {},
		exit: (code) => {
			for (const listener of exits) listener(code);
		},
		fail: (error) => {
			for (const listener of errors) listener(error);
		},
	};
}

interface SpawnRecorder {
	child: ReturnType<typeof fakeChild>;
	spawns: { command: string; args: string[] }[];
/** CliDeps with stub boot/serve, the fake child's spawn seam, and a
	 * stub bin resolver — cliMain's DEFAULT launchTui wiring (the spawn path
	 * under test) runs between them. */
	deps(): CliDeps;
	shutdowns(): number;
}

function spawnRecorder(options?: {
	bin?: string;
	resolveTuiBinThrows?: boolean;
}): SpawnRecorder {
	const { bin, resolveTuiBinThrows } = options ?? {};
	const child = fakeChild();
	const spawns: { command: string; args: string[] }[] = [];
	let shutdowns = 0;
	const spawn: TuiSpawnFn = (command, args) => {
		spawns.push({ command, args: [...args] });
		return child;
	};
	const shutdownOnce = async (): Promise<void> => {
		shutdowns += 1;
	};
	const deps = (): CliDeps => ({
		serve: async () => {},
		boot: async () => ({
			port: 4321,
			shutdown: shutdownOnce,
			shutdownOnce,
		}),
		spawn,
		// launchTui is deliberately OMITTED: cliMain composes its DEFAULT
		// spawn wiring (launchTuiProcess + these injected seams) — the unit
		// under test is the argv composition and the child-exit lifecycle.
		...(resolveTuiBinThrows
			? {
					resolveTuiBin: () => {
						throw new Error(
							"Cannot find module '@sigrun/tui/package.json' (mocked)",
						);
					},
				}
			: { resolveTuiBin: () => bin ?? "/resolved/node_modules/@sigrun/tui/dist/launch.js" }),
	});
	return { child, spawns, deps, shutdowns: () => shutdowns };
}

describe("cliMain run/attach spawn the sigrun-tui bin", () => {
	test("run spawns node + the resolved bin with the loopback URL and user", async () => {
		const rec = spawnRecorder();
		const run = cliMain(["--user", "acme-user"], await hermeticEnv(), rec.deps());
		await vi.waitFor(() => {
			expect(rec.spawns).toHaveLength(1);
		});
		expect(rec.spawns[0]?.command).toBe(process.execPath);
		expect(rec.spawns[0]?.args).toEqual([
			"/resolved/node_modules/@sigrun/tui/dist/launch.js",
			"--server",
			"http://localhost:4321",
			"--user",
			"acme-user",
		]);
		rec.child.exit(0);
		expect(await run).toBe(0);
	});

	test("attach spawns node + the resolved bin against the --server URL", async () => {
		const rec = spawnRecorder();
		const run = cliMain(
			["attach", "--server", "https://sigrun.example", "--user", "acme-user"],
			await hermeticEnv(),
			rec.deps(),
		);
		await vi.waitFor(() => {
			expect(rec.spawns).toHaveLength(1);
		});
		expect(rec.spawns[0]?.command).toBe(process.execPath);
		expect(rec.spawns[0]?.args).toEqual([
			"/resolved/node_modules/@sigrun/tui/dist/launch.js",
			"--server",
			"https://sigrun.example",
			"--user",
			"acme-user",
		]);
		// attach boots no harness: the child exiting is the whole lifecycle.
		rec.child.exit(0);
		expect(await run).toBe(0);
		expect(rec.shutdowns()).toBe(0);
	});

	test("tui.json theme fields ride the child argv (palette/keymap/editor…)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-cli-spawn-"));
		tmpDirs.push(dir);
		const { writeFile } = await import("node:fs/promises");
		await writeFile(
			join(dir, "tui.json"),
			JSON.stringify({ palette: "birch-moss", keymap: "vim", editor: "vim" }),
			"utf8",
		);
		const rec = spawnRecorder();
		const run = cliMain(
			["attach"],
			{ SIGRUN_CONFIG_DIR: dir },
			rec.deps(),
		);
		await vi.waitFor(() => {
			expect(rec.spawns).toHaveLength(1);
		});
		rec.child.exit(0);
		expect(await run).toBe(0);
		expect(rec.spawns[0]?.args).toContain("--palette");
		expect(rec.spawns[0]?.args).toContain("birch-moss");
		expect(rec.spawns[0]?.args).toContain("--keymap");
		expect(rec.spawns[0]?.args).toContain("vim");
		expect(rec.spawns[0]?.args).toContain("--editor");
	});

	test("the parent shuts the server down when the tui child exits (agent-dies-with-tui)", async () => {
		const rec = spawnRecorder();
		const run = cliMain([], await hermeticEnv(), rec.deps());
		await vi.waitFor(() => {
			expect(rec.spawns).toHaveLength(1);
		});
		expect(rec.shutdowns()).toBe(0); // mid-TUI: still serving
		rec.child.exit(0);
		expect(await run).toBe(0);
		expect(rec.shutdowns()).toBe(1);
	});

	test("a nonzero child exit is an error AND still shuts the server down", async () => {
		const rec = spawnRecorder();
		const errors: string[] = [];
		const run = cliMain([], await hermeticEnv(), rec.deps(), {
			error: (text) => errors.push(text),
		});
		await vi.waitFor(() => {
			expect(rec.spawns).toHaveLength(1);
		});
		rec.child.exit(3);
		expect(await run).toBe(1);
		expect(rec.shutdowns()).toBe(1);
		expect(errors[0]).toMatch(/sigrun-tui/);
	});

	test("a spawn 'error' event rejects the launch (no unhandled crash)", async () => {
		// Spawn failures (ENOENT on the bin, EACCES) arrive as the child's
		// 'error' event, NOT an exit: without a listener node raises an
		// unhandled 'error' event and the CLI CRASHES instead of printing
		// the actionable message (the T2 review's carried finding).
		const rec = spawnRecorder();
		const errors: string[] = [];
		const run = cliMain(
			["attach", "--server", "http://localhost:3000"],
			await hermeticEnv(),
			rec.deps(),
			{ error: (text) => errors.push(text) },
		);
		await vi.waitFor(() => {
			expect(rec.spawns).toHaveLength(1);
		});
		rec.child.fail(new Error("spawn ENOENT"));
		expect(await run).toBe(1);
		expect(errors[0]).toMatch(/spawn ENOENT/);
	});

	test("a signal-killed child (code null) reports no exit code", async () => {
		const rec = spawnRecorder();
		const errors: string[] = [];
		const run = cliMain(
			["attach", "--server", "http://localhost:3000"],
			await hermeticEnv(),
			rec.deps(),
			{ error: (text) => errors.push(text) },
		);
		await vi.waitFor(() => {
			expect(rec.spawns).toHaveLength(1);
		});
		// A signal kill reports code === null (the exit listener's null
		// arm) — the message must name it, not print "null" or crash.
		rec.child.exit(null);
		expect(await run).toBe(1);
		expect(errors[0]).toMatch(/sigrun-tui exited with no exit code/);
	});
});

describe("a missing @sigrun/tui", () => {
	test("errors 'install @sigrun/tui' (exit 1), not a module-not-found crash", async () => {
		const rec = spawnRecorder({ resolveTuiBinThrows: true });
		const errors: string[] = [];
		const code = await cliMain(
			["attach", "--server", "http://localhost:3000"],
			await hermeticEnv(),
			rec.deps(),
			{ error: (text) => errors.push(text) },
		);
		expect(code).toBe(1);
		expect(rec.spawns).toHaveLength(0);
		// The message LEADS with the actionable install hint (a bare
		// module-not-found crash would start with "Cannot find module").
		expect(errors[0]).toMatch(
			/^sigrun: sigrun-tui is not installed; install @sigrun\/tui/,
		);
	});

	test("launchTuiProcess wraps ANY bin-resolution failure as the install hint", async () => {
		await expect(
			launchTuiProcess(
				{ baseUrl: "http://localhost:3000" },
				{
					resolveTuiBin: () => {
						throw new Error("boom");
					},
				},
			),
		).rejects.toThrow(/install @sigrun\/tui/);
	});
});

describe("the default bin resolver", () => {
	test("resolves the workspace @sigrun/tui bin through its exports map", () => {
		// In this repo the tui is a workspace dependency; the resolver must
		// find its manifest via "./package.json" (the exports entry the
		// spawn resolution needs) and join the declared bin.
		const bin = resolveTuiBin();
		expect(bin.endsWith(join("tui", "dist", "launch.js"))).toBe(true);
	});
});
