/**
 * The typed §5 client against a stub fetch (Task 20): path + accept-header
 * shaping, JSON pass-through, baseUrl prefixing, and fail-loud non-2xx
 * handling. Runs under the webui workspace's own vitest (node environment —
 * the client never touches the DOM).
 */

import { describe, expect, test } from "vitest";
import {
	ApiError,
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
		contentType?: string;
		body?: string | Uint8Array;
	}[] = [];
	const fetchImpl: FetchLike = (input, request) => {
		calls.push({
			input,
			method: request?.method,
			accept: request?.headers?.["accept"],
			contentType: request?.headers?.["content-type"],
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
	version: "0.0.0-test",
		harnessVersion: "h-0",
	schemaVersion: "s-0",
	extensions: [],
	health: { backup: "unconfigured", memory: "ok", providers: "ok" },
	auth: { methods: [], claimed: true },
	backup: {},
	capabilities: { backup: false, channels: ["webui"] },
	dev: false,
	supervised: false,
	isolation: { mode: "auto", active: false, available: false, abi: 0, osUsers: "off" },
	seam: { interactions: [], ambient: [] },
	collisions: { webui: [], providers: [], commands: [] },
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
			conversations: [
				{ id: 1, root: true, archived: false, pinned: false, access: "write" },
			],
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

	test("a non-2xx response rejects with an ApiError carrying status + error (never a silent empty state)", async () => {
		const { fetchImpl } = stubFetch({ error: "nope" }, { status: 503 });
		const client = createClient({ fetch: fetchImpl });
		const caught = await client.getMeta().then(
			() => undefined,
			(cause: unknown) => cause,
		);
		expect(caught).toBeInstanceOf(ApiError);
		const error = caught as ApiError;
		expect(error.status).toBe(503);
		expect(error.error).toBe("nope");
		// The message keeps the fail-loud spelling (status + path).
		expect(error.message).toContain("503");
		expect(error.message).toContain("/v1/meta");
	});

	describe("the auth surface (W1 Task 8)", () => {
		test("getOnboarding GETs /v1/onboarding and parses the state", async () => {
			const body = {
				state: "unclaimed",
				methods: ["token"],
				codeRequired: true,
			};
			const { calls, fetchImpl } = stubFetch(body);
			const client = createClient({ fetch: fetchImpl });
			const state = await client.getOnboarding();
			expect(state).toEqual(body);
			expect(calls[0]).toEqual({
				input: "/v1/onboarding",
				method: "GET",
				accept: "application/json",
			});
		});

		test("claim POSTs the claim body verbatim (code + identity + issueToken)", async () => {
			const { calls, fetchImpl } = stubFetch({
				user: { user: "alice", admin: true, createdAt: 1, source: "cli" },
			});
			const client = createClient({ fetch: fetchImpl });
			const response = await client.claim({
				code: "ABCD-EFGH",
				user: "alice",
				issueToken: true,
				tokenName: "webui",
			});
			expect(response.user.user).toBe("alice");
			expect(calls[0]).toEqual({
				input: "/v1/onboarding/claim",
				method: "POST",
				accept: "application/json",
				contentType: "application/json",
				body: JSON.stringify({
					code: "ABCD-EFGH",
					user: "alice",
					issueToken: true,
					tokenName: "webui",
				}),
			});
		});

		test("login POSTs {token} and parses {user}", async () => {
			const { calls, fetchImpl } = stubFetch({ user: "alice" });
			const client = createClient({ fetch: fetchImpl });
			const who = await client.login("sig-token");
			expect(who).toEqual({ user: "alice" });
			expect(calls[0]).toEqual({
				input: "/v1/auth/login",
				method: "POST",
				accept: "application/json",
				contentType: "application/json",
				body: JSON.stringify({ token: "sig-token" }),
			});
		});

		test("logout POSTs /v1/auth/logout and resolves void on the 204 (no body parse)", async () => {
			const { calls, fetchImpl } = stubFetch(undefined, { status: 204 });
			const client = createClient({ fetch: fetchImpl });
			await expect(client.logout()).resolves.toBeUndefined();
			expect(calls[0]).toEqual({
				input: "/v1/auth/logout",
				method: "POST",
				accept: "application/json",
				contentType: "application/json",
				body: JSON.stringify({}),
			});
		});

		test("whoami GETs /v1/auth/whoami and parses the principal", async () => {
			const body = {
				user: "alice",
				admin: true,
				service: false,
				method: "token",
			};
			const { calls, fetchImpl } = stubFetch(body);
			const client = createClient({ fetch: fetchImpl });
			const identity = await client.whoami();
			expect(identity).toEqual(body);
			expect(calls[0]).toEqual({
				input: "/v1/auth/whoami",
				method: "GET",
				accept: "application/json",
			});
		});

		test("patchConversationMeta carries the sharing patch (scope shapes + null clear)", async () => {
			const { calls, fetchImpl } = stubFetch({});
			const client = createClient({ fetch: fetchImpl });
			await client.patchConversationMeta(5, {
				sharing: { scope: "household", level: "write" },
			});
			expect(calls[0]?.body).toBe(
				JSON.stringify({ sharing: { scope: "household", level: "write" } }),
			);
			await client.patchConversationMeta(5, { sharing: null });
			expect(calls[1]?.body).toBe(JSON.stringify({ sharing: null }));
		});
	});

	test("submit POSTs the §7.1 submission body (input parts + requestId + whenBusy) and parses the admission record", async () => {
		const admitted = {
			submission: {
				id: 7,
				conversationId: 2,
				type: "input",
				status: "placed",
				entry: 5,
			},
		};
		const { calls, fetchImpl } = stubFetch(admitted, { status: 202 });
		const client = createClient({ fetch: fetchImpl });
		const result = await client.submit(
				2,
				[{ type: "text", text: "hello there" }],
				{ requestId: "req-1", whenBusy: "steer" },
		);
		expect(result).toEqual(admitted);
		expect(calls).toEqual([
			{
				input: "/v1/conversations/2/submissions",
				method: "POST",
				accept: "application/json",
				contentType: "application/json",
				body: JSON.stringify({
					input: [{ type: "text", text: "hello there" }],
					requestId: "req-1",
					whenBusy: "steer",
				}),
			},
		]);
	});

	test("submit omits requestId/whenBusy when the options are absent", async () => {
		const { calls, fetchImpl } = stubFetch({
			submission: { id: 1, conversationId: 3, type: "input", status: "queued" },
		});
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
				contentType: "application/json",
				body: JSON.stringify({ archived: true }),
			},
		]);
	});

	test("createConversation POSTs /v1/conversations and parses the created summary", async () => {
		const body = { id: 42, root: false, archived: false, pinned: false };
		const { calls, fetchImpl } = stubFetch(body);
		const client = createClient({ fetch: fetchImpl });
		const created = await client.createConversation();
		expect(created).toEqual(body);
		expect(calls).toEqual([
			{
				input: "/v1/conversations",
				method: "POST",
				accept: "application/json",
				contentType: "application/json",
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

	test("upload PUTs the raw bytes with an octet-stream content-type and returns the workspace-relative path", async () => {
		const { calls, fetchImpl } = stubFetch(
			{ path: "uploads/4/note.txt" },
			{ status: 201 },
		);
		const client = createClient({ fetch: fetchImpl });
		const file = {
			name: "note.txt",
			// "hi" = 0x68 0x69 — sent RAW (the raw PUT route), not base64.
			arrayBuffer: () =>
				Promise.resolve(new Uint8Array([104, 105]).buffer),
		};
		const uploaded = await client.upload(4, file);
		expect(uploaded).toEqual({ path: "uploads/4/note.txt" });
		expect(calls).toEqual([
			{
				input: "/v1/conversations/4/uploads/note.txt",
				method: "PUT",
				accept: "application/json",
				contentType: "application/octet-stream",
				body: new Uint8Array([104, 105]),
			},
		]);
	});

	test("upload percent-encodes the file name into the route param", async () => {
		const { calls, fetchImpl } = stubFetch(
			{ path: "uploads/4/my file.png" },
			{ status: 201 },
		);
		const client = createClient({ fetch: fetchImpl });
		const file = {
			name: "my file.png",
			arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
		};
		await client.upload(4, file);
		expect(calls[0]?.input).toBe("/v1/conversations/4/uploads/my%20file.png");
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
				contentType: "application/json",
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
