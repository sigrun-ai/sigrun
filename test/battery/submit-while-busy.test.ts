/**
 * Crash-battery item 5 (plan Task 12 step 5, spec §7 M1): submit-while-busy
 * — the named queue-semantics verification: the default `whenBusy`
 * admission is OBSERVED and recorded (queued, with its inbox mode), the
 * queued submission survives a `kill -9` (nothing lost — honest terminal
 * state after resume), and the explicit `steer`/`reject` variants are
 * recorded from the verify pass's fresh conversation. Two-process
 * orchestration via test/battery/lib.ts; the scenario driver is
 * test/battery/drivers/submit-while-busy.ts.
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
	"kill -9 with a durably queued submission → restart → queued input not lost; steer queues, reject rejects",
	{ timeout: 120_000 },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-battery-busy-"));
		let setup: ReturnType<typeof spawnDriver> | undefined;
		try {
			const driverPath = join(DRIVER_DIR, "submit-while-busy.ts");
			// Setup pass: first turn streams slowly; the second input (NO
			// whenBusy — the default) is durably queued in pi.inbox; the
			// kill marker QUEUED:<mode> carries the observed inbox mode.
			setup = spawnDriver(driverPath, ["setup", dir]);
			await setup.waitForLine("READY", BOOT_DEADLINE_MS);
			const queuedMarker = await setup.waitForLine(
				"QUEUED:",
				KILL_MARKER_DEADLINE_MS,
			);
			// The observed default whenBusy admission mode is one of the
			// known queue semantics.
			const observedMode = queuedMarker.slice("QUEUED:".length);
			expect(observedMode).toMatch(/^(steer|followUp)$/);
			// SIGKILL with the queued submission durably admitted.
			const exit = await setup.kill();
			expect(exit.code).toBeNull();
			expect(exit.signal).toBe("SIGKILL");

			// Verify pass: reopen + resume; both submissions recover, the
			// queued input reaches an honest terminal state, and the steer/
			// reject variants are observed on a fresh conversation.
			const payload = await runVerifyPass(
				driverPath,
				["verify", dir],
				VERIFY_DEADLINE_MS,
			);
			// The recorded OBSERVED behavior (spec: observe + record): the
			// default admission queued the input — nothing rejected/lost.
			expect(payload.observedDefaultMode).toMatch(/^(steer|followUp)$/);
			expect(payload.secondInitialStatus).toBe("queued");
			// Nothing lost across the crash.
			expect(payload.firstSettledStatus).toBe("done");
			expect(payload.secondSettledStatus).toMatch(/^(done|unanswered)$/);
			// The explicit variants.
			expect(payload.steerObservedMode).toBe("steer");
			expect(payload.rejectRejected).toBe(true);
		} finally {
			// Reap the setup driver promptly on the failure path (on the happy
			// path it is already dead; kill() is best-effort and never throws).
			await setup?.kill().catch(() => undefined);
			// The test owns the tmpdir lifecycle.
			await rm(dir, { recursive: true, force: true });
		}
	},
);
