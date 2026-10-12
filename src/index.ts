/**
 * The deploy entry (Task 13) — the composition the Deployment's container
 * command runs:
 *
 * `loadConfig(process.env)` → `openHarness` → `createServer` → listen.
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
import { loadConfig } from "./config.js";
import { openHarness } from "./harness/boot.js";
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
	const config = loadConfig(process.env);
	// The workspace directory must exist before any files endpoint or tool
	// call touches it. The deploy manifest mounts a volume at /data; the
	// workspace is /data/workspace. Without this, the first files request
	// 404s forever (the directory was never created).
	const { mkdir } = await import("node:fs/promises");
	await mkdir(config.workspace.path, { recursive: true });
	const opened = await openHarness(config);
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
