/**
 * Continue after a failed run (continue lane Task 2): POST /continue
 * admits pi-durable's run-resuming input without adding a user message.
 * Admission is write-gated and idempotent by requestId, never queues,
 * adopts a job run and declines pending questions in its one commit.
 *
 * Hermetic: faux provider + tmp workspace + app.inject(). Busy runs use
 * an unresolved faux response gate, never a timed/slow stream.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import { configure } from "@earendil-works/pi-durable";
import type {
	ConversationId,
	SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { InteractionDoc } from "../src/harness/interactions.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import type { SeamHost } from "../src/harness/seam-host.js";
import { createServer } from "../src/server/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { seededIdentity } from "./helpers/identity.js";

const DECLINABLE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-declinable", "index.js"),
).href;

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly faux: FauxProviderHandle;
	readonly aliceToken?: string;
	readonly bobToken?: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
}, 120_000);

/** One hermetic server with retries and auto-naming disabled. */
async function bootServer(options: {
	readonly auth?: "none" | "token";
	readonly declinable?: boolean;
} = {}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-continue-"));
	const authMethod = options.auth ?? "none";
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: authMethod,
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
	});
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ namingModel: false, retry: { enabled: false } }),
	);
	const identity = await seededIdentity(dir, "alice");
	if (authMethod === "token") {
		await identity.users.add({ user: "bob", admin: false, source: "cli" });
	}
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		env: {},
		...(options.declinable === true
			? { extensionSpecifiers: [DECLINABLE_SPECIFIER] }
			: {}),
		settingsDir: dir,
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	if (authMethod !== "token") return { app, opened, faux };
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	const { token: bobToken } = await opened.identity.tokens.create(
		"bob-cli",
		"bob",
	);
	return { app, opened, faux, aliceToken, bobToken };
}

function failedMessage(): AssistantMessage {
	return fauxAssistantMessage("boom", {
		stopReason: "error",
		errorMessage: "boom",
	});
}

/** A gated model call: the run cannot settle until release(). */
function holdRun(
	faux: FauxProviderHandle,
	message: AssistantMessage = fauxAssistantMessage("done"),
): { readonly release: () => void } {
	let resolve!: (value: AssistantMessage) => void;
	const gate = new Promise<AssistantMessage>((res) => {
		resolve = res;
	});
	faux.setResponses([async () => await gate]);
	return { release: () => resolve(message) };
}

async function rootOf(opened: OpenedHarness) {
	return await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: opened.defaultModel },
	});
}

async function submitInput(
	app: FastifyInstance,
	conversationId: number,
	input: string,
	requestId?: string,
	token?: string,
): Promise<SubmissionRecord> {
	const response = await app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/submissions`,
		payload: {
			input,
			...(requestId === undefined ? {} : { requestId }),
		},
		headers: {
			"content-type": "application/json",
			...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
		},
	});
	expect(response.statusCode).toBe(202);
	return response.json().submission as SubmissionRecord;
}

async function postContinue(
	app: FastifyInstance,
	conversationId: number,
	body?: unknown,
	token?: string,
) {
	return await app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/continue`,
		...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
		headers: {
			"content-type": "application/json",
			...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
		},
	});
}

async function submissionOf(
	opened: OpenedHarness,
	submissionId: number,
) {
	const submission = await opened.harness.submission(
		submissionId as SubmissionRecord["id"],
		BACKGROUND_CONTEXT,
	);
	if (submission === undefined) throw new Error("submission missing");
	return submission;
}

async function submissionsOf(
	opened: OpenedHarness,
	conversationId: number,
): Promise<SubmissionRecord[]> {
	const page = await opened.storage.scanSubmissions(
		{ conversationId: conversationId as ConversationId, order: "ascending" },
		100,
		undefined,
		BACKGROUND_CONTEXT,
	);
	return [...page.items];
}

async function viewOf(app: FastifyInstance, conversationId: number) {
	const response = await app.inject({
		method: "GET",
		url: `/v1/conversations/${conversationId}`,
	});
	expect(response.statusCode).toBe(200);
	return response.json();
}

async function lastActivityOf(
	app: FastifyInstance,
	conversationId: number,
): Promise<string | undefined> {
	const response = await app.inject({ method: "GET", url: "/v1/conversations" });
	expect(response.statusCode).toBe(200);
	return response.json().conversations.find(
		(row: { id: number }) => row.id === conversationId,
	)?.lastActivityAt;
}

async function waitForActivityAfter(
	app: FastifyInstance,
	conversationId: number,
	before: string | undefined,
): Promise<string> {
	const beforeMs = before === undefined ? 0 : Date.parse(before);
	const deadline = Date.now() + 5_000;
	for (;;) {
		const current = await lastActivityOf(app, conversationId);
		if (current !== undefined && Date.parse(current) > beforeMs) return current;
		if (Date.now() > deadline) {
			throw new Error(
				`lastActivityAt did not move past ${before ?? "unset"}: ${current ?? "unset"}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("POST /v1/conversations/:id/continue", () => {
	test("continue resumes a failed run", async () => {
		const { app, opened, faux } = await bootServer();
		const root = await rootOf(opened);
		faux.setResponses([failedMessage()]);
		const failed = await submitInput(app, root.id, "hello");
		expect(
			(await (await submissionOf(opened, failed.id)).wait(BACKGROUND_CONTEXT))
				.status,
		).toBe("unanswered");
		const activityBefore = await lastActivityOf(app, root.id);
		faux.setResponses([fauxAssistantMessage("resumed")]);

		const response = await postContinue(app, root.id, {});
		expect(response.statusCode).toBe(202);
		const { submissionId } = response.json() as { submissionId: number };
		expect(submissionId).toBeTypeOf("number");
		const settled = await (
			await submissionOf(opened, submissionId)
		).wait(BACKGROUND_CONTEXT);
		expect(settled).toMatchObject({ type: "continue", status: "done" });
		const view = await viewOf(app, root.id);
		expect(
			view.entries.filter((entry: { kind: string }) => entry.kind === "pi.user"),
		).toHaveLength(1);
		expect(
			view.entries.filter(
				(entry: { kind: string }) => entry.kind === "pi.assistant",
			),
		).toHaveLength(2);
		expect(view.docs["pi.live"]?.runFailure).toBeUndefined();
		const activityAfter = await waitForActivityAfter(
			app,
			root.id,
			activityBefore,
		);
		expect(Date.parse(activityAfter)).toBeGreaterThan(
			Date.parse(activityBefore as string),
		);
	});

	test("a second continue while the first runs is rejected", async () => {
		const { app, opened, faux } = await bootServer();
		const root = await rootOf(opened);
		faux.setResponses([failedMessage()]);
		const failed = await submitInput(app, root.id, "hello");
		await (await submissionOf(opened, failed.id)).wait(BACKGROUND_CONTEXT);
		const gate = holdRun(faux, fauxAssistantMessage("resumed"));
		try {
			const first = await postContinue(app, root.id, {});
			expect(first.statusCode).toBe(202);
			const second = await postContinue(app, root.id, {});
			expect(second.statusCode).toBe(409);
			expect(second.json()).toEqual({ error: "conversation_busy" });
			expect(
				(await submissionsOf(opened, root.id)).filter(
					(record) => record.type === "continue",
				),
			).toHaveLength(1);
		} finally {
			gate.release();
		}
		await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
	});

	test("continue on a finished conversation ends nothing_to_answer", async () => {
		const { app, opened, faux } = await bootServer();
		const root = await rootOf(opened);
		faux.setResponses([fauxAssistantMessage("answered")]);
		const answered = await submitInput(app, root.id, "hello");
		await (await submissionOf(opened, answered.id)).wait(BACKGROUND_CONTEXT);

		const response = await postContinue(app, root.id, {});
		expect(response.statusCode).toBe(202);
		const settled = await (
			await submissionOf(opened, response.json().submissionId)
		).wait(BACKGROUND_CONTEXT);
		expect(settled).toMatchObject({
			type: "continue",
			status: "unanswered",
			reason: "nothing_to_answer",
		});
		const view = await viewOf(app, root.id);
		expect(view.docs["pi.live"]?.runFailure?.reason).toBe(
			"nothing_to_answer",
		);
	});

	test("continue admits on an unserved model", async () => {
		const { app, opened } = await bootServer();
		const root = await rootOf(opened);
		const configured = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/configure`,
			payload: { model: "faux/nonexistent" },
			headers: { "content-type": "application/json" },
		});
		expect(configured.statusCode).toBe(200);
		const response = await postContinue(app, root.id, {});
		expect(response.statusCode).toBe(202);
		const settled = await (
			await submissionOf(opened, response.json().submissionId)
		).wait(BACKGROUND_CONTEXT);
		expect(settled).toMatchObject({
			type: "continue",
			status: "unanswered",
			reason: "no_model",
		});
	});

	test("continue on a busy conversation is 409", async () => {
		const { app, opened, faux } = await bootServer();
		const root = await rootOf(opened);
		const gate = holdRun(faux);
		try {
			const live = await submitInput(app, root.id, "held");
			expect(live.status).toBe("placed");
			const response = await postContinue(app, root.id, {});
			expect(response.statusCode).toBe(409);
			expect(response.json()).toEqual({ error: "conversation_busy" });
			expect(
				(await submissionsOf(opened, root.id)).filter(
					(record) => record.type === "continue",
				),
			).toHaveLength(0);
		} finally {
			gate.release();
		}
		await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
	});

	test("body validation", async () => {
		const { app, opened } = await bootServer();
		const root = await rootOf(opened);
		for (const [body, field] of [
			[{ foo: 1 }, "foo"],
			[{ requestId: 7 }, "requestId"],
			[{ requestId: "job:acme-daily:1" }, "requestId"],
		] as const) {
			const response = await postContinue(app, root.id, body);
			expect(response.statusCode).toBe(400);
			expect(response.json()).toEqual({ error: "invalid_field", field });
		}
		expect(await submissionsOf(opened, root.id)).toHaveLength(0);
	});

	test("a requestId of an earlier input is request_conflict; a continue requestId is idempotent", async () => {
		const { app, opened, faux } = await bootServer();
		const root = await rootOf(opened);
		faux.setResponses([failedMessage()]);
		const failed = await submitInput(app, root.id, "hello", "r1");
		await (await submissionOf(opened, failed.id)).wait(BACKGROUND_CONTEXT);
		const conflict = await postContinue(app, root.id, { requestId: "r1" });
		expect(conflict.statusCode).toBe(409);
		expect(conflict.json()).toEqual({ error: "request_conflict" });

		faux.setResponses([fauxAssistantMessage("resumed")]);
		const first = await postContinue(app, root.id, { requestId: "continue-r1" });
		expect(first.statusCode).toBe(202);
		const firstId = first.json().submissionId as number;
		await (await submissionOf(opened, firstId)).wait(BACKGROUND_CONTEXT);
		const second = await postContinue(app, root.id, { requestId: "continue-r1" });
		expect(second.statusCode).toBe(202);
		expect(second.json()).toEqual({ submissionId: firstId });
		expect(
			(await submissionsOf(opened, root.id)).filter(
				(record) => record.type === "continue",
			),
		).toHaveLength(1);
	});

	test("read access cannot continue", async () => {
		const { app, opened, aliceToken, bobToken } = await bootServer({
			auth: "token",
		});
		if (aliceToken === undefined || bobToken === undefined) {
			throw new Error("tokens missing");
		}
		const created = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: { authorization: `Bearer ${aliceToken}` },
		});
		expect(created.statusCode).toBe(201);
		const id = created.json().id as number;
		const shared = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${id}/meta`,
			payload: { sharing: { scope: "people", users: ["bob"], level: "read" } },
			headers: {
				authorization: `Bearer ${aliceToken}`,
				"content-type": "application/json",
			},
		});
		expect(shared.statusCode).toBe(200);

		const response = await postContinue(app, id, {}, bobToken);
		expect(response.statusCode).toBe(403);
		expect(response.json()).toEqual({ error: "forbidden" });
		expect(await submissionsOf(opened, id)).toHaveLength(0);
	});

	test("continue adopts a job run in the same commit", async () => {
		const { app, opened, faux } = await bootServer();
		const root = await rootOf(opened);
		await root.commit(async (tx) => {
			const meta = await tx.doc(SessionMetaDoc, root.id);
			meta.source = "cron";
			meta.jobOutcome = "failed";
			await configure(tx, root.id, { maxTurns: 150 });
		}, BACKGROUND_CONTEXT);

		const response = await postContinue(app, root.id, {});
		expect(response.statusCode).toBe(202);
		await (
			await submissionOf(opened, response.json().submissionId)
		).wait(BACKGROUND_CONTEXT);
		const meta = await opened.harness.snapshot(
			SessionMetaDoc,
			root.id,
			BACKGROUND_CONTEXT,
		);
		expect(meta).toMatchObject({ source: "cron", adopted: true });
		expect((await root.agent(BACKGROUND_CONTEXT)).maxTurns).toBeUndefined();

		// A busy rejection writes no adoption side effect either. Use a fresh
		// unadopted conversation and direct admission: submitOp would itself
		// adopt, making it unusable as this rejection test's setup.
		const busyRoot = await opened.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: opened.defaultModel },
				init: async (tx, id) => {
					const draft = await tx.doc(SessionMetaDoc, id);
					draft.source = "cron";
					draft.jobOutcome = "failed";
				},
			},
			BACKGROUND_CONTEXT,
		);
		const gate = holdRun(faux);
		try {
			await busyRoot.submit(
				{ type: "input", content: "held" },
				BACKGROUND_CONTEXT,
			);
			const busy = await postContinue(app, busyRoot.id, {});
			expect(busy.statusCode).toBe(409);
			expect(
				(
					await opened.harness.snapshot(
						SessionMetaDoc,
						busyRoot.id,
						BACKGROUND_CONTEXT,
					)
				)?.adopted,
			).toBeUndefined();
		} finally {
			gate.release();
		}
		await opened.harness.waitForIdle(BACKGROUND_CONTEXT);
	});

	test("continue declines a pending question", async () => {
		const { app, opened, faux } = await bootServer({ declinable: true });
		const root = await rootOf(opened);
		faux.setResponses([failedMessage()]);
		const failed = await submitInput(app, root.id, "hello");
		await (await submissionOf(opened, failed.id)).wait(BACKGROUND_CONTEXT);
		const host = (globalThis as Record<string, unknown>).__declinableHost as
			| SeamHost
			| undefined;
		if (host === undefined) throw new Error("declinable host not captured");
		await host.seedInteraction(
			root.id,
			{
				kind: "decl.ask",
				callId: "continue-question",
				status: "pending",
				createdAt: 1,
				declinable: true,
			} as never,
			BACKGROUND_CONTEXT,
		);
		faux.setResponses([fauxAssistantMessage("resumed")]);
		const response = await postContinue(app, root.id, {});
		expect(response.statusCode).toBe(202);
		await (
			await submissionOf(opened, response.json().submissionId)
		).wait(BACKGROUND_CONTEXT);
		const record = await opened.harness.snapshot(
			InteractionDoc,
			root.id,
			"continue-question",
			BACKGROUND_CONTEXT,
		);
		expect(record).toMatchObject({
			status: "skipped",
			declinedVia: "message",
			answeredBy: "human",
		});
	});
});
