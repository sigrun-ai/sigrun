/**
 * Task 9b: submissions (content-part resolution) + uploads + files + models.
 *
 * `POST /v1/conversations/:id/submissions` accepts content parts —
 * `{type:"text",text}` and `{type:"image"|"file", path, mime?}` — and the
 * server resolves path-parts to INLINE content at submit time via the
 * conversation's ExecutionEnv (the same `envBuilder` seam tool calls use):
 * base64 `ImageContent` for images, text for files. A missing path yields an
 * EXPLICIT error part in the submitted content — never a silent drop
 * (Review Focus #1). `requestId` is passed through to upstream's
 * idempotent-submit machinery.
 *
 * `POST .../uploads` materializes a base64 body into the conversation's
 * workspace (`uploads/<conversationId>/<name>` via `env.writeFile`), and the
 * files endpoints list/read through the same env (read-only). `GET
 * /v1/models` serves the merged chat-model catalog.
 *
 * Hermetic pattern: faux provider + tmp workspace + `app.inject()` (see
 * server.test.ts).
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
import { InboxDoc } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import type { FastifyInstance } from "fastify";

/** A 1x1 red PNG (base64), for the image round-trip. */
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8BQDwAEBQAF" +
	"yN0c5gAAAABJRU5ErkJggg==";

/** One hermetic server: harness + faux provider + Fastify app + workspace. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	/** The tmp workspace root (`SIGRUN_WORKSPACE_PATH`). */
	workspace: string;
	/** The faux provider (append responses per test). */
	faux: FauxProviderHandle;
}

/**
 * Boot a hermetic server whose workspace already contains the fixture files:
 * `notes.txt` (text), `dot.png` (binary PNG bytes), plus an `empty/` dir.
 * `env` appends config overrides (e.g. the forced compaction thresholds
 * the compact-endpoint test needs).
 */
async function bootServer(
	env: Record<string, string> = {},
): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-subm-"));
	await writeFile(join(dir, "notes.txt"), "workspace notes", "utf8");
	await writeFile(join(dir, "dot.png"), Buffer.from(PNG_BASE64, "base64"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
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
	});
	const app = await createServer(opened, config);
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, workspace: dir, faux };
}

/**
 * Boot a hermetic server with extension packages loaded (T26a: the memory
 * extension's wiring) and the faux provider streaming at `tokensPerSecond`
 * (a slow stream keeps the first turn busy for the steer observation). The
 * faux queue starts EMPTY — each test scripts its own responses.
 */
async function bootExtendedServer(options: {
	extensionSpecifiers: readonly string[];
	tokensPerSecond?: number;
}): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-subm-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
		...(options.tokensPerSecond === undefined
			? {}
			: { tokensPerSecond: options.tokensPerSecond }),
	});
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		extensions: [contributor],
		env: {},
		extensionSpecifiers: options.extensionSpecifiers,
	});
	const app = await createServer(opened, config);
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, workspace: dir, faux };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Submit `input` to `conversationId`; returns the parsed response. */
async function submit(
	app: FastifyInstance,
	conversationId: number,
	input: unknown,
	requestId?: string,
) {
	return app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/submissions`,
		payload: requestId === undefined ? { input } : { input, requestId },
		headers: { "content-type": "application/json" },
	});
}

// ---------------------------------------------------------------------------
// POST /v1/conversations/:id/submissions — content-part resolution
// ---------------------------------------------------------------------------

describe("POST /v1/conversations/:id/submissions", () => {
	test("a conversation pinned to an unserved model gets 400 + available ids at submit", async () => {
		// Spec §2/§3 binding contract (Review Focus #2): fail loud at SUBMIT
		// with the available list, never a silent fallback and never a settled
		// no_model run surfaced later. Configure the conversation to a model
		// no provider serves, then submit.
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const configured = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/configure`,
			payload: { model: "faux/nonexistent" },
			headers: { "content-type": "application/json" },
		});
		// configure accepts it (validation of the catalog is not configure's
		// job — T9c-i ruling); the submit is where the contract bites.
		expect(configured.statusCode).toBe(200);
		const response = await submit(app, root.id, "hello");
		expect(response.statusCode).toBe(400);
		const body = response.json();
		expect(body.error).toBe("unserved_model");
		expect(body.model).toBe("faux/nonexistent");
		expect(body.available).toContain("faux/m");
		// And nothing was admitted: no submission, no run, no entries.
		const view = (
			await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
		).json();
		expect(
			view.entries.filter((e: { kind: string }) => e.kind === "pi.user"),
		).toEqual([]);
	});

	test("a bare string input submits and the answer lands in the view", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await submit(app, root.id, "hello");
		expect(response.statusCode).toBe(202);
		const body = response.json();
		expect(body.conversationId).toBe(root.id);
		expect(body.status).toBe("done");
		const view = (
			await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
		).json();
		const kinds = view.entries.map((e: { kind: string }) => e.kind);
		expect(kinds).toContain("pi.assistant");
	});

	test("text parts submit and reach the transcript verbatim", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await submit(app, root.id, [
			{ type: "text", text: "part one" },
			{ type: "text", text: "part two" },
		]);
		expect(response.statusCode).toBe(202);
		const view = (
			await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
		).json();
		const user = view.entries.find(
			(e: { kind: string }) => e.kind === "pi.user",
		);
		expect(user.model[0].content).toEqual([
			{ type: "text", text: "part one" },
			{ type: "text", text: "part two" },
		]);
	});

	test("image parts inline as base64 ImageContent", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await submit(app, root.id, [
			{ type: "text", text: "look" },
			{ type: "image", path: "dot.png", mime: "image/png" },
		]);
		expect(response.statusCode).toBe(202);
		const view = (
			await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
		).json();
		const user = view.entries.find(
			(e: { kind: string }) => e.kind === "pi.user",
		);
		const image = user.model[0].content.find(
			(part: { type: string }) => part.type === "image",
		);
		expect(image).toEqual({
			type: "image",
			data: PNG_BASE64,
			mimeType: "image/png",
		});
	});

	test("image parts default the mime type from the extension", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await submit(app, root.id, [
			{ type: "image", path: "dot.png" },
		]);
		expect(response.statusCode).toBe(202);
		const view = (
			await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
		).json();
		const user = view.entries.find(
			(e: { kind: string }) => e.kind === "pi.user",
		);
		expect(user.model[0].content[0].mimeType).toBe("image/png");
	});

	test("file parts inline as text parts", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await submit(app, root.id, [
			{ type: "text", text: "read this" },
			{ type: "file", path: "notes.txt" },
		]);
		expect(response.statusCode).toBe(202);
		const view = (
			await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
		).json();
		const user = view.entries.find(
			(e: { kind: string }) => e.kind === "pi.user",
		);
		const texts = user.model[0].content.filter(
			(part: { type: string }) => part.type === "text",
		);
		expect(texts).toEqual([
			{ type: "text", text: "read this" },
			{ type: "text", text: "workspace notes" },
		]);
	});

	test("a missing path yields an explicit error part, never a silent drop", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await submit(app, root.id, [
			{ type: "text", text: "see attached" },
			{ type: "file", path: "no-such-file.txt" },
			{ type: "image", path: "also-missing.png" },
		]);
		expect(response.statusCode).toBe(202);
		const view = (
			await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
		).json();
		const user = view.entries.find(
			(e: { kind: string }) => e.kind === "pi.user",
		);
		const texts = user.model[0].content.map((part: { text?: string; type?: string }) =>
			part.type === "text" ? part.text : part.type,
		);
		// BOTH missing paths appear — explicit, addressed to the model.
		expect(texts[0]).toBe("see attached");
		expect(texts[1]).toContain("no-such-file.txt");
		expect(texts[1]).toContain("not_found");
		expect(texts[2]).toContain("also-missing.png");
		expect(texts[2]).toContain("not_found");
	});

	test("a non-UTF8 file part becomes an explicit error part", async () => {
		const { app, opened, workspace } = await bootServer();
		await writeFile(
			join(workspace, "blob.bin"),
			Buffer.from([0xff, 0xfe, 0x00, 0x81]),
		);
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await submit(app, root.id, [
			{ type: "file", path: "blob.bin" },
		]);
		expect(response.statusCode).toBe(202);
		const view = (
			await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
		).json();
		const user = view.entries.find(
			(e: { kind: string }) => e.kind === "pi.user",
		);
		const text = user.model[0].content[0].text;
		expect(text).toContain("blob.bin");
		expect(text).toContain("invalid_utf8");
	});

	test("requestId makes a duplicate submit return the same submission", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const first = (
			await submit(app, root.id, [{ type: "text", text: "once" }], "req-1")
		).json();
		const second = (
			await submit(app, root.id, [{ type: "text", text: "once again" }], "req-1")
		).json();
		expect(second.id).toBe(first.id);
		expect(second.status).toBe("done");
		// Only ONE user turn was placed: the duplicate was deduped upstream.
		const view = (
			await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
		).json();
		const users = view.entries.filter(
			(e: { kind: string }) => e.kind === "pi.user",
		);
		expect(users.length).toBe(1);
	});

	test("submits against an untracked stored conversation (restart amnesia)", async () => {
		const { app, opened } = await bootServer();
		// A conversation created directly through the harness — never added to
		// the server's tracked Set (the post-restart situation).
		const conversation = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		const listed = (
			await app.inject({ method: "GET", url: "/v1/conversations" })
		).json();
		expect(
			listed.conversations.some(
				(c: { id: number }) => c.id === conversation.id,
			),
		).toBe(false);
		const response = await submit(app, conversation.id, "still works");
		expect(response.statusCode).toBe(202);
		expect(response.json().status).toBe("done");
	});

	test("404s for an unknown conversation id", async () => {
		const { app } = await bootServer();
		const response = await submit(app, 999999, "hello");
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "conversation_not_found" });
	});

	test("rejects an unknown whenBusy value fail-loud (400 invalid_field)", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		for (const whenBusy of ["interrupt", "STEER", 42, null]) {
			const response = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "hello", whenBusy },
				headers: { "content-type": "application/json" },
			});
			expect(response.statusCode).toBe(400);
			expect(response.json()).toEqual({
				error: "invalid_field",
				field: "whenBusy",
			});
		}
		// A rejected whenBusy never admitted anything: no user entries.
		const view = (
			await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
		).json();
		expect(
			view.entries.filter((e: { kind: string }) => e.kind === "pi.user"),
		).toEqual([]);
	});

	test(
		'submit while busy with whenBusy:"steer" queues the inbox item in steer mode',
		{ timeout: 60_000 },
		async () => {
			// T26a Fix A: the route must pass body.whenBusy through to
			// conversation.submit. The discriminating observable (the T12b
			// battery's): upstream queues a busy-conversation input in pi.inbox
			// with mode "steer" for an explicit steer, "followUp" otherwise
			// (submissions.js: `draft.whenBusy === "steer" ? "steer" :
			// "followUp"`) — a DROPPED whenBusy lands in followUp mode.
			const { app, opened, faux } = await bootExtendedServer({
				extensionSpecifiers: [],
				tokensPerSecond: 4,
			});
			// Turn 1 streams a long answer slowly (the busy lever); turn 2 is the
			// steered input's answer (served at the next boundary).
			faux.setResponses([
				fauxAssistantMessage("slow streaming first answer ".repeat(30)),
				fauxAssistantMessage("steered answer"),
			]);
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			// Start the busy turn directly through the harness — the server route
			// waits for settlement, which would serialize the observation.
			const first = await root.submit(
				{ type: "input", content: "first turn (busy lever)" },
				BACKGROUND_CONTEXT,
			);
			// The server-driven steer submit: admitted (queued) at once; the
			// route's settlement wait resolves after the steered round answers.
			const pending = app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/submissions`,
				payload: { input: "steer me", whenBusy: "steer" },
				headers: { "content-type": "application/json" },
			});
			// Observe the inbox BEFORE the busy turn ends (the steer item is
			// consumed at the boundary when the first answer completes).
			const observedModes: string[] = [];
			const deadline = Date.now() + 20_000;
			for (;;) {
				const inbox = await opened.harness.snapshot(
					InboxDoc,
					root.id,
					BACKGROUND_CONTEXT,
				);
				for (const item of inbox?.items ?? []) {
					if (item.mode !== "write" && !observedModes.includes(item.mode)) {
						observedModes.push(item.mode);
					}
				}
				if (observedModes.includes("steer")) break;
				const firstStatus = await first.status(BACKGROUND_CONTEXT);
				if (
					(firstStatus.status === "done" ||
						firstStatus.status === "unanswered") &&
					Date.now() > deadline
				) {
					break;
				}
				if (Date.now() > deadline) break;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			// The steer item MUST have been observed — a followUp-mode sighting
			// means the route dropped whenBusy (the pre-fix behavior).
			expect(observedModes).toContain("steer");
			const response = await pending;
			expect(response.statusCode).toBe(202);
			expect(response.json().status).toBe("done");
		},
	);

	test(
		"a server-driven submit binds the memory recall source (memory_recall answers)",
		{ timeout: 60_000 },
		async () => {
			// T26a Fix B: sigrun-ext-memory-markdown's wiring submit binds the
			// conversation as the recall source at the submit boundary
			// (degenerate.js: hosts submit through the wiring's submit()). The
			// server must route submissions through it (OpenedHarness.memorySubmit,
			// identity-matched to the section owner like memoryHealth) — else the
			// memory_recall tool answers "No conversation bound to memory recall
			// yet." on every call.
			const { app, opened, faux } = await bootExtendedServer({
				extensionSpecifiers: ["sigrun-ext-memory-markdown"],
			});
			// Boot exposed the memory wiring's submit (identity-matched).
			expect(opened.memorySubmit).toBeDefined();
			faux.setResponses([
				fauxAssistantMessage("an unremarkable answer"),
			]);
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const response = await submit(app, root.id, "hello");
			expect(response.statusCode).toBe(202);
			expect(response.json().status).toBe("done");
			// Drive the registered memory_recall tool directly: its execute
			// ignores the api/context params (degenerate.js recallTool: `_api`,
			// `_context`), so a direct call exercises exactly the binding gate
			// plus the transcript scan — the user entry the server submit wrote.
			const tool = opened.registry
				.snapshot()
				.tools()
				.find((entry) => entry.tool.name === "memory_recall")?.tool;
			expect(tool).toBeDefined();
			const result = await tool!.execute(
				{ query: "hello" },
				undefined as never,
				BACKGROUND_CONTEXT,
			);
			expect(result.isError).toBeUndefined();
			// The pinned sigrun-ext-memory-markdown (Task 2's working tree, pin
			// bump in Task 8) still speaks pi-durable 1.0.2's `content` shape;
			// read whichever channel the direct call actually returned.
			const raw = result as { output?: unknown; content?: unknown };
			const blocks = (raw.output ?? raw.content ?? []) as {
				type: string;
				text?: string;
			}[];
			const text = blocks
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("");
			expect(text).toContain("hello");
			expect(text).not.toContain("No conversation bound");
		},
	);

	test("rejects a malformed input (fail-loud): not an array, bad part shape", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const badPart = await submit(app, root.id, [
			{ type: "text", text: "ok" },
			{ type: "text" },
		]);
		expect(badPart.statusCode).toBe(400);
		expect(badPart.json()).toEqual({ error: "invalid_input" });

		const notArray = await submit(app, root.id, 42);
		expect(notArray.statusCode).toBe(400);

		const badType = await submit(app, root.id, [{ type: "audio", path: "x" }]);
		expect(badType.statusCode).toBe(400);

		const absolutePath = await submit(app, root.id, [
			{ type: "file", path: "/etc/passwd" },
		]);
		expect(absolutePath.statusCode).toBe(400);
		expect(absolutePath.json()).toEqual({ error: "invalid_input" });

		const dotDot = await submit(app, root.id, [
			{ type: "file", path: "../outside.txt" },
		]);
		expect(dotDot.statusCode).toBe(400);
	});
});

// ---------------------------------------------------------------------------
// POST /v1/conversations/:id/uploads
// ---------------------------------------------------------------------------

describe("POST /v1/conversations/:id/uploads", () => {
	test("writes the body into the conversation's upload namespace and returns the path", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/uploads`,
			payload: { name: "snapshot.png", contentBase64: PNG_BASE64 },
			headers: { "content-type": "application/json" },
		});
		expect(response.statusCode).toBe(201);
		const body = response.json();
		expect(body.path).toBe(`uploads/${root.id}/snapshot.png`);
		// Round-trip: the returned path works as a submission content part.
		const submitted = await submit(app, root.id, [
			{ type: "image", path: body.path },
		]);
		expect(submitted.statusCode).toBe(202);
		const view = (
			await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
		).json();
		const user = view.entries.find(
			(e: { kind: string }) => e.kind === "pi.user",
		);
		expect(user.model[0].content[0].data).toBe(PNG_BASE64);
	});

	test("rejects invalid bodies (name, base64) fail-loud", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const url = `/v1/conversations/${root.id}/uploads`;
		const missing = await app.inject({
			method: "POST",
			url,
			payload: { contentBase64: "aGk=" },
			headers: { "content-type": "application/json" },
		});
		expect(missing.statusCode).toBe(400);
		const badB64 = await app.inject({
			method: "POST",
			url,
			payload: { name: "x.txt", contentBase64: "!!!" },
			headers: { "content-type": "application/json" },
		});
		expect(badB64.statusCode).toBe(400);
		const traversal = await app.inject({
			method: "POST",
			url,
			payload: { name: "../escape.txt", contentBase64: "aGk=" },
			headers: { "content-type": "application/json" },
		});
		expect(traversal.statusCode).toBe(400);
		const subdir = await app.inject({
			method: "POST",
			url,
			payload: { name: "a/b.txt", contentBase64: "aGk=" },
			headers: { "content-type": "application/json" },
		});
		expect(subdir.statusCode).toBe(400);
	});

	test("404s for an unknown conversation id", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "POST",
			url: "/v1/conversations/999999/uploads",
			payload: { name: "x.txt", contentBase64: "aGk=" },
			headers: { "content-type": "application/json" },
		});
		expect(response.statusCode).toBe(404);
	});
});

// ---------------------------------------------------------------------------
// GET /v1/conversations/:id/files + .../files/content
// ---------------------------------------------------------------------------

describe("GET /v1/conversations/:id/files", () => {
	test("lists workspace directory entries", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/files?path=.`,
		});
		expect(response.statusCode).toBe(200);
		const body = response.json();
		const names = body.entries.map((e: { name: string }) => e.name);
		expect(names).toContain("notes.txt");
		expect(names).toContain("dot.png");
		const notes = body.entries.find(
			(e: { name: string }) => e.name === "notes.txt",
		);
		expect(notes.kind).toBe("file");
		expect(typeof notes.size).toBe("number");
	});

	test("defaults to the workspace root when path is absent", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/files`,
		});
		expect(response.statusCode).toBe(200);
		expect(
			response.json().entries.some(
				(e: { name: string }) => e.name === "notes.txt",
			),
		).toBe(true);
	});

	test("a missing dir 404s; an escaping path 400s", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const missing = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/files?path=no-such-dir`,
		});
		expect(missing.statusCode).toBe(404);
		const escape = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/files?path=..`,
		});
		expect(escape.statusCode).toBe(400);
		expect(escape.json()).toEqual({ error: "invalid_path" });
	});
});

describe("GET /v1/conversations/:id/files/content", () => {
	test("reads a text file as text", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/files/content?path=notes.txt`,
		});
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.encoding).toBe("text");
		expect(body.content).toBe("workspace notes");
		expect(typeof body.size).toBe("number");
	});

	test("reads a binary file as base64", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const response = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/files/content?path=dot.png`,
		});
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.encoding).toBe("base64");
		expect(body.content).toBe(PNG_BASE64);
	});

	test("a missing file 404s; oversize 413s; escaping path 400s", async () => {
		const { app, opened, workspace } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const missing = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/files/content?path=nope.txt`,
		});
		expect(missing.statusCode).toBe(404);
		expect(missing.json()).toEqual({ error: "not_found" });

		await writeFile(
			join(workspace, "big.txt"),
			"a".repeat(1024 * 1024 + 1),
		);
		const oversize = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/files/content?path=big.txt`,
		});
		expect(oversize.statusCode).toBe(413);

		const escape = await app.inject({
			method: "GET",
			url: `/v1/conversations/${root.id}/files/content?path=/etc/passwd`,
		});
		expect(escape.statusCode).toBe(400);
	});
});

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

describe("GET /v1/models", () => {
	test("serves the merged chat-model catalog as picker entries", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "GET",
			url: "/v1/models",
		});
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.models.length).toBe(1);
		const model = body.models[0];
		expect(model.id).toBe("faux/m");
		expect(model.provider).toBe("faux");
		expect(model.modelId).toBe("m");
		expect(model.contextWindow).toBe(128_000);
		expect(model.reasoning).toBe(false);
		// No provider internals leak onto the wire.
		expect(model.baseUrl).toBeUndefined();
		expect(model.headers).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// POST /v1/conversations/:id/compact — manual compaction (Task 4, pi parity)
// ---------------------------------------------------------------------------

describe("POST /v1/conversations/:id/compact", () => {
	// The manual path needs a real transcript worth cutting: a turn first
	// (the faux answer), then the compact POST. Upstream's `selectCut` walks
	// back `keepRecentTokens`; forced to `1` the cut falls right before the
	// newest entry, so the whole first turn is summarized — the same forced-
	// thresholds pattern as test/compaction.test.ts, proving the config
	// knobs reach the policy the manual path reads. `backgroundTokens: 0`
	// keeps the faux queue deterministic for the turn itself; the manual
	// path ignores `enabled` and the thresholds (upstream doc), but its
	// SELECT phase still reads `keepRecentTokens` from the live policy.
	async function bootCompactionServer() {
		return await bootServer({
			SIGRUN_COMPACTION_KEEP_RECENT_TOKENS: "1",
			SIGRUN_COMPACTION_BACKGROUND_TOKENS: "0",
		});
	}

	test("404s for an unknown conversation id", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "POST",
			url: "/v1/conversations/999999/compact",
			payload: {},
			headers: { "content-type": "application/json" },
		});
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "conversation_not_found" });
	});

	test("rejects invalid bodies fail-loud (unknown keys, non-string instructions)", async () => {
		const { app, opened } = await bootServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		for (const [payload, field] of [
			[42, null],
			[{ instructions: "summarize", extra: true }, "extra"],
			[{ instructions: 42 }, "instructions"],
		] as const) {
			const response = await app.inject({
				method: "POST",
				url: `/v1/conversations/${root.id}/compact`,
				payload: payload as unknown as Record<string, unknown>,
				headers: { "content-type": "application/json" },
			});
			expect(response.statusCode).toBe(400);
			const body = response.json() as { error?: string; field?: string };
			if (field === null) {
				expect(body).toEqual({ error: "invalid_body" });
			} else {
				expect(body).toEqual({ error: "invalid_field", field });
			}
		}
		// A rejected compact never admitted a task: no compaction entries.
		const view = (
			await app.inject({ method: "GET", url: `/v1/conversations/${root.id}` })
		).json();
		expect(
			view.entries.filter((e: { kind: string }) => e.kind === "pi.compaction"),
		).toEqual([]);
	});

	test("a manual compact produces a summary entry with reason manual", async () => {
		const { app, opened, faux } = await bootCompactionServer();
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		// One long turn so the compaction has a prefix worth cutting. The
		// faux queue serves the turn's answer (set at boot); the manual
		// compaction consumes the NEXT response (the summary).
		faux.appendResponses([fauxAssistantMessage("turn one answer")]);
		const first = await root.submit(
			{ type: "input", content: `hello ${"filler ".repeat(200)}` },
			BACKGROUND_CONTEXT,
		);
		expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe("done");
		faux.appendResponses([fauxAssistantMessage("manual compaction summary")]);

		const response = await app.inject({
			method: "POST",
			url: `/v1/conversations/${root.id}/compact`,
			payload: {},
			headers: { "content-type": "application/json" },
		});
		expect(response.statusCode).toBe(202);
		const { taskId } = response.json() as { taskId: number };
		expect(typeof taskId).toBe("number");

		// Conversation-owned manual compaction settles with the idle scope:
		// its write submission places the summary at the next boundary.
		await root.waitForIdle(BACKGROUND_CONTEXT);
		let compaction: { kind: string; data?: { reason?: string } } | undefined;
		for (let attempt = 0; attempt < 100 && compaction === undefined; attempt++) {
			const view = (
				await app.inject({
					method: "GET",
					url: `/v1/conversations/${root.id}`,
				})
			).json();
			compaction = view.entries.find(
				(e: { kind: string }) => e.kind === "pi.compaction",
			);
			if (compaction === undefined)
				await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(compaction).toBeDefined();
		expect(compaction?.data?.reason).toBe("manual");
	}, 60_000);
});
