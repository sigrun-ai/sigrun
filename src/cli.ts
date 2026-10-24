#!/usr/bin/env node
/**
 * The CLI entrypoints (Task 5): `sigrun` / `sigrun serve` / `sigrun attach`
 * — the package's `bin` (`"sigrun": "dist/cli.js"`, plain node — build
 * Task 3; the tsx shebang served the from-source era).
 *
 * - `sigrun` (run): boot harness+server IN-PROCESS (the `src/serve.ts`
 *   composition) and launch the TUI against the loopback URL of the bound
 *   port. The spec's lifecycle rule: the agent dies with the TUI — when the
 *   TUI exits, the server+harness shut down. SIGTERM/SIGINT also stop the
 *   in-process server — and, in run mode, exit the process once shutdown
 *   completes (fix wave A8: the TUI must never run against a dead server).
 * - `sigrun serve`: the deploy composition minus the TUI — literally the
 *   `src/index.ts` entry (same graceful shutdown, same fail-loud boot).
 * - `sigrun attach`: no harness boot; launch the TUI against the resolved
 *   server URL, carrying the resolved user into the client config.
 *
 * Build-and-webui Task 2: the TUI is a SPAWNED package, not an in-process
 * import. `run`/`attach` spawn `node <resolved @sigrun/tui bin>` as a
 * child process, passing the resolved server URL, user, and tui.json UI
 * fields as `--flags` (the bin, `tui/dist/launch.js`, parses them itself).
 * The parent watches the child's exit: exit → shutdown (agent-dies-with-
 * tui), nonzero exit → exit 1. A package-resolution failure surfaces as
 * an actionable `install @sigrun/tui` message, never a module-not-found
 * crash — the core install is server-only unless the companion tui
 * package is present. The old lazy `import("../tui/src/launch.js")` is
 * gone: an in-process import would drag the tui workspace's runtime
 * (pi-tui) into the core's resolution graph.
 *
 * Resolution chains (both `attach`; `run` resolves `user` the same way):
 * - server: `--server` > tui.json `server` > `http://localhost:$SIGRUN_PORT`
 *   (default 3000)
 * - user: `--user` > `SIGRUN_USER` > tui.json `user`
 *
 * The TUI entry (Task 6) is the `@sigrun/tui` package's `sigrun-tui` bin
 * (`tui/dist/launch.js` — build-and-webui Task 2) — the CLI's default
 * `launchTui` spawns it; everything else is real and tested through the
 * seams (`test/cli.test.ts` injects factories — process-launch stays out
 * of the unit tests, and `npm start` → src/index.ts is unchanged for the
 * cluster's monolith).
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";
import { resolveStoreRoots, writeFileAtomic } from "./harness/stores.js";
import { openIdentityStores } from "./harness/identity/index.js";
import { pathToFileURL } from "node:url";
import { effectiveMethods, loadConfig, type Env } from "./config.js";
import { probeIsolation, runHelperProbe, selfTestHelper } from "./sandbox/availability.js";
import { SettingsStore } from "./harness/settings.js";
import { resolveHelper } from "./sandbox/helper.js";
import { selfPackageRoot } from "./harness/packages.js";
import { createAdmissionGuard } from "./harness/identity/users.js";
import type { ClaimResponse, OnboardingState } from "@sigrun/shared/views";
import { serve, type BootedServer } from "./serve.js";
import {
	ACCENT_NAMES,
	PALETTE_NAMES,
	isAccentName,
	isPaletteName,
	type AccentName,
	type ModeName,
	type PaletteName,
} from "@sigrun/shared/themes";

export const USAGE_TEXT = `usage: sigrun [--user <name>]
       sigrun serve
       sigrun attach [--server <url>] [--user <name>]
       sigrun token create <name> --user <user>
       sigrun token list
       sigrun token revoke <id>
       sigrun user add <user> [--admin] [--name <n>] [--email <e>]
       sigrun user list
       sigrun provider list [--url <base>] [--token <token>]
       sigrun provider key <id> [--url <base>] [--token <token>]
       sigrun provider clear <id> [--url <base>] [--token <token>]

provider commands are API clients: they talk to a running sigrun server
(--url <base>, default http://localhost:$SIGRUN_PORT or 3000) and never
start one; provider key reads the api key from stdin, never argv`;

/** The marker prefix on usage-error messages. */
const USAGE_ERROR_PREFIX = "usage:";

/**
 * The pattern matching a usage error's message (tests assert parseArgs
 * throws it; the dispatch prints the message + usage and exits 1).
 */
export const USAGE_ERROR_PATTERN = /^usage:/;

/** The parse result: which command, plus the flag-carried overrides. */
export interface ParsedArgs {
	readonly command: "run" | "serve" | "attach" | "token" | "user" | "provider";
	readonly server?: string;
	readonly user?: string;
	/** The `token`/`user`/`provider` subcommand: create | list | revoke | add | key | clear. */
	readonly sub?: "create" | "list" | "revoke" | "add" | "key" | "clear";
	/** `token create <name>` — the token's display name. */
	readonly tokenName?: string;
	/** `token revoke <id>` / `provider key|clear <id>` — the record/provider id. */
	readonly id?: string;
	/** `user add --admin`. */
	readonly admin?: boolean;
	/** `user add --name <n>` — the display name. */
	readonly name?: string;
	/** `user add --email <e>`. */
	readonly email?: string;
	/** `provider … --url <base>` — the remote server to act on. */
	readonly url?: string;
	/** `provider … --token <t>` — the bearer for a token-method server. */
	readonly token?: string;
}

function usageError(message: string): Error {
	return new Error(`${USAGE_ERROR_PREFIX} ${message}\n${USAGE_TEXT}`);
}

/**
 * Parse `token <sub> …` (Task 7): `create <name> --user <u>`, `list`,
 * `revoke <id>`. The positional/flag grammar is strict — anything else
 * is a usage error.
 */
function parseTokenArgs(argv: readonly string[]): ParsedArgs {
	const sub = argv[0];
	if (sub === "list") {
		if (argv.length !== 1) {
			throw usageError("token list takes no arguments");
		}
		return { command: "token", sub: "list" };
	}
	if (sub === "revoke") {
		if (argv.length !== 2) {
			throw usageError("token revoke takes exactly one <id>");
		}
		return { command: "token", sub: "revoke", id: argv[1] };
	}
	if (sub === "create") {
		let tokenName: string | undefined;
		let user: string | undefined;
		let index = 1;
		while (index < argv.length) {
			const arg = argv[index] as string;
			if (arg === "--user") {
				const value = argv[index + 1];
				if (value === undefined || value.startsWith("--")) {
					throw usageError("--user requires a value");
				}
				user = value;
				index += 2;
				continue;
			}
			if (tokenName === undefined && !arg.startsWith("--")) {
				tokenName = arg;
				index += 1;
				continue;
			}
			throw usageError(`unexpected argument ${JSON.stringify(arg)}`);
		}
		if (tokenName === undefined) {
			throw usageError("token create requires a <name>");
		}
		if (user === undefined) {
			throw usageError("token create requires --user");
		}
		return { command: "token", sub: "create", tokenName, user };
	}
	throw usageError(
		`unknown token subcommand ${JSON.stringify(sub ?? "")} (create, list, revoke)`,
	);
}

/**
 * Parse `user <sub> …` (Task 7): `add <user> [--admin] [--name <n>]
 * [--email <e>]`, `list`. One positional (the username), flags anywhere.
 */
function parseUserArgs(argv: readonly string[]): ParsedArgs {
	const sub = argv[0];
	if (sub === "list") {
		if (argv.length !== 1) {
			throw usageError("user list takes no arguments");
		}
		return { command: "user", sub: "list" };
	}
	if (sub === "add") {
		let user: string | undefined;
		let admin = false;
		let name: string | undefined;
		let email: string | undefined;
		let index = 1;
		while (index < argv.length) {
			const arg = argv[index] as string;
			if (arg === "--admin") {
				admin = true;
				index += 1;
				continue;
			}
			if (arg === "--name" || arg === "--email") {
				const value = argv[index + 1];
				if (value === undefined || value.startsWith("--")) {
					throw usageError(`${arg} requires a value`);
				}
				if (arg === "--name") name = value;
				else email = value;
				index += 2;
				continue;
			}
			if (user === undefined && !arg.startsWith("--")) {
				user = arg;
				index += 1;
				continue;
			}
			throw usageError(`unexpected argument ${JSON.stringify(arg)}`);
		}
		if (user === undefined) {
			throw usageError("user add requires a <user>");
		}
		return {
			command: "user",
			sub: "add",
			user,
			...(admin ? { admin } : {}),
			...(name === undefined ? {} : { name }),
			...(email === undefined ? {} : { email }),
		};
	}
	throw usageError(
		`unknown user subcommand ${JSON.stringify(sub ?? "")} (add, list)`,
	);
}

/**
 * Parse `provider <sub> …` (release 0.1 Task 2b): `list`, `key <id>`,
 * `clear <id>`, each accepting `--url <base>` (a remote server; the
 * default is `http://localhost:$SIGRUN_PORT` or 3000 — the attach
 * shape) and `--token <t>` (the bearer for a token-method server).
 * These commands are API clients: they NEVER start a server (the usage
 * note says so).
 */
function parseProviderArgs(argv: readonly string[]): ParsedArgs {
	const sub = argv[0];
	if (sub !== "list" && sub !== "key" && sub !== "clear") {
		throw usageError(
			`unknown provider subcommand ${JSON.stringify(sub ?? "")} (list, key, clear)`,
		);
	}
	let id: string | undefined;
	let url: string | undefined;
	let token: string | undefined;
	let index = 1;
	while (index < argv.length) {
		const arg = argv[index] as string;
		if (arg === "--url" || arg === "--token") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw usageError(`${arg} requires a value`);
			}
			if (arg === "--url") url = value;
			else token = value;
			index += 2;
			continue;
		}
		if (id === undefined && !arg.startsWith("--")) {
			id = arg;
			index += 1;
			continue;
		}
		// NEVER echo the offending token (secret-hygiene, review P2): a
		// `provider key acme THEKEY` typo puts the key on stderr — stderr
		// lands in CI logs, issue reports and scrollback where shell history
		// does not. Name the problem + the accepted shape, reproduce nothing.
		throw usageError(
			"unexpected argument — `provider <sub> [<id>] [--url <base>] [--token <token>]` takes one id at most, and reads the api key from stdin",
		);
	}
	if (sub === "list" && id !== undefined) {
		throw usageError("provider list takes no arguments");
	}
	if (sub !== "list" && id === undefined) {
		throw usageError(`provider ${sub} requires an <id>`);
	}
	return {
		command: "provider",
		sub,
		...(id === undefined ? {} : { id }),
		...(url === undefined ? {} : { url }),
		...(token === undefined ? {} : { token }),
	};
}

/**
 * Parse argv (post-node slices — no `node`/`cli.ts` entries). A pure
 * function: bare → `run`; `serve`/`attach` as subcommands; `token`/
 * `user`/`provider` dispatch to their own sub-parsers (Task 7 + release
 * 0.1 Task 2b — they must be the FIRST argument); `--user` is valid on
 * every command, `--server` only on `attach`. Unknown subcommands/flags
 * and missing flag values throw usage errors.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
	if (argv[0] === "token") return parseTokenArgs(argv.slice(1));
	if (argv[0] === "user") return parseUserArgs(argv.slice(1));
	if (argv[0] === "provider") return parseProviderArgs(argv.slice(1));
	let command: ParsedArgs["command"] | undefined;
	let server: string | undefined;
	let user: string | undefined;
	let index = 0;
	while (index < argv.length) {
		const arg = argv[index] as string;
		if (arg === "run" || arg === "serve" || arg === "attach") {
			if (command !== undefined) {
				throw usageError(`unexpected extra command ${JSON.stringify(arg)}`);
			}
			command = arg;
			index += 1;
			continue;
		}
		if (arg === "--server" || arg === "--user") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw usageError(`${arg} requires a value`);
			}
			if (arg === "--server") server = value;
			else user = value;
			index += 2;
			continue;
		}
		throw usageError(`unknown argument ${JSON.stringify(arg)}`);
	}
	if (server !== undefined && command !== "attach") {
		throw usageError("--server is only valid for attach");
	}
	return {
		command: command ?? "run",
		...(server === undefined ? {} : { server }),
		...(user === undefined ? {} : { user }),
	};
}

/**
 * The tui.json client file: the TUI's own small config, read from
 * `SIGRUN_CONFIG_DIR`/tui.json (the same dir `settings.json` lives in —
 * `SIGRUN_CONFIG_DIR` stays env-only and locates the file itself).
 * `{ user?, server?, token? }` plus the UI refresh's client fields
 * (C1): `palette`/`accent`/`mode` (theme), `keymap`
 * (standard/vim/emacs — bindings land in C3), `editor` (external editor
 * command, validated in C4). Absent dir/file → `{}`. Fail-loud on a
 * malformed file (the settings.json posture). `token` (Task 7) is the
 * attach credential the onboarding claim wrote — 0600 material; env
 * `SIGRUN_TOKEN` wins over it at launch time.
 */
export interface TuiFile {
	readonly user?: string;
	readonly server?: string;
	readonly token?: string;
	readonly palette?: PaletteName;
	readonly accent?: AccentName;
	readonly mode?: ModeName;
	readonly keymap?: "standard" | "vim" | "emacs";
	readonly editor?: string;
}

/**
 * The config dir: the ONE config-root chain (`resolveStoreRoots`,
 * spec Decision 3) — `SIGRUN_CONFIG_DIR` → `$XDG_CONFIG_HOME`/sigrun
 * → `~/.config/sigrun`, identical to `defaultSettingsDir()` in
 * src/harness/settings.ts (both delegate to the same resolver, so
 * settings/auth/packages/git can never split from the store roots);
 * `SIGRUN_CONFIG_DIR` itself stays env-only.
 */
export function defaultConfigDir(env: Env): string {
	return resolveStoreRoots(env).configDir;
}

/** Read `tui.json` (see {@link TuiFile}); `env` defaults to process.env. */
export async function loadTuiFile(env: Env): Promise<TuiFile> {
	const path = join(defaultConfigDir(env), "tui.json");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		// Absent file is the normal case (ENOENT); any read failure is
		// treated as absent — a malformed FILE is the fail-loud case below.
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new Error(
			`tui.json: ${path} is not valid JSON (${
				cause instanceof Error ? cause.message : String(cause)
			})`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`tui.json: ${path} must contain a JSON object`);
	}
	const record = parsed as Record<string, unknown>;
	const user = record.user;
	const server = record.server;
	const token = record.token;
	if (user !== undefined && typeof user !== "string") {
		throw new Error(`tui.json: user must be a string`);
	}
	if (server !== undefined && typeof server !== "string") {
		throw new Error(`tui.json: server must be a string`);
	}
	if (token !== undefined && typeof token !== "string") {
		throw new Error(`tui.json: token must be a string`);
	}
	// UI refresh (C1): validate each client field, failing loud naming the
	// key — the shared themes module owns the palette/accent name sets.
	const palette = record.palette;
	if (palette !== undefined && !isPaletteName(palette)) {
		throw new Error(
			`tui.json: palette must be one of ${PALETTE_NAMES.join(", ")}`,
		);
	}
	const accent = record.accent;
	if (accent !== undefined && !isAccentName(accent)) {
		throw new Error(
			`tui.json: accent must be one of ${ACCENT_NAMES.join(", ")}`,
		);
	}
	const mode = record.mode;
	if (mode !== undefined && mode !== "dark" && mode !== "light") {
		throw new Error(`tui.json: mode must be one of dark, light`);
	}
	const keymap = record.keymap;
	if (
		keymap !== undefined &&
		keymap !== "standard" &&
		keymap !== "vim" &&
		keymap !== "emacs"
	) {
		throw new Error(`tui.json: keymap must be one of standard, vim, emacs`);
	}
	// Any string: the editor command's existence/validation is C4's job.
	const editor = record.editor;
	if (editor !== undefined && typeof editor !== "string") {
		throw new Error(`tui.json: editor must be a string`);
	}
	return {
		...(user === undefined ? {} : { user }),
		...(server === undefined ? {} : { server }),
		...(token === undefined ? {} : { token }),
		...(palette === undefined ? {} : { palette }),
		...(accent === undefined ? {} : { accent }),
		...(mode === undefined ? {} : { mode }),
		...(keymap === undefined ? {} : { keymap }),
		...(editor === undefined ? {} : { editor }),
	};
}

/**
 * Merge `update` into `tui.json` and write it atomically at mode 0600
 * (Task 7: the onboarding claim stores its `token` here — credential
 * material never lands world-readable, and a pre-existing wider mode is
 * tightened by the rewrite). The file's other fields (theme, keymap,
 * editor) survive verbatim.
 */
export async function writeTuiFile(update: TuiFile, env: Env): Promise<void> {
	const dir = defaultConfigDir(env);
	await mkdir(dir, { recursive: true });
	const merged: TuiFile = { ...(await loadTuiFile(env)), ...update };
	await writeFileAtomic(
		join(dir, "tui.json"),
		`${JSON.stringify(merged, null, "\t")}\n`,
		0o600,
	);
}

/** The launch surface the TUI entry (Task 6/8) provides. */
export interface LaunchTuiOptions {
	/** The server's base URL (`SigrunClient`'s `baseUrl`). */
	readonly baseUrl: string;
	/** The `X-Sigrun-User` identity; absent = the server's naive mode. */
	readonly user?: string;
	/**
	 * A bearer token for an authenticated server (Task 7): rides the
	 * child as env `SIGRUN_TOKEN` — NEVER argv (a process list must never
	 * show credentials). The TUI bin reads it from its environment.
	 */
	readonly token?: string;
	/** The UI refresh's tui.json client fields (C1), threaded through. */
	readonly palette?: PaletteName;
	readonly accent?: AccentName;
	readonly mode?: ModeName;
	readonly keymap?: "standard" | "vim" | "emacs";
	readonly editor?: string;
}

/**
 * The child-process surface {@link launchTuiProcess} drives — the
 * narrowed slice of `ChildProcess` the tests fake.
 */
export interface TuiChildProcess {
	on(event: "exit", listener: (code: number | null) => void): void;
	/** Spawn failures (ENOENT, EACCES) — without a listener node emits an
	 * unhandled `error` event, which CRASHES the CLI instead of printing
	 * the actionable message. */
	on(event: "error", listener: (error: Error) => void): void;
	kill(signal?: NodeJS.Signals): void;
}

/**
 * The spawn seam (tests inject a fake; production uses node's spawn).
 * The options carry the child's `env` — the SIGRUN_TOKEN path (the
 * token NEVER rides argv).
 */
export type TuiSpawnFn = (
	command: string,
	args: readonly string[],
	options?: { readonly env?: NodeJS.ProcessEnv },
) => TuiChildProcess;

/** The bin-resolver seam: returns the ABSOLUTE path of the tui bin. */
export type TuiBinResolver = () => string;

/**
 * Resolve the `@sigrun/tui` bin: the package manifest through its
 * `./package.json` exports entry (a createRequire rooted at THIS module —
 * never a relative path into the workspace), joined with the `sigrun-tui`
 * bin the manifest declares. Any resolution failure (package absent,
 * manifest shape, bin missing on disk) throws — callers translate it into
 * the `install @sigrun/tui` error.
 */
export function resolveTuiBin(): string {
	const require = createRequire(import.meta.url);
	const manifestPath = require.resolve("@sigrun/tui/package.json");
	// The manifest path is read DIRECTLY (never wrapped in a file:// URL —
	// interpolating a filesystem path into a URL mis-parses on `#`, `?`,
	// and `%`, and WHATWG quirks are exactly how the T2 reviewer's
	// mis-parse class happens; a plain path is what readFileSync takes).
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		bin?: Record<string, string> | string;
	};
	const binField = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["sigrun-tui"];
	if (binField === undefined) {
		throw new Error(`@sigrun/tui/package.json declares no sigrun-tui bin`);
	}
	return join(dirname(manifestPath), binField);
}

/** The tui.json UI fields as `--flag value` argv pairs (Task 2: the tui
 * is spawned; the fields the old in-process call threaded now ride the
 * child's argv, parsed by the bin's own `parseTuiLaunchArgs`). */
function tuiArgv(options: LaunchTuiOptions): string[] {
	return [
		"--server",
		options.baseUrl,
		...(options.user === undefined ? [] : ["--user", options.user]),
		...(options.palette === undefined ? [] : ["--palette", options.palette]),
		...(options.accent === undefined ? [] : ["--accent", options.accent]),
		...(options.mode === undefined ? [] : ["--mode", options.mode]),
		...(options.keymap === undefined ? [] : ["--keymap", options.keymap]),
		...(options.editor === undefined ? [] : ["--editor", options.editor]),
	];
}

/**
 * The default `launchTui`: spawn `node <resolved sigrun-tui bin>` as a
 * child process (stdio inherited — the TUI owns the terminal) and resolve
 * when the child exits. A bin-resolution failure is wrapped as the
 * actionable `install @sigrun/tui` message; a nonzero child exit rejects
 * (the CLI prints it and exits 1).
 */
export async function launchTuiProcess(
	options: LaunchTuiOptions,
	seams?: { spawn?: TuiSpawnFn; resolveTuiBin?: TuiBinResolver },
): Promise<void> {
	const doSpawn: TuiSpawnFn =
		seams?.spawn ??
		((command, args, spawnOptions) =>
			nodeSpawn(command, [...args], {
				stdio: "inherit",
				...(spawnOptions?.env === undefined
					? {}
					: { env: spawnOptions.env }),
			}));
	const resolveBin = seams?.resolveTuiBin ?? resolveTuiBin;
	let bin: string;
	try {
		bin = resolveBin();
	} catch (cause) {
		throw new Error(
			`sigrun-tui is not installed; install @sigrun/tui to use the terminal client (${
				cause instanceof Error ? cause.message : String(cause)
			})`,
		);
	}
	const child = doSpawn(
		process.execPath,
		[bin, ...tuiArgv(options)],
		// The token's ONLY route into the child: the environment (an
		// explicit env REPLACES process.env in node's spawn — spread the
		// parent's through so PATH and friends survive).
		options.token === undefined
			? {}
			: { env: { ...process.env, SIGRUN_TOKEN: options.token } },
	);
	const code = await new Promise<number | null>((resolve, reject) => {
		child.on("exit", (exitCode: number | null) => resolve(exitCode));
		child.on("error", (error: Error) => reject(error));
	});
	if (code !== 0) {
		throw new Error(`sigrun-tui exited with ${code ?? "no exit code (terminated)"}`);
	}
}

/**
 * The CLI's injected dependencies — the wiring seams the unit tests stub
 * (process-launch stays out of unit tests; the deploy-entry test owns the
 * real boot through `src/index.ts`).
 */
export interface CliDeps {
	/**
	 * The deploy entry's serve-only composition (`src/index.ts`) — `serve`
	 * the command dispatches to it directly (never returns while serving).
	 */
	serve(env: NodeJS.ProcessEnv): Promise<void>;
	/**
	 * Boot harness+server in-process (`src/serve.ts`), resolving the bound
	 * port and the shutdown the `run` lifecycle drives. The CLI passes
	 * `{ host: "127.0.0.1" }` — workstation mode is loopback-only (the
	 * TUI dials loopback; the naive-identity API must not answer on the
	 * LAN). `serve` (the deploy entry) keeps the dual-stack `::` default.
	 */
	boot(env: NodeJS.ProcessEnv, options?: { host?: string }): Promise<BootedServer>;
	/**
	 * The TUI launch (build-and-webui Task 2): spawn the `@sigrun/tui`
	 * bin as a child process — resolves when the child exits, rejects on a
	 * nonzero exit (or an `install @sigrun/tui` resolution failure).
	 * OPTIONAL: the default composes {@link launchTuiProcess} with the
	 * `spawn`/`resolveTuiBin` seams below (inject those to fake the child
	 * while keeping the real default wiring); `run`/`attach` shut the
	 * server down when it settles (agent-dies-with-tui).
	 */
	launchTui?(options: LaunchTuiOptions): Promise<void>;
	/**
	 * TEST SEAM: the child-process spawn (`launchTuiProcess`'s engine).
	 * Defaults to node's `spawn` with `stdio: "inherit"` (the TUI owns
	 * the terminal).
	 */
	spawn?(command: string, args: readonly string[], options?: { readonly env?: NodeJS.ProcessEnv }): TuiChildProcess;
	/** TEST SEAM: the `@sigrun/tui` bin resolver (see {@link resolveTuiBin}). */
	resolveTuiBin?(): string;
	/**
	 * The process-exit seam (fix wave A8): run mode's signal path exits
	 * once shutdown completes so the TUI never runs against a dead server.
	 * Defaults to `process.exit`; tests inject a capture.
	 */
	exit?(code: number): never;
	/**
	 * TEST SEAM (Task 7): the interactive prompt over the real TTY
	 * (readline/promises). Production ({@link ttyPrompt}) echoes answers;
	 * `{secret: true}` swaps in a muted output stream. The onboarding
	 * flow prompts the setup code, username, name, and email through it.
	 */
	prompt?(question: string, opts?: { secret?: boolean }): Promise<string>;
	/**
	 * TEST SEAM (Task 7): the onboarding HTTP leg (`GET /v1/onboarding`,
	 * `POST /v1/onboarding/claim`). Defaults to the ambient `fetch`.
	 */
	fetch?: CliFetch;
	/**
	 * TEST SEAM (release 0.1 Task 2b): `provider key`'s secret read — the
	 * muted TTY prompt or all of piped stdin (see {@link readCliSecret}).
	 * The value goes to the PUT body only; it is never printed.
	 */
	readSecret?(): Promise<string>;
	/** Test seam for the multi-user admission availability decision. */
	probeIsolation?: typeof probeIsolation;
}

/**
 * The fetch surface the onboarding flow needs (a structural slice of the
 * ambient `fetch` — tests stub it with plain object responders).
 */
export type CliFetch = (
	url: string,
	init?: {
		readonly method?: string;
		readonly headers?: Record<string, string>;
		readonly body?: string;
	},
) => Promise<{
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}>;

/**
 * The production prompt (Task 7): one readline question per call on the
 * real stdin/stdout. `secret: true` answers with the echo muted — the
 * question itself still prints, the typed text does not.
 */
export async function ttyPrompt(
	question: string,
	opts?: { secret?: boolean },
): Promise<string> {
	if (opts?.secret === true) {
		process.stdout.write(question);
		// A black-hole output stream: readline echoes what it writes to its
		// output — pointing that at a sink mutes the typing without raw-mode
		// games (the standard readline muted-input idiom).
		const muted = new Writable({
			write: (_chunk, _encoding, callback) => {
				callback();
			},
		});
		const rl = readline.createInterface({ input: process.stdin, output: muted });
		try {
			return await rl.question("");
		} finally {
			rl.close();
			process.stdout.write("\n");
		}
	}
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		return await rl.question(question);
	} finally {
		rl.close();
	}
}

/** The sink for usage/boot error lines (tests capture it). */
export interface CliIO {
	error(text: string): void;
	/**
	 * Data output — `token create`'s one-time secret, `token list`/
	 * `user list`/`provider …` rows (Task 7 + release 0.1 Task 2b).
	 * Absent drops the data (error-only callers); the production default
	 * prints to stdout.
	 */
	out?(text: string): void;
}

/** Resolve the attach/run user: `--user` > `SIGRUN_USER` > tui.json. */
function resolveUser(
	parsed: ParsedArgs,
	env: Env,
	file: TuiFile,
): string | undefined {
	return parsed.user ?? env.SIGRUN_USER ?? file.user;
}

/**
 * The tui.json UI refresh fields (C1) as a spreadable launch fragment —
 * the same five keys for both dispatch paths (attach + run).
 */
function tuiThemeFields(file: TuiFile): {
	palette?: PaletteName;
	accent?: AccentName;
	mode?: ModeName;
	keymap?: "standard" | "vim" | "emacs";
	editor?: string;
} {
	return {
		...(file.palette === undefined ? {} : { palette: file.palette }),
		...(file.accent === undefined ? {} : { accent: file.accent }),
		...(file.mode === undefined ? {} : { mode: file.mode }),
		...(file.keymap === undefined ? {} : { keymap: file.keymap }),
		...(file.editor === undefined ? {} : { editor: file.editor }),
	};
}

/** Parse a port env value: undefined when absent/empty, else a positive
 * integer — anything else fails loud naming the variable (D1: extracted
 * from resolveServer's lazy IIFE). */
export function parsePort(raw: string | undefined): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	const port = Number(raw);
	if (!Number.isInteger(port) || port <= 0) {
		throw new Error(`SIGRUN_PORT must be a positive integer, got ${raw}`);
	}
	return port;
}

/** Resolve the attach server: `--server` > tui.json > localhost default. */
function resolveServer(
	parsed: ParsedArgs,
	env: Env,
	file: TuiFile,
): string {
	if (parsed.server !== undefined) return parsed.server;
	if (file.server !== undefined) return file.server;
	return `http://localhost:${parsePort(env.SIGRUN_PORT) ?? 3000}`;
}

/**
 * Read the api key for `provider key` (release 0.1 Task 2b): a muted
 * prompt when stdin is a TTY (the typed key never echoes), otherwise
 * ALL of piped stdin, trimmed (`printf 'k' | sigrun provider key …`).
 * The value returns to the caller only — it is never printed, logged,
 * or carried on argv.
 */
export async function readCliSecret(): Promise<string> {
	if (process.stdin.isTTY === true) {
		return (await ttyPrompt("api key: ", { secret: true })).trim();
	}
	process.stdin.setEncoding("utf8");
	let text = "";
	for await (const chunk of process.stdin) {
		text += chunk as string;
	}
	return text.trim();
}

/**
 * Run the `provider` subcommands (release 0.1 Task 2b, spec §7.6): API
 * clients over the RUNNING server's credential surface — `list` prints
 * the readiness report, `key` PUTs a secret read from stdin, `clear`
 * DELETEs one. The command NEVER starts a server: `--url` targets a
 * remote base, and the default is the localhost shape `attach` resolves
 * (`SIGRUN_PORT` or 3000); nothing listening fails loud naming the URL.
 * Output is id, readiness, model count — one tab-separated row per
 * provider (the identity rows' style). The key rides the PUT body ONLY:
 * it never appears in any output, error, or log line.
 */
async function runProviderCommand(
	parsed: ParsedArgs,
	env: NodeJS.ProcessEnv,
	io: CliIO,
	fetchImpl: CliFetch,
	readSecret: () => Promise<string>,
): Promise<number> {
	const base =
		parsed.url ?? `http://localhost:${parsePort(env.SIGRUN_PORT) ?? 3000}`;
	/** One route call: bearer when --token was given, fail-loud on non-2xx
	 * (the status + the server's error code — never any body value). */
	const call = async (
		method: "GET" | "PUT" | "DELETE" | "POST",
		path: string,
		body?: unknown,
	): Promise<Record<string, unknown>> => {
		let response: Awaited<ReturnType<CliFetch>>;
		try {
			response = await fetchImpl(`${base}${path}`, {
				method,
				headers: {
					accept: "application/json",
					...(parsed.token === undefined
						? {}
						: { authorization: `Bearer ${parsed.token}` }),
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch (cause) {
			throw new Error(
				`cannot reach a sigrun server at ${base} (${
					cause instanceof Error ? cause.message : String(cause)
				}) — provider commands are API clients and never start a server; start one (sigrun serve) or pass --url`,
			);
		}
		const payload = (await response.json().catch(() => undefined)) as
			| { error?: unknown }
			| undefined;
		if (!response.ok) {
			throw new Error(
				`server rejected ${method} ${path}: status ${response.status}${
					typeof payload?.error === "string" ? ` (${payload.error})` : ""
				}`,
			);
		}
		return (payload ?? {}) as Record<string, unknown>;
	};
	/** One readiness row: id, status, model count — tab-separated. */
	const rowOf = (entry: Record<string, unknown>): string =>
		[
			String(entry.provider ?? "?"),
			String(entry.status ?? "?"),
			String(entry.models ?? "?"),
		].join("\t");
	switch (parsed.sub) {
		case "list": {
			const report = await call("GET", "/v1/providers");
			const providers = report.providers;
			if (!Array.isArray(providers)) {
				throw new Error("server returned a malformed providers report");
			}
			for (const entry of providers) {
				if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
					throw new Error("server returned a malformed providers report");
				}
				io.out?.(rowOf(entry as Record<string, unknown>));
			}
			return 0;
		}
		case "key": {
			const secret = (await readSecret()).trim();
			if (secret === "") {
				throw new Error(
					"provider key: no api key was provided — pipe it on stdin or type it at the prompt",
				);
			}
			const entry = await call(
				"PUT",
				`/v1/providers/${encodeURIComponent(parsed.id as string)}/credential`,
				{ apiKey: secret },
			);
			io.out?.(rowOf(entry));
			return 0;
		}
		case "clear": {
			const entry = await call(
				"DELETE",
				`/v1/providers/${encodeURIComponent(parsed.id as string)}/credential`,
			);
			io.out?.(rowOf(entry));
			return 0;
		}
	}
	// parseArgs guarantees one of the cases above.
	throw new Error(`unhandled provider subcommand`);
}

/**
 * Run the `token`/`user` subcommands (Task 7, spec §5.4): the identity
 * stores DIRECTLY over the resolved roots — no server needed, honored
 * live by a running one (the stores re-read on mtime change).
 *
 * - `token create` checks the user exists first (a token IS its user);
 * - `token list`/`user list` print one row per record, no secrets (the
 *   secret exists only at create time);
 * - `token revoke` fails loud on an unknown id.
 */
async function runIdentityCommand(
	parsed: ParsedArgs,
	env: NodeJS.ProcessEnv,
	io: CliIO,
	isolationProbe: typeof probeIsolation,
): Promise<number> {
	const stores = openIdentityStores(resolveStoreRoots(env));
	if (parsed.command === "token") {
		switch (parsed.sub) {
			case "create": {
				const user = parsed.user as string;
				if (stores.users.get(user) === undefined) {
					throw new Error(
						`unknown user "${user}" — add it first: sigrun user add ${user}`,
					);
				}
				const { token } = await stores.tokens.create(
					parsed.tokenName as string,
				user,
				);
				// The one-time secret: printed ONCE, never stored.
				io.out?.(token);
				return 0;
			}
			case "list": {
				for (const record of stores.tokens.list()) {
					io.out?.(
						[
							record.name,
							record.user,
							record.id,
							new Date(record.createdAt).toISOString(),
						].join("\t"),
					);
				}
				return 0;
			}
			case "revoke": {
				const revoked = await stores.tokens.revoke(parsed.id as string);
				if (!revoked) {
					throw new Error(`no token with id ${parsed.id}`);
				}
				return 0;
			}
		}
	}
	switch (parsed.sub) {
		case "add": {
			const config = loadConfig(
				env,
				new SettingsStore({ dir: defaultConfigDir(env) }).read(),
			);
			const coreRoot = selfPackageRoot();
			const isolation = await isolationProbe({
				platform: process.platform,
				helper: coreRoot === undefined ? undefined : resolveHelper(env, coreRoot),
				runProbe: runHelperProbe,
				selfTest: selfTestHelper,
			});
			const methods = effectiveMethods(config.auth, "127.0.0.1");
			stores.users.configureAdmission({
				firstWorkspace: config.workspace.path,
				admit: createAdmissionGuard({
					isolation,
					mode: config.isolation.mode,
					methods,
					proxySecretHeader: config.auth.proxy.secretHeader,
				}),
			});
			await stores.users.add({
				user: parsed.user as string,
				admin: parsed.admin ?? false,
				...(parsed.name === undefined ? {} : { name: parsed.name }),
				...(parsed.email === undefined ? {} : { email: parsed.email }),
				source: "cli",
			});
			return 0;
		}
		case "list": {
			for (const record of stores.users.list()) {
				io.out?.(
					[
						record.admin ? "admin" : "-",
						record.user,
						...(record.name === undefined ? [] : [record.name]),
						...(record.email === undefined ? [] : [record.email]),
					].join("\t"),
				);
			}
			return 0;
		}
	}
	// parseArgs guarantees one of the cases above.
	throw new Error(`unhandled ${parsed.command} subcommand`);
}

/** What a successful onboarding claim returned (Task 7, spec §5.8). */
interface OnboardedIdentity {
	readonly user: string;
	/** The one-time token (present when the claim sent issueToken). */
	readonly token?: string;
}

/**
 * The pre-launch onboarding flow (Task 7, spec §5.8): `attach`/`run`
 * ask the server its state; an UNCLAIMED server gets the interactive
 * claim — setup code (when the GET said one is required), username,
 * name, email — then `POST /v1/onboarding/claim {…, issueToken: true}`.
 *
 * Returns `undefined` whenever the flow does not apply (claimed server,
 * unreachable server, a non-setup GET failure): the TUI launches on the
 * old path and surfaces whatever the server says. A failed CLAIM is
 * loud (the server's error body, exit 1) — the operator re-runs.
 */
async function onboardIfUnclaimed(
	server: string,
	prompt: (question: string, opts?: { secret?: boolean }) => Promise<string>,
	fetchImpl: CliFetch,
): Promise<OnboardedIdentity | undefined> {
	let state: OnboardingState | undefined;
	try {
		const response = await fetchImpl(`${server}/v1/onboarding`, {
			method: "GET",
			headers: { accept: "application/json" },
		});
		if (response.ok) {
			state = (await response.json()) as OnboardingState;
		} else if (response.status === 403) {
			// "a setup_required arrives later": a public-path GET that still
			// answers setup_required means unclaimed with a code required.
			const body = (await response.json().catch(() => undefined)) as
				| { error?: unknown }
				| undefined;
			if (body?.error !== "setup_required") return undefined;
			state = { state: "unclaimed", methods: [], codeRequired: true };
		} else {
			return undefined;
		}
	} catch {
		// Unreachable server: not this flow's business — the TUI reports it.
		return undefined;
	}
	if (state.state !== "unclaimed") return undefined;

	let code: string | undefined;
	if (state.codeRequired) {
		code = (await prompt("setup code: ")).trim();
		if (code === "") {
			throw new Error("onboarding: a setup code is required for this server");
		}
	}
	const user = (await prompt("username: ")).trim();
	if (user === "") {
		throw new Error("onboarding: a username is required");
	}
	const name = (await prompt("name (optional): ")).trim();
	const email = (await prompt("email (optional): ")).trim();

	const response = await fetchImpl(`${server}/v1/onboarding/claim`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			...(code === undefined ? {} : { code }),
			user,
			...(name === "" ? {} : { name }),
			...(email === "" ? {} : { email }),
			issueToken: true,
		}),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => undefined)) as
			| { error?: unknown }
			| undefined;
		throw new Error(
			`onboarding claim failed: ${
				typeof body?.error === "string" ? body.error : `status ${response.status}`
			}`,
		);
	}
	const claimed = (await response.json()) as ClaimResponse;
	return {
		user: claimed.user.user,
		...(claimed.token === undefined ? {} : { token: claimed.token }),
	};
}

/**
 * The dispatch. Returns the intended process exit code (0 clean, 1 on a
 * usage error or a boot/launch failure) — the module scope below maps it
 * onto `process.exit`. Env and deps are injectable: unit tests pass a
 * hermetic env and stub factories.
 */
export async function cliMain(
	argv: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
	deps?: CliDeps,
	io: CliIO = {
		error: (text) => console.error(text),
		out: (text) => console.log(text),
	},
): Promise<number> {
	const realDeps: CliDeps = {
		...(deps ?? {}),
		serve:
			deps?.serve ??
			(async (serveEnv) => {
				const booted = await serve(serveEnv);
				// Second-signal force exit (the index.ts pattern): a hung
				// graceful shutdown must never trap the operator.
				let signaled = false;
				const stop = (): void => {
					if (signaled) {
						console.error("sigrun: forcing exit (shutdown did not complete)");
						process.exit(130);
					}
					signaled = true;
					void booted.shutdownOnce().then(
						() => process.exit(0),
						(error: unknown) => {
							console.error("sigrun shutdown error:", error);
							process.exit(1);
						},
					);
				};
				process.on("SIGTERM", stop);
				process.on("SIGINT", stop);
				// Stay pending until a signal runs `stop` (which exits the
				// process): cliMain's caller maps this promise's RESOLUTION onto
				// `process.exit(0)` — a serve that returned after attaching the
				// handlers would exit the process the instant the server started
				// listening (the built-bin test caught exactly that: boot, print
				// the listening line, exit 0, serve nothing).
				await new Promise<never>(() => {});
			}),
		boot: deps?.boot ?? ((bootEnv, bootOptions) => serve(bootEnv, bootOptions)),
	};
	// The resolved TUI launch: an injected `launchTui` wins (cli.test.ts's
	// in-process stubs); otherwise the SPAWN default, composed with the
	// injected child seams (cli-spawn.test.ts fakes the child while running
	// this real wiring).
	const launchTui =
		realDeps.launchTui ??
		((options: LaunchTuiOptions) =>
			launchTuiProcess(options, {
				...(realDeps.spawn === undefined ? {} : { spawn: realDeps.spawn }),
				...(realDeps.resolveTuiBin === undefined
					? {}
					: { resolveTuiBin: realDeps.resolveTuiBin }),
			}));

	const prompt =
		realDeps.prompt ??
		((question: string, opts?: { secret?: boolean }) => ttyPrompt(question, opts));
	const fetchImpl =
		realDeps.fetch ??
		((url: string, init?: Parameters<CliFetch>[1]) =>
			globalThis.fetch(url, init));
	const readSecret = realDeps.readSecret ?? readCliSecret;

	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		io.error(error instanceof Error ? error.message : String(error));
		return 1;
	}

	try {
		switch (parsed.command) {
			case "serve": {
				await realDeps.serve(env);
				return 0;
			}
			case "token":
			case "user": {
				// The identity commands (Task 7): stores directly, server or not.
				return await runIdentityCommand(
					parsed,
					env,
					io,
					realDeps.probeIsolation ?? probeIsolation,
				);
			}
			case "provider": {
				// The provider commands (release 0.1 Task 2b): API clients over
				// the running server — never a boot, never a local store.
				return await runProviderCommand(parsed, env, io, fetchImpl, readSecret);
			}
			case "attach": {
				const file = await loadTuiFile(env);
				const server = resolveServer(parsed, env, file);
				const onboarded = await onboardIfUnclaimed(server, prompt, fetchImpl);
				if (onboarded !== undefined) {
					// The claim's carry-home: identity + where it was claimed + the
					// one-time token (0600, merged over any existing fields).
					await writeTuiFile(
						{
							user: onboarded.user,
							server,
							...(onboarded.token === undefined ? {} : { token: onboarded.token }),
						},
						env,
					);
				}
				// Token precedence (spec §5.4): env SIGRUN_TOKEN > tui.json > claim.
				const token = env.SIGRUN_TOKEN ?? file.token ?? onboarded?.token;
				const user = resolveUser(parsed, env, file) ?? onboarded?.user;
				await launchTui({
					baseUrl: server,
					...(user === undefined ? {} : { user }),
					...(token === undefined || token === "" ? {} : { token }),
					...tuiThemeFields(file),
				});
				return 0;
			}
			case "run": {
				// The flags are parsed; the model spec fails loud inside boot
				// (loadConfig names SIGRUN_DEFAULT_MODEL).
				const file = await loadTuiFile(env);
				// Workstation mode binds loopback only: the TUI dials
				// 127.0.0.1, and the naive-identity API has no business
				// answering the LAN.
				const booted = await realDeps.boot(env, { host: "127.0.0.1" });
				const exit = realDeps.exit ?? ((exitCode: number) => process.exit(exitCode));
				const stop = (): void => {
					// Fix wave A8: once shutdown completes, run mode EXITS — the
					// TUI must never run against a dead server (a signal is the
					// operator's stop request; the serve entry keeps its own
					// semantics in src/index.ts, unchanged).
					void booted.shutdownOnce().then(
						() => exit(0),
						(error: unknown) => {
							console.error("sigrun shutdown error:", error);
							exit(1);
						},
					);
				};
				process.on("SIGTERM", stop);
				process.on("SIGINT", stop);
				try {
					const server = `http://localhost:${booted.port}`;
					// Loopback onboarding (Task 7): no code (loopback is the trust);
					// tui.json gains ONLY the user — workstation run stays
					// unauthenticated, so there is no token to keep.
					const onboarded = await onboardIfUnclaimed(server, prompt, fetchImpl);
					if (onboarded !== undefined) {
						await writeTuiFile({ user: onboarded.user }, env);
					}
					const user = resolveUser(parsed, env, file) ?? onboarded?.user;
					await launchTui({
						baseUrl: server,
						...(user === undefined ? {} : { user }),
						...tuiThemeFields(file),
					});
				} finally {
					// The lifecycle rule: the agent dies with the TUI.
					await booted.shutdownOnce();
				}
				return 0;
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// The launchTui placeholder message already carries the prefix.
		io.error(message.startsWith("sigrun:") ? message : `sigrun: ${message}`);
		return 1;
	}
}

// Script detection (fix wave A7 + build Task 3): the exact entry-module
// comparison — the old endsWith("cli.ts") fired for ANY cli.ts basename.
// The argv side is REALPATH'd first (the T2 fix, mirrored for the core
// bin): npm bin entries are symlinks (…/.bin/sigrun → dist/cli.js), node
// realpaths the main module (import.meta.url is the real path) while
// process.argv[1] keeps the invoked symlink — a raw comparison mismatches
// and the bin exits 0 SILENTLY.
function invokedEntryPath(): string | undefined {
	if (process.argv[1] === undefined) return undefined;
	try {
		return realpathSync(process.argv[1]);
	} catch {
		return undefined;
	}
}

const invokedEntry = invokedEntryPath();
const invokedAsScript =
	invokedEntry !== undefined &&
	import.meta.url === pathToFileURL(invokedEntry).href;
if (invokedAsScript) {
	void cliMain(process.argv.slice(2)).then((code) => {
		process.exit(code);
	});
}
