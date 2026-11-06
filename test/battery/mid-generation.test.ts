/**
 * Crash-battery item 1 (plan Task 12 step 1, spec §7 M1; 1.5.0 crash
 * semantics per spec §3.2-e): `kill -9` mid-streaming-generation → restart
 * → the in-flight request is NEVER resent — it is a failed attempt under
 * `settings.retry` (pinned `maxRetries: 0` in the driver), so the run ends
 * `unanswered` reason `interrupted` with `pi.live.runFailure.reason ===
 * "interrupted"`, no final answer, the stored partial as exactly one
 * aborted entry, and `pi.live.run` cleared (not stuck busy). Two-process
 * orchestration via test/battery/lib.ts; the scenario driver is
 * test/battery/drivers/mid-generation.ts (its header documents the marker
 * protocol and the stored-state mid-generation observable).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DRIVER_DIR, runVerifyPass, spawnDriver } from "./lib.js";

/** Marker-wait deadlines (fail loud, never at vitest's default timeout). */
const BOOT_DEADLINE_MS = 30_000;
const KILL_MARKER_DEADLINE_MS = 30_000;
const VERIFY_DEADLINE_MS = 60_000;

test(
	"kill -9 mid-streaming-generation → restart → run ends interrupted, never resent, not stuck busy",
	{ timeout: 120_000 },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-battery-gen-"));
		let setup: ReturnType<typeof spawnDriver> | undefined;
		try {
			const driverPath = join(DRIVER_DIR, "mid-generation.ts");
			// Setup pass: boot, submit, stream slowly; the kill marker fires
			// only after the streamed partial is STORED (the 1.5.0 deferred-
			// persistence window plus slack — STORE_SETTLE_MS in the driver).
			setup = spawnDriver(driverPath, ["setup", dir]);
			await setup.waitForLine("READY", BOOT_DEADLINE_MS);
			await setup.waitForLine("GENERATING", KILL_MARKER_DEADLINE_MS);
			// SIGKILL while streaming (the slow faux stream guarantees the
			// window: ~2 minutes of streaming ahead when the partial stores).
			const exit = await setup.kill();
			expect(exit.code).toBeNull();
			expect(exit.signal).toBe("SIGKILL");

			// Verify pass: reopen + resume + assert the 1.5.0 outcome.
			const payload = await runVerifyPass(
				driverPath,
				["verify", dir],
				VERIFY_DEADLINE_MS,
			);
			// 1.5.0: settled unanswered reason "interrupted"; the view's
			// pi.live.runFailure records it and pi.live.run is cleared.
			expect(payload.settledStatus).toBe("unanswered");
			expect(payload.reason).toBe("interrupted");
			expect(payload.runFailureReason).toBe("interrupted");
			expect(payload.runCleared).toBe(true);
			// No resend → no final answer; the stored partial is exactly one
			// aborted entry.
			expect(payload.finalAnswers).toBe(0);
			expect(payload.abortedPartials).toBe(1);
			expect(payload.outcome).toBe("aborted");
		} finally {
			// Reap the setup driver promptly on the failure path (on the happy
			// path it is already dead; kill() is best-effort and never throws).
			await setup?.kill().catch(() => undefined);
			// The test owns the tmpdir lifecycle.
			await rm(dir, { recursive: true, force: true });
		}
	},
);
