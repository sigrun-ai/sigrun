/**
 * Jobs Task 2 battery (plan Task 2): kill -9 across the fire path of a
 * `conversation:"new"` prompt job; restart → exactly one run conversation
 * and one submission per fire slot. Three kill points:
 *
 *  (a) while `waiting` (before the fire) → restart fires once;
 *  (b) right after the run conversation exists (the run record's
 *      conversationId is durable — CONVERSATION_CREATED) → restart reuses
 *      the run record; the requestId dedups the re-submission;
 *  (c) before the schedule task exists → the verify pass creates it; the
 *      fire lands with zero orphan conversations.
 *
 * The scenario driver is test/battery/drivers/job-fire.ts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DRIVER_DIR, runVerifyPass, spawnDriver } from "./lib.js";

const BOOT_DEADLINE_MS = 30_000;
const KILL_MARKER_DEADLINE_MS = 45_000;
const VERIFY_DEADLINE_MS = 90_000;

const DRIVER = join(DRIVER_DIR, "job-fire.ts");

test(
	"kill -9 while waiting → restart → exactly one run conversation for the slot",
	{ timeout: 180_000 },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-battery-jobfire-a-"));
		let setup: ReturnType<typeof spawnDriver> | undefined;
		try {
			setup = spawnDriver(DRIVER, ["setup-waiting", dir]);
			await setup.waitForLine("READY", BOOT_DEADLINE_MS);
			await setup.waitForLine("WAITING", KILL_MARKER_DEADLINE_MS);
			const exit = await setup.kill();
			expect(exit.code).toBeNull();
			expect(exit.signal).toBe("SIGKILL");

			const payload = await runVerifyPass(DRIVER, ["verify", dir], VERIFY_DEADLINE_MS);
			expect(payload.submissions).toBe(1);
			expect(payload.conversationId).toBeTypeOf("number");
			expect(["succeeded", "failed", "running"]).toContain(payload.outcome);
		} finally {
			await setup?.kill().catch(() => undefined);
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"kill -9 right after CONVERSATION_CREATED → restart → one conversation, one submission (requestId dedup)",
	{ timeout: 180_000 },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-battery-jobfire-b-"));
		let setup: ReturnType<typeof spawnDriver> | undefined;
		try {
			setup = spawnDriver(DRIVER, ["setup-created", dir]);
			await setup.waitForLine("READY", BOOT_DEADLINE_MS);
			const created = await setup.waitForLine(
				"CONVERSATION_CREATED:",
				KILL_MARKER_DEADLINE_MS,
			);
			const conversationId = Number(created.slice("CONVERSATION_CREATED:".length));
			expect(Number.isFinite(conversationId)).toBe(true);
			const exit = await setup.kill();
			expect(exit.code).toBeNull();
			expect(exit.signal).toBe("SIGKILL");

			const payload = await runVerifyPass(DRIVER, ["verify", dir], VERIFY_DEADLINE_MS);
			expect(payload.submissions).toBe(1);
			// The reused run conversation is the one the setup pass created.
			expect(payload.conversationId).toBe(conversationId);
		} finally {
			await setup?.kill().catch(() => undefined);
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"kill -9 before the task exists → verify boot creates it → one conversation, zero orphans",
	{ timeout: 180_000 },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-battery-jobfire-c-"));
		let setup: ReturnType<typeof spawnDriver> | undefined;
		try {
			setup = spawnDriver(DRIVER, ["setup-before", dir]);
			await setup.waitForLine("READY", BOOT_DEADLINE_MS);
			// Kill immediately after READY — before any schedule task exists.
			const exit = await setup.kill();
			expect(exit.code).toBeNull();
			expect(exit.signal).toBe("SIGKILL");

			const payload = await runVerifyPass(DRIVER, ["verify", dir], VERIFY_DEADLINE_MS);
			expect(payload.submissions).toBe(1);
			expect(payload.conversationId).toBeTypeOf("number");
		} finally {
			await setup?.kill().catch(() => undefined);
			await rm(dir, { recursive: true, force: true });
		}
	},
);
