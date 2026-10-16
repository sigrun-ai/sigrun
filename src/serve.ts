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
 * The settings bootstrap (the settings-file parity piece): env resolves
 * the server section ONCE (`loadConfig(env)` — env-only, exactly the
 * pre-file resolution); the store then writes that resolved section on
 * first boot only, and the FINAL config re-resolves env over the
 * (possibly just-written) file (`loadConfig(env, file)`) — env always
 * wins, the file fills only what env leaves unset. `SIGRUN_CONFIG_DIR`
 * stays env-only (it locates the file itself).
 *
 * Fail-loud is the contract (the task brief): any boot error rejects the
 * boot promise; callers print it and exit 1 — a wedged deploy must crash,
 * never serve a broken process.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig, resolvedServerSection } from "./config.js";
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
	 * commit, admission is still open), THEN close the harness (joins tasks,
	 * seals storage). Throws with all collected failures; resolves on a
	 * clean close. Does NOT exit the process — the caller owns exit policy
	 * (the deploy entry exits 0/1; the CLI's `run` returns to its exit
	 * code).
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
	//    env value before anything is written).
	const envConfig = loadConfig(env);
	// 2. First-boot bootstrap: absent settings file → write the RESOLVED
	//    boot configuration (server section incl. webuiBundle, plus the
	//    resolved extension list, and defaultModel when the env provided
	//    it) as the deployment's visible baseline — the file records
	//    reality. A present file is never touched.
	const settingsStore = new SettingsStore({ dir: defaultSettingsDir() });
	settingsStore.bootstrap(resolvedServerSection(envConfig), {
		extensions: envConfig.extensions,
		defaultModel: `${envConfig.models.provider}/${envConfig.models.modelId}`,
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
	const app = await createServer(opened, config);
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
