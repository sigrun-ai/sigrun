/**
 * Crash-battery item 7 (plan Task 12 step 7, spec §7 M1, App A
 * crash-durable scheduled jobs): `kill -9` a task mid-durable-`sleep(until)`
 * → restart → the task wakes at (or after) the deadline EXACTLY ONCE — no
 * double-fire, no missed wake, no early wake. Two-process orchestration via
 * test/battery/lib.ts; the scenario driver is
 * test/battery/drivers/task-wake.ts (its header documents the task
 * definition, the marker protocol, and the timing discipline).
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
	"kill -9 mid-durable-sleep(until) → restart before the deadline → exactly one wake at/after the deadline",
	{ timeout: 120_000 },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-battery-wake-"));
		let setup: ReturnType<typeof spawnDriver> | undefined;
		try {
			const driverPath = join(DRIVER_DIR, "task-wake.ts");
			// Setup pass: boot, create the wake task (deadline ~6s out), wait
			// for the durable sleep checkpoint + START marker.
			setup = spawnDriver(driverPath, ["setup", dir]);
			await setup.waitForLine("READY", BOOT_DEADLINE_MS);
			await setup.waitForLine("SLEEPING", KILL_MARKER_DEADLINE_MS);
			// SIGKILL immediately: the kill lands INSIDE the durable sleep
			// window, comfortably before the ~6s deadline.
			const exit = await setup.kill();
			expect(exit.code).toBeNull();
			expect(exit.signal).toBe("SIGKILL");

			// Verify pass: reopen BEFORE the deadline (the driver itself
			// refuses a late boot), resume, wait past the deadline, and
			// assert exactly-once wake semantics.
			const payload = await runVerifyPass(
				driverPath,
				["verify", dir],
				VERIFY_DEADLINE_MS,
			);
			expect(payload.taskOutcome).toBe("completed");
			expect(payload.startMarkers).toBe(1);
			expect(payload.wakeMarkers).toBe(1);
			expect(payload.wokeAfterDeadline).toBe(true);
			// The wake landed at/after the deadline — the recorded margin is
			// non-negative and bounded (no pathological late wake).
			const margin = payload.marginMs as number;
			expect(margin).toBeGreaterThanOrEqual(0);
			expect(margin).toBeLessThan(20_000);
		} finally {
			// Reap the setup driver promptly on the failure path (on the happy
			// path it is already dead; kill() is best-effort and never throws).
			await setup?.kill().catch(() => undefined);
			// The test owns the tmpdir lifecycle.
			await rm(dir, { recursive: true, force: true });
		}
	},
);
