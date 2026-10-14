/**
 * The deploy entry (Task 13) — the composition the Deployment's container
 * command runs:
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
 * boot promise, is printed, and exits 1 — a wedged deploy must crash, never
 * serve a broken process. Graceful shutdown on SIGTERM/SIGINT (the kubelet
 * stop path): close the server first (drain in-flight requests), then the
 * harness (joins tasks, seals storage), then exit 0 — the deploy-entry test
 * asserts exactly this.
 *
 * `npm start` runs this via tsx (the repo's internal imports use `.js`
 * specifiers resolving to `.ts` sources, which stock node cannot resolve —
 * same rule as the backup CronJob's image note).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig, resolvedServerSection } from "./config.js";
import { openHarness } from "./harness/boot.js";
import { packagesDirOf, syncPackages } from "./harness/packages.js";
import { defaultSettingsDir, SettingsStore } from "./harness/settings.js";
import { createServer } from "./server/index.js";

/** Close server then harness; exit 0 on clean close, 1 on any failure. */
async function shutdown(
	app: Awaited<ReturnType<typeof createServer>>,
	harness: { close(context: typeof BACKGROUND_CONTEXT): Promise<unknown> },
): Promise<never> {
	const failures: unknown[] = [];
	try {
		await app.close();
	} catch (error) {
		failures.push(error);
	}
	try {
		await harness.close(BACKGROUND_CONTEXT);
	} catch (error) {
		failures.push(error);
	}
	if (failures.length > 0) {
		for (const failure of failures) {
			console.error("sigrun shutdown error:", failure);
		}
		process.exit(1);
	}
	process.exit(0);
}

async function main(): Promise<void> {
	// 1. Env-only resolution (the pre-file behavior — fail-loud on a bad
	//    env value before anything is written).
	const envConfig = loadConfig(process.env);
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
	const config = loadConfig(process.env, settingsStore.read());
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
	// 0.0.0.0: the container's address (loopback-only would be unreachable
	// behind the Service). The port is SIGRUN_PORT (config default 3000) —
	// loadConfig refuses 0, so a real port is always bound.
	await app.listen({ port: config.port, host: "0.0.0.0" });
	// Machine-greppable: the deploy-entry test waits for this line, and an
	// operator reading pod logs sees the bound port without guessing.
	console.log(`sigrun listening on http://0.0.0.0:${config.port}`);
	// A second signal (Ctrl-C twice, or SIGTERM+SIGINT) must not re-enter
	// shutdown: the second harness.close() throws upstream, and which
	// invocation reaches process.exit first would be a race — a benign
	// double-signal could exit 1. The guard makes the first signal win.
	let stopping = false;
	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		void shutdown(app, opened.harness);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}

main().catch((error: unknown) => {
	console.error("sigrun boot failed:", error);
	process.exit(1);
});
