/**
 * The TUI's extension-surface transport (UI-blocks U3 Task 5): the
 * `SurfaceTransport` over the U3 routes as a REMOTE client (baseUrl +
 * identity headers). Tests pin the same wire shapes as the webui twin
 * plus the TUI-only headers (x-sigrun-user, bearer token) and the
 * hub's (slug, id, k) change-event routing.
 */

import { describe, expect, test } from "vitest";
import {
	createExtSurfaceTransport,
	ExtSurfaceHub,
	surfaceKeyHash,
	type ExtSurfaceTransportOptions,
} from "../src/blocks/ext-transport.js";
import { eventKey, instanceKey } from "../../src/server/surfaces/instance.js";

/** One recorded fetch call (input + init). */
interface RecordedCall {
	readonly input: string;
	readonly init?: {
		readonly method?: string;
		readonly headers?: Record<string, string>;
		readonly body?: unknown;
	};
}

function stubFetch(body: unknown = { ok: true }): {
	readonly fetch: typeof globalThis.fetch;
	readonly calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	return {
		calls,
		fetch: (async (input: string, init?: RecordedCall["init"]) => {
			calls.push({ input, init });
			return {
				ok: true,
				status: 200,
				json: async () => body,
			} as Response;
		}) as typeof globalThis.fetch,
	};
}

const BASE: Omit<ExtSurfaceTransportOptions, "fetch"> = {
	slug: "fixture-surfaces",
	id: "board",
	baseUrl: "http://127.0.0.1:8080/",
	user: "alice",
	token: "tok-1",
	streamId: "stream-9",
};

describe("surfaceKeyHash (wire compat)", () => {
	test("the client's k matches the server's eventKey byte-for-byte", () => {
		const key = instanceKey({ board: "b2" });
		expect(surfaceKeyHash("fixture-surfaces", "board", key)).toBe(
			eventKey("fixture-surfaces", "board", key),
		);
	});
});

describe("createExtSurfaceTransport", () => {
	test("load() GETs the surface route on the baseUrl (trailing slash normalized)", async () => {
		const stub = stubFetch({ tree: {}, data: {}, rev: 0, treeRev: 0, access: "write" });
		const transport = createExtSurfaceTransport({ ...BASE, fetch: stub.fetch }).transport;
		await transport.load();
		expect(stub.calls[0]?.input).toBe(
			"http://127.0.0.1:8080/v1/ext/fixture-surfaces/surfaces/board",
		);
		// The TUI's identity + watcher headers ride every fetch.
		expect(stub.calls[0]?.init?.headers?.["x-sigrun-user"]).toBe("alice");
		expect(stub.calls[0]?.init?.headers?.authorization).toBe("Bearer tok-1");
		expect(stub.calls[0]?.init?.headers?.["x-sigrun-stream"]).toBe("stream-9");
	});

	test("params ride load (?params=) and the actions body", async () => {
		const stub = stubFetch();
		const transport = createExtSurfaceTransport({
			...BASE,
			params: { board: "b2" },
			fetch: stub.fetch,
		}).transport;
		await transport.load();
		expect(stub.calls[0]?.input).toContain(
			`params=${encodeURIComponent('{"board":"b2"}')}`,
		);
		await transport.act({ action: "move", payload: {}, actionId: "a1" });
		expect(stub.calls[1]?.init?.body).toBe(
			'{"action":"move","payload":{},"actionId":"a1","params":{"board":"b2"}}',
		);
	});

	test("fetchData(since) carries ?since= joined onto ?params=", async () => {
		const stub = stubFetch({ rev: 3, treeRev: 1 });
		const transport = createExtSurfaceTransport({
			...BASE,
			params: { board: "b2" },
			fetch: stub.fetch,
		}).transport;
		await transport.fetchData(2);
		expect(stub.calls[0]?.input).toContain("/data");
		expect(stub.calls[0]?.input).toContain("params=");
		expect(stub.calls[0]?.input).toContain("since=2");
	});

	test("image() rejects (the route ships with U7)", async () => {
		const transport = createExtSurfaceTransport({ ...BASE, fetch: stubFetch().fetch }).transport;
		await expect(
			transport.image("/v1/image/x", { asPng: true }),
		).rejects.toThrow(/U7/);
	});

	test("setStreamId: a reconnect's new id rides the NEXT fetch (stream-id staleness fix)", async () => {
		const stub = stubFetch({ rev: 1, treeRev: 1 });
		const handle = createExtSurfaceTransport({ ...BASE, fetch: stub.fetch });
		await handle.transport.fetchData();
		expect(stub.calls[0]?.init?.headers?.["x-sigrun-stream"]).toBe("stream-9");
		// The reconnect: the app hands the open view the new id; the next
		// fetch carries it (re-registering the watcher entry).
		handle.setStreamId("stream-10");
		await handle.transport.fetchData();
		expect(stub.calls[1]?.init?.headers?.["x-sigrun-stream"]).toBe("stream-10");
		// The hub attach passes the setter through.
		const hub = new ExtSurfaceHub();
		const attached = hub.attach({ ...BASE, fetch: stub.fetch }, "k");
		attached.setStreamId("stream-11");
		await attached.transport.fetchData();
		expect(stub.calls[2]?.init?.headers?.["x-sigrun-stream"]).toBe("stream-11");
	});
});

describe("ExtSurfaceHub (tui)", () => {
	test("dispatch fires only the matching (slug, id, k) subscription", () => {
		const hub = new ExtSurfaceHub();
		const stub = stubFetch();
		const board = hub.attach({ ...BASE, fetch: stub.fetch }, "k-board").transport;
		const stats = hub.attach(
			{ ...BASE, id: "stats", fetch: stub.fetch },
			"k-stats",
		).transport;
		const seenBoard: number[] = [];
		const seenStats: number[] = [];
		board.onChanged((event) => seenBoard.push(event.rev));
		stats.onChanged((event) => seenStats.push(event.rev));
		hub.dispatch({ slug: "fixture-surfaces", id: "board", k: "k-board", rev: 4, treeRev: 1 });
		expect(seenBoard).toEqual([4]);
		expect(seenStats).toEqual([]);
	});

	test("a same-slug/id event under a different k does NOT fire (multi-instance)", () => {
		const hub = new ExtSurfaceHub();
		const board = hub.attach({ ...BASE, fetch: stubFetch().fetch }, "k-b1").transport;
		const seen: number[] = [];
		const off = board.onChanged((event) => seen.push(event.rev));
		hub.dispatch({ slug: "fixture-surfaces", id: "board", k: "k-b2", rev: 9, treeRev: 1 });
		expect(seen).toEqual([]);
		off();
		hub.dispatch({ slug: "fixture-surfaces", id: "board", k: "k-b1", rev: 10, treeRev: 1 });
		expect(seen).toEqual([]);
	});
});
