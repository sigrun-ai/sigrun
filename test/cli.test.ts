/**
 * Task 5: the CLI entrypoints — `sigrun` / `sigrun serve` / `sigrun attach`.
 *
 * Unit tests only: parseArgs is a pure function, and the three command
 * behaviors are tested through the CLI's injected dependency seams
 * (boot/serve/launchTui factories) — no real process, port, or terminal
 * is launched here (the deploy-entry test owns the real process boot;
 * `npm start` still runs src/index.ts unchanged).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	cliMain,
	loadTuiFile,
	parseArgs,
	parsePort,
	USAGE_TEXT,
	USAGE_ERROR_PATTERN,
	type CliDeps,
} from "../src/cli.js";

const tmpDirs: string[] = [];

afterEach(async () => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	}
});

async function tmpConfigDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-cli-"));
	tmpDirs.push(dir);
	return dir;
}

describe("parsePort (D1)", () => {
	test("absent/empty → undefined (the localhost default applies)", () => {
		expect(parsePort(undefined)).toBeUndefined();
		expect(parsePort("")).toBeUndefined();
	});

	test("a positive integer parses", () => {
		expect(parsePort("4444")).toBe(4444);
	});

	test("non-integers and non-positives fail loud naming the variable", () => {
		expect(() => parsePort("abc")).toThrowError(/SIGRUN_PORT/);
		expect(() => parsePort("-1")).toThrowError(/SIGRUN_PORT/);
		expect(() => parsePort("3.5")).toThrowError(/SIGRUN_PORT/);
	});
});

describe("script detection (A7)", () => {
	test("cli.ts's own file resolves to its module URL (the entry case matches)", () => {
		// The detection is import.meta.url === pathToFileURL(argv[1]).href;
		// the hermetic check feeds cli.ts's own path as argv[1].
		const cliUrl = new URL("../src/cli.ts", import.meta.url);
		expect(pathToFileURL(cliUrl.pathname).href).toBe(cliUrl.href);
	});

	test("an unrelated argv path does NOT match (imported, not invoked)", () => {
		const cliUrl = new URL("../src/cli.ts", import.meta.url);
		expect(pathToFileURL("/some/other/tool.ts").href).not.toBe(cliUrl.href);
	});
});

describe("parseArgs", () => {
	test("bare → run (the default command)", () => {
		expect(parseArgs([])).toEqual({ command: "run" });
	});

	test("serve → the serve command", () => {
		expect(parseArgs(["serve"])).toEqual({ command: "serve" });
	});

	test("attach --server <url> → attach with the explicit server", () => {
		expect(parseArgs(["attach", "--server", "https://sigrun.example"]))
			.toEqual({ command: "attach", server: "https://sigrun.example" });
	});

	test("attach with no flags carries no server (the localhost default resolves later, env-aware)", () => {
		expect(parseArgs(["attach"])).toEqual({ command: "attach" });
	});

	test("attach --user carries the identity override", () => {
		expect(parseArgs(["attach", "--user", "acme-user"])).toEqual({
			command: "attach",
			user: "acme-user",
		});
	});

	test("run accepts the identity flag too (the in-process client's user)", () => {
		expect(parseArgs(["--user", "acme-user"])).toEqual({
			command: "run",
			user: "acme-user",
		});
	});

	test("unknown subcommand → usage error naming the usage", () => {
		expect(() => parseArgs(["bogus"])).toThrowError(USAGE_ERROR_PATTERN);
	});

	test("a flag without a value fails loud", () => {
		expect(() => parseArgs(["attach", "--server"])).toThrowError(USAGE_ERROR_PATTERN);
		expect(() => parseArgs(["--user"])).toThrowError(USAGE_ERROR_PATTERN);
	});

	test("unknown flags fail loud (a typo must not silently boot run)", () => {
		expect(() => parseArgs(["--bogus"])).toThrowError(USAGE_ERROR_PATTERN);
	});
});

describe("loadTuiFile", () => {
	test("absent config dir → empty file", async () => {
		expect(await loadTuiFile({})).toEqual({});
	});

	test("absent tui.json → empty file", async () => {
		const dir = await tmpConfigDir();
		expect(await loadTuiFile({ SIGRUN_CONFIG_DIR: dir })).toEqual({});
	});

	test("present tui.json → its user/server fields", async () => {
		const dir = await tmpConfigDir();
		await writeFile(
			join(dir, "tui.json"),
			JSON.stringify({ user: "acme-user", server: "https://tui.example" }),
			"utf8",
		);
		expect(await loadTuiFile({ SIGRUN_CONFIG_DIR: dir })).toEqual({
			user: "acme-user",
			server: "https://tui.example",
		});
	});

	test("a malformed tui.json fails loud (same posture as settings.json)", async () => {
		const dir = await tmpConfigDir();
		await writeFile(join(dir, "tui.json"), "{not json", "utf8");
		await expect(
			loadTuiFile({ SIGRUN_CONFIG_DIR: dir }),
		).rejects.toThrowError(/tui\.json/);
	});

	test("a non-object tui.json fails loud", async () => {
		const dir = await tmpConfigDir();
		await writeFile(join(dir, "tui.json"), JSON.stringify([1, 2]), "utf8");
		await expect(
			loadTuiFile({ SIGRUN_CONFIG_DIR: dir }),
		).rejects.toThrowError(/tui\.json/);
	});
});

/** A deps stub: factories record their calls, never boot anything real. */
function stubDeps(overrides: Partial<CliDeps> = {}): {
	deps: CliDeps;
	calls: {
		serve: { env: NodeJS.ProcessEnv }[];
		boot: { env: NodeJS.ProcessEnv; host?: string }[];
		launchTui: { baseUrl: string; user?: string }[];
		shutdown: number;
	};
} {
	const calls = {
		serve: [] as { env: NodeJS.ProcessEnv }[],
		boot: [] as { env: NodeJS.ProcessEnv; host?: string }[],
		launchTui: [] as { baseUrl: string; user?: string }[],
		shutdown: 0,
	};
	const deps: CliDeps = {
		serve: async (env) => {
			calls.serve.push({ env });
		},
		boot: async (env, options) => {
			calls.boot.push({ env, ...(options?.host === undefined ? {} : { host: options.host }) });
			const shutdownOnce = async (): Promise<void> => {
				calls.shutdown += 1;
			};
			return { port: 4321, shutdown: shutdownOnce, shutdownOnce };
		},
		launchTui: async (options) => {
			calls.launchTui.push(options);
		},
		...overrides,
	};
	return { deps, calls };
}

describe("cliMain serve", () => {
	test("delegates to the deploy boot (serve IS index.ts's composition)", async () => {
		const { deps, calls } = stubDeps();
		const env = { SIGRUN_DEFAULT_MODEL: "acme/model-1" };
		const code = await cliMain(["serve"], env, deps);
		expect(code).toBe(0);
		expect(calls.serve).toEqual([{ env }]);
		expect(calls.boot).toEqual([]);
		expect(calls.launchTui).toEqual([]);
	});
});

describe("cliMain run", () => {
	test("boots harness+server in-process, then launches the TUI against the bound port", async () => {
		const { deps, calls } = stubDeps();
		const code = await cliMain(["run"], { SIGRUN_DEFAULT_MODEL: "acme/model-1" }, deps);
		expect(code).toBe(0);
		expect(calls.boot).toHaveLength(1);
		expect(calls.serve).toEqual([]);
		expect(calls.launchTui).toEqual([
			{ baseUrl: "http://localhost:4321", user: undefined },
		]);
	});

	test("run binds loopback only (the workstation ruling) while serve keeps the container default", async () => {
		const { deps, calls } = stubDeps();
		await cliMain(["run"], { SIGRUN_DEFAULT_MODEL: "acme/model-1" }, deps);
		// Fix wave F3: the naive-identity API must not answer the LAN in
		// workstation mode; the TUI dials loopback, so loopback is all it needs.
		expect(calls.boot).toEqual([
			{ env: { SIGRUN_DEFAULT_MODEL: "acme/model-1" }, host: "127.0.0.1" },
		]);
		// `serve` carries no host override: the 0.0.0.0 default stands (the
		// serve command calls the serve dep, which never takes a host).
		expect(calls.serve).toEqual([]);
		const serveDeps = stubDeps();
		await cliMain(["serve"], { SIGRUN_DEFAULT_MODEL: "acme/model-1" }, serveDeps.deps);
		expect(serveDeps.calls.serve).toEqual([
			{ env: { SIGRUN_DEFAULT_MODEL: "acme/model-1" } },
		]);
		expect(serveDeps.calls.boot).toEqual([]);
	});

	test("the agent dies with the TUI: launchTui's return triggers one shutdown", async () => {
		const { deps, calls } = stubDeps();
		await cliMain([], {}, deps);
		expect(calls.shutdown).toBe(1);
	});

	test("run-mode signal: shutdown AND exit(0) fire (fix wave A8 — the TUI never outlives its server)", async () => {
		const exitCalls: number[] = [];
		const { deps, calls } = stubDeps({
			// The TUI never exits on its own: the signal is the only way down.
			launchTui: () => new Promise<void>(() => {}),
			exit: (code) => {
				exitCalls.push(code);
				return undefined as never;
			},
		});
		// Capture the SIGTERM listener cliMain installs (the run case wires
		// process.on("SIGTERM", stop)); invoking it directly is the signal.
		const onSpy = vi.spyOn(process, "on");
		const run = cliMain([], {}, deps);
		// cliMain is now mid-launchTui (pending): find and fire its SIGTERM stop.
		await vi.waitFor(() => {
			expect(calls.boot).toHaveLength(1);
		});
		const sigterm = onSpy.mock.calls.find(
			([event]) => event === "SIGTERM",
		)?.[1] as (() => void) | undefined;
		expect(sigterm).toBeDefined();
		onSpy.mockRestore();
		sigterm!();
		// shutdownOnce resolves asynchronously; the exit seam follows it.
		await vi.waitFor(() => {
			expect(exitCalls).toContain(0);
		});
		expect(calls.shutdown).toBeGreaterThanOrEqual(1);
		// cliMain's own promise stays pending (the TUI never returned) — the
		// exit seam is what retires the process, per the ruling.
		void run;
	});

	test("carries --user into the TUI launch", async () => {
		const { deps, calls } = stubDeps();
		await cliMain(["--user", "acme-user"], {}, deps);
		expect(calls.launchTui).toEqual([
			{ baseUrl: "http://localhost:4321", user: "acme-user" },
		]);
	});

	test("SIGRUN_USER is the run user's fallback", async () => {
		const { deps, calls } = stubDeps();
		await cliMain([], { SIGRUN_USER: "acme-env-user" }, deps);
		expect(calls.launchTui).toEqual([
			{ baseUrl: "http://localhost:4321", user: "acme-env-user" },
		]);
	});

	test("a launchTui failure shuts the booted server down (never leaves it serving)", async () => {
		const { deps, calls } = stubDeps({
			launchTui: async () => {
				throw new Error("no tty");
			},
		});
		const code = await cliMain([], {}, deps);
		expect(code).toBe(1);
		expect(calls.shutdown).toBe(1);
	});
});

describe("cliMain attach", () => {
	test("explicit --server wins, carrying --user", async () => {
		const { deps, calls } = stubDeps();
		const code = await cliMain(
			["attach", "--server", "https://sigrun.example", "--user", "acme-user"],
			{},
			deps,
		);
		expect(code).toBe(0);
		expect(calls.launchTui).toEqual([
			{ baseUrl: "https://sigrun.example", user: "acme-user" },
		]);
		expect(calls.boot).toEqual([]);
		expect(calls.serve).toEqual([]);
	});

	test("bare attach defaults to localhost on SIGRUN_PORT (3000 default)", async () => {
		const { deps, calls } = stubDeps();
		await cliMain(["attach"], {}, deps);
		expect(calls.launchTui).toEqual([
			{ baseUrl: "http://localhost:3000", user: undefined },
		]);
	});

	test("SIGRUN_PORT shapes the attach default", async () => {
		const { deps, calls } = stubDeps();
		await cliMain(["attach"], { SIGRUN_PORT: "4444" }, deps);
		expect(calls.launchTui[0]?.baseUrl).toBe("http://localhost:4444");
	});

	test("an invalid SIGRUN_PORT fails loud (exit 1), naming the variable", async () => {
		const { deps, calls } = stubDeps();
		const code = await cliMain(["attach"], { SIGRUN_PORT: "abc" }, deps);
		expect(code).toBe(1);
		expect(calls.launchTui).toEqual([]);
	});

	test("user precedence: --user > SIGRUN_USER > tui.json", async () => {
		const dir = await tmpConfigDir();
		await writeFile(
			join(dir, "tui.json"),
			JSON.stringify({ user: "acme-file-user", server: "https://file.example" }),
			"utf8",
		);
		const env = { SIGRUN_CONFIG_DIR: dir, SIGRUN_USER: "acme-env-user" };

		const fromFlag = stubDeps();
		await cliMain(["attach", "--user", "acme-flag-user"], env, fromFlag.deps);
		expect(fromFlag.calls.launchTui[0]?.user).toBe("acme-flag-user");

		const fromEnv = stubDeps();
		await cliMain(["attach"], env, fromEnv.deps);
		expect(fromEnv.calls.launchTui[0]?.user).toBe("acme-env-user");

		const fromFile = stubDeps();
		await cliMain(["attach"], { SIGRUN_CONFIG_DIR: dir }, fromFile.deps);
		expect(fromFile.calls.launchTui[0]?.user).toBe("acme-file-user");
	});

	test("server precedence: --server > tui.json server > localhost default", async () => {
		const dir = await tmpConfigDir();
		await writeFile(
			join(dir, "tui.json"),
			JSON.stringify({ server: "https://file.example" }),
			"utf8",
		);

		const fromFlag = stubDeps();
		await cliMain(
			["attach", "--server", "https://flag.example"],
			{ SIGRUN_CONFIG_DIR: dir },
			fromFlag.deps,
		);
		expect(fromFlag.calls.launchTui[0]?.baseUrl).toBe("https://flag.example");

		const fromFile = stubDeps();
		await cliMain(["attach"], { SIGRUN_CONFIG_DIR: dir }, fromFile.deps);
		expect(fromFile.calls.launchTui[0]?.baseUrl).toBe("https://file.example");
	});
});

describe("cliMain usage errors", () => {
	test("unknown subcommand prints usage and resolves 1 (never boots)", async () => {
		const { deps, calls } = stubDeps();
		const printed: string[] = [];
		const code = await cliMain(["bogus"], {}, deps, {
			error: (text) => {
				printed.push(text);
			},
		});
		expect(code).toBe(1);
		expect(printed.join("\n")).toContain(USAGE_TEXT.trim().split("\n")[0] ?? "");
		expect(calls.boot).toEqual([]);
		expect(calls.serve).toEqual([]);
		expect(calls.launchTui).toEqual([]);
	});
});
