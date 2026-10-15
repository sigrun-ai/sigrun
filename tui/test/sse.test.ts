/**
 * The TUI SSE watcher (Task 4) against a real `node:http` server writing
 * `text/event-stream` frames: `watchConversation` delivers the connect
 * snapshot then `view` frames; killing the connection triggers a reconnect
 * whose fresh snapshot REPLACES state wholesale (Review Focus 1 — a
 * snapshot subsumes any missed frame; no stale merge).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { watchConversation, type WatchHandlers } from "../src/sse.js";

/** One scripted connection of the fake SSE server. */
interface ConnectionScript {
	/** Frames to write on connect (raw SSE text). */
	readonly frames: string[];
	/** Close the connection after writing the frames. */
	readonly closeAfter?: boolean;
}

/** A fake SSE endpoint: serves one scripted connection per request. */
function fakeSseServer(scripts: ConnectionScript[]) {
	const requests: string[] = [];
	const server = http.createServer((request, response) => {
		requests.push(request.url ?? "");
		const script = scripts[Math.min(requests.length - 1, scripts.length - 1)];
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		for (const frame of script.frames) {
			response.write(frame);
		}
		if (script.closeAfter === true) {
			response.end();
		}
		// Open scripts stay open until the client closes them; end the
		// response on client abort so the server can close cleanly.
		request.on("close", () => {
			response.end();
		});
	});
	return {
		requests,
		start(): Promise<string> {
			return new Promise((resolve) => {
				server.listen(0, "127.0.0.1", () => {
					const address = server.address() as AddressInfo;
					resolve(`http://127.0.0.1:${address.port}`);
				});
			});
		},
		close(): Promise<void> {
			return new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}

/** Collect events until `predicate` is satisfied or the deadline passes. */
function collect() {
	const events: { kind: string; view: unknown }[] = [];
	const errors: string[] = [];
	let waiter: (() => void) | undefined;
	const handlers: WatchHandlers = {
		onSnapshot: (view) => {
			events.push({ kind: "snapshot", view });
			waiter?.();
		},
		onView: (view) => {
			events.push({ kind: "view", view });
			waiter?.();
		},
		onError: (message) => {
			errors.push(message);
			waiter?.();
		},
	};
	function waitFor(predicate: () => boolean, ms = 2_000): Promise<void> {
		return new Promise((resolve, reject) => {
			const started = Date.now();
			const check = () => {
				if (predicate()) {
					resolve();
					return;
				}
				if (Date.now() - started > ms) {
					reject(
						new Error(
							`timed out waiting; events=${JSON.stringify(events)} errors=${JSON.stringify(errors)}`,
						),
					);
					return;
				}
				waiter = check;
				setTimeout(check, 5);
			};
			check();
		});
	}
	return { events, errors, handlers, waitFor };
}

function snapshotFrame(view: unknown): string {
	return `event: snapshot\ndata: ${JSON.stringify(view)}\n\n`;
}

function viewFrame(view: unknown, id?: string): string {
	const idLine = id === undefined ? "" : `id: ${id}\n`;
	return `${idLine}event: view\ndata: ${JSON.stringify(view)}\n\n`;
}

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
	await Promise.all(servers.map((server) => server.close()));
	servers.length = 0;
});

describe("watchConversation", () => {
	test("delivers the connect snapshot then view frames", async () => {
		const server = fakeSseServer([
			{
				frames: [
					snapshotFrame({ conversation: { id: 1 }, entries: [] }),
					viewFrame({ conversation: { id: 1 }, entries: [{ id: 1 }] }, "2"),
				],
			},
		]);
		servers.push(server);
		const base = await server.start();
		const collector = collect();
		const unwatch = watchConversation(1, collector.handlers, {
			baseUrl: base,
			reconnectBaseMs: 10,
		});
		await collector.waitFor(() => collector.events.length === 2);
		unwatch();
		expect(collector.events.map((event) => event.kind)).toEqual([
			"snapshot",
			"view",
		]);
		expect(collector.errors).toEqual([]);
		expect(server.requests).toEqual(["/v1/conversations/1/stream"]);
	});

	test("a reconnect's fresh snapshot replaces state wholesale (no stale merge)", async () => {
		// Connection 1: snapshot rev-1 plus one view frame, then the server
		// kills the connection. Revisions 3..7 happen while disconnected.
		// Connection 2: a fresh snapshot at rev-8 — it SUBSUMES the gap; the
		// client must not try to merge or replay.
		const server = fakeSseServer([
			{
				frames: [
					snapshotFrame({ revision: 1, entries: [{ id: 1 }] }),
					viewFrame({ revision: 2, entries: [{ id: 1 }, { id: 2 }] }),
				],
				closeAfter: true,
			},
			{
				frames: [snapshotFrame({ revision: 8, entries: [{ id: 1 }] })],
			},
		]);
		servers.push(server);
		const base = await server.start();
		const collector = collect();
		const unwatch = watchConversation(1, collector.handlers, {
			baseUrl: base,
			reconnectBaseMs: 10,
		});
		// snapshot(1), view(2), then after the drop + reconnect snapshot(8).
		await collector.waitFor(() => collector.events.length === 3);
		unwatch();
		expect(collector.events.map((event) => event.kind)).toEqual([
			"snapshot",
			"view",
			"snapshot",
		]);
		const last = collector.events.at(-1)?.view as { revision: number };
		expect(last.revision).toBe(8);
		expect(server.requests).toHaveLength(2);
	});

	test("sends the X-Sigrun-User header when configured", async () => {
		const seen: (string | undefined)[] = [];
		const server = http.createServer((request, response) => {
			seen.push(request.headers["x-sigrun-user"] as string | undefined);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(snapshotFrame({ conversation: { id: 1 } }));
		});
		servers.push({
			close: () =>
				new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				),
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address() as AddressInfo;
		const collector = collect();
		const unwatch = watchConversation(1, collector.handlers, {
			baseUrl: `http://127.0.0.1:${address.port}`,
			user: "acme-agent",
			reconnectBaseMs: 10,
		});
		await collector.waitFor(() => seen.length > 0);
		unwatch();
		expect(seen[0]).toBe("acme-agent");
	});

	test("comment lines and multi-line data frames are tolerated", async () => {
		const server = fakeSseServer([
			{
				frames: [
					": ping\n\n",
					"event: snapshot\ndata: {\"conversation\":\ndata: {\"id\": 1}}\n\n",
				],
			},
		]);
		servers.push(server);
		const base = await server.start();
		const collector = collect();
		const unwatch = watchConversation(1, collector.handlers, {
			baseUrl: base,
			reconnectBaseMs: 10,
		});
		await collector.waitFor(() => collector.events.length === 1);
		unwatch();
		expect(collector.events[0]?.kind).toBe("snapshot");
		expect(collector.errors).toEqual([]);
	});

	test("a malformed frame reports onError and the stream stays open", async () => {
		const server = fakeSseServer([
			{
				frames: [
					snapshotFrame({ conversation: { id: 1 } }),
					"event: view\ndata: {not json\n\n",
					viewFrame({ conversation: { id: 1 }, entries: [{ id: 2 }] }),
				],
			},
		]);
		servers.push(server);
		const base = await server.start();
		const collector = collect();
		const unwatch = watchConversation(1, collector.handlers, {
			baseUrl: base,
			reconnectBaseMs: 10,
		});
		await collector.waitFor(() => collector.events.length === 2);
		unwatch();
		expect(collector.events.map((event) => event.kind)).toEqual([
			"snapshot",
			"view",
		]);
		expect(collector.errors).toHaveLength(1);
	});

	test("unwatch stops the stream and cancels any pending reconnect", async () => {
		const server = fakeSseServer([{ frames: [], closeAfter: true }]);
		servers.push(server);
		const base = await server.start();
		const collector = collect();
		const unwatch = watchConversation(1, collector.handlers, {
			baseUrl: base,
			reconnectBaseMs: 50,
		});
		// Wait for the FIRST connection to land and drop (onError fires on
		// the server close), so the reconnect timer is the pending one.
		await collector.waitFor(() => server.requests.length === 1);
		await collector.waitFor(() => collector.errors.length > 0);
		unwatch();
		// Give the reconnect ladder time to fire if it were going to.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(server.requests).toHaveLength(1);
	});
});
