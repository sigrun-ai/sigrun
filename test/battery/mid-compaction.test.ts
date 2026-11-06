/**
 * Crash-battery item 3 (plan Task 12 step 3, spec §7 M1, Review Focus #5;
 * 1.5.0 crash semantics per spec §3.2-e): `kill -9` during a background
 * compaction → the restart-limited compaction no longer parks nor
 * re-runs: with `settings.restartLimit` pinned to 1, the first recovery
 * ENDS the cut-off compaction task (failed) into
 * `pi.live.compactionFailure`, the summarize request fires in SETUP ONLY
 * (never re-requested), NO summary entry is ever placed (no half-written
 * summary is possible), the committed turns stay intact, the view
 * serializes, and subsequent submits succeed. Two-process orchestration
 * via test/battery/lib.ts; the scenario driver is
 * test/battery/drivers/mid-compaction.ts (its header documents the marker
 * protocol and the mid-compaction observable).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DRIVER_DIR, runVerifyPass, spawnDriver } from "./lib.js";

/** Marker-wait deadlines (fail loud, never at vitest's default timeout). */
const BOOT_DEADLINE_MS = 30_000;
const KILL_MARKER_DEADLINE_MS = 60_000;
const VERIFY_DEADLINE_MS = 90_000;

test(
"kill -9 mid-background-compaction → restart → restart-limited compaction ENDS into pi.live.compactionFailure, no summary, turns intact",
{ timeout: 150_000 },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-battery-compact-"));
		let setup: ReturnType<typeof spawnDriver> | undefined;
		try {
			const driverPath = join(DRIVER_DIR, "mid-compaction.ts");
			// Setup pass: warm-up turn, turn 2 inside the background band —
			// upstream creates a conversation-owned background compaction;
			// the driver waits for its summarize request to START, with no
			// summary placed yet, then prints COMPACTING.
			setup = spawnDriver(driverPath, ["setup", dir]);
			await setup.waitForLine("READY", BOOT_DEADLINE_MS);
			await setup.waitForLine("COMPACTING", KILL_MARKER_DEADLINE_MS);
			// SIGKILL while the summarizer streams its slow summary (the
			// marker fired only with the compaction task durably listed, its
			// request started, and NO summary entry placed — the kill is
			// provably mid-compaction, not before or after it).
			const exit = await setup.kill();
			expect(exit.code).toBeNull();
			expect(exit.signal).toBe("SIGKILL");

			// Verify pass: reopen + resume; the restart-limited compaction
			// ENDS (failed) into pi.live.compactionFailure and every
			// Review-Focus-#5 assertion runs in the driver (fail-loud
			// VERIFY-FAIL reasons surface through runVerifyPass).
			const payload = await runVerifyPass(
				driverPath,
				["verify", dir],
				VERIFY_DEADLINE_MS,
			);
			// 1.5.0: the cut-off compaction task ENDS failed (never completes).
			expect(payload.compactionOutcome).toBe("failed");
			// The failure is recorded in pi.live.compactionFailure.
			expect(payload.compactionFailureRecorded).toBe(true);
			// No summary entry is ever placed (no half-written summary).
			expect(payload.summaryEntries).toBe(0);
			// The summarize request fired in SETUP ONLY — the restart-limited
			// compaction never re-requests it.
			expect(payload.summarizeRequests).toEqual(["setup"]);
			expect(payload.preKillTurnsIntact).toBe(true);
			expect(payload.viewSerializes).toBe(true);
			expect(payload.subsequentSubmitStatus).toBe("done");
		} finally {
			// Reap the setup driver promptly on the failure path (on the happy
			// path it is already dead; kill() is best-effort and never throws).
			await setup?.kill().catch(() => undefined);
			// The test owns the tmpdir lifecycle.
			await rm(dir, { recursive: true, force: true });
		}
	},
);
