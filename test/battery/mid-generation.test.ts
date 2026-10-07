/**
 * Crash-battery item 1 (plan Task 12 step 1, spec §7 M1): `kill -9`
 * mid-streaming-generation → restart → the answer completes OR is marked
 * aborted; no duplicate final answer. Two-process orchestration via
 * test/battery/lib.ts; the scenario driver is
 * test/battery/drivers/mid-generation.ts (its header documents the marker
 * protocol and the chosen mid-generation observable).
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
	"kill -9 mid-streaming-generation → restart → exactly one terminal outcome, no duplicate final answer",
	{ timeout: 120_000 },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-battery-gen-"));
		try {
			const driverPath = join(DRIVER_DIR, "mid-generation.ts");
			// Setup pass: boot, submit, stream slowly.
			const setup = spawnDriver(driverPath, ["setup", dir]);
			await setup.waitForLine("READY", BOOT_DEADLINE_MS);
			// The kill marker: the committed generation partial exists.
			await setup.waitForLine("GENERATING", KILL_MARKER_DEADLINE_MS);
			// SIGKILL while streaming (the slow faux stream guarantees the
			// window: ~2 minutes of streaming ahead when the partial commits).
			const exit = await setup.kill();
			expect(exit.code).toBeNull();
			expect(exit.signal).toBe("SIGKILL");

			// Verify pass: reopen + resume + assert.
			const payload = await runVerifyPass(
				driverPath,
				["verify", dir],
				VERIFY_DEADLINE_MS,
			);
			expect(payload.settledStatus).toMatch(/^(done|unanswered)$/);
			const outcome = payload.outcome;
			expect(outcome).toMatch(/^(completed|aborted)$/);
			if (outcome === "completed") {
				// Exactly one final answer; the interrupted attempt's partial
				// may persist as an aborted assistant entry (visible state, not
				// a duplicate answer).
				expect(payload.finalAnswers).toBe(1);
			} else {
				expect(payload.finalAnswers).toBe(0);
			}
		} finally {
			// The test owns the tmpdir lifecycle.
			await rm(dir, { recursive: true, force: true });
		}
	},
);
