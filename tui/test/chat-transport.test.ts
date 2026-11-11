/**
 * The TUI's chat-block transport: every fetch carries the shared request
 * headers (client label, user, bearer) — the GET routes and the action
 * POST alike.
 */

import { describe, expect, test } from "vitest";
import { createChatTransport } from "../src/blocks/chat-transport.js";

interface RecordedCall {
	readonly input: string;
	readonly init?: {
		readonly method?: string;
		readonly headers?: Record<string, string>;
		readonly body?: unknown;
	};
}

function stubFetch(body: unknown): {
	readonly fetch: typeof globalThis.fetch;
	readonly calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	return {
		calls,
		fetch: (async (input: string, init?: RecordedCall["init"]) => {
			calls.push({ input, init });
			return { ok: true, status: 200, json: async () => body } as Response;
		}) as typeof globalThis.fetch,
	};
}

describe("createChatTransport headers", () => {
	test("load GET and the action POST carry the client label, user, and bearer", async () => {
		const stub = stubFetch({ ok: true });
		const transport = createChatTransport({
			conversationId: 7,
			entryId: "e1",
			baseUrl: "http://127.0.0.1:8080/",
			user: "alice",
			token: "tok-1",
			fetch: stub.fetch,
		});
		await transport.load();
		await transport.act({
			action: "go",
			type: "submit",
			payload: null,
			actionId: "a1",
		});
		expect(stub.calls.map((call) => call.input)).toEqual([
			"http://127.0.0.1:8080/v1/conversations/7/blocks/e1",
			"http://127.0.0.1:8080/v1/conversations/7/blocks/e1/actions",
		]);
		for (const call of stub.calls) {
			expect(call.init?.headers?.["x-sigrun-client"]).toBe("tui");
			expect(call.init?.headers?.["x-sigrun-user"]).toBe("alice");
			expect(call.init?.headers?.authorization).toBe("Bearer tok-1");
		}
		expect(stub.calls[1]?.init?.headers?.["content-type"]).toBe(
			"application/json",
		);
	});
});
