/**
 * Crash-battery item 4 (plan Task 12 step 4, spec §7 M1): duplicate-
 * `requestId` submit after a crash → single completion. Two-process
 * orchestration via test/battery/lib.ts; the scenario driver is
 * test/battery/drivers/duplicate-request-id.ts (its header documents the
 * marker protocol and the idempotence-contract assertions).
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
	"kill -9 after requestId admission → restart → duplicate requestId resubmit returns the same submission, no second run",
	{ timeout: 120_000 },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-battery-dupreq-"));
		let setup: ReturnType<typeof spawnDriver> | undefined;
		try {
			const driverPath = join(DRIVER_DIR, "duplicate-request-id.ts");
			// Setup pass: boot, submit with requestId "req-1", then slow-
			// stream; ADMITTED (the admission commit is durable) then
			// GENERATING (the committed partial carries streamed text).
			setup = spawnDriver(driverPath, ["setup", dir]);
			await setup.waitForLine("READY", BOOT_DEADLINE_MS);
			await setup.waitForLine("ADMITTED", KILL_MARKER_DEADLINE_MS);
			await setup.waitForLine("GENERATING", KILL_MARKER_DEADLINE_MS);
			// SIGKILL mid-generation with the requestId durably admitted.
			const exit = await setup.kill();
			expect(exit.code).toBeNull();
			expect(exit.signal).toBe("SIGKILL");

			// Verify pass: reopen + resume; the driver settles the crashed
			// submission, RESUBMITS the identical draft, and asserts the
			// idempotence contract (same submission id, no second run).
			const payload = await runVerifyPass(
				driverPath,
				["verify", dir],
				VERIFY_DEADLINE_MS,
			);
			expect(payload.dedupReturnedSameId).toBe(true);
			expect(payload.settledStatus).toBe("done");
			expect(payload.resubmitSettledStatus).toBe("done");
			expect(payload.sameAnswerEntry).toBe(true);
			expect(payload.finalAnswers).toBe(1);
			expect(payload.userEntriesForContent).toBe(1);
		} finally {
			// Reap the setup driver promptly on the failure path (on the happy
			// path it is already dead; kill() is best-effort and never throws).
			await setup?.kill().catch(() => undefined);
			// The test owns the tmpdir lifecycle.
			await rm(dir, { recursive: true, force: true });
		}
	},
);
