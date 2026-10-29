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
	/** The spawn options per call (the SIGRUN_TOKEN env assertion). */
	envs: (NodeJS.ProcessEnv | undefined)[];
	/** CliDeps with stub boot/serve, the fake child's spawn seam, and a
	 * stub bin resolver — cliMain's DEFAULT launchTui wiring (the spawn path
	 * under test) runs between them. */
	deps(overrides?: Partial<CliDeps>): CliDeps;
	shutdowns(): number;
}

function spawnRecorder(options?: {
	bin?: string;
	resolveTuiBinThrows?: boolean;
}): SpawnRecorder {
	const { bin, resolveTuiBinThrows } = options ?? {};
	const child = fakeChild();
	const spawns: { command: string; args: string[] }[] = [];
	const envs: (NodeJS.ProcessEnv | undefined)[] = [];
	let shutdowns = 0;
	const spawn: TuiSpawnFn = (command, args, spawnOptions) => {
		spawns.push({ command, args: [...args] });
		envs.push(spawnOptions?.env);
		return child;
	};
	const shutdownOnce = async (): Promise<void> => {
		shutdowns += 1;
	};
	const deps = (overrides: Partial<CliDeps> = {}): CliDeps => ({
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
		// Task 7: the onboarding GET defaults to a claimed server (the
		// SIGRUN_TOKEN tests override it with their own fetch stubs).
		fetch: (async () => ({
			ok: true,
			status: 200,
			json: () =>
				Promise.resolve({ state: "claimed", methods: [], codeRequired: false }),
		})) as CliDeps["fetch"],
		...(resolveTuiBinThrows
			? {
					resolveTuiBin: () => {
						throw new Error(
							"Cannot find module '@sigrun/tui/package.json' (mocked)",
						);
					},
				}
			: { resolveTuiBin: () => bin ?? "/resolved/node_modules/@sigrun/tui/dist/launch.js" }),
		...overrides,
	});
	return { child, spawns, envs, deps, shutdowns: () => shutdowns };
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

	test("run --user \"Mike Smith\" normalises to mike-smith on the child argv", async () => {
		const rec = spawnRecorder();
		const run = cliMain(
			["--user", "Mike Smith"],
			await hermeticEnv(),
			rec.deps(),
		);
		await vi.waitFor(() => {
			expect(rec.spawns).toHaveLength(1);
		});
		expect(rec.spawns[0]?.args).toEqual([
			"/resolved/node_modules/@sigrun/tui/dist/launch.js",
			"--server",
			"http://localhost:4321",
			"--user",
			"mike-smith",
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

describe("SIGRUN_TOKEN reaches the child via env, never argv (Task 7)", () => {
		/** The onboarding fetch/prompt stubs: unclaimed + code, one claim. */
		function onboardingStubs(): {
			deps: Partial<CliDeps>;
			claims: { body?: string }[];
		} {
			const claims: { body?: string }[] = [];
			const fetch = (async (
						_url: string,
						init?: { method?: string; body?: string },
			) => {
						if (init?.method === "POST") {
								claims.push({ body: init.body });
								return {
												ok: true,
												status: 200,
												json: () =>
														Promise.resolve({
																user: { user: "alice", admin: true, createdAt: 1, source: "cli" },
																token: "sgr_claimed_token",
														}),
										};
						}
						return {
								ok: true,
								status: 200,
								json: () =>
										Promise.resolve({ state: "unclaimed", methods: ["token"], codeRequired: true }),
						};
			}) as unknown as NonNullable<CliDeps["fetch"]>;
			const answers = ["ABCD-EFGH", "alice", "", ""];
			let next = 0;
			const prompt = async () => {
						const answer = answers[next] ?? "";
						next += 1;
						return answer;
			};
			return { deps: { fetch, prompt }, claims };
		}

		test("attach onboarding: the claimed token rides env SIGRUN_TOKEN, absent from argv", async () => {
			const rec = spawnRecorder();
			const stubs = onboardingStubs();
			const run = cliMain(
						["attach", "--server", "https://sigrun.example"],
						await hermeticEnv(),
						rec.deps(stubs.deps),
			);
			await vi.waitFor(() => {
						expect(rec.spawns).toHaveLength(1);
			});
			// The claim was made with issueToken (the fetch stub's POST body).
			expect(JSON.parse(stubs.claims[0]?.body ?? "{}")).toMatchObject({
						code: "ABCD-EFGH",
						user: "alice",
						issueToken: true,
			});
			// The child env carries the token; the argv NEVER does.
			expect(rec.envs[0]?.SIGRUN_TOKEN).toBe("sgr_claimed_token");
			expect(rec.spawns[0]?.args.join(" ")).not.toContain("sgr_claimed_token");
			rec.child.exit(0);
			expect(await run).toBe(0);
		});

		test("a tui.json token reaches the child env too (claimed server, no onboarding)", async () => {
			const dir = await mkdtemp(join(tmpdir(), "sigrun-cli-spawn-"));
			tmpDirs.push(dir);
			const { writeFile } = await import("node:fs/promises");
			await writeFile(
						join(dir, "tui.json"),
						JSON.stringify({ user: "acme-user", token: "sgr_file_token" }),
						"utf8",
			);
			const claims: unknown[] = [];
			const fetch = (async (
						_url: string,
						init?: { method?: string; body?: string },
			) => {
						if (init?.method === "POST") claims.push(init.body);
						return {
								ok: true,
								status: 200,
								json: () => Promise.resolve({ state: "claimed", methods: ["token"], codeRequired: false }),
						};
			}) as unknown as NonNullable<CliDeps["fetch"]>;
			const rec = spawnRecorder();
			const run = cliMain(
						["attach", "--server", "https://sigrun.example"],
						{ SIGRUN_CONFIG_DIR: dir },
						rec.deps({ fetch }),
			);
			await vi.waitFor(() => {
						expect(rec.spawns).toHaveLength(1);
			});
			expect(claims).toEqual([]); // claimed: no onboarding POST at all
			expect(rec.envs[0]?.SIGRUN_TOKEN).toBe("sgr_file_token");
			expect(rec.spawns[0]?.args.join(" ")).not.toContain("sgr_file_token");
			rec.child.exit(0);
			expect(await run).toBe(0);
		});

		test("no token anywhere: the spawn options carry no env override (inheritance)", async () => {
			const rec = spawnRecorder();
			const fetch = (async () => {
						return {
								ok: true,
								status: 200,
								json: () => Promise.resolve({ state: "claimed", methods: [], codeRequired: false }),
						};
			}) as unknown as NonNullable<CliDeps["fetch"]>;
			const run = cliMain(
						["attach", "--server", "https://sigrun.example"],
						await hermeticEnv(),
						rec.deps({ fetch }),
			);
			await vi.waitFor(() => {
						expect(rec.spawns).toHaveLength(1);
			});
			expect(rec.envs[0]).toBeUndefined();
			rec.child.exit(0);
			expect(await run).toBe(0);
		});
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
