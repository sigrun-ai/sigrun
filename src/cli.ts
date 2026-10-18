#!/usr/bin/env -S npx tsx
/**
 * The CLI entrypoints (Task 5): `sigrun` / `sigrun serve` / `sigrun attach`
 * — the package's `bin` (`"sigrun": "src/cli.ts"`, run via tsx).
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
 * Resolution chains (both `attach`; `run` resolves `user` the same way):
 * - server: `--server` > tui.json `server` > `http://localhost:$SIGRUN_PORT`
 *   (default 3000)
 * - user: `--user` > `SIGRUN_USER` > tui.json `user`
 *
 * The TUI entry (Task 6) is `tui/src/launch.ts`'s `launchTuiShell` — the
 * CLI's default `launchTui` imports it lazily (the deploy container
 * install strips devDependencies, so a static import would drag the tui
 * workspace into `npm start` resolution). Everything else is real and
 * tested through the seams (`test/cli.test.ts` injects factories —
 * process-launch stays out of the unit tests, and `npm start` →
 * src/index.ts is unchanged for the cluster's monolith).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveStoreRoots } from "./harness/stores.js";
import { pathToFileURL } from "node:url";
import type { Env } from "./config.js";
import { serve, type BootedServer } from "./serve.js";
import {
	ACCENT_NAMES,
	PALETTE_NAMES,
	isAccentName,
	isPaletteName,
	type AccentName,
	type ModeName,
	type PaletteName,
} from "./shared/themes.js";

export const USAGE_TEXT = `usage: sigrun [--user <name>]
       sigrun serve
       sigrun attach [--server <url>] [--user <name>]`;

/** The marker prefix on usage-error messages. */
const USAGE_ERROR_PREFIX = "usage:";

/**
 * The pattern matching a usage error's message (tests assert parseArgs
 * throws it; the dispatch prints the message + usage and exits 1).
 */
export const USAGE_ERROR_PATTERN = /^usage:/;

/** The parse result: which command, plus the flag-carried overrides. */
export interface ParsedArgs {
	readonly command: "run" | "serve" | "attach";
	readonly server?: string;
	readonly user?: string;
}

function usageError(message: string): Error {
	return new Error(`${USAGE_ERROR_PREFIX} ${message}\n${USAGE_TEXT}`);
}

/**
 * Parse argv (post-node slices — no `node`/`cli.ts` entries). A pure
 * function: bare → `run`; `serve`/`attach` as subcommands; `--user` is
 * valid on every command, `--server` only on `attach`. Unknown
 * subcommands/flags and missing flag values throw usage errors.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
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
 * The `tui.json` client file: the TUI's own small config (room to grow an
 * OAuth section later), read from `SIGRUN_CONFIG_DIR`/tui.json (the same
 * dir `settings.json` lives in — `SIGRUN_CONFIG_DIR` stays env-only and
 * locates the file itself). `{ user?, server? }` plus the UI refresh's
 * client fields (C1): `palette`/`accent`/`mode` (theme), `keymap`
 * (standard/vim/emacs — bindings land in C3), `editor` (external editor
 * command, validated in C4). Absent dir/file → `{}`. Fail-loud on a
 * malformed file (the settings.json posture).
 */
export interface TuiFile {
	readonly user?: string;
	readonly server?: string;
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
	if (user !== undefined && typeof user !== "string") {
		throw new Error(`tui.json: user must be a string`);
	}
	if (server !== undefined && typeof server !== "string") {
		throw new Error(`tui.json: server must be a string`);
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
		...(palette === undefined ? {} : { palette }),
		...(accent === undefined ? {} : { accent }),
		...(mode === undefined ? {} : { mode }),
		...(keymap === undefined ? {} : { keymap }),
		...(editor === undefined ? {} : { editor }),
	};
}

/** The launch surface the TUI entry (Task 6/8) provides. */
export interface LaunchTuiOptions {
	/** The server's base URL (`SigrunClient`'s `baseUrl`). */
	readonly baseUrl: string;
	/** The `X-Sigrun-User` identity; absent = the server's naive mode. */
	readonly user?: string;
	/** The UI refresh's tui.json client fields (C1), threaded through. */
	readonly palette?: PaletteName;
	readonly accent?: AccentName;
	readonly mode?: ModeName;
	readonly keymap?: "standard" | "vim" | "emacs";
	readonly editor?: string;
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
	 * LAN). `serve` (the deploy entry) keeps the `0.0.0.0` default.
	 */
	boot(env: NodeJS.ProcessEnv, options?: { host?: string }): Promise<BootedServer>;
	/**
	 * The TUI entry (tui/src/launch.ts's `launchTuiShell`): resolves when
	 * the TUI exits. The default lazy-imports the tui workspace (the deploy
	 * container's `npm start` path must never load it).
	 */
	launchTui(options: LaunchTuiOptions): Promise<void>;
	/**
	 * The process-exit seam (fix wave A8): run mode's signal path exits
	 * once shutdown completes so the TUI never runs against a dead server.
	 * Defaults to `process.exit`; tests inject a capture.
	 */
	exit?(code: number): never;
}

/** The sink for usage/boot error lines (tests capture it). */
export interface CliIO {
	error(text: string): void;
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
 * The dispatch. Returns the intended process exit code (0 clean, 1 on a
 * usage error or a boot/launch failure) — the module scope below maps it
 * onto `process.exit`. Env and deps are injectable: unit tests pass a
 * hermetic env and stub factories.
 */
export async function cliMain(
	argv: readonly string[],
	env: NodeJS.ProcessEnv = process.env,
	deps?: CliDeps,
	io: CliIO = { error: (text) => console.error(text) },
): Promise<number> {
	const realDeps: CliDeps = deps ?? {
		serve: async (serveEnv) => {
			const booted = await serve(serveEnv);
			const stop = (): void => {
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
		},
		boot: (bootEnv, bootOptions) => serve(bootEnv, bootOptions),
		launchTui: async (options) => {
			// Lazy import (see the module docstring): the tui workspace must
			// never load in the deploy container's `npm start` path.
			const { launchTuiShell } = await import("../tui/src/launch.js");
			await launchTuiShell({
				baseUrl: options.baseUrl,
				...(options.user === undefined ? {} : { user: options.user }),
				// C1a threads the tui.json fields through; the shell consumes
				// them in C1b's launcher rework (accept-and-ignore for now).
				...(options.palette === undefined ? {} : { palette: options.palette }),
				...(options.accent === undefined ? {} : { accent: options.accent }),
				...(options.mode === undefined ? {} : { mode: options.mode }),
				...(options.keymap === undefined ? {} : { keymap: options.keymap }),
				...(options.editor === undefined ? {} : { editor: options.editor }),
			});
		},
		exit: (exitCode) => process.exit(exitCode),
	};

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
			case "attach": {
				const file = await loadTuiFile(env);
				await realDeps.launchTui({
					baseUrl: resolveServer(parsed, env, file),
					user: resolveUser(parsed, env, file),
					...tuiThemeFields(file),
				});
				return 0;
			}
			case "run": {
				// The flags are parsed; the model spec fails loud inside boot
				// (loadConfig names SIGRUN_DEFAULT_MODEL).
				const file = await loadTuiFile(env);
				const user = resolveUser(parsed, env, file);
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
					await realDeps.launchTui({
						baseUrl: `http://localhost:${booted.port}`,
						user,
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

// Script detection (fix wave A7): the exact entry-module comparison —
// the old endsWith("cli.ts") fired for ANY cli.ts basename.
const invokedAsScript =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
	void cliMain(process.argv.slice(2)).then((code) => {
		process.exit(code);
	});
}
