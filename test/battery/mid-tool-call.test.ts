/**
 * Crash-battery item 2 (plan Task 12 step 2, spec §7 M1): `kill -9`
 * mid-tool-call → safe tools may re-execute; unsafe tools must NOT silently
 * re-execute (ended failed with visible state). Two-process orchestration
 * via test/battery/lib.ts; the scenario driver is
 * test/battery/drivers/mid-tool-call.ts (its header documents the marker
 * protocol and the at-most-once execution-marker evidence).
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
	"kill -9 mid-tool-call → restart → unsafe tool never silently re-executes (at-most-once marker), safe tool may",
	{ timeout: 120_000 },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-battery-tool-"));
		try {
			const driverPath = join(DRIVER_DIR, "mid-tool-call.ts");
			// Setup pass: boot with both tools registered, submit; both tools
			// start (parallel round), print their markers, and block.
			const setup = spawnDriver(driverPath, ["setup", dir]);
			await setup.waitForLine("READY", BOOT_DEADLINE_MS);
			await setup.waitForLine("TOOL_RUNNING:unsafe_write", KILL_MARKER_DEADLINE_MS);
			await setup.waitForLine("TOOL_RUNNING:safe_read", KILL_MARKER_DEADLINE_MS);
			// SIGKILL while both tools are blocked mid-execution (they sleep
			// 120s; the markers fired only after the replay-intent checkpoint
			// committed, so the kill lands with the decision durable).
			const exit = await setup.kill();
			expect(exit.code).toBeNull();
			expect(exit.signal).toBe("SIGKILL");

			// Verify pass: reopen + resume; the tool tasks recover under the
			// replay rule and the assertions run in the driver (fail-loud
			// VERIFY-FAIL reasons surface through runVerifyPass).
			const payload = await runVerifyPass(
				driverPath,
				["verify", dir],
				VERIFY_DEADLINE_MS,
			);
			// The unsafe-tool invariant (the item's exit criterion): at most
			// one execution across both processes, and its result entry is a
			// VISIBLE interrupted error, never a silent re-execution.
			expect(payload.unsafeExecutions).toBeLessThanOrEqual(1);
			expect(payload.unsafeInterrupted).toBe(true);
			// The safe tool may re-execute once on recovery.
			expect(payload.safeExecutions).toBeGreaterThanOrEqual(1);
			expect(payload.safeExecutions).toBeLessThanOrEqual(2);
			// The recovered conversation completes with one final answer.
			expect(payload.settledStatus).toBe("done");
			expect(payload.finalAnswers).toBe(1);
		} finally {
			// The test owns the tmpdir lifecycle.
			await rm(dir, { recursive: true, force: true });
		}
	},
);
