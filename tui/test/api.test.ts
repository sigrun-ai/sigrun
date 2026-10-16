/**
 * The TUI §5 client against a stub fetch (Task 4): every method issues the
 * right request (method + path + body), carries the configured
 * `X-Sigrun-User` header on EVERY call (absent/empty user → header omitted,
 * the server's naive mode), and a non-2xx rejects with a typed error
 * carrying the server's error body.
 */

import { describe, expect, test } from "vitest";
import {
	SigrunClient,
	SigrunApiError,
	type FetchLike,
	type WhenBusyMode,
} from "../src/api.js";

/** A fetch stub returning one canned JSON body; records its calls. */
function stubFetch(body: unknown, init?: { status?: number }) {
	const calls: {
		input: string;
		method?: string;
		user?: string;
		accept?: string;
		body?: string;
	}[] = [];
	const fetchImpl: FetchLike = (input, request) => {
		calls.push({
			input,
			method: request?.method,
			user: request?.headers?.["x-sigrun-user"],
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

const BASE = "http://sigrun.example.invalid";

describe("SigrunClient request shaping", () => {
	test("listConversations GETs /v1/conversations with the X-Sigrun-User header", async () => {
		const body = {
			conversations: [{ id: 1, root: true, entryCount: 0, owner: "acme-agent" }],
		};
		const { calls, fetchImpl } = stubFetch(body);
		const client = new SigrunClient({
			baseUrl: BASE,
			user: "acme-agent",
			fetch: fetchImpl,
		});
		const list = await client.listConversations();
		expect(list.conversations).toHaveLength(1);
		expect(calls).toEqual([
			{
				input: `${BASE}/v1/conversations`,
				method: "GET",
				user: "acme-agent",
				accept: "application/json",
				body: undefined,
			},
		]);
	});

	test("an absent user omits the X-Sigrun-User header (naive mode)", async () => {
		const { calls, fetchImpl } = stubFetch({ conversations: [] });
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		await client.listConversations();
		expect(calls[0]?.user).toBeUndefined();
	});

	test("an empty/whitespace user omits the X-Sigrun-User header", async () => {
		const { calls, fetchImpl } = stubFetch({ conversations: [] });
		const client = new SigrunClient({
			baseUrl: BASE,
			user: "   ",
			fetch: fetchImpl,
		});
		await client.listConversations();
		expect(calls[0]?.user).toBeUndefined();
	});

	test("a baseUrl with a trailing slash never doubles the route's slash", async () => {
		const { calls, fetchImpl } = stubFetch({ conversations: [] });
		const client = new SigrunClient({
			baseUrl: `${BASE}/`,
			fetch: fetchImpl,
		});
		await client.listConversations();
		expect(calls[0]?.input).toBe(`${BASE}/v1/conversations`);
	});

	test("getConversation GETs the view route", async () => {
		const view = {
			conversation: { id: 7 },
			entries: [],
			docs: {},
			steer: { busy: false, queued: 0 },
		};
		const { calls, fetchImpl } = stubFetch(view);
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		const got = await client.getConversation(7);
		expect(got).toEqual(view);
		expect(calls[0]?.input).toBe(`${BASE}/v1/conversations/7`);
		expect(calls[0]?.method).toBe("GET");
	});

	test("createConversation POSTs an empty body to /v1/conversations", async () => {
		const created = {
			id: 3,
			view: {
				conversation: { id: 3 },
				entries: [],
				docs: {},
				steer: { busy: false, queued: 0 },
			},
		};
		const { calls, fetchImpl } = stubFetch(created);
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		const result = await client.createConversation();
		expect(result).toEqual(created);
		expect(calls[0]).toMatchObject({
			input: `${BASE}/v1/conversations`,
			method: "POST",
			body: "{}",
		});
	});

	test("forkConversation POSTs to .../fork with an optional at", async () => {
		const created = { id: 9, view: { conversation: { id: 9 } } };
		const { calls, fetchImpl } = stubFetch(created);
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		await client.forkConversation(3, 42);
		expect(calls[0]).toMatchObject({
			input: `${BASE}/v1/conversations/3/fork`,
			method: "POST",
			body: JSON.stringify({ at: 42 }),
		});
		await client.forkConversation(3);
		expect(calls[1]?.body).toBe("{}");
	});

	test("submit POSTs the text input parts and whenBusy", async () => {
		const settled = {
			id: 11,
			conversationId: 2,
			type: "input",
			status: "done",
		};
		const { calls, fetchImpl } = stubFetch(settled, { status: 202 });
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		const whenBusy: WhenBusyMode = "steer";
		const result = await client.submit(2, "hello there", whenBusy);
		expect(result).toEqual(settled);
		expect(calls[0]).toMatchObject({
			input: `${BASE}/v1/conversations/2/submissions`,
			method: "POST",
			body: JSON.stringify({
				input: [{ type: "text", text: "hello there" }],
				whenBusy: "steer",
			}),
		});
	});

	test("submit without whenBusy omits the field", async () => {
		const { calls, fetchImpl } = stubFetch({ id: 1 });
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		await client.submit(2, "plain");
		expect(calls[0]?.body).toBe(
			JSON.stringify({ input: [{ type: "text", text: "plain" }] }),
		);
	});

	test("abort POSTs to .../abort", async () => {
		const aborted = { result: "aborted", submissionId: 5 };
		const { calls, fetchImpl } = stubFetch(aborted);
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		const result = await client.abort(2);
		expect(result).toEqual(aborted);
		expect(calls[0]).toMatchObject({
			input: `${BASE}/v1/conversations/2/abort`,
			method: "POST",
		});
	});

	test("compact POSTs to .../compact", async () => {
		const { calls, fetchImpl } = stubFetch({ taskId: 99 });
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		const result = await client.compact(2);
		expect(result).toEqual({ taskId: 99 });
		expect(calls[0]).toMatchObject({
			input: `${BASE}/v1/conversations/2/compact`,
			method: "POST",
		});
	});

	test("getMeta GETs and patchMeta PATCHes .../meta", async () => {
		const meta = {
			pinned: false,
			tagged: [],
			archived: false,
			draft: { text: "", attachments: [] },
			source: "user",
		};
		const { calls, fetchImpl } = stubFetch(meta);
		const client = new SigrunClient({
			baseUrl: BASE,
			user: "acme-agent",
			fetch: fetchImpl,
		});
		const got = await client.getMeta(4);
		expect(got).toEqual(meta);
		const patched = await client.patchMeta(4, { archived: true });
		expect(patched).toEqual(meta);
		expect(calls[0]).toMatchObject({
			input: `${BASE}/v1/conversations/4/meta`,
			method: "GET",
			user: "acme-agent",
		});
		expect(calls[1]).toMatchObject({
			input: `${BASE}/v1/conversations/4/meta`,
			method: "PATCH",
			body: JSON.stringify({ archived: true }),
			user: "acme-agent",
		});
	});

	test("listInteractions GETs .../interactions", async () => {
		const { calls, fetchImpl } = stubFetch({ interactions: [] });
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		const list = await client.listInteractions(4);
		expect(list.interactions).toEqual([]);
		expect(calls[0]?.input).toBe(`${BASE}/v1/conversations/4/interactions`);
	});

	test("answerInteraction POSTs the answer to the ONE generic route", async () => {
		const answered = {
			callId: "call-1",
			status: "answered",
			answer: { ids: ["yes"] },
		};
		const { calls, fetchImpl } = stubFetch(answered);
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		const result = await client.answerInteraction(4, "call-1", {
			ids: ["yes"],
		});
		expect(result).toEqual(answered);
		expect(calls[0]).toMatchObject({
			input: `${BASE}/v1/conversations/4/interactions/call-1/answer`,
			method: "POST",
			body: JSON.stringify({ ids: ["yes"] }),
		});
	});

	test("getAmbient GETs .../ambient", async () => {
		const { calls, fetchImpl } = stubFetch({ ambient: [] });
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		const list = await client.getAmbient(4);
		expect(list.ambient).toEqual([]);
		expect(calls[0]?.input).toBe(`${BASE}/v1/conversations/4/ambient`);
	});

	test("getCommands GETs /v1/commands", async () => {
		const { calls, fetchImpl } = stubFetch({ commands: [] });
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		const result = await client.getCommands();
		expect(result.commands).toEqual([]);
		expect(calls[0]?.input).toBe(`${BASE}/v1/commands`);
	});

	test("getSettings GETs /v1/settings", async () => {
		const { calls, fetchImpl } = stubFetch({ toolRoster: [] });
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		const result = await client.getSettings();
		expect(result).toEqual({ toolRoster: [] });
		expect(calls[0]?.input).toBe(`${BASE}/v1/settings`);
	});
});

describe("SigrunClient error handling", () => {
	test("a non-2xx rejects with a SigrunApiError carrying status, path, and the server's error body", async () => {
		const errorBody = { error: "conversation_not_found" };
		const { fetchImpl } = stubFetch(errorBody, { status: 404 });
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		const caught = await client.getConversation(404).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(caught).toBeInstanceOf(SigrunApiError);
		const apiError = caught as SigrunApiError;
		expect(apiError.status).toBe(404);
		expect(apiError.body).toEqual(errorBody);
		expect(apiError.message).toContain("404");
		expect(apiError.message).toContain("/v1/conversations/404");
	});

	test("a non-2xx rejects on every write method too (fail-loud, never silent)", async () => {
		const { fetchImpl } = stubFetch(
			{ error: "unserved_model", model: "acme/missing-1" },
			{ status: 400 },
		);
		const client = new SigrunClient({ baseUrl: BASE, fetch: fetchImpl });
		const caught = await client.submit(1, "hi").then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(caught).toBeInstanceOf(SigrunApiError);
		expect((caught as SigrunApiError).status).toBe(400);
		expect((caught as SigrunApiError).body).toMatchObject({
			error: "unserved_model",
		});
	});
});
