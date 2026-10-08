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
	type FetchLike,
	type MetaResponse,
	type ModelsResponse,
} from "./api";

/** A fetch stub returning one canned JSON body; records its calls. */
function stubFetch(body: unknown, init?: { status?: number }) {
	const calls: { input: string; method?: string; accept?: string }[] = [];
	const fetchImpl: FetchLike = (input, request) => {
		calls.push({
			input,
			method: request?.method,
			accept: request?.headers?.["accept"],
		});
		return Promise.resolve({
			ok: (init?.status ?? 200) >= 200 && (init?.status ?? 200) < 300,
			status: init?.status ?? 200,
			json: () => Promise.resolve(body),
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
});
