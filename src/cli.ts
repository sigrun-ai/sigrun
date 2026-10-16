/**
 * The CLI entrypoints (Task 5): `sigrun` / `sigrun serve` / `sigrun attach`
 * — the package's `bin` (`"sigrun": "src/cli.ts"`, run via tsx).
 *
 * - `sigrun` (run): boot harness+server IN-PROCESS (the `src/serve.ts`
 *   composition) and launch the TUI against the loopback URL of the bound
 *   port. The spec's lifecycle rule: the agent dies with the TUI — when the
 *   TUI exits, the server+harness shut down. SIGTERM/SIGINT also stop the
 *   in-process server while the TUI runs.
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
import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "./config.js";
import { serve, type BootedServer } from "./serve.js";

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
 * locates the file itself). `{ user?, server? }`; absent dir/file → `{}`.
 * Fail-loud on a malformed file (the settings.json posture).
 */
export interface TuiFile {
	readonly user?: string;
	readonly server?: string;
}

/**
 * The config dir: `SIGRUN_CONFIG_DIR`, defaulting to
 * `~/.config/sigrun` when unset (the T5 deferred minor, absorbed in Task
 * 6 — mirroring `defaultSettingsDir()` in src/harness/settings.ts, the
 * server-side twin; `SIGRUN_CONFIG_DIR` itself stays env-only).
 */
export function defaultConfigDir(env: Env): string {
	return env.SIGRUN_CONFIG_DIR !== undefined && env.SIGRUN_CONFIG_DIR !== ""
		? env.SIGRUN_CONFIG_DIR
		: join(homedir(), ".config", "sigrun");
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
	return {
		...(user === undefined ? {} : { user }),
		...(server === undefined ? {} : { server }),
	};
}

/** The launch surface the TUI entry (Task 6/8) will provide. */
export interface LaunchTuiOptions {
	/** The server's base URL (`SigrunClient`'s `baseUrl`). */
	readonly baseUrl: string;
	/** The `X-Sigrun-User` identity; absent = the server's naive mode. */
	readonly user?: string;
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
	 * port and the shutdown the `run` lifecycle drives.
	 */
	boot(env: NodeJS.ProcessEnv): Promise<BootedServer>;
	/**
	 * The TUI entry (Task 6/8): resolves when the TUI exits. The DEFAULT
	 * throws — the TUI is not yet wired, and a bare `sigrun` says so at
	 * launch time rather than silently idling.
	 */
	launchTui(options: LaunchTuiOptions): Promise<void>;
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

/** Resolve the attach server: `--server` > tui.json > localhost default. */
function resolveServer(
	parsed: ParsedArgs,
	env: Env,
	file: TuiFile,
): string {
	if (parsed.server !== undefined) return parsed.server;
	if (file.server !== undefined) return file.server;
	const rawPort = env.SIGRUN_PORT;
	const port =
		rawPort === undefined || rawPort === ""
			? 3000
			: (() => {
					const parsedPort = Number(rawPort);
					if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
						throw new Error(
							`SIGRUN_PORT must be a positive integer, got ${rawPort}`,
						);
					}
					return parsedPort;
				})();
	return `http://localhost:${port}`;
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
		boot: (bootEnv) => serve(bootEnv),
		launchTui: async (options) => {
			// Lazy import (see the module docstring): the tui workspace must
			// never load in the deploy container's `npm start` path.
			const { launchTuiShell } = await import("../tui/src/launch.js");
			await launchTuiShell({
				baseUrl: options.baseUrl,
				...(options.user === undefined ? {} : { user: options.user }),
			});
		},
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
				});
				return 0;
			}
			case "run": {
				// The flags are parsed; the model spec fails loud inside boot
				// (loadConfig names SIGRUN_DEFAULT_MODEL).
				const file = await loadTuiFile(env);
				const user = resolveUser(parsed, env, file);
				const booted = await realDeps.boot(env);
				const stop = (): void => {
					void booted.shutdownOnce().catch((error: unknown) => {
						console.error("sigrun shutdown error:", error);
					});
				};
				process.on("SIGTERM", stop);
				process.on("SIGINT", stop);
				try {
					await realDeps.launchTui({
						baseUrl: `http://localhost:${booted.port}`,
						user,
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

const invokedAsScript = process.argv[1]?.endsWith("cli.ts") === true;
if (invokedAsScript) {
	void cliMain(process.argv.slice(2)).then((code) => {
		process.exit(code);
	});
}
