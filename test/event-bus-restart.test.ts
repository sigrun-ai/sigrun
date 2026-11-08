/**
 * Durable run-settled Task 3: boot replays terminal-but-undelivered runs
 * before resuming interrupted runs. One faux provider and one fixture module
 * survive two real openHarness boots over the same SQLite database.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { SubmissionId } from "@earendil-works/pi-durable";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import {
	EventBus,
	RunDeliveryDoc,
} from "../src/harness/event-bus.js";
import { seededIdentity } from "./helpers/identity.js";
import {
	blockRunSettled,
	events,
	releaseRunSettled,
	resetRunRestartFixture,
	waitForBlockedRunSettled,
} from "./fixtures/fixture-run-restart/index.js";

const FIXTURE = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-run-restart", "index.js"),
).href;

interface RestartRig {
	readonly dir: string;
	readonly faux: FauxProviderHandle;
	readonly opened: OpenedHarness;
}

const rigs: RestartRig[] = [];
const dirs: string[] = [];

afterEach(async () => {
	releaseRunSettled();
	resetRunRestartFixture();
	vi.restoreAllMocks();
	for (const rig of rigs.splice(0)) {
		await rig.opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
	}
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The bootBus shape, with retry off and a short blocked-handler deadline. */
async function boot(dir: string, faux: FauxProviderHandle): Promise<RestartRig> {
	const configDir = join(dir, "config");
	const env = {
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_CONFIG_DIR: configDir,
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_AUTH: "none",
		SIGRUN_TIMEZONE: "UTC",
	};
	const config = loadConfig(env);
	const opened = await openHarness(config, {
		identity: await seededIdentity(configDir, "root-admin"),
		extensions: [{ name: "ext-faux", providers: [{ provider: faux.provider }] }],
		builtins: false,
		extensionSpecifiers: [FIXTURE],
		env,
		settingsDir: dir,
		settings: { retry: { enabled: false } },
		eventBus: { hookDeadlineMs: 50, shutdownSettleWaitMs: 50 },
	});
	const rig = { dir, faux, opened };
	rigs.push(rig);
	return rig;
}

async function newRig(): Promise<RestartRig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-event-bus-restart-"));
	dirs.push(dir);
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	return await boot(dir, faux);
}

async function root(rig: RestartRig) {
	return await rig.opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: rig.opened.defaultModel },
	});
}

async function runTurn(rig: RestartRig, input: string) {
	const conversation = await root(rig);
	const submission = await conversation.submit(
		{ type: "input", content: input },
		BACKGROUND_CONTEXT,
	);
	const record = await submission.wait(BACKGROUND_CONTEXT);
	return { conversation, submission, record };
}

/** A held first model call; its gate survives into the second boot. */
function holdRun(faux: FauxProviderHandle): { release: () => void } {
	let resolve!: (message: AssistantMessage) => void;
	const gate = new Promise<AssistantMessage>((res) => {
		resolve = res;
	});
	faux.setResponses([async () => await gate]);
	return { release: () => resolve(fauxAssistantMessage("resumed answer")) };
}

/** Seed one delivered run so replay has a durable marker above zero. */
async function seedMarker(rig: RestartRig): Promise<number> {
	rig.faux.setResponses([fauxAssistantMessage("marker answer")]);
	const seeded = await runTurn(rig, "seed marker");
	expect(seeded.record.status).toBe("done");
	await rig.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
	const marker = await rig.opened.harness.snapshot(RunDeliveryDoc, BACKGROUND_CONTEXT);
	expect(marker?.through).toBeGreaterThan(seeded.submission.id);
	return marker!.through;
}

async function closeFirst(rig: RestartRig): Promise<void> {
	rig.opened.eventBus.close();
	await rig.opened.harness.close(BACKGROUND_CONTEXT);
}

function recordedFor(submissionId: SubmissionId) {
	return events.filter((event) => event.inputs.includes(submissionId));
}

describe("boot startup replay", () => {
	test("a job run whose event was lost settles after restart", { timeout: 20_000 }, async () => {
		const first = await newRig();
		await seedMarker(first);
		const job = await first.opened.jobs.createApi({
			name: "acme-daily",
			schedule: { at: "2099-01-01T00:00:00.000Z" },
			action: { kind: "prompt", prompt: "acme daily check", conversation: "new" },
		} satisfies JobSpec, "root-admin");
		blockRunSettled();
		first.faux.setResponses([fauxAssistantMessage("job answer")]);
		const fire = await first.opened.jobs.runNow(job.id);
		expect(fire.conversationId).toBeTypeOf("number");
		await first.opened.harness.waitForIdle(BACKGROUND_CONTEXT);
		await waitForBlockedRunSettled();
		expect((await first.opened.jobs.get(job.id))?.lastRun?.outcome).toBe("running");
		await closeFirst(first);
		releaseRunSettled();
		resetRunRestartFixture();

		const second = await boot(first.dir, first.faux);
		await second.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		expect((await second.opened.jobs.get(job.id))?.lastRun?.outcome).toBe("succeeded");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			conversationId: fire.conversationId,
			inputTexts: ["acme daily check"],
			replayed: true,
			outcome: "answered",
		});
	});

	test("a run resumed after restart is delivered once", { timeout: 20_000 }, async () => {
		const first = await newRig();
		await seedMarker(first);
		const gate = holdRun(first.faux);
		const conversation = await root(first);
		const held = await conversation.submit(
			{ type: "input", content: "held through restart" },
			BACKGROUND_CONTEXT,
		);
		await vi.waitFor(async () => {
			expect((await held.status(BACKGROUND_CONTEXT)).status).toBe("placed");
		});
		await closeFirst(first);
		resetRunRestartFixture();

		const second = await boot(first.dir, first.faux);
		await second.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		const resumed = await second.opened.harness.submission(held.id, BACKGROUND_CONTEXT);
		expect(resumed).toBeDefined();
		gate.release();
		expect((await resumed!.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		await vi.waitFor(() => {
			expect(recordedFor(held.id)).toHaveLength(1);
		});
		await second.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		expect(recordedFor(held.id)).toHaveLength(1);
		expect(recordedFor(held.id)[0]).toMatchObject({ replayed: false, outcome: "answered" });
	});

	test("a failed replay leaves the marker alone", { timeout: 20_000 }, async () => {
		const first = await newRig();
		const before = await seedMarker(first);
		blockRunSettled();
		first.faux.setResponses([fauxAssistantMessage("undelivered answer")]);
		await runTurn(first, "undelivered before failed replay");
		await waitForBlockedRunSettled();
		await closeFirst(first);
		releaseRunSettled();
		resetRunRestartFixture();
		const failure = vi.spyOn(EventBus.prototype, "replayUndelivered")
			.mockRejectedValueOnce(new Error("synthetic boot replay failure"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		const second = await boot(first.dir, first.faux);
		expect(failure).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith(
			"boot: run-event replay failed; delivery marker saves are frozen until the next boot",
			expect.objectContaining({ message: "synthetic boot replay failure" }),
		);
		second.faux.setResponses([fauxAssistantMessage("live answer")]);
		const live = await runTurn(second, "live after failed replay");
		expect(live.record.status).toBe("done");
		await second.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		expect(await second.opened.harness.snapshot(RunDeliveryDoc, BACKGROUND_CONTEXT)).toEqual({ through: before });
		expect(recordedFor(live.submission.id)).toHaveLength(1);
	});

	test("replay happens before resume", { timeout: 20_000 }, async () => {
		const first = await newRig();
		await seedMarker(first);
		first.faux.setResponses([fauxAssistantMessage("lost answer")]);
		const lost = await runTurn(first, "lost settled run");
		expect(lost.record.status).toBe("done");
		// Stop automatic delivery without letting this terminal group enter a
		// blocked handler: only the interrupted run needs the fixture gate.
		first.opened.eventBus.close();
		const gate = holdRun(first.faux);
		const held = await lost.conversation.submit(
			{ type: "input", content: "interrupted run" },
			BACKGROUND_CONTEXT,
		);
		await vi.waitFor(async () => {
			expect((await held.status(BACKGROUND_CONTEXT)).status).toBe("placed");
		});
		await first.opened.harness.close(BACKGROUND_CONTEXT);
		resetRunRestartFixture();

		const second = await boot(first.dir, first.faux);
		await second.opened.eventBus.drain(5_000, BACKGROUND_CONTEXT);
		const resumed = await second.opened.harness.submission(held.id, BACKGROUND_CONTEXT);
		expect(resumed).toBeDefined();
		gate.release();
		expect((await resumed!.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		await vi.waitFor(() => {
			expect(recordedFor(held.id)).toHaveLength(1);
		});
		expect(events.map((event) => event.replayed)).toEqual([true, false]);
		expect(events.map((event) => event.inputs)).toEqual([
			[lost.submission.id],
			[held.id],
		]);
	});
});
