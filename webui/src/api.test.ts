/**
 * The typed §5 client against a stub fetch (Task 20): path + accept-header
 * shaping, JSON pass-through, baseUrl prefixing, and fail-loud non-2xx
 * handling. Runs under the webui workspace's own vitest (node environment —
 * the client never touches the DOM).
 */

import { describe, expect, test } from "vitest";
import {
	createClient,
	type ConversationList,
	type ConversationMeta,
	type FetchLike,
	type FileContentResponseWire,
	type FileListResponseWire,
	type MetaResponse,
	type ModelsResponse,
} from "./api";

/** A fetch stub returning one canned JSON body; records its calls. */
function stubFetch(body: unknown, init?: { status?: number }) {
	const calls: {
		input: string;
		method?: string;
		accept?: string;
		body?: string;
	}[] = [];
	const fetchImpl: FetchLike = (input, request) => {
		calls.push({
			input,
			method: request?.method,
			accept: request?.headers?.["accept"],
			body: request?.body,
		});
		return Promise.resolve({
			ok: (init?.status ?? 200) >= 200 && (init?.status ?? 200) < 300,
			status: init?.status ?? 200,
			json: () => Promise.resolve(body),
			text: () => Promise.resolve(String(body)),
		});
	};
	return { calls, fetchImpl };
}

const META: MetaResponse = {
	harnessVersion: "h-0",
	schemaVersion: "s-0",
	extensions: [],
	health: { backup: "unconfigured", memory: "ok", providers: "ok" },
	capabilities: { backup: false, channels: ["webui"] },
};

describe("createClient", () => {
	test("getMeta GETs /v1/meta with an accept header and parses the body", async () => {
		const { calls, fetchImpl } = stubFetch(META);
		const client = createClient({ fetch: fetchImpl });
		const meta = await client.getMeta();
		expect(meta).toEqual(META);
		expect(meta.capabilities.channels).toEqual(["webui"]);
		expect(calls).toEqual([
			{ input: "/v1/meta", method: "GET", accept: "application/json" },
		]);
	});

	test("listConversations GETs /v1/conversations", async () => {
		const body: ConversationList = {
			conversations: [{ id: 1, root: true, entryCount: 0 }],
		};
		const { calls, fetchImpl } = stubFetch(body);
		const client = createClient({ fetch: fetchImpl });
		const list = await client.listConversations();
		expect(list.conversations).toHaveLength(1);
		expect(calls[0]?.input).toBe("/v1/conversations");
	});

	test("listModels GETs /v1/models", async () => {
		const body: ModelsResponse = { models: [] };
		const { calls, fetchImpl } = stubFetch(body);
		const client = createClient({ fetch: fetchImpl });
		const list = await client.listModels();
		expect(list.models).toEqual([]);
		expect(calls[0]?.input).toBe("/v1/models");
	});

	test("baseUrl prefixes every request path", async () => {
		const { calls, fetchImpl } = stubFetch(META);
		const client = createClient({
			baseUrl: "https://sigrun.example",
			fetch: fetchImpl,
		});
		await client.getMeta();
		expect(calls[0]?.input).toBe("https://sigrun.example/v1/meta");
	});

	test("a non-2xx response rejects with status and path, never a silent empty state", async () => {
		const { fetchImpl } = stubFetch({ error: "nope" }, { status: 503 });
		const client = createClient({ fetch: fetchImpl });
		await expect(client.getMeta()).rejects.toThrow("503");
		await expect(client.getMeta()).rejects.toThrow("/v1/meta");
	});

	test("submit POSTs the §5 submission body (input parts + requestId + whenBusy) and parses the settled record", async () => {
		const settled = {
			id: 7,
			conversationId: 2,
			type: "input",
			status: "done",
		};
		const { calls, fetchImpl } = stubFetch(settled, { status: 202 });
		const client = createClient({ fetch: fetchImpl });
		const result = await client.submit(
			2,
			[{ type: "text", text: "hello there" }],
			{ requestId: "req-1", whenBusy: "steer" },
		);
		expect(result).toEqual(settled);
		expect(calls).toEqual([
			{
				input: "/v1/conversations/2/submissions",
				method: "POST",
				accept: "application/json",
				body: JSON.stringify({
					input: [{ type: "text", text: "hello there" }],
					requestId: "req-1",
					whenBusy: "steer",
				}),
			},
		]);
	});

	test("submit omits requestId/whenBusy when the options are absent", async () => {
		const { calls, fetchImpl } = stubFetch({ id: 1 });
		const client = createClient({ fetch: fetchImpl });
		await client.submit(3, [{ type: "text", text: "plain" }]);
		expect(calls[0]?.input).toBe("/v1/conversations/3/submissions");
		expect(calls[0]?.body).toBe(
			JSON.stringify({ input: [{ type: "text", text: "plain" }] }),
		);
	});

	test("getConversationMeta GETs the meta shape", async () => {
		const body: ConversationMeta = {
			pinned: true,
			tagged: [],
			archived: false,
			draft: { text: "", attachments: [] },
			source: "user",
			owner: "local",
		};
		const { calls, fetchImpl } = stubFetch(body);
		const client = createClient({ fetch: fetchImpl });
		const meta = await client.getConversationMeta(7);
		expect(meta.pinned).toBe(true);
		expect(meta.owner).toBe("local");
		expect(calls).toEqual([
			{
				input: "/v1/conversations/7/meta",
				method: "GET",
				accept: "application/json",
			},
		]);
	});

	test("patchConversationMeta PATCHes a merge body", async () => {
		const { calls, fetchImpl } = stubFetch({});
		const client = createClient({ fetch: fetchImpl });
		await client.patchConversationMeta(7, { archived: true });
		expect(calls).toEqual([
			{
				input: "/v1/conversations/7/meta",
				method: "PATCH",
				accept: "application/json",
				body: JSON.stringify({ archived: true }),
			},
		]);
	});

	test("createConversation POSTs /v1/conversations and parses the created summary", async () => {
		const body = { id: 42, root: false, entryCount: 0 };
		const { calls, fetchImpl } = stubFetch(body);
		const client = createClient({ fetch: fetchImpl });
		const created = await client.createConversation();
		expect(created).toEqual(body);
		expect(calls).toEqual([
			{
				input: "/v1/conversations",
				method: "POST",
				accept: "application/json",
				body: JSON.stringify({}),
			},
		]);
	});

	test("createConversation is fail-loud on a non-2xx response", async () => {
		const { fetchImpl } = stubFetch({}, { status: 500 });
		const client = createClient({ fetch: fetchImpl });
		await expect(client.createConversation()).rejects.toThrow("500");
	});

	test("listFiles GETs the files endpoint with the path query (default '.')", async () => {
		const body: FileListResponseWire = {
			entries: [
				{
					name: "src",
					path: "src",
					kind: "directory",
					size: 0,
					mtimeMs: 1,
				},
			],
		};
		const { calls, fetchImpl } = stubFetch(body);
		const client = createClient({ fetch: fetchImpl });
		const listed = await client.listFiles(4);
		expect(listed.entries[0]?.kind).toBe("directory");
		expect(calls[0]?.input).toBe("/v1/conversations/4/files?path=.");
		await client.listFiles(4, "src/deep dir");
		expect(calls[1]?.input).toBe(
			"/v1/conversations/4/files?path=src%2Fdeep%20dir",
		);
	});

	test("readFile GETs files/content with the encoded path and parses both encodings", async () => {
		const textBody: FileContentResponseWire = {
			encoding: "text",
			content: "hello",
			size: 5,
		};
		const { calls, fetchImpl } = stubFetch(textBody);
		const client = createClient({ fetch: fetchImpl });
		const read = await client.readFile(4, "src/a file.txt");
		expect(read).toEqual(textBody);
		expect(calls[0]?.input).toBe(
			"/v1/conversations/4/files/content?path=src%2Fa%20file.txt",
		);
	});

	test("upload POSTs {name, contentBase64} and returns the workspace-relative path", async () => {
		const { calls, fetchImpl } = stubFetch(
			{ path: "uploads/4/note.txt" },
			{ status: 201 },
		);
		const client = createClient({ fetch: fetchImpl });
		const file = {
			name: "note.txt",
			// "hi" = 0x68 0x69 → base64 "aGk="
			arrayBuffer: () =>
				Promise.resolve(new Uint8Array([104, 105]).buffer),
		};
		const uploaded = await client.upload(4, file);
		expect(uploaded).toEqual({ path: "uploads/4/note.txt" });
		expect(calls).toEqual([
			{
				input: "/v1/conversations/4/uploads",
				method: "POST",
				accept: "application/json",
				body: JSON.stringify({ name: "note.txt", contentBase64: "aGk=" }),
			},
		]);
	});

	test("compact POSTs the compact endpoint and parses the task id", async () => {
		const { calls, fetchImpl } = stubFetch({ taskId: 12 }, { status: 202 });
		const client = createClient({ fetch: fetchImpl });
		const admitted = await client.compact(7);
		expect(admitted).toEqual({ taskId: 12 });
		expect(calls).toEqual([
			{
				input: "/v1/conversations/7/compact",
				method: "POST",
				accept: "application/json",
				body: JSON.stringify({}),
			},
		]);
	});

	test("compact is fail-loud on a non-2xx response", async () => {
		const { fetchImpl } = stubFetch(
			{ error: "conversation_not_found" },
			{ status: 404 },
		);
		const client = createClient({ fetch: fetchImpl });
		await expect(client.compact(999)).rejects.toThrow("404");
	});

	test("readFile is fail-loud on a non-2xx response (e.g. 413 file_too_large)", async () => {
		const { fetchImpl } = stubFetch(
			{ error: "file_too_large", maxBytes: 1048576 },
			{ status: 413 },
		);
		const client = createClient({ fetch: fetchImpl });
		await expect(client.readFile(4, "big.bin")).rejects.toThrow("413");
	});
});
