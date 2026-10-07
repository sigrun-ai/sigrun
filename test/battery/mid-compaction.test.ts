/**
 * Crash-battery item 3 (plan Task 12 step 3, spec §7 M1, Review Focus #5):
 * `kill -9` during a background compaction → resume succeeds, no
 * half-written summary, committed turns intact, view serializes,
 * subsequent submits succeed. Two-process orchestration via
 * test/battery/lib.ts; the scenario driver is
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
	"kill -9 mid-background-compaction → restart → resume succeeds, no half-written summary, turns intact",
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

			// Verify pass: reopen + resume; the compaction task re-runs from
			// its durable checkpoint and every Review-Focus-#5 assertion runs
			// in the driver (fail-loud VERIFY-FAIL reasons surface through
			// runVerifyPass).
			const payload = await runVerifyPass(
				driverPath,
				["verify", dir],
				VERIFY_DEADLINE_MS,
			);
			expect(payload.compactionOutcome).toBe("completed");
			expect(payload.summaryEntries).toBe(1);
			expect(payload.summaryWellFormed).toBe(true);
			expect(payload.summarizeRequests).toEqual(["setup", "verify"]);
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
