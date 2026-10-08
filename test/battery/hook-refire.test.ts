/**
 * Crash-battery item 6 (plan Task 12 step 6, spec §7 M1): `kill -9`
 * mid-streaming-generation while a `GenerationHooks.afterResponse` hook is
 * installed → restart → the hook's OBSERVED fire count across both
 * processes finalizes the memory extension's observe-guard design (spec §3
 * Memory row). Two-process orchestration via test/battery/lib.ts; the
 * scenario driver is test/battery/drivers/hook-refire.ts (its header
 * documents the marker protocol and the fire-count semantics).
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
	"kill -9 mid-generation with an afterResponse hook → restart → observed fire count recorded (observe-guard design finalized)",
	{ timeout: 120_000 },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-battery-hook-"));
		let setup: ReturnType<typeof spawnDriver> | undefined;
		try {
			const driverPath = join(DRIVER_DIR, "hook-refire.ts");
			// Setup pass: boot with the hook installed, submit, stream slowly.
			setup = spawnDriver(driverPath, ["setup", dir]);
			await setup.waitForLine("READY", BOOT_DEADLINE_MS);
			// The kill marker: the committed generation partial carries streamed
			// text (mid-token-stream — afterResponse cannot have fired yet).
			await setup.waitForLine("GENERATING", KILL_MARKER_DEADLINE_MS);
			// SIGKILL while streaming (the slow faux stream guarantees the
			// window: ~2 minutes of streaming ahead when the partial commits).
			const exit = await setup.kill();
			expect(exit.code).toBeNull();
			expect(exit.signal).toBe("SIGKILL");

			// Verify pass: reopen + resume + observe the fire count.
			const payload = await runVerifyPass(
				driverPath,
				["verify", dir],
				VERIFY_DEADLINE_MS,
			);
			// The turn completed with exactly one final answer (non-vacuity:
			// a completed turn guarantees the recovered run classified one
			// terminal provider message — the hook's only fire point).
			expect(payload.settledStatus).toBe("done");
			expect(payload.finalAnswers).toBe(1);
			// The OBSERVED fire count is the payload: a positive integer,
			// recorded verbatim (1 = no re-fire, ≥2 = re-fired on replay).
			// The driver itself guards the vacuous extremes (0 fires with a
			// completed turn, or setup-side fires before the kill).
			expect(payload.hookFires).toBeGreaterThanOrEqual(1);
			expect(typeof payload.observeGuard).toBe("string");
		} finally {
			// Reap the setup driver promptly on the failure path (on the happy
			// path it is already dead; kill() is best-effort and never throws).
			await setup?.kill().catch(() => undefined);
			// The test owns the tmpdir lifecycle.
			await rm(dir, { recursive: true, force: true });
		}
	},
);
