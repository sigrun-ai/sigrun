/**
 * Task 5: the CLI entrypoints — `sigrun` / `sigrun serve` / `sigrun attach`.
 *
 * Unit tests only: parseArgs is a pure function, and the three command
 * behaviors are tested through the CLI's injected dependency seams
 * (boot/serve/launchTui factories) — no real process, port, or terminal
 * is launched here (the deploy-entry test owns the real process boot;
 * `npm start` still runs src/index.ts unchanged).
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

	test("XDG tier resolves the config dir (one chain with the store roots)", async () => {
		// Spec Decision 3: defaultConfigDir delegates to resolveStoreRoots,
		// so XDG_CONFIG_HOME (set + SIGRUN_CONFIG_DIR unset) lands tui.json
		// under $XDG_CONFIG_HOME/sigrun — never a split from the stores.
		const dir = await tmpConfigDir();
		await mkdir(join(dir, "sigrun"), { recursive: true });
		await writeFile(
			join(dir, "sigrun", "tui.json"),
			JSON.stringify({ user: "acme-xdg-user" }),
			"utf8",
		);
		expect(await loadTuiFile({ XDG_CONFIG_HOME: dir })).toEqual({
			user: "acme-xdg-user",
		});
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

	test("UI refresh fields (palette/accent/mode/keymap/editor) round-trip", async () => {
		const dir = await tmpConfigDir();
		await writeFile(
				dir + "/tui.json",
			JSON.stringify({
					palette: "fjord",
				accent: "lichen",
				mode: "light",
				keymap: "vim",
				editor: "/usr/bin/nvim",
			}),
			"utf8",
		);
		expect(await loadTuiFile({ SIGRUN_CONFIG_DIR: dir })).toEqual({
			palette: "fjord",
			accent: "lichen",
			mode: "light",
			keymap: "vim",
			editor: "/usr/bin/nvim",
		});
	});

	test("an unknown palette fails loud naming the key", async () => {
		const dir = await tmpConfigDir();
		await writeFile(
			dir + "/tui.json",
			JSON.stringify({ palette: "nord" }),
			"utf8",
		);
		await expect(
			loadTuiFile({ SIGRUN_CONFIG_DIR: dir }),
		).rejects.toThrowError(
			/tui\.json: palette must be one of fjord, iron-ember, polar-night, birch-moss/,
		);
	});

	test("an unknown accent, mode, or keymap fails loud naming the key", async () => {
		const dir = await tmpConfigDir();
		await writeFile(
			dir + "/tui.json",
			JSON.stringify({ accent: "gold", mode: "sepia", keymap: "dvorak" }),
			"utf8",
		);
		await expect(
			loadTuiFile({ SIGRUN_CONFIG_DIR: dir }),
		).rejects.toThrowError(/tui\.json: accent must be one of/);
		await writeFile(dir + "/tui.json", JSON.stringify({ mode: "sepia" }), "utf8");
		await expect(
			loadTuiFile({ SIGRUN_CONFIG_DIR: dir }),
		).rejects.toThrowError(/tui\.json: mode must be one of dark, light/);
		await writeFile(dir + "/tui.json", JSON.stringify({ keymap: "dvorak" }), "utf8");
		await expect(
			loadTuiFile({ SIGRUN_CONFIG_DIR: dir }),
		).rejects.toThrowError(
				/tui\.json: keymap must be one of standard, vim, emacs/,
		);
	});

	test("a non-string editor fails loud", async () => {
		const dir = await tmpConfigDir();
		await writeFile(
			dir + "/tui.json",
			JSON.stringify({ editor: 42 }),
			"utf8",
		);
		await expect(
			loadTuiFile({ SIGRUN_CONFIG_DIR: dir }),
		).rejects.toThrowError(/tui\.json: editor must be a string/);
	});
});

/** A fetch stub answering a CLAIMED server — the stubDeps default so
 * the pre-Task-7 attach/run tests stay network-free and skip onboarding. */
const claimedFetch = (async () => ({
	ok: true,
	status: 200,
	json: () =>
		Promise.resolve({ state: "claimed", methods: [], codeRequired: false }),
})) as CliDeps["fetch"];

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
		// Task 7: the onboarding GET defaults to a claimed server (override
		// with an unclaimed stub for the onboarding-flow tests).
		fetch: claimedFetch,
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

describe("parseArgs: token/user subcommands (Task 7)", () => {
	test("token create <name> --user <u>", () => {
		expect(parseArgs(["token", "create", "laptop", "--user", "alice"])).toEqual({
			command: "token",
			sub: "create",
			tokenName: "laptop",
			user: "alice",
		});
	});

	test("token list", () => {
		expect(parseArgs(["token", "list"])).toEqual({ command: "token", sub: "list" });
	});

	test("token revoke <id>", () => {
		expect(parseArgs(["token", "revoke", "0f0e0d0c"])).toEqual({
			command: "token",
			sub: "revoke",
			id: "0f0e0d0c",
		});
	});

	test("token create without --user is a usage error", () => {
		expect(() => parseArgs(["token", "create", "laptop"]))
			.toThrowError(USAGE_ERROR_PATTERN);
	});

	test("token create without a name is a usage error", () => {
		expect(() => parseArgs(["token", "create", "--user", "alice"]))
			.toThrowError(USAGE_ERROR_PATTERN);
	});

	test("token with an unknown sub is a usage error", () => {
		expect(() => parseArgs(["token", "bogus"])).toThrowError(USAGE_ERROR_PATTERN);
	});

	test("token list rejects extra positionals", () => {
		expect(() => parseArgs(["token", "list", "extra"]))
			.toThrowError(USAGE_ERROR_PATTERN);
	});

	test("user add <user> with --admin/--name/--email", () => {
		expect(
			parseArgs([
				"user", "add", "alice", "--admin", "--name", "Alice MacLeod",
				"--email", "alice@example.invalid",
			]),
		).toEqual({
			command: "user",
			sub: "add",
			user: "alice",
			admin: true,
			name: "Alice MacLeod",
			email: "alice@example.invalid",
		});
	});

	test("user add bare (no flags)", () => {
		expect(parseArgs(["user", "add", "bob"])).toEqual({
			command: "user",
			sub: "add",
			user: "bob",
		});
	});

	test("user add --name without a value is a usage error", () => {
		expect(() => parseArgs(["user", "add", "bob", "--name"]))
			.toThrowError(USAGE_ERROR_PATTERN);
	});

	test("user add without a username is a usage error", () => {
		expect(() => parseArgs(["user", "add", "--admin"]))
			.toThrowError(USAGE_ERROR_PATTERN);
	});

	test("user list", () => {
		expect(parseArgs(["user", "list"])).toEqual({ command: "user", sub: "list" });
	});
});

/** A store-hermetic env: identity roots all inside the tmp config dir
 * (the CLI opens the stores over resolveStoreRoots(env) directly). */
function storeEnv(dir: string): NodeJS.ProcessEnv {
	return {
		SIGRUN_CONFIG_DIR: dir,
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
	};
}

/** An output capture: data lines (out) + error lines, as CliIO. */
function captureIo(): {
	out: string[];
	errors: string[];
	io: { out(text: string): void; error(text: string): void };
} {
	const out: string[] = [];
	const errors: string[] = [];
	return {
		out,
		errors,
		io: {
			out: (text) => {
				out.push(text);
			},
			error: (text) => {
				errors.push(text);
			},
		},
	};
}

describe("cliMain user/token subcommands (Task 7: stores directly, no server)", () => {
	test("user add creates the directory entry (users.json 0600, source cli)", async () => {
		const dir = await tmpConfigDir();
		const { io } = captureIo();
		const code = await cliMain(
			["user", "add", "alice", "--admin", "--name", "Alice", "--email", "alice@example.invalid"],
			storeEnv(dir),
			undefined,
			io,
		);
		expect(code).toBe(0);
		const raw = JSON.parse(await readFile(join(dir, "users.json"), "utf8"));
		expect(raw).toEqual([
			{
				user: "alice",
				name: "Alice",
				email: "alice@example.invalid",
				admin: true,
				createdAt: expect.any(Number),
				source: "cli",
			},
		]);
		const fileStat = await stat(join(dir, "users.json"));
		expect(fileStat.mode & 0o777).toBe(0o600);
	});

	test("user add without --admin lands non-admin; duplicates fail loud", async () => {
		const dir = await tmpConfigDir();
		const { errors, io } = captureIo();
		expect(
			await cliMain(["user", "add", "bob"], storeEnv(dir), undefined, io),
		).toBe(0);
		const raw = JSON.parse(await readFile(join(dir, "users.json"), "utf8"));
		expect(raw[0]).toMatchObject({ user: "bob", admin: false });
		// The duplicate is an error naming the user (exit 1).
		expect(
			await cliMain(["user", "add", "bob"], storeEnv(dir), undefined, io),
		).toBe(1);
		expect(errors.join("\n")).toMatch(/bob/);
	});

	test("user list prints the directory (user, admin marker, name, email)", async () => {
		const dir = await tmpConfigDir();
		const { out, io } = captureIo();
		await cliMain(
			["user", "add", "alice", "--admin", "--name", "Alice", "--email", "alice@example.invalid"],
			storeEnv(dir),
			undefined,
			io,
		);
		out.length = 0;
		expect(await cliMain(["user", "list"], storeEnv(dir), undefined, io)).toBe(0);
		const printed = out.join("\n");
		expect(printed).toContain("alice");
		expect(printed).toContain("Alice");
		expect(printed).toContain("alice@example.invalid");
});

	test("token create prints one sgr_ line; list shows the name without the secret; revoke removes it", async () => {
		const dir = await tmpConfigDir();
		const { out, errors, io } = captureIo();
		await cliMain(["user", "add", "alice"], storeEnv(dir), undefined, io);
		out.length = 0;

		expect(
			await cliMain(["token", "create", "laptop", "--user", "alice"], storeEnv(dir), undefined, io),
		).toBe(0);
		const lines = out.filter((line) => line.trim() !== "");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^sgr_/);
		const secret = lines[0] as string;

		// The store holds the digest, never the secret.
		const stored = JSON.parse(await readFile(join(dir, "api-tokens.json"), "utf8"));
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ name: "laptop", user: "alice" });
		expect(JSON.stringify(stored)).not.toContain(secret);

		out.length = 0;
		expect(await cliMain(["token", "list"], storeEnv(dir), undefined, io)).toBe(0);
		const listing = out.join("\n");
		expect(listing).toContain("laptop");
		expect(listing).toContain("alice");
		expect(listing).not.toContain(secret);

		const id = (stored[0] as { id: string }).id;
		expect(
			await cliMain(["token", "revoke", id], storeEnv(dir), undefined, io),
		).toBe(0);
		const after = JSON.parse(await readFile(join(dir, "api-tokens.json"), "utf8"));
		expect(after).toEqual([]);
		// Revoking an unknown id fails loud.
		errors.length = 0;
		expect(
			await cliMain(["token", "revoke", id], storeEnv(dir), undefined, io),
		).toBe(1);
		expect(errors.join("\n")).toMatch(/token/);
	});

	test("token create for an unknown user fails loud naming the user", async () => {
		const dir = await tmpConfigDir();
		const { errors, io } = captureIo();
		expect(
			await cliMain(["token", "create", "laptop", "--user", "ghost"], storeEnv(dir), undefined, io),
		).toBe(1);
		expect(errors.join("\n")).toMatch(/ghost/);
		// Nothing was minted.
		await expect(readFile(join(dir, "api-tokens.json"), "utf8")).rejects.toThrow();
	});
});

/** A scripted prompt seam: pops answers in order, records the questions. */
function scriptedPrompt(answers: string[]): {
	questions: string[];
	prompt: (question: string) => Promise<string>;
} {
	const questions: string[] = [];
	let next = 0;
	return {
		questions,
		prompt: (question) => {
			questions.push(question);
			const answer = answers[next];
			next += 1;
			if (answer === undefined) {
				return Promise.reject(new Error(`no scripted answer for "${question}"`));
			}
			return Promise.resolve(answer);
		},
	};
}

/** The onboarding fetch stub: GET answers the state; POST records the claim. */
function onboardingFetchStub(options?: {
	state?: "unclaimed" | "claimed";
	codeRequired?: boolean;
	claimStatus?: number;
	claimBody?: unknown;
	noToken?: boolean;
}): {
	fetch: NonNullable<CliDeps["fetch"]>;
	claims: { url: string; method?: string; body?: string }[];
} {
	const state = options?.state ?? "unclaimed";
	const claims: { url: string; method?: string; body?: string }[] = [];
	const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
		if (init?.method === "POST") {
			claims.push({ url, method: init.method, body: init.body });
			const status = options?.claimStatus ?? 200;
			const body =
				options?.claimBody ??
				(options?.noToken === true
					? { user: { user: "alice", admin: true, createdAt: 1, source: "cli" } }
					: {
							user: { user: "alice", admin: true, createdAt: 1, source: "cli" },
							token: "sgr_claimed_token",
						});
			return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
		}
		return {
			ok: true,
			status: 200,
			json: () =>
				Promise.resolve({
					state,
					methods: ["token"],
					codeRequired: options?.codeRequired ?? true,
				}),
		};
	}) as NonNullable<CliDeps["fetch"]>;
	return { fetch: fetchImpl, claims };
}

describe("cliMain attach: the onboarding prompt flow (Task 7)", () => {
	test("unclaimed → prompts code/username/name/email, claims with issueToken, writes tui.json (0600), launches with the token", async () => {
		const dir = await tmpConfigDir();
		const { prompt, questions } = scriptedPrompt([
			"ABCD-EFGH",
			"alice",
			"Alice",
			"alice@example.invalid",
		]);
		const { fetch, claims } = onboardingFetchStub();
		const { deps, calls } = stubDeps({ prompt, fetch });
		const code = await cliMain(
			["attach", "--server", "https://sigrun.example"],
			{ SIGRUN_CONFIG_DIR: dir },
			deps,
		);
		expect(code).toBe(0);

		// Four prompts, the code one FIRST (codeRequired came from the GET).
		expect(questions).toHaveLength(4);
		expect(questions[0]).toMatch(/code/i);
		expect(questions[1]).toMatch(/username/i);

		// The claim body matches the scripted answers.
		expect(claims).toHaveLength(1);
		expect(claims[0]?.url).toBe("https://sigrun.example/v1/onboarding/claim");
		expect(JSON.parse(claims[0]?.body ?? "{}")).toEqual({
			code: "ABCD-EFGH",
			user: "alice",
			name: "Alice",
			email: "alice@example.invalid",
			issueToken: true,
		});

		// tui.json: user + server + token, mode 0600.
		const file = JSON.parse(await readFile(join(dir, "tui.json"), "utf8"));
		expect(file).toEqual({
			user: "alice",
			server: "https://sigrun.example",
			token: "sgr_claimed_token",
		});
		const fileStat = await stat(join(dir, "tui.json"));
		expect(fileStat.mode & 0o777).toBe(0o600);

		// The launch carries the claimed identity and token.
		expect(calls.launchTui).toEqual([
			{
				baseUrl: "https://sigrun.example",
				user: "alice",
				token: "sgr_claimed_token",
			},
		]);
	});

	test("empty name/email answers are omitted from the claim body", async () => {
		const dir = await tmpConfigDir();
		const { prompt } = scriptedPrompt(["ABCD-EFGH", "alice", "", "  "]);
		const { fetch, claims } = onboardingFetchStub();
		const { deps } = stubDeps({ prompt, fetch });
		await cliMain(["attach", "--server", "https://sigrun.example"], { SIGRUN_CONFIG_DIR: dir }, deps);
		expect(JSON.parse(claims[0]?.body ?? "{}")).toEqual({
			code: "ABCD-EFGH",
			user: "alice",
			issueToken: true,
		});
	});

	test("a claimed server skips onboarding entirely (no prompts, no claim, no write)", async () => {
		const dir = await tmpConfigDir();
		const { prompt, questions } = scriptedPrompt([]);
		const { fetch, claims } = onboardingFetchStub({ state: "claimed" });
		const { deps, calls } = stubDeps({ prompt, fetch });
		await cliMain(["attach", "--server", "https://sigrun.example"], { SIGRUN_CONFIG_DIR: dir }, deps);
		expect(questions).toEqual([]);
		expect(claims).toEqual([]);
		expect(calls.launchTui).toEqual([{ baseUrl: "https://sigrun.example" }]);
		await expect(readFile(join(dir, "tui.json"), "utf8")).rejects.toThrow();
	});

	test("a failed claim exits 1 naming the server's error, writes nothing, launches nothing", async () => {
		const dir = await tmpConfigDir();
		const { prompt } = scriptedPrompt(["WRONG", "alice", "", ""]);
		const { fetch, claims } = onboardingFetchStub({
			claimStatus: 403,
			claimBody: { error: "invalid_code" },
		});
		const errors: string[] = [];
		const { deps, calls } = stubDeps({ prompt, fetch });
		const code = await cliMain(
			["attach", "--server", "https://sigrun.example"],
			{ SIGRUN_CONFIG_DIR: dir },
			deps,
			{ error: (text) => errors.push(text) },
		);
		expect(code).toBe(1);
		expect(claims).toHaveLength(1);
		expect(errors.join("\n")).toMatch(/invalid_code/);
		expect(calls.launchTui).toEqual([]);
		await expect(readFile(join(dir, "tui.json"), "utf8")).rejects.toThrow();
	});

	test("a GET that 403s setup_required is treated as unclaimed with a code", async () => {
		const dir = await tmpConfigDir();
		const { prompt, questions } = scriptedPrompt(["ABCD-EFGH", "alice", "", ""]);
		const claims: { url: string; body?: string }[] = [];
		const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
			if (init?.method === "POST") {
				claims.push({ url, body: init.body });
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
				ok: false,
				status: 403,
				json: () => Promise.resolve({ error: "setup_required" }),
			};
		}) as NonNullable<CliDeps["fetch"]>;
		const { deps } = stubDeps({ prompt, fetch: fetchImpl });
		await cliMain(["attach", "--server", "https://sigrun.example"], { SIGRUN_CONFIG_DIR: dir }, deps);
		expect(questions).toHaveLength(4);
		expect(JSON.parse(claims[0]?.body ?? "{}")).toMatchObject({ code: "ABCD-EFGH" });
	});

	test("an unreachable server (fetch rejects) skips onboarding and launches the TUI as before", async () => {
		const dir = await tmpConfigDir();
		const { questions } = scriptedPrompt([]);
		const fetchImpl = (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as unknown as NonNullable<CliDeps["fetch"]>;
		const { deps, calls } = stubDeps({ fetch: fetchImpl });
		const code = await cliMain(
			["attach", "--server", "https://down.example"],
			{ SIGRUN_CONFIG_DIR: dir },
			deps,
		);
		expect(code).toBe(0);
		expect(questions).toEqual([]);
		expect(calls.launchTui).toEqual([{ baseUrl: "https://down.example" }]);
	});

	test("token precedence on launch: env SIGRUN_TOKEN > tui.json token (both claimed and pre-existing)", async () => {
		// A pre-existing tui.json token is passed through (claimed server).
		const dir = await tmpConfigDir();
		await writeFile(
			join(dir, "tui.json"),
			JSON.stringify({ user: "acme-user", token: "sgr_file_token" }),
			"utf8",
		);
		const { fetch } = onboardingFetchStub({ state: "claimed" });
		const fromFile = stubDeps({ fetch });
		await cliMain(["attach", "--server", "https://sigrun.example"], { SIGRUN_CONFIG_DIR: dir }, fromFile.deps);
		expect(fromFile.calls.launchTui[0]).toMatchObject({ token: "sgr_file_token" });

		// The env var wins over the file.
		const fromEnv = stubDeps({ fetch });
		await cliMain(
			["attach", "--server", "https://sigrun.example"],
			{ SIGRUN_CONFIG_DIR: dir, SIGRUN_TOKEN: "sgr_env_token" },
			fromEnv.deps,
		);
		expect(fromEnv.calls.launchTui[0]).toMatchObject({ token: "sgr_env_token" });
	});
});

describe("cliMain run: the loopback onboarding flow (Task 7)", () => {
	test("unclaimed loopback → no code prompt, claims with issueToken, writes user ONLY (no token, no server)", async () => {
		const dir = await tmpConfigDir();
		const { prompt, questions } = scriptedPrompt(["alice", "Alice", "alice@example.invalid"]);
		const { fetch, claims } = onboardingFetchStub({ codeRequired: false });
		const { deps, calls } = stubDeps({ prompt, fetch });
		const code = await cliMain([], storeEnv(dir), deps);
		expect(code).toBe(0);

		// Three prompts, no code (loopback is the trust).
		expect(questions).toHaveLength(3);
		expect(questions.join("\n")).not.toMatch(/code/i);

		// The claim hit the booted loopback server.
		expect(claims[0]?.url).toBe("http://localhost:4321/v1/onboarding/claim");
		expect(JSON.parse(claims[0]?.body ?? "{}")).toEqual({
			user: "alice",
			name: "Alice",
			email: "alice@example.invalid",
			issueToken: true,
		});

		// tui.json gains ONLY the user.
		const file = JSON.parse(await readFile(join(dir, "tui.json"), "utf8"));
		expect(file).toEqual({ user: "alice" });

		// The launch carries the user and NO token (workstation run is
		// loopback and unauthenticated — spec §5.4).
		expect(calls.launchTui[0]).toEqual({
			baseUrl: "http://localhost:4321",
			user: "alice",
		});
	});

	test("a claimed loopback server runs the old path unchanged", async () => {
		const dir = await tmpConfigDir();
		const { questions } = scriptedPrompt([]);
		const { fetch, claims } = onboardingFetchStub({ state: "claimed" });
		const { deps, calls } = stubDeps({ fetch });
		await cliMain([], storeEnv(dir), deps);
		expect(questions).toEqual([]);
		expect(claims).toEqual([]);
		expect(calls.launchTui).toEqual([{ baseUrl: "http://localhost:4321" }]);
	});
});

describe("TuiFile token validation (Task 7)", () => {
	test("a string token round-trips", async () => {
		const dir = await tmpConfigDir();
		await writeFile(
			join(dir, "tui.json"),
			JSON.stringify({ token: "sgr_tui_file_token" }),
			"utf8",
		);
		expect(await loadTuiFile({ SIGRUN_CONFIG_DIR: dir })).toEqual({
			token: "sgr_tui_file_token",
		});
	});

	test("a non-string token fails loud", async () => {
		const dir = await tmpConfigDir();
		await writeFile(join(dir, "tui.json"), JSON.stringify({ token: 42 }), "utf8");
		await expect(loadTuiFile({ SIGRUN_CONFIG_DIR: dir })).rejects.toThrowError(
			/tui\.json: token must be a string/,
		);
	});
});
