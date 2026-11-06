/**
 * Crash-battery item 1 (plan Task 12 step 1, spec §7 M1; 1.5.0 crash
 * semantics per spec §3.2-e): `kill -9` mid-streaming-generation → restart
 * → the in-flight request is a failed attempt under `settings.retry`,
 * NEVER blindly resent. TWO verify passes cover both outcomes:
 * - `verify` (retry pinned `maxRetries: 0`): no retry left → the run ends
 *   `unanswered` reason `interrupted`, `pi.live.runFailure.reason` matches,
 *   no final answer, exactly one aborted entry (the stored partial).
 * - `verify-retry` (DEFAULT retry, maxRetries 3): the charged attempt
 *   RE-RUNS against the fresh provider → settled `done`, exactly one
 *   aborted entry followed by exactly one final answer.
 * Both: `pi.live.run` cleared (not stuck busy). Two-process orchestration
 * via test/battery/lib.ts; the scenario driver is
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
	"kill -9 mid-streaming-generation → restart → interrupted (no retry) or retried-done; never stuck busy",
	{ timeout: 180_000 },
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

			// Outcome (b): retry pinned to maxRetries 0 — the killed attempt
			// has no retry left, so the run ends interrupted.
			const interruptedPayload = await runVerifyPass(
				driverPath,
				["verify", dir],
				VERIFY_DEADLINE_MS,
			);
			expect(interruptedPayload.settledStatus).toBe("unanswered");
			expect(interruptedPayload.reason).toBe("interrupted");
			expect(interruptedPayload.runFailureReason).toBe("interrupted");
			expect(interruptedPayload.runCleared).toBe(true);
			expect(interruptedPayload.finalAnswers).toBe(0);
			expect(interruptedPayload.abortedPartials).toBe(1);
			expect(interruptedPayload.outcome).toBe("aborted");

			// Outcome (a): a SEPARATE killed scenario retried with the default
			// policy — the charged attempt re-runs and the turn completes.
			// A fresh setup pass keeps the killed state independent.
			const dir2 = await mkdtemp(join(tmpdir(), "sigrun-battery-gen-retry-"));
			let setup2: ReturnType<typeof spawnDriver> | undefined;
			try {
				setup2 = spawnDriver(driverPath, ["setup", dir2]);
				await setup2.waitForLine("READY", BOOT_DEADLINE_MS);
				await setup2.waitForLine("GENERATING", KILL_MARKER_DEADLINE_MS);
				const exit2 = await setup2.kill();
				expect(exit2.code).toBeNull();
				expect(exit2.signal).toBe("SIGKILL");
				const retriedPayload = await runVerifyPass(
					driverPath,
					["verify-retry", dir2],
					VERIFY_DEADLINE_MS,
				);
				expect(retriedPayload.settledStatus).toBe("done");
				expect(retriedPayload.outcome).toBe("completed");
				expect(retriedPayload.runCleared).toBe(true);
				// The retry answered exactly once, after exactly one aborted
				// partial (the stored interrupted attempt).
				expect(retriedPayload.abortedPartials).toBe(1);
				expect(retriedPayload.finalAnswers).toBe(1);
			} finally {
				await setup2?.kill().catch(() => undefined);
				await rm(dir2, { recursive: true, force: true });
			}
		} finally {
			// Reap the setup driver promptly on the failure path (on the happy
			// path it is already dead; kill() is best-effort and never throws).
			await setup?.kill().catch(() => undefined);
			// The test owns the tmpdir lifecycle.
			await rm(dir, { recursive: true, force: true });
		}
	},
);
