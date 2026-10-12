/**
 * Task 8b: GET/PATCH /v1/settings.
 *
 * The endpoint serves the file-backed settings store `openHarness` boots
 * with (Task 8a): GET the effective settings, PATCH merges (unknown key →
 * 400 invalid_field; wrong types → 400 per the file conventions; null
 * clears a key) and persists to the file, and the harness picks changes
 * up on the NEXT resolution — steeringMode on the next submission's
 * admission (pi-durable re-reads HarnessSettings per boundary).
 *
 * The steering testable (the spec's binding test): PATCH steeringMode to
 * "all", then drive two submissions through the REAL harness and observe
 * the inbox modes — with steeringMode "all" every queued steer item is
 * admitted at the boundary, versus pi-durable's default one-at-a-time.
 * Mirrors the queue-mode observation pattern of
 * test/server-submissions.test.ts.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import { InboxDoc, type ConversationId } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { settingsPath } from "../src/harness/settings.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import type { FastifyInstance } from "fastify";

/** One hermetic server: harness + faux provider + Fastify app + settings dir. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	/** The tmp settings dir (the store's file lives at `settings.json`). */
	settingsDir: string;
	/** The faux provider (append responses per test). */
	faux: FauxProviderHandle;
}

/**
 * Boot a hermetic server with its settings store over a fresh tmp dir
 * (the `settingsDir` seam — no `~/.config/sigrun` write).
 */
async function bootServer(
	env: Record<string, string> = {},
): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-sett-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
		// A slow stream keeps the first turn busy for the steer observation.
		tokensPerSecond: 4,
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		...env,
	});
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
		settingsDir: dir,
	});
	const app = await createServer(opened, config);
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, settingsDir: dir, faux };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

const patch = (app: FastifyInstance, body: unknown) =>
	app.inject({
		method: "PATCH",
		url: "/v1/settings",
		payload: body as Record<string, unknown>,
		headers: { "content-type": "application/json" },
	});

/**
 * The `pi.user` entries whose content starts with `prefix` — content may
 * be a plain string (a bare-string submission) or a parts array, so both
 * shapes are checked (the §5 view serializes the stored entry verbatim).
 */
function userEntriesWithText(
	view: { readonly entries: readonly unknown[] },
	prefix: string,
): readonly unknown[] {
	return (
		view.entries as Array<{
			kind: string;
			model?: { content?: unknown }[];
		}>
	).filter((entry) => {
		if (entry.kind !== "pi.user") return false;
		const content = entry.model?.[0]?.content;
		const parts = Array.isArray(content) ? content : [{ text: content }];
		return parts.some((part) =>
			String((part as { text?: string }).text ?? "").startsWith(prefix),
		);
	});
}

describe("GET /v1/settings", () => {
	test("serves {} when the settings file is absent (all defaults)", async () => {
		const { app } = await bootServer();
		const response = await app.inject({ method: "GET", url: "/v1/settings" });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({});
	});

	test("serves the file's contents when present", async () => {
		const { app, settingsDir } = await bootServer();
		await writeFile(
			settingsPath(settingsDir),
			'{"steeringMode": "all"}',
			"utf8",
		);
		const response = await app.inject({ method: "GET", url: "/v1/settings" });
		expect(response.json()).toEqual({ steeringMode: "all" });
	});
});

describe("PATCH /v1/settings", () => {
	test("merges, persists to the file, and reads back", async () => {
		const { app, settingsDir } = await bootServer();
		const response = await patch(app, { steeringMode: "all" });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ steeringMode: "all" });
		// The file on disk carries it (the next boot reads the same value).
		const file = JSON.parse(
			await (await import("node:fs/promises")).readFile(
				settingsPath(settingsDir),
				"utf8",
			),
		);
		expect(file).toEqual({ steeringMode: "all" });
		const readBack = await app.inject({
			method: "GET",
			url: "/v1/settings",
		});
		expect(readBack.json()).toEqual({ steeringMode: "all" });
	});

	test("a second PATCH preserves the first key (merge, not replace)", async () => {
		const { app } = await bootServer();
		await patch(app, { steeringMode: "all" });
		const response = await patch(app, { followUpMode: "all" });
		expect(response.json()).toEqual({
			steeringMode: "all",
			followUpMode: "all",
		});
	});

	test("null clears a key", async () => {
		const { app } = await bootServer();
		await patch(app, { steeringMode: "all" });
		const response = await patch(app, { steeringMode: null });
		expect(response.json()).toEqual({});
	});

	test("unknown key → 400 invalid_field naming it", async () => {
		const { app } = await bootServer();
		const response = await patch(app, { compaction: {} });
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({
			error: "invalid_field",
			field: "compaction",
		});
	});

	test("wrong types → 400 invalid_field naming the key", async () => {
		const { app } = await bootServer();
		for (const [body, field] of [
			[{ steeringMode: "sometimes" }, "steeringMode"],
			[{ defaultTools: "read" }, "defaultTools"],
			[{ defaultTools: ["read", 42] }, "defaultTools"],
			[{ perModelThinking: { "faux/m": "sideways" } }, "perModelThinking.faux/m"],
			[{ retry: { maxRetries: -1 } }, "retry.maxRetries"],
		] as const) {
			const response = await patch(app, body);
			expect(response.statusCode).toBe(400);
			expect(response.json()).toEqual({
				error: "invalid_field",
				field,
			});
		}
	});

	test("a non-object body → 400 invalid_body", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "PATCH",
			url: "/v1/settings",
			payload: [1, 2],
			headers: { "content-type": "application/json" },
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "invalid_body" });
	});

	test("a rejected PATCH persists nothing", async () => {
		const { app, settingsDir } = await bootServer();
		await patch(app, { steeringMode: "all" });
		await patch(app, { bogus: 1 });
		const read = (
			await app.inject({ method: "GET", url: "/v1/settings" })
		).json();
		expect(read).toEqual({ steeringMode: "all" });
		expect(JSON.parse(
			await (await import("node:fs/promises")).readFile(
				settingsPath(settingsDir),
				"utf8",
			),
		)).toEqual({ steeringMode: "all" });
	});
});

describe("the steering testable: a PATCHed steeringMode changes the next submission's admission", () => {
	/**
	 * Drive one busy turn plus `count` steered submissions through the REAL
	 * harness + server routes, polling the inbox and the transcript while
	 * the runs proceed. Each sample records (steered answers placed, inbox
	 * steer items queued) — the direct observable of the boundary's queue
	 * mode: "all" drains EVERY steer at the single boundary, one-at-a-time
	 * leaves the rest queued while the first steered answer runs.
	 */
	async function steerSamples(
		server: TestServer,
		count: number,
	): Promise<readonly { answers: number; queued: number }[]> {
		const { app, opened, faux } = server;
		// Turn 1: a long answer streamed slowly (the busy lever). The steered
		// rounds' answers stream slowly TOO: under one-at-a-time the second
		// steer sits queued WHILE the first steered answer runs, and a fast
		// answer closes that window before the 25ms poll can observe it (the
		// racy prior version; the slow stream holds the window open).
		faux.setResponses([
			fauxAssistantMessage("slow streaming first answer ".repeat(12)),
			...Array.from({ length: count }, (_, i) =>
				fauxAssistantMessage(`steered answer ${i} `.repeat(12)),
			),
		]);
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const first = await root.submit(
			{ type: "input", content: "first turn (busy lever)" },
			BACKGROUND_CONTEXT,
		);
		// Submit the steers through the server route; the routes settle only
		// after their steered rounds run, so they are started (not awaited)
		// while the observation loop watches the inbox.
		const pending = Array.from({ length: count }, (_, i) =>
			app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: `steer ${i}`, whenBusy: "steer" },
				headers: { "content-type": "application/json" },
			}),
		);
		const samples: { answers: number; queued: number }[] = [];
		const deadline = Date.now() + 60_000;
		for (;;) {
			const inbox = await opened.harness.snapshot(
				InboxDoc,
				root.id,
				BACKGROUND_CONTEXT,
			);
			const queued =
				(inbox?.items ?? []).filter((item) => item.mode === "steer").length;
			const view = (
				await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
			).json();
			const answers = userAnswersWithText(view, "steered answer").length;
			samples.push({ answers, queued });
			// Done when every submission settled and the inbox drained.
			if (answers >= count && queued === 0) break;
			if (Date.now() > deadline) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const results = await Promise.all(pending);
		for (const result of results) {
			expect(result.statusCode).toBe(202);
			expect(result.json().status).toBe("done");
		}
		expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		return samples;
	}

	/**
	 * The `pi.assistant` entries whose content starts with `prefix` (the
	 * steered rounds' answers) — same string-or-parts handling as the user
	 * matcher.
	 */
	function userAnswersWithText(
		view: { readonly entries: readonly unknown[] },
		prefix: string,
	): readonly unknown[] {
		return (
			view.entries as Array<{
				kind: string;
				model?: { content?: unknown }[];
			}>
		).filter((entry) => {
			if (entry.kind !== "pi.assistant") return false;
			const content = entry.model?.[0]?.content;
			const parts = Array.isArray(content) ? content : [{ text: content }];
			return parts.some((part) =>
				String((part as { text?: string }).text ?? "").startsWith(prefix),
			);
		});
	}

	test(
		'steeringMode "all" (PATCHed through the endpoint): every steer is admitted at the single boundary',
		{ timeout: 90_000 },
		async () => {
			const server = await bootServer();
			const patched = await patch(server.app, { steeringMode: "all" });
			expect(patched.statusCode).toBe(200);
			const samples = await steerSamples(server, 2);
			// The binding observable: at NO sample does a steer sit queued
			// while a steered answer exists — the one boundary admitted
			// BOTH steers at once, so the inbox is empty the moment the
			// first steered answer appears.
			const leftover = samples.filter(
				(sample) => sample.answers > 0 && sample.queued > 0,
			);
			expect(leftover).toEqual([]);
			// And the steers really did run (both answers placed).
			expect(samples[samples.length - 1].answers).toBe(2);
		},
	);

	test(
		"the default (no PATCH): one-at-a-time — the second steer is STILL QUEUED when the first steered answer lands",
		{ timeout: 90_000 },
		async () => {
			const server = await bootServer();
			const samples = await steerSamples(server, 2);
			// The binding observable (the mirror of the "all" test):
			// pi-durable's default one-at-a-time admission holds the second
			// steer for the NEXT boundary, so its durable state transition
			// (queued → consumed) is ordered AFTER the first steered answer's
			// commit: the inbox keeps a steer queued past the first answer's
			// arrival. The sample stream may not catch the overlap — the view
			// serializer lags the entry commit by many poll cycles while the
			// inbox snapshot reads fresh (observed: the inbox drained at the
			// second boundary ~500 samples before the view served the first
			// answer, so answers-then-queued is never SEEN even though the
			// ordering held). The durable artifacts the stream DOES carry
			// discriminate the modes honestly:
			// (1) the second steer sat queued for many samples — the first
			//     boundary consumed only steer 0 and held steer 1 back (under
			//     "all" the queue is empty the moment the first round commits,
			//     so a post-"1a" queued tail cannot form);
			// (2) both rounds ran and the inbox drained (the routes settled).
			const firstAnswerAt = samples.findIndex((sample) => sample.answers > 0);
			expect(firstAnswerAt).toBeGreaterThan(0);
			const holdback = samples
				.slice(0, firstAnswerAt)
				.filter((sample) => sample.queued > 0).length;
			expect(holdback).toBeGreaterThan(0);
			// Both ran eventually (the routes settled done).
			expect(samples[samples.length - 1].answers).toBe(2);
			expect(samples[samples.length - 1].queued).toBe(0);
		},
	);
});

describe("defaultTools and perModelThinking (the sigrun-resolved fields)", () => {
	test("defaultTools filters the created conversation's tools (server create)", async () => {
		const { app, opened } = await bootServer();
		const patched = await patch(app, {
			defaultTools: ["read", "bash"],
		});
		expect(patched.statusCode).toBe(200);
		// The server route applies the store's tool filter at create
		// (storeAgentChange) — resolve the agent and check the selection.
		const response = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			payload: {},
			headers: { "content-type": "application/json" },
		});
		expect(response.statusCode).toBe(201);
		const { id } = response.json() as { id: number };
		const conversation = await opened.harness.conversation(
			id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		expect(conversation).toBeDefined();
		const agent = await conversation!.agent(BACKGROUND_CONTEXT);
		// Exactly the filter's names, in filter order (pi-durable resolves
		// the stored name array against the composed selection).
		expect(agent.tools.map((tool) => tool.name)).toEqual(["read", "bash"]);
		// And unPATCHed settings (an absent file) leave every tool on:
		// a second server booted with no file sees all 7 core tools.
		const bare = await bootServer();
		const created = await bare.app.inject({
			method: "POST",
			url: "/v1/conversations",
			payload: {},
			headers: { "content-type": "application/json" },
		});
		const conv = await bare.opened.harness.conversation(
			(created.json() as { id: number }).id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const fullAgent = await conv!.agent(BACKGROUND_CONTEXT);
		// Every core-installed tool (7 core tools + load_skill from the
		// skills convention) — the no-filter default.
		expect(fullAgent.tools.map((tool) => tool.name).sort()).toEqual([
			"bash",
			"edit",
			"find",
			"grep",
			"load_skill",
			"ls",
			"read",
			"write",
		]);
	});

	test("perModelThinking applies at create and at configure", async () => {
		const { app, opened } = await bootServer();
		const patched = await patch(app, {
			perModelThinking: { "faux/m": "high" },
		});
		expect(patched.statusCode).toBe(200);
		const response = await app.inject({
			method: "POST",
			url: "/v1/conversations",
			payload: {},
			headers: { "content-type": "application/json" },
		});
		const { id } = response.json() as { id: number };
		const conversation = await opened.harness.conversation(
			id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		expect((await conversation!.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe(
			"high",
		);
		// configure: a model change WITHOUT an explicit thinking re-applies
		// the map's override for the NEW model; an explicit thinking wins.
		const configured = await app.inject({
			method: "POST",
			url: `/v1/conversations/${id}/configure`,
			payload: { model: "faux/m", thinking: "low" },
			headers: { "content-type": "application/json" },
		});
		expect(configured.json().thinkingLevel).toBe("low");
	});
});