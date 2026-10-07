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
 */
async function bootServer(): Promise<TestServer> {
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
