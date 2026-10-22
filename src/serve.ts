/**
 * The serve boot (Task 5): the deploy entry's composition, factored out of
 * `src/index.ts` so the CLI's `run` command can reuse it (boot
 * harness+server, get the bound port, shut down on demand) while
 * `src/index.ts` — and therefore `npm start` and the cluster container
 * command — keeps the exact same deployed behavior by calling
 * {@link serve} once with signal handlers attached. Every behavior the
 * deploy-entry test pins (the bootstrap, the listening line, the
 * SIGTERM/SIGINT shutdown, the fail-loud boot) lives here.
 *
 * `loadConfig(process.env)` → settings bootstrap → `openHarness` →
 * `createServer` → listen.
 *
 * The settings bootstrap (ruling 5 / spec §6.6): on first boot the
 * store writes ONLY what the environment set (the env-sourced `server`
 * fields plus `extensions`/`defaultModel` when env supplied them —
 * defaults are never persisted), and the FINAL config re-resolves env
 * over the (possibly just-written) file (`loadConfig(env, file)`) — env
 * always wins, the file fills only what env leaves unset.
 * `SIGRUN_CONFIG_DIR` stays env-only (it locates the file itself).
 *
 * Fail-loud is the contract (the task brief): any boot error rejects the
 * boot promise; callers print it and exit 1 — a wedged deploy must crash,
 * never serve a broken process.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { envServerSection, loadConfig } from "./config.js";
import { openHarness } from "./harness/boot.js";
import { packagesDirOf, syncPackages } from "./harness/packages.js";
import { defaultSettingsDir, SettingsStore } from "./harness/settings.js";
import { createServer } from "./server/index.js";

/** A booted harness+server pair: the bound port and the ordered shutdown. */
export interface BootedServer {
	/** The port the server actually bound (the resolved `SIGRUN_PORT`). */
	readonly port: number;
	/**
	 * The ordered shutdown (spec §2, memory-seam Task 4): close the server
	 * (drain in-flight requests), run the event bus's shutdown sequence
	 * (drain pending settles, then deliver `harnessShutdown` — handlers may
	 * commit, admission is still open), stop the interval refresh scheduler
	 * and join any still-in-flight boot refresh (provider plugins Tasks 4-5
	 * — no catalog fetch outlives the shutdown), THEN close the harness
	 * (joins tasks, seals storage). Throws with all collected failures;
	 * resolves on a clean close. Does NOT exit the process — the caller owns
	 * exit policy (the deploy entry exits 0/1; the CLI's `run` returns to its
	 * exit code).
	 */
	shutdown(): Promise<void>;
	/**
	 * Idempotent {@link BootedServer.shutdown} guarded against re-entry:
	 * the deploy entry's signal path calls this (a second SIGTERM/SIGINT
	 * must not re-enter — the second harness.close() throws upstream, and
	 * which invocation reached process.exit first would be a race).
	 * Concurrent callers join the ONE in-flight shutdown.
	 */
	shutdownOnce(): Promise<void>;
}

/**
 * Boot options. The one knob is the listen host: the default is the
 * container's `0.0.0.0` (loopback-only would be unreachable behind the
 * Service); the CLI's `run` passes `127.0.0.1` — workstation mode is
 * local-only (the TUI dials loopback; the naive-identity API must not
 * answer on the LAN).
 */
export interface ServeOptions {
	/** The listen host (default `"0.0.0.0"`; `run` passes `"127.0.0.1"`). */
	readonly host?: string;
}

/**
 * Boot the harness + server composition and listen on
 * `options.host ?? "0.0.0.0"` + `<port>` (the default is the container's
 * address — loopback-only would be unreachable behind the Service;
 * `loadConfig` refuses port 0, so a real port is always bound).
 * The CLI's `run` additionally launches the TUI against the loopback URL
 * on {@link BootedServer.port}.
 */
export async function serve(
	env: NodeJS.ProcessEnv,
	options?: ServeOptions,
): Promise<BootedServer> {
	// 1. Env-only resolution (the pre-file behavior — fail-loud on a bad
	//    env value before anything is written). A file-only `defaultModel`
	//    must NOT fail here: the file has not been read yet, and step 3
	//    re-resolves with it. The env-only `envConfig` result feeds ONLY the
	//    bootstrap's `defaultModel` write, which is used only when env
	//    actually supplied the model — so skip the env-only resolution
	//    entirely when no env model is set (a file-only model otherwise
	//    throws here, before `settings.json` is ever read).
	const envHasModel =
		env.SIGRUN_DEFAULT_MODEL?.trim() !== undefined ||
		env.SIGRUN_MODEL?.trim() !== undefined;
	const envConfig = envHasModel ? loadConfig(env) : undefined;
	// 2. First-boot bootstrap (ruling 5 / spec §6.6): absent settings file
	//    → write ONLY what the environment explicitly set — the env-sourced
	//    `server` fields (`envServerSection`) plus `extensions` and
	//    `defaultModel` when env supplied them. Defaults are NEVER
	//    persisted, so later releases' default changes reach existing
	//    installs (the file records intent, not reality); a `server`
	//    section with zero entries is omitted entirely. A present file is
	//    never touched.
	const envModel =
		env.SIGRUN_DEFAULT_MODEL?.trim() || env.SIGRUN_MODEL?.trim() || undefined;
	const settingsStore = new SettingsStore({ dir: defaultSettingsDir() });
	settingsStore.bootstrap(envServerSection(env), {
		extensions:
			env.SIGRUN_EXTENSIONS?.trim() === undefined
				? undefined
				: envConfig!.extensions,
		defaultModel:
			envModel === undefined
				? undefined
				: `${envConfig!.models.provider}/${envConfig!.models.modelId}`,
	});
	// 3. Final resolution: env over the file over code defaults. The file
	//    re-read picks up whatever bootstrap wrote (or what was already
	//    there) — env still wins every field it sets.
	const config = loadConfig(env, settingsStore.read());
	// Boot-time package install (the pi-style packages dir): the settings
	// file's top-level `packages` array is the INSTALL intent — install the
	// declared specifiers into `<config-dir>/packages` and prune the
	// undeclared BEFORE any extension loads. Fail-loud: an uninstallable
	// declaration fails the boot here, naming the specifier. Steady state
	// (the dir already matches) costs one manifest read, no subprocess.
	const settingsFile = settingsStore.read();
	const packagesDir = packagesDirOf(defaultSettingsDir());
	const extensionResolutions = await syncPackages(
		settingsFile.extensions ?? [],
		packagesDir,
	);
	// The workspace directory must exist before any files endpoint or tool
	// call touches it. The deploy manifest mounts a volume at /data; the
	// workspace is /data/workspace. Without this, the first files request
	// 404s forever (the directory was never created).
	const { mkdir } = await import("node:fs/promises");
	await mkdir(config.workspace.path, { recursive: true });
	const opened = await openHarness(config, { extensionEntries: extensionResolutions });
	// The contributed-bundle registry (build-and-webui Task 6): boot folded
	// the loader's extension contributions into the name-keyed registry;
	// the server's serve-time NAME-selector resolution reads it here.
	const app = await createServer(opened, config, opened.webuiBundles, {
		listenHost: options?.host ?? "0.0.0.0",
		env,
	});
	const host = options?.host ?? "0.0.0.0";
	await app.listen({ port: config.port, host });
	// Machine-greppable: the deploy-entry test waits for this line, and an
	// operator reading pod logs sees the bound port without guessing.
	console.log(`sigrun listening on http://${host}:${config.port}`);

	const shutdown = async (): Promise<void> => {
		const failures: unknown[] = [];
		try {
			await app.close();
		} catch (error) {
			failures.push(error);
		}
		try {
			await opened.eventBus.shutdownSequence(BACKGROUND_CONTEXT);
		} catch (error) {
			failures.push(error);
		}
		try {
			// The interval refresh scheduler (provider plugins Task 5) stops
			// BEFORE the harness closes. The T4 boot refresh promise is raced
			// against a bounded join: a wedged catalog fetch must not hold the
			// ordered shutdown (and the SSE test harness's `app.close`) — the
			// refresh contract already treats abandon as a retained-catalog
			// warn, never a boot failure.
			opened.stopProviderRefresh();
			let joined = false;
			const join = opened.bootRefresh
				.then(() => {
					joined = true;
				})
				.catch(() => {});
			const BOOT_REFRESH_JOIN_MS = 2_000;
			await Promise.race([
				join,
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, BOOT_REFRESH_JOIN_MS);
					timer.unref?.();
				}),
			]);
			if (!joined) {
				console.warn(
					`sigrun: boot refresh still in flight after ${BOOT_REFRESH_JOIN_MS}ms at shutdown — abandoning the join`,
				);
			}
		} catch (error) {
			failures.push(error);
		}
		try {
			await opened.harness.close(BACKGROUND_CONTEXT);
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, "sigrun shutdown failed");
		}
	};

	let stopping: Promise<void> | undefined;
	return {
		port: config.port,
		shutdown,
		shutdownOnce: () => {
			stopping ??= shutdown();
			return stopping;
		},
	};
}
