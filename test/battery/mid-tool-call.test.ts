/**
 * Crash-battery item 2 (plan Task 12 step 2, spec §7 M1; 1.5.0 crash
 * semantics per spec §3.2-e): `kill -9` mid-tool-call → restart-limited
 * tools no longer park. With `settings.restartLimit` pinned to 1, the
 * first recovery of the cut-off round ENDS each cut-off tool with a
 * visible error result carrying diagnostic code `restart_limit` — NEITHER
 * tool's body re-runs (the execution marker files are the
 * no-duplicate-side-effect evidence: exactly one execution each, from the
 * killed process). Two-process orchestration via test/battery/lib.ts;
 * the scenario driver is test/battery/drivers/mid-tool-call.ts (its
 * header documents the marker protocol and the restart_limit semantics).
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
	"kill -9 mid-tool-call → restart → both cut-off tools end restart_limited, never re-executed (at-most-once marker)",
	{ timeout: 120_000 },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-battery-tool-"));
		let setup: ReturnType<typeof spawnDriver> | undefined;
		try {
			const driverPath = join(DRIVER_DIR, "mid-tool-call.ts");
			// Setup pass: boot with both tools registered, submit; both tools
			// start (parallel round), print their markers, and block.
			setup = spawnDriver(driverPath, ["setup", dir]);
			await setup.waitForLine("READY", BOOT_DEADLINE_MS);
			await setup.waitForLine("TOOL_RUNNING:unsafe_write", KILL_MARKER_DEADLINE_MS);
			await setup.waitForLine("TOOL_RUNNING:safe_read", KILL_MARKER_DEADLINE_MS);
			// SIGKILL while both tools are blocked mid-execution (they sleep
			// 120s; the markers fired only after the replay-intent checkpoint
			// committed, so the kill lands with the decision durable).
			const exit = await setup.kill();
			expect(exit.code).toBeNull();
			expect(exit.signal).toBe("SIGKILL");

			// Verify pass: reopen + resume; the restart-limited tools END and
			// the assertions run in the driver (fail-loud VERIFY-FAIL reasons
			// surface through runVerifyPass).
			const payload = await runVerifyPass(
				driverPath,
				["verify", dir],
				VERIFY_DEADLINE_MS,
			);
			// The no-duplicate-side-effect invariant (1.5.0: at the pinned
			// limit NEITHER tool re-executes): exactly one execution each.
			expect(payload.unsafeExecutions).toBe(1);
			expect(payload.safeExecutions).toBe(1);
			// Both cut-off tools ended with the visible restart_limit error.
			expect(payload.unsafeRestartLimited).toBe(true);
			expect(payload.safeRestartLimited).toBe(true);
			// The run ENDED (never stuck busy); whether it failed with a
			// runFailure or continued from the error results to an answer is
			// upstream's settled behavior — the driver verified one held.
			expect(payload.runCleared).toBe(true);
		} finally {
			// Reap the setup driver promptly on the failure path (on the happy
			// path it is already dead; kill() is best-effort and never throws).
			await setup?.kill().catch(() => undefined);
			// The test owns the tmpdir lifecycle.
			await rm(dir, { recursive: true, force: true });
		}
	},
);
