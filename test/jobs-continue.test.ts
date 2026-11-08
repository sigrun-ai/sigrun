/**
 * Continue-rescued job runs (continue lane Task 3): a failed cron run
 * (`meta.source === "cron"`, `meta.jobOutcome === "failed"`) that is
 * resumed ONLY by a Continue — the continued run's inputs are exactly
 * the continue itself — and answers clears the `Failed · ` label
 * (`meta.jobOutcome = "succeeded"`). Any other input in the continued
 * run (a typed message or a queued job fire) keeps the label; the job's
 * own run record and `lastRun` keep the ORIGINAL failure.
 *
 * Hermetic: faux provider + tmp workspace + app.inject(). Held runs use
 * an unresolved faux response gate, never a timed/slow stream.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { displayName } from "@sigrun/shared/conversations";
import type { JobSpec } from "@sigrun/shared/jobs";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import type { SigrunHost } from "../src/extension.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import { createServer } from "../src/server/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { seededIdentity } from "./helpers/identity.js";

const CHANNEL_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-channel", "index.js"),
).href;

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly faux: FauxProviderHandle;
	/** The job owner's token (the continue runs as the owner). */
	readonly aliceToken: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
}, 120_000);

async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-jobs-continue-"));
	const configDir = join(dir, "config");
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_TIMEZONE: "UTC",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: configDir,
	}, { server: {} } as Parameters<typeof loadConfig>[1]);
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ namingModel: false }),
	);
	const identity = await seededIdentity(dir, "root-admin");
	await identity.users.add({ user: "alice", admin: false, source: "cli" });
	const opened = await openHarness(config, {
		identity,
		extensions: [{ name: "ext-faux", providers: [{ provider: faux.provider }] }],
		extensionSpecifiers: [CHANNEL_SPECIFIER],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
		settings: {
			followUpMode: "all",
			retry: { enabled: false },
		},
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close().catch(() => {});
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	return { app, opened, faux, aliceToken };
}

function channelHost(opened: OpenedHarness): SeamHost & SigrunHost {
	const host = opened.seamHosts.get("fixture-channel");
	if (host === undefined) throw new Error("fixture-channel host not loaded");
	return host as SeamHost & SigrunHost;
}

function jobSpec(overrides?: Partial<JobSpec>): JobSpec {
	return {
		name: "acme-daily",
		schedule: { at: "2099-01-01T00:00:00.000Z" },
		action: {
			kind: "prompt",
			prompt: "check the job state",
			conversation: "new",
		},
		...overrides,
	};
}

function failedMessage(): AssistantMessage {
	return fauxAssistantMessage("boom", {
		stopReason: "error",
		errorMessage: "faux provider failure",
	});
}

/** A gated response: the run's FIRST model call stays in flight until
 * `release()`. Queue anything that must still be queued at the continue
 * boundary while this gate holds (a later submission would steer-place
 * into the live run instead). */
function holdRun(faux: FauxProviderHandle): { release: () => void } {
	let resolve!: (message: AssistantMessage) => void;
	const gate = new Promise<AssistantMessage>((res) => {
		resolve = res;
	});
	faux.setResponses([async () => await gate]);
	return {
		release: () => {
			resolve(failedMessage());
		},
	};
}

/** Wait for the fired run to settle terminal: the model settles
 * (waitForIdle), then the event bus delivers runSettled to the jobs
 * observer (drain). */
async function waitSettled(opened: OpenedHarness, jobId: string): Promise<void> {
	await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
	await opened.eventBus.drain(10_000, BACKGROUND_CONTEXT);
	for (let i = 0; i < 500; i += 1) {
		const job = await opened.jobs.get(jobId);
		if (job?.lastRun !== undefined && job.lastRun.outcome !== "running") return;
		await new Promise((res) => setTimeout(res, 20));
	}
	throw new Error(`run of ${jobId} never settled`);
}

/** Wait for a continue submission to settle and the rescue observer to
 * run. The continue's submission record itself is the settle signal;
 * the drain then guarantees the runSettled handlers (jobs + rescue)
 * have delivered before the meta assertions read. */
async function continueConversation(
	app: FastifyInstance,
	opened: OpenedHarness,
	conversationId: number,
	token: string,
): Promise<{ readonly submissionId: number; readonly outcome: string }> {
	const response = await app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/continue`,
		payload: {},
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
	});
	expect(response.statusCode).toBe(202);
	const submissionId = response.json().submissionId as number;
	const submission = await opened.harness.submission(
		submissionId as never,
		BACKGROUND_CONTEXT,
	);
	if (submission === undefined) throw new Error("continue submission missing");
	const settled = await submission.wait(BACKGROUND_CONTEXT);
	await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
	await opened.eventBus.drain(10_000, BACKGROUND_CONTEXT);
	return { submissionId, outcome: settled.status };
}

async function viewOf(app: FastifyInstance, conversationId: number, token: string) {
	const response = await app.inject({
		method: "GET",
		url: `/v1/conversations/${conversationId}`,
		headers: { authorization: `Bearer ${token}` },
	});
	expect(response.statusCode).toBe(200);
	return response.json();
}

async function listRowOf(app: FastifyInstance, conversationId: number, token: string) {
	const response = await app.inject({
		method: "GET",
		url: "/v1/conversations",
		headers: { authorization: `Bearer ${token}` },
	});
	expect(response.statusCode).toBe(200);
	return (response.json().conversations as Array<Record<string, unknown>>).find(
		(row) => row.id === conversationId,
	);
}

describe("a Continue-rescued job run", () => {
	test("continue rescues a failed job run", { timeout: 30_000 }, async () => {
		const { app, opened, faux, aliceToken } = await bootServer();
		const host = channelHost(opened);
		const job = await opened.jobs.createApi(jobSpec(), "alice");
		faux.setResponses([failedMessage()]);
		const fire = await opened.jobs.runNow(job.id);
		if (fire.conversationId === undefined) throw new Error("new-conversation fire has no id");
		const conversationId = fire.conversationId as ConversationId;

		await waitSettled(opened, job.id);
		const failedRun = (await opened.jobs.get(job.id))?.lastRun;
		expect(failedRun).toMatchObject({ outcome: "failed", error: "model_error" });
		await expect(host.conversations.meta(conversationId)).resolves.toMatchObject({
			jobOutcome: "failed",
		});
		// Before the rescue: visible with the Failed prefix.
		const before = await listRowOf(app, conversationId as unknown as number, aliceToken);
		expect(before).toBeDefined();
		expect(displayName(before as never)).toMatch(/^Failed · /);

		faux.setResponses([fauxAssistantMessage("rescued")]);
		const { outcome } = await continueConversation(app, opened, conversationId as unknown as number, aliceToken);
		expect(outcome).toBe("done");

		await expect(host.conversations.meta(conversationId)).resolves.toMatchObject({
			jobOutcome: "succeeded",
			adopted: true,
		});
		const row = await listRowOf(app, conversationId as unknown as number, aliceToken);
		expect(row).toBeDefined();
		expect(displayName(row as never)).not.toMatch(/^Failed · /);
		// The Jobs view keeps the original failure: the run record and the
		// job's lastRun are untouched by the rescue.
		expect((await opened.jobs.get(job.id))?.lastRun).toEqual(failedRun);
	});

	test("a continue that fails again keeps the label", { timeout: 30_000 }, async () => {
		const { app, opened, faux, aliceToken } = await bootServer();
		const host = channelHost(opened);
		const job = await opened.jobs.createApi(jobSpec(), "alice");
		faux.setResponses([failedMessage()]);
		const fire = await opened.jobs.runNow(job.id);
		if (fire.conversationId === undefined) throw new Error("new-conversation fire has no id");
		const conversationId = fire.conversationId as ConversationId;
		await waitSettled(opened, job.id);

		faux.setResponses([failedMessage()]);
		const { outcome } = await continueConversation(app, opened, conversationId as unknown as number, aliceToken);
		expect(outcome).toBe("unanswered");

		await expect(host.conversations.meta(conversationId)).resolves.toMatchObject({
			jobOutcome: "failed",
		});
		const view = await viewOf(app, conversationId as unknown as number, aliceToken);
		expect(view.docs["pi.live"]?.runFailure).toBeDefined();
	});

	test("a queued typed message keeps the label", { timeout: 30_000 }, async () => {
		const { app, opened, faux, aliceToken } = await bootServer();
		const host = channelHost(opened);
		const job = await opened.jobs.createApi(jobSpec(), "alice");
		const gate = holdRun(faux);
		const fire = await opened.jobs.runNow(job.id);
		if (fire.conversationId === undefined) throw new Error("new-conversation fire has no id");
		const conversationId = fire.conversationId as ConversationId;
		// Queue the typed message while the run is held on its FIRST model
		// call: it must still be queued when the continue is admitted (a
		// submission after the failure boundary would steer-place into the
		// failing run instead).
		const conversation = await opened.harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new Error("run conversation not found");
		const queued = await conversation.submit({
			type: "input",
			content: [{ type: "text", text: "also check this" }],
			whenBusy: "steer",
		}, BACKGROUND_CONTEXT);
		gate.release();
		await waitSettled(opened, job.id);
		// The queued input must still be QUEUED at the continue boundary
		// (wait() would hang on a queued submission — read the status).
		expect((await queued.status(BACKGROUND_CONTEXT)).status).toBe("queued");
		const failedRun = (await opened.jobs.get(job.id))?.lastRun;

		faux.setResponses([fauxAssistantMessage("both answered")]);
		const { outcome } = await continueConversation(app, opened, conversationId as unknown as number, aliceToken);
		expect(outcome).toBe("done");
		expect((await queued.wait(BACKGROUND_CONTEXT)).status).toBe("done");

		// Two inputs in the continued run (queued text + continue): not a
		// continue-only rescue, so the label stays.
		await expect(host.conversations.meta(conversationId)).resolves.toMatchObject({
			jobOutcome: "failed",
		});
		expect((await opened.jobs.get(job.id))?.lastRun).toEqual(failedRun);
	});

	test("continue resumes past a turn limit", { timeout: 30_000 }, async () => {
		const { app, opened, faux, aliceToken } = await bootServer();
		const host = channelHost(opened);
		const job = await opened.jobs.createApi(jobSpec({
			action: { kind: "prompt", prompt: "loop forever", conversation: "new", maxTurns: 1 },
		}), "alice");
		// Every round answers with a tool call: the agent's maxTurns (1)
		// ends the fire's run `turn_limit`.
		faux.setResponses([fauxAssistantMessage(
			[fauxToolCall("bash", { command: "echo acme" })],
			{ stopReason: "toolUse" },
		)]);
		const fire = await opened.jobs.runNow(job.id);
		if (fire.conversationId === undefined) throw new Error("new-conversation fire has no id");
		const conversationId = fire.conversationId as ConversationId;
		await waitSettled(opened, job.id);
		expect((await opened.jobs.get(job.id))?.lastRun).toMatchObject({
			outcome: "failed",
			error: "turn_limit",
		});

		// The continued run needs more than one model round: two tool-call
		// rounds, then a text answer. Adoption cleared the turn cap in the
		// continue's admission commit, so these rounds can run.
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo one" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo two" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done after the limit"),
		]);
		const { outcome } = await continueConversation(app, opened, conversationId as unknown as number, aliceToken);
		expect(outcome).toBe("done");

		await expect(host.conversations.meta(conversationId)).resolves.toMatchObject({
			jobOutcome: "succeeded",
			adopted: true,
		});
		const conversation = await opened.harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new Error("run conversation not found");
		expect((await conversation.agent(BACKGROUND_CONTEXT)).maxTurns).toBeUndefined();
	});

	test("a continue on a non-job conversation writes no jobOutcome", { timeout: 30_000 }, async () => {
		const { app, opened, faux, aliceToken } = await bootServer();
		const host = channelHost(opened);
		const id = await host.conversations.create({ owner: "alice" });
		faux.setResponses([failedMessage()]);
		const response = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/submissions`,
			payload: { input: "hello" },
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${aliceToken}`,
			},
		});
		expect(response.statusCode).toBe(202);
		const submissionId = response.json().submission.id as number;
		const submission = await opened.harness.submission(submissionId as never, BACKGROUND_CONTEXT);
		if (submission === undefined) throw new Error("submission missing");
		await submission.wait(BACKGROUND_CONTEXT);

		faux.setResponses([fauxAssistantMessage("resumed")]);
		const { outcome } = await continueConversation(app, opened, id as unknown as number, aliceToken);
		expect(outcome).toBe("done");
		await expect(host.conversations.meta(id)).resolves.not.toHaveProperty("jobOutcome");
	});

	test("a queued job fire placed by a continue is a job run", { timeout: 30_000 }, async () => {
		const { app, opened, faux, aliceToken } = await bootServer();
		const host = channelHost(opened);
		// A fixed-conversation job firing into a conversation whose meta
		// already carries a failed cron outcome.
		const id = await host.conversations.create({ owner: "alice" });
		await opened.harness.commit(async (tx) => {
			const meta = await tx.doc(SessionMetaDoc, id);
			meta.source = "cron";
			meta.jobOutcome = "failed";
		}, BACKGROUND_CONTEXT);
		const job = await opened.jobs.createApi(jobSpec({
			overlap: "queue",
			action: { kind: "prompt", prompt: "acme queued check", conversation: id as unknown as number },
		}), "alice");

		// Hold a failing ordinary run in the conversation; run-now the job
		// while it is held so its `job:` input queues behind it.
		const gate = holdRun(faux);
		const conversation = await opened.harness.conversation(id, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new Error("fixed conversation not found");
		const held = await conversation.submit({
			type: "input",
			content: [{ type: "text", text: "hold the failing run" }],
		}, BACKGROUND_CONTEXT);
		await opened.jobs.runNow(job.id);
		gate.release();
		expect((await held.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
		await opened.eventBus.drain(10_000, BACKGROUND_CONTEXT);

		// The continue places the queued job input: the run answers with
		// both inputs, and the jobs observer settles the job's run record
		// from its job:<fireKey> requestId.
		faux.setResponses([fauxAssistantMessage("queued job done")]);
		const { outcome } = await continueConversation(app, opened, id as unknown as number, aliceToken);
		expect(outcome).toBe("done");
		await waitSettled(opened, job.id);
		expect((await opened.jobs.get(job.id))?.lastRun).toMatchObject({
			outcome: "succeeded",
		});

		// Two inputs (the job's queued input + the continue): the rescue
		// predicate does not fire — the label stays failed.
		await expect(host.conversations.meta(id)).resolves.toMatchObject({
			jobOutcome: "failed",
		});
	});
});
