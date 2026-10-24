/**
 * extTransport (UI-blocks U3 Task 5): the webui's `SurfaceTransport` over
 * the U3 routes. Tests pin the wire shapes (params encoding, the
 * `X-Sigrun-Stream` watcher header, `?since=` on data fetches, the
 * action body's `params`, the octet-stream upload path), the deferred
 * `image()` rejection (until U7), and the hub's (slug, id, k) routing —
 * a `surface.changed` event must fire exactly the matching instance's
 * listeners (the multi-instance rule: a same-slug/id event under a
 * different `k` must NOT fire), and the unsubscribe must silence it.
 */

import { describe, expect, test } from "vitest";
import {
	createExtTransport,
	ExtSurfaceHub,
	type ExtFetchLike,
} from "./extTransport";

/** One recorded fetch call (input + init). */
interface RecordedCall {
	readonly input: string;
	readonly init?: {
		readonly method?: string;
		readonly headers?: Record<string, string>;
		readonly body?: string | Uint8Array;
	};
}

/** A stub fetch that records calls and returns a canned JSON body. */
function stubFetch(body: unknown = { ok: true }): {
	readonly fetch: ExtFetchLike;
	readonly calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	return {
		calls,
		fetch: async (input, init) => {
			calls.push({ input, init });
			return {
				ok: true,
				status: 200,
				json: async () => body,
			};
		},
	};
}

describe("createExtTransport", () => {
	test("load() GETs the surface route (no params → no ?params=)", async () => {
		const stub = stubFetch({ tree: {}, data: {}, rev: 0, treeRev: 0, access: "write" });
		const transport = createExtTransport({
			slug: "fixture-surfaces",
			id: "board",
			fetch: stub.fetch,
		});
		const load = await transport.load();
		expect(load.access).toBe("write");
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.input).toBe("/v1/ext/fixture-surfaces/surfaces/board");
		expect(stub.calls[0]?.init?.method).toBe("GET");
	});

	test("params ride every route as ?params= (load) and the actions body", async () => {
		const stub = stubFetch();
		const transport = createExtTransport({
			slug: "fixture-surfaces",
			id: "board",
			params: { board: "b2" },
			fetch: stub.fetch,
		});
		await transport.load();
		expect(stub.calls[0]?.input).toBe(
			`/v1/ext/fixture-surfaces/surfaces/board?params=${encodeURIComponent('{"board":"b2"}')}`,
		);
		await transport.act({ action: "move", type: "move", payload: { itemId: "c1" }, actionId: "a1" });
		expect(stub.calls[1]?.init?.body).toBe(
			'{"action":"move","type":"move","payload":{"itemId":"c1"},"actionId":"a1","params":{"board":"b2"}}',
		);
	});

	test("fetchData(since) carries ?since= (and joins ?params= correctly)", async () => {
		const stub = stubFetch({ rev: 7, treeRev: 1, ops: [] });
		const transport = createExtTransport({
			slug: "fixture-surfaces",
			id: "board",
			params: { board: "b2" },
			fetch: stub.fetch,
		});
		const fetch_ = await transport.fetchData(6);
		expect(fetch_.rev).toBe(7);
		expect(stub.calls[0]?.input).toContain("/data");
		expect(stub.calls[0]?.input).toContain("since=6");
		expect(stub.calls[0]?.input).toContain("params=");
	});

	test("X-Sigrun-Stream rides every fetch once the stream id is known", async () => {
		const stub = stubFetch();
		const transport = createExtTransport({
			slug: "fixture-surfaces",
			id: "board",
			streamId: "stream-1",
			fetch: stub.fetch,
		});
		await transport.load();
		await transport.fetchData();
		expect(stub.calls[0]?.init?.headers?.["x-sigrun-stream"]).toBe("stream-1");
		expect(stub.calls[1]?.init?.headers?.["x-sigrun-stream"]).toBe("stream-1");
	});

	test("upload() PUTs raw octet-stream to the uploads route", async () => {
		const stub = stubFetch();
		const transport = createExtTransport({
			slug: "fixture-surfaces",
			id: "board",
			fetch: stub.fetch,
		});
		const bytes = new Uint8Array([1, 2, 3]);
		await transport.upload({ field: "attachment", name: "a.txt", bytes, actionId: "u1" });
		expect(stub.calls[0]?.input).toContain("/uploads/attachment/a.txt");
		expect(stub.calls[0]?.init?.method).toBe("PUT");
		expect(stub.calls[0]?.init?.headers?.["content-type"]).toBe(
			"application/octet-stream",
		);
		expect(stub.calls[0]?.init?.body).toBe(bytes);
	});

	test("image() rejects (the route ships with U7 — never a silent blank)", async () => {
		const transport = createExtTransport({
			slug: "fixture-surfaces",
			id: "board",
			fetch: stubFetch().fetch,
		});
		await expect(transport.image("/v1/image/x", { asPng: true })).rejects.toThrow(
			/U7/,
		);
	});
});

describe("ExtSurfaceHub", () => {
	test("attach() wires onChanged into the hub; dispatch fires the matching instance", () => {
		const hub = new ExtSurfaceHub();
		const stub = stubFetch();
		const board = hub.attach(
			{ slug: "fixture-surfaces", id: "board", fetch: stub.fetch },
			"k-board",
		);
		const stats = hub.attach(
			{ slug: "fixture-surfaces", id: "stats", fetch: stub.fetch },
			"k-stats",
		);
		const seenBoard: number[] = [];
		const seenStats: number[] = [];
		board.onChanged((event) => seenBoard.push(event.rev));
		stats.onChanged((event) => seenStats.push(event.rev));
		hub.dispatch({ slug: "fixture-surfaces", id: "board", k: "k-board", rev: 3, treeRev: 1 });
		expect(seenBoard).toEqual([3]);
		expect(seenStats).toEqual([]);
	});

	test("the unsubscribe silences the instance", () => {
		const hub = new ExtSurfaceHub();
		const board = hub.attach(
			{ slug: "fixture-surfaces", id: "board", fetch: stubFetch().fetch },
			"k-board",
		);
		const seen: number[] = [];
		const off = board.onChanged((event) => seen.push(event.rev));
		hub.dispatch({ slug: "fixture-surfaces", id: "board", k: "k-board", rev: 1, treeRev: 1 });
		off();
		hub.dispatch({ slug: "fixture-surfaces", id: "board", k: "k-board", rev: 2, treeRev: 1 });
		expect(seen).toEqual([1]);
	});

	test("the k hash is the routing key — a same-slug/id event under another k does NOT fire", () => {
		const hub = new ExtSurfaceHub();
		const board = hub.attach(
			{ slug: "fixture-surfaces", id: "board", fetch: stubFetch().fetch },
			"k-b1",
		);
		const seen: number[] = [];
		board.onChanged((event) => seen.push(event.rev));
		// A board instance under params {board:"b2"} (different key) must NOT
		// reach the b1 instance's listeners (the multi-instance rule).
		hub.dispatch({ slug: "fixture-surfaces", id: "board", k: "k-b2", rev: 9, treeRev: 1 });
		expect(seen).toEqual([]);
	});
});
