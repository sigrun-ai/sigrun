/**
 * The deploy entry (Task 13) — the composition the Deployment's container
 * command runs. The composition itself lives in `src/serve.ts` (extracted
 * in Task 5 so the CLI's `run` command can reuse it); this entry is the
 * serve-only invocation of it: boot via `serve(process.env)`, attach the
 * SIGTERM/SIGINT graceful shutdown (close the server first — drain
 * in-flight requests — then the event-bus shutdown sequence, then the
 * harness; exit 0 on a clean close, 1 on any failure), and fail loud on
 * any boot error (exit 1 — a wedged deploy must crash, never serve a
 * broken process). The deploy-entry test asserts exactly this.
 *
 * `npm start` runs this via tsx — the DEV shape (the repo's internal
 * imports use `.js` specifiers resolving to `.ts` sources, which stock
 * node cannot resolve). Deployed entries run the BUILT form instead
 * (plain `node dist/index.js`; the Dockerfile CMD, the chart's container
 * command, and docker-compose all do — see CHANGELOG's packaging entry).
 */

import { serve } from "./serve.js";

async function main(): Promise<void> {
	const booted = await serve(process.env);
	// A second signal (Ctrl-C twice, or SIGTERM+SIGINT) must not re-enter
	// shutdown (see BootedServer.shutdownOnce); the guard makes the first
	// signal win.
	const stop = (): void => {
		void booted
			.shutdownOnce()
			.then(() => process.exit(0))
			.catch((error: unknown) => {
				console.error("sigrun shutdown error:", error);
				process.exit(1);
			});
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}

main().catch((error: unknown) => {
	console.error("sigrun boot failed:", error);
	process.exit(1);
});
