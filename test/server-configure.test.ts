/**
 * Task 9c-i: configure + abort endpoints (no approvals — separate slice).
 *
 * `POST /v1/conversations/:id/configure` changes the conversation's model
 * and/or thinking level: the body accepts EXACTLY `{ model?, thinking? }`
 * (`model` is `"provider/modelId"`, split on the first `/`; `thinking` is a
 * `ModelThinkingLevel`), applied through `conversation.configure()`. The
 * response reads the agent back and projects the configured surface only —
 * resolved extensions/tools/sections stay server-side.
 *
 * `POST /v1/conversations/:id/abort` aborts the conversation's active
 * submission: `harness.inspect()` filtered to the conversation, lowest live
 * id (the active run's placed input; queued inbox items have higher ids) →
 * `harness.abortSubmission(id, ctx, conversationId)`. `"aborted"` /
 * `"already_placed"` / `"settled"` all map to 200 (idempotent; the body notes
 * the prior state), nothing active maps to 404.
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * server-submissions.test.ts). The abort test gates the faux response on a
 * promise the test controls, so the run's input is deterministically `placed`
 * while abort is called; the submission is issued through
 * `conversation.submit()` directly because the T9b submissions endpoint waits
 * for settlement server-side.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";

/** One hermetic server: harness + faux provider + Fastify app. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
}

/**
 * Boot a hermetic server with TWO faux models (`faux/m`, `faux/m2`) so
 * configure can switch between them.
 */
async function bootServer(options?: {
	responses?: FauxResponseStep[];
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-conf-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [
			{ id: "m", contextWindow: 128_000 },
			{ id: "m2", contextWindow: 128_000 },
		],
	});
	faux.setResponses(options?.responses ?? [fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
	});
	const app = await createServer(opened, config);
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** `POST /v1/conversations/:id/configure` with a JSON body. */
async function configure(
	app: FastifyInstance,
	conversationId: number,
	body: Record<string, unknown>,
) {
	return app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/configure`,
		payload: body,
		headers: { "content-type": "application/json" },
	});
}

/** Poll `harness.inspect()` until `submissionId` is placed; fail loud on timeout. */
async function waitForPlacement(
	opened: OpenedHarness,
	submissionId: number,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const inspection = await opened.harness.inspect(BACKGROUND_CONTEXT);
		const record = inspection.submissions.find((s) => s.id === submissionId);
		if (record?.status === "placed") return;
		if (Date.now() > deadline) {
			throw new Error(
				`submission ${submissionId} never placed (last: ${record?.status ?? "absent"})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

// ---------------------------------------------------------------------------
// POST /v1/conversations/:id/configure
// ---------------------------------------------------------------------------

describe("POST /v1/conversations/:id/configure", () => {
	test("applies model and thinking; read back via conversation.agent", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await configure(app, root.id, {
			model: "faux/m2",
			thinking: "high",
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			model: { provider: "faux", modelId: "m2" },
			thinkingLevel: "high",
		});
		// The stored agent changed, not just the echo.
		const agent = await root.agent(BACKGROUND_CONTEXT);
		expect(agent.model).toEqual({ provider: "faux", modelId: "m2" });
		expect(agent.thinkingLevel).toBe("high");
	});

	test("a partial change (thinking only) leaves the model untouched", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await configure(app, root.id, { thinking: "low" });
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.model).toEqual({ provider: "faux", modelId: "m" });
		expect(body.thinkingLevel).toBe("low");
	});

	test("rejects an unknown field with 400 invalid_field", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await configure(app, root.id, {
			model: "faux/m2",
			temperature: 0.7,
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({
			error: "invalid_field",
			field: "temperature",
		});
		// Nothing was applied.
		const agent = await root.agent(BACKGROUND_CONTEXT);
		expect(agent.model).toEqual({ provider: "faux", modelId: "m" });
	});

	test("rejects malformed values (model shape, model type, thinking level)", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const noSlash = await configure(app, root.id, { model: "just-a-model" });
		expect(noSlash.statusCode).toBe(400);
		expect(noSlash.json()).toEqual({
			error: "invalid_field",
			field: "model",
		});
		const emptyModelId = await configure(app, root.id, { model: "faux/" });
		expect(emptyModelId.statusCode).toBe(400);
		const emptyProvider = await configure(app, root.id, { model: "/m2" });
		expect(emptyProvider.statusCode).toBe(400);
		const wrongType = await configure(app, root.id, { model: 42 });
		expect(wrongType.statusCode).toBe(400);
		const badLevel = await configure(app, root.id, { thinking: "ultra" });
		expect(badLevel.statusCode).toBe(400);
		expect(badLevel.json()).toEqual({
			error: "invalid_field",
			field: "thinking",
		});
	});

	test("rejects an empty body (a configure that changes nothing)", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await configure(app, root.id, {});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "invalid_body" });
	});

	test("404s for an unknown conversation id", async () => {
		const { app } = await bootServer();
		const response = await configure(app, 999999, { thinking: "high" });
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "conversation_not_found" });
	});
});

// ---------------------------------------------------------------------------
// POST /v1/conversations/:id/abort
// ---------------------------------------------------------------------------

describe("POST /v1/conversations/:id/abort", () => {
	test("reports the active run's placed input (already_placed), idempotently; 404 once settled", async () => {
		// Gate the faux response: the run stays generating until released.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { app, opened } = await bootServer({
			responses: [
				async () => {
					await gate;
					return fauxAssistantMessage("late answer");
				},
			],
		});
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const submission = await root.submit(
			{ type: "input", content: [{ type: "text", text: "slow" }] },
			BACKGROUND_CONTEXT,
		);
		await waitForPlacement(opened, submission.id);

		const abort = () =>
			app.inject({ method: "POST", url: `/v1/conversations/${root.id}/abort` });
		const first = await abort();
		expect(first.statusCode).toBe(200);
		expect(first.json()).toEqual({
			result: "already_placed",
			submissionId: submission.id,
		});
		// Idempotent: the same 200 for the same active submission.
		const second = await abort();
		expect(second.statusCode).toBe(200);
		expect(second.json()).toEqual({
			result: "already_placed",
			submissionId: submission.id,
		});

		// Let the run settle; then nothing is active.
		release();
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		expect(settled.status).toBe("done");
		const third = await abort();
		expect(third.statusCode).toBe(404);
		expect(third.json()).toEqual({ error: "no_active_submission" });
	});

	test("404s when nothing was ever submitted", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/abort`,
		});
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "no_active_submission" });
	});

	test("404s for an unknown conversation id", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "POST",
			url: "/v1/conversations/999999/abort",
		});
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "conversation_not_found" });
	});
});
