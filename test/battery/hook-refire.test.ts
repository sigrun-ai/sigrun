/**
 * Crash-battery item 6 (plan Task 12 step 6, spec §7 M1; 1.5.0 crash
 * semantics per spec §3.2-e): `kill -9` mid-streaming-generation while a
 * `GenerationHooks.afterResponse` hook is installed → restart → with the
 * retry pinned (`maxRetries: 0`) the run ends `unanswered` reason
 * `interrupted`, and `afterResponse` NEVER fires (an interrupted run has
 * no terminal provider message — the hook's only fire point). The
 * observed fire count finalizes the memory extension's observe-guard
 * design (spec §3 Memory row): 1.5.0 ⇒ the durable-memo guard stays
 * defensive-only. Two-process orchestration via test/battery/lib.ts; the
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
	"kill -9 mid-generation with an afterResponse hook → restart → run interrupted, hook never fires (observe-guard: defensive-only)",
	{ timeout: 120_000 },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-battery-hook-"));
		let setup: ReturnType<typeof spawnDriver> | undefined;
		try {
			const driverPath = join(DRIVER_DIR, "hook-refire.ts");
			// Setup pass: boot with the hook installed, submit, stream slowly;
			// the kill marker fires only after the partial is STORED (the
			// 1.5.0 deferred-persistence window plus slack).
			setup = spawnDriver(driverPath, ["setup", dir]);
			await setup.waitForLine("READY", BOOT_DEADLINE_MS);
			// The kill marker: the committed generation partial carries streamed
			// text (mid-token-stream — afterResponse cannot have fired yet).
			await setup.waitForLine("GENERATING", KILL_MARKER_DEADLINE_MS);
			// SIGKILL while streaming (the slow faux stream guarantees the
			// window: ~2 minutes of streaming ahead when the partial stores).
			const exit = await setup.kill();
			expect(exit.code).toBeNull();
			expect(exit.signal).toBe("SIGKILL");

			// Verify pass: reopen + resume + observe the fire count.
			const payload = await runVerifyPass(
				driverPath,
				["verify", dir],
				VERIFY_DEADLINE_MS,
			);
			// 1.5.0: the run ends unanswered/interrupted (never resent), with
			// pi.live cleared of the run and runFailure recording the reason.
			expect(payload.settledStatus).toBe("unanswered");
			expect(payload.reason).toBe("interrupted");
			expect(payload.runFailureReason).toBe("interrupted");
			expect(payload.runCleared).toBe(true);
			// afterResponse's only fire point is a terminal provider message;
			// an interrupted run has none — the crash pass adds 0 fires (the
			// driver's control turn proves the hook registration works), and
			// the observe-guard conclusion is defensive-only.
			expect(payload.hookFires).toBe(0);
			expect(typeof payload.observeGuard).toBe("string");
			// The stored partial converts to exactly one aborted entry; no
			// final answer exists.
			expect(payload.finalAnswers).toBe(0);
			expect(payload.abortedPartials).toBe(1);
		} finally {
			// Reap the setup driver promptly on the failure path (on the happy
			// path it is already dead; kill() is best-effort and never throws).
			await setup?.kill().catch(() => undefined);
			// The test owns the tmpdir lifecycle.
			await rm(dir, { recursive: true, force: true });
		}
	},
);
