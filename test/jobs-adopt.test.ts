/**
 * Jobs quiet runs Task 5: writing in a job-run conversation ADOPTS it
 * (meta.adopted = true, the run's maxTurns cap cleared, the list row
 * stops being quiet), a `job:` fire never adopts, and a fork of a job
 * run is an ordinary conversation (source reset to "user", the job
 * stamps dropped, maxTurns cleared).
 *
 * Rig: the jobs-settle pattern — faux provider, tmpdir, `openHarness`
 * with the fixture-channel extension, a real server. `runNow` fires the
 * job; the settle waiter drains the event bus so the run record and the
 * conversation's `jobOutcome` land before the assertions.
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
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { isQuietJobRun } from "@sigrun/shared/conversations";
import type { JobSpec } from "@sigrun/shared/jobs";
import { loadConfig } from "../src/config.js";
import type { SigrunHost } from "../src/extension.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import { JobRunDoc, runKeyOf } from "../src/jobs/docs.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { createServer } from "../src/server/index.js";
import { BlocksAnswerEntry } from "../src/harness/blocks/entries.js";
import { seededIdentity } from "./helpers/identity.js";

const CHANNEL_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-channel", "index.js"),
).href;

interface TestServer {
	readonly opened: OpenedHarness;
	readonly faux: FauxProviderHandle;
	readonly app: Awaited<ReturnType<typeof createServer>>;
	readonly aliceToken: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
}, 120_000);

async function bootServer(options?: {
	readonly retryOff?: boolean;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-jobs-adopt-"));
	const configDir = join(dir, "config");
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	const config = loadConfig(
		{
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_AUTH: "token",
			SIGRUN_TIMEZONE: "UTC",
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_CONFIG_DIR: configDir,
		},
		{ server: {} } as Parameters<typeof loadConfig>[1],
	);
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
			...(options?.retryOff === true ? { retry: { enabled: false } } : {}),
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
	return { opened, faux, app, aliceToken };
}

function channelHost(opened: OpenedHarness): SeamHost & SigrunHost {
	const host = opened.seamHosts.get("fixture-channel");
	if (host === undefined) throw new Error("fixture-channel host not loaded");
	return host as SeamHost & SigrunHost;
}

function jobSpec(overrides?: Partial<JobSpec>): JobSpec {
	return {
		name: "acme-nightly-check",
		schedule: { at: "2099-01-01T00:00:00.000Z" },
		action: {
			kind: "prompt",
			prompt: "check the job state",
			conversation: "new",
		},
		...overrides,
	};
}

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

async function metaOf(opened: OpenedHarness, id: number) {
	return await opened.harness.snapshot(
		SessionMetaDoc,
		id as ConversationId,
		BACKGROUND_CONTEXT,
	);
}

async function agentMaxTurns(
	opened: OpenedHarness,
	id: number,
): Promise<number | undefined> {
	const conversation = await opened.harness.conversation(
		id as ConversationId,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) throw new Error("conversation not found");
	return (await conversation.agent(BACKGROUND_CONTEXT)).maxTurns;
}

/** POST one plain user message through the submissions route (as alice). */
async function postMessage(
	server: TestServer,
	conversationId: number,
	input: string,
) {
	const response = await server.app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/submissions?waitMs=5000`,
		payload: { input },
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${server.aliceToken}`,
		},
	});
	expect(response.statusCode).toBe(202);
	return response.json();
}

/** The list rows (`GET /v1/conversations`, as alice). */
async function listRows(server: TestServer) {
	const response = await server.app.inject({
		method: "GET",
		url: "/v1/conversations",
		headers: { authorization: `Bearer ${server.aliceToken}` },
	});
	expect(response.statusCode).toBe(200);
	return response.json().conversations as Array<Record<string, unknown>>;
}

describe("adoption of a job-run conversation", () => {
	test("a user message adopts a job-run conversation", async () => {
		const server = await bootServer();
		const { opened, faux } = server;
		const job = await opened.jobs.createApi(jobSpec(), "alice");
		faux.setResponses([fauxAssistantMessage("job done")]);
		const fire = await opened.jobs.runNow(job.id);
		if (fire.conversationId === undefined) throw new Error("no conversation id");
		const runId = fire.conversationId;
		await waitSettled(opened, job.id);

		// Pre-adoption: source cron, jobId stamped, maxTurns defaulted 150,
		// the list row quiet.
		const before = await metaOf(opened, runId);
		expect(before?.source).toBe("cron");
		expect(before?.jobId).toBe(job.id);
		expect(before?.adopted).toBeUndefined();
		expect(await agentMaxTurns(opened, runId)).toBe(150);
		const quietBefore = (await listRows(server)).find((row) => row.id === runId);
		expect(isQuietJobRun(quietBefore as never)).toBe(true);

		faux.setResponses([fauxAssistantMessage("user turn done")]);
		await postMessage(server, runId, "thanks — I am looking at this now");

		const after = await metaOf(opened, runId);
		expect(after?.adopted).toBe(true);
		expect(after?.source).toBe("cron");
		expect(after?.jobId).toBe(job.id);
		expect(await agentMaxTurns(opened, runId)).toBeUndefined();
		// The run record is untouched.
		const lastRun = (await opened.jobs.get(job.id))?.lastRun;
		if (lastRun === undefined) throw new Error("no lastRun");
		const runRecord = await opened.harness.snapshot(
			JobRunDoc,
			runKeyOf(lastRun),
			BACKGROUND_CONTEXT,
		);
		expect(runRecord?.outcome).toBe("succeeded");
		expect(runRecord?.conversationId).toBe(runId);
		const quietAfter = (await listRows(server)).find((row) => row.id === runId);
		expect(isQuietJobRun(quietAfter as never)).toBe(false);
	});

	test("a block answer adopts too", async () => {
		const server = await bootServer();
		const { opened, faux } = server;
		const job = await opened.jobs.createApi(jobSpec(), "alice");
		faux.setResponses([fauxAssistantMessage("job done")]);
		const fire = await opened.jobs.runNow(job.id);
		if (fire.conversationId === undefined) throw new Error("no conversation id");
		const runId = fire.conversationId;
		await waitSettled(opened, job.id);

		const conversation = await opened.harness.conversation(
			runId as ConversationId,
			BACKGROUND_CONTEXT,
		);
		if (conversation === undefined) throw new Error("run conversation not found");
		const { submitOp } = await import("../src/server/conversation-ops.js");
		const ctx = { opened } as unknown as Parameters<typeof submitOp>[0];
		faux.setResponses([fauxAssistantMessage("answer turn done")]);
		await submitOp(ctx, conversation, "Submitted 'Ranking': 1. Acme", {
			user: "alice",
			entry: {
				kind: BlocksAnswerEntry.kind,
				data: { entryId: "1", action: "useOrder", payload: {}, state: {} },
			},
		});
		await opened.harness.waitForIdle(BACKGROUND_CONTEXT);

		const after = await metaOf(opened, runId);
		expect(after?.adopted).toBe(true);
		expect(await agentMaxTurns(opened, runId)).toBeUndefined();
	});

	test("a job: request never adopts", async () => {
		const server = await bootServer();
		const { opened, faux } = server;
		// A new-conversation run, then a FIXED job firing at that run
		// conversation's own id: the fixed fire's `job:` input must not
		// adopt the cron conversation it lands in.
		const first = await opened.jobs.createApi(jobSpec({ name: "acme-first" }), "alice");
		faux.setResponses([fauxAssistantMessage("first done")]);
		const fire = await opened.jobs.runNow(first.id);
		if (fire.conversationId === undefined) throw new Error("no conversation id");
		const runId = fire.conversationId;
		await waitSettled(opened, first.id);

		const second = await opened.jobs.createApi(
			jobSpec({
				name: "acme-second",
				action: {
					kind: "prompt",
					prompt: "follow up in the run conversation",
					conversation: runId,
				},
			}),
			"alice",
		);
		faux.setResponses([fauxAssistantMessage("second done")]);
		await opened.jobs.runNow(second.id);
		await waitSettled(opened, second.id);

		const after = await metaOf(opened, runId);
		expect(after?.adopted).toBeUndefined();
		expect(after?.source).toBe("cron");
		expect(after?.jobId).toBe(first.id);
		expect(await agentMaxTurns(opened, runId)).toBe(150);
	});

	test("adoption through the host bridge", async () => {
		const server = await bootServer();
		const { opened, faux } = server;
		const host = channelHost(opened);
		const job = await opened.jobs.createApi(jobSpec(), "alice");
		faux.setResponses([fauxAssistantMessage("job done")]);
		const fire = await opened.jobs.runNow(job.id);
		if (fire.conversationId === undefined) throw new Error("no conversation id");
		const runId = fire.conversationId;
		await waitSettled(opened, job.id);

		faux.setResponses([fauxAssistantMessage("channel turn done")]);
		await host.conversations.submit(
			runId as ConversationId,
			[{ type: "text", text: "a channel user writes in the run" }],
			{ user: "alice" },
		);
		await opened.harness.waitForIdle(BACKGROUND_CONTEXT);

		const after = await metaOf(opened, runId);
		expect(after?.adopted).toBe(true);
		expect(await agentMaxTurns(opened, runId)).toBeUndefined();
	});
});

describe("forks of job runs are ordinary", () => {
	test("fork of a failed, adopted job run resets the job stamps and the turn cap", async () => {
		const server = await bootServer({ retryOff: true });
		const { opened, faux, app } = server;
		const job = await opened.jobs.createApi(jobSpec(), "alice");
		faux.setResponses([
			fauxAssistantMessage("boom", {
				stopReason: "error",
				errorMessage: "faux provider failure",
			}),
		]);
		const fire = await opened.jobs.runNow(job.id);
		if (fire.conversationId === undefined) throw new Error("no conversation id");
		const runId = fire.conversationId;
		await waitSettled(opened, job.id);

		// Adopt it (a failed run is already visible, but adoption also
		// exercises the reset of `adopted` on the fork).
		faux.setResponses([fauxAssistantMessage("user turn done")]);
		await postMessage(server, runId, "looking into the failure");
		const adoptedMeta = await metaOf(opened, runId);
		expect(adoptedMeta?.adopted).toBe(true);
		expect(adoptedMeta?.jobOutcome).toBe("failed");
		expect(await agentMaxTurns(opened, runId)).toBeUndefined();

		// Fork at the newest entry.
		const forked = await app.inject({
			method: "POST",
			url: `/v1/conversations/${runId}/fork`,
			payload: {},
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${server.aliceToken}`,
			},
		});
		expect(forked.statusCode).toBe(201);
		const forkId = forked.json().id as number;

		const forkMeta = await metaOf(opened, forkId);
		expect(forkMeta?.source).toBe("user");
		expect(forkMeta?.jobId).toBeUndefined();
		expect(forkMeta?.deliver).toBeUndefined();
		expect(forkMeta?.jobOutcome).toBeUndefined();
		expect(forkMeta?.adopted).toBeUndefined();
		// The fork drops the run's maxTurns cap (an adopted source cleared
		// it; an unadopted source's 150 must not follow the fork either).
		expect(await agentMaxTurns(opened, forkId)).toBeUndefined();
		expect(
			await (await import("../src/harness/interactive-tools.js")).isJobRunConversation(
				opened.harness,
				forkId as ConversationId,
				BACKGROUND_CONTEXT,
			),
		).toBe(false);
		// The list row is visible and unprefixed (no `Failed · ` prefix —
		// the fork's source is "user" and it carries no jobOutcome).
		const row = (await listRows(server)).find((r) => r.id === forkId);
		expect(row).toBeDefined();
		expect(isQuietJobRun(row as never)).toBe(false);
		expect(row?.source).toBe("user");
		expect(row?.jobOutcome).toBeUndefined();
	});

	test("fork of an UNADOPTED job run clears maxTurns too", async () => {
		const server = await bootServer();
		const { opened, faux, app } = server;
		const job = await opened.jobs.createApi(jobSpec(), "alice");
		faux.setResponses([fauxAssistantMessage("job done")]);
		const fire = await opened.jobs.runNow(job.id);
		if (fire.conversationId === undefined) throw new Error("no conversation id");
		const runId = fire.conversationId;
		await waitSettled(opened, job.id);
		expect(await agentMaxTurns(opened, runId)).toBe(150);

		const forked = await app.inject({
			method: "POST",
			url: `/v1/conversations/${runId}/fork`,
			payload: {},
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${server.aliceToken}`,
			},
		});
		expect(forked.statusCode).toBe(201);
		const forkId = forked.json().id as number;
		const forkMeta = await metaOf(opened, forkId);
		expect(forkMeta?.source).toBe("user");
		expect(forkMeta?.jobId).toBeUndefined();
		expect(await agentMaxTurns(opened, forkId)).toBeUndefined();
	});
});
