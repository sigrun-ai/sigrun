/**
 * The TUI SSE watcher (Task 4; delta frames in core hardening W3 Task 3)
 * against a real `node:http` server writing `text/event-stream` frames:
 * `watchConversation` delivers the connect snapshot, folds each `delta`
 * frame via the shared `applyDelta`, and surfaces full folded revisions on
 * `onView`; killing the connection triggers a reconnect whose fresh
 * snapshot REPLACES state wholesale (Review Focus 1 — a snapshot subsumes
 * any missed frame; no stale merge).
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
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

function deltaFrame(delta: unknown, id?: string): string {
	const idLine = id === undefined ? "" : `id: ${id}\n`;
	return `${idLine}event: delta\ndata: ${JSON.stringify(delta)}\n\n`;
}

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
	await Promise.all(servers.map((server) => server.close()));
	servers.length = 0;
});

describe("watchConversation", () => {
	test("delivers the connect snapshot then folds delta frames into full revisions", async () => {
		const server = fakeSseServer([
			{
				frames: [
					snapshotFrame({ conversation: { id: 1 }, entries: [], docs: {}, steer: { busy: false, queued: 0 } }),
					deltaFrame({ entries: { append: [{ id: 1, kind: "pi.user" }] }, steer: { busy: true, queued: 0 } }, "2"),
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
		// The delta folded: the surfaced revision carries the appended entry
		// AND the folded steer field.
		const folded = collector.events[1]?.view as {
			entries: { id: number }[];
			steer: { busy: boolean };
		};
		expect(folded.entries.map((entry) => entry.id)).toEqual([1]);
		expect(folded.steer.busy).toBe(true);
		expect(collector.errors).toEqual([]);
		expect(server.requests).toEqual(["/v1/conversations/1/stream"]);
	});

	test("a reconnect's fresh snapshot replaces state wholesale (no stale merge)", async () => {
		// Connection 1: snapshot rev-1 plus one delta frame, then the server
		// kills the connection. Revisions 3..7 happen while disconnected.
		// Connection 2: a fresh snapshot at rev-8 — it SUBSUMES the gap; the
		// fold re-bases on it (the connection-1 delta is gone).
		const server = fakeSseServer([
			{
				frames: [
					snapshotFrame({ revision: 1, entries: [{ id: 1 }], docs: {}, steer: { busy: false, queued: 0 } }),
					deltaFrame({ entries: { append: [{ id: 2, kind: "pi.user" }] } }),
				],
				closeAfter: true,
			},
			{
				frames: [snapshotFrame({ revision: 8, entries: [{ id: 1 }], docs: {}, steer: { busy: false, queued: 0 } })],
			},
		]);
		servers.push(server);
		const base = await server.start();
		const collector = collect();
		const unwatch = watchConversation(1, collector.handlers, {
			baseUrl: base,
			reconnectBaseMs: 10,
		});
		// snapshot(1), folded delta (rev 2: entries 1+2), then after the
		// drop + reconnect snapshot(8) — the replacement carries entry 1 ONLY.
		await collector.waitFor(() => collector.events.length === 3);
		unwatch();
		expect(collector.events.map((event) => event.kind)).toEqual([
			"snapshot",
			"view",
			"snapshot",
		]);
		const foldedMid = collector.events[1]?.view as { entries: { id: number }[] };
		expect(foldedMid.entries.map((entry) => entry.id)).toEqual([1, 2]);
		const last = collector.events.at(-1)?.view as {
			revision: number;
			entries: { id: number }[];
		};
		expect(last.revision).toBe(8);
		expect(last.entries.map((entry) => entry.id)).toEqual([1]);
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
					snapshotFrame({ conversation: { id: 1 }, entries: [], docs: {}, steer: { busy: false, queued: 0 } }),
					"event: delta\ndata: {not json\n\n",
					deltaFrame({ entries: { append: [{ id: 2, kind: "pi.user" }] } }),
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
		// The folded revision carries the appended entry.
		const folded = collector.events[1]?.view as { entries: { id: number }[] };
		expect(folded.entries.map((entry) => entry.id)).toEqual([2]);
		expect(collector.errors).toHaveLength(1);
	});

	test("a delta before any snapshot is malformed; the stream survives", async () => {
		const server = fakeSseServer([
			{
				frames: [
					deltaFrame({ steer: { busy: true, queued: 0 } }),
					snapshotFrame({ conversation: { id: 1 }, entries: [], docs: {}, steer: { busy: false, queued: 0 } }),
					deltaFrame({ steer: { busy: true, queued: 0 } }),
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
		// One error for the orphan delta; the post-snapshot delta folded.
		expect(collector.errors).toHaveLength(1);
		expect(collector.errors[0]).toMatch(/before any snapshot/i);
		const folded = collector.events.at(-1)?.view as { steer: { busy: boolean } };
		expect(folded.steer.busy).toBe(true);
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

	test("a mid-stream kill emits exactly ONE onError per connection failure (fix wave A10)", async () => {
		const server = fakeSseServer([
			{ frames: [snapshotFrame({ revision: 1, entries: [] })], closeAfter: true },
			{ frames: [snapshotFrame({ revision: 2, entries: [] })], closeAfter: true },
			{ frames: [], closeAfter: false },
		]);
		servers.push(server);
		const base = await server.start();
		const collector = collect();
		const unwatch = watchConversation(1, collector.handlers, {
			baseUrl: base,
			reconnectBaseMs: 10,
		});
		// Connection 1: snapshot + server close → one error, reconnect.
		await collector.waitFor(() => collector.errors.length === 1);
		await collector.waitFor(() => server.requests.length === 2);
		expect(collector.errors).toHaveLength(1);
		// Connection 2: the same — a NEW failure gets its own one error.
		await collector.waitFor(() => collector.errors.length === 2);
		await collector.waitFor(() => server.requests.length === 3);
		expect(collector.errors).toHaveLength(2);
		unwatch();
	});

	test("reconnect delays carry ±30% jitter around the backoff ladder (fix wave A3)", async () => {
		vi.useFakeTimers();
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5); // zero jitter
		try {
			const calls: number[] = [];
			const baseFetch = vi.fn(async (): Promise<Response> => {
				calls.push(Date.now());
				throw new Error("connection refused");
			});
			const unwatch = watchConversation(1, {}, {
				baseUrl: "http://127.0.0.1:1",
				reconnectBaseMs: 1_000,
				reconnectMaxMs: 30_000,
				fetch: baseFetch as unknown as typeof globalThis.fetch,
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(calls).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(calls).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(calls).toHaveLength(3);
			await vi.advanceTimersByTimeAsync(4_000);
			expect(calls).toHaveLength(4);
			// Zero jitter (random = 0.5): exact ladder 1s, 2s, 4s.
			expect(calls[1]! - calls[0]!).toBe(1_000);
			expect(calls[2]! - calls[1]!).toBe(2_000);
			expect(calls[3]! - calls[2]!).toBe(4_000);
			unwatch();
		} finally {
			randomSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	test.each([
		{ random: 0, expectedMs: 700 }, // the ×0.7 endpoint
		{ random: 0.999_999, expectedMs: 1_300 }, // the ×1.3 endpoint (≈)
	])("the jitter endpoint $random delays ~$expectedMs on the first reconnect", async ({ random, expectedMs }) => {
		vi.useFakeTimers();
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(random);
		try {
			let calls = 0;
			const failing = vi.fn(async (): Promise<Response> => {
				calls += 1;
				throw new Error("connection refused");
			});
			const unwatch = watchConversation(1, {}, {
				baseUrl: "http://127.0.0.1:1",
				reconnectBaseMs: 1_000,
				fetch: failing as unknown as typeof globalThis.fetch,
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(calls).toBe(1);
			// Just before the jittered delay: no reconnect yet.
			await vi.advanceTimersByTimeAsync(expectedMs - 2);
			expect(calls).toBe(1);
			// At the delay: the reconnect fires.
			await vi.advanceTimersByTimeAsync(2);
			expect(calls).toBe(2);
			unwatch();
		} finally {
			randomSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	test("10 consecutive failures give up with ONE final onError; a success resets the cap (fix wave A3)", async () => {
		vi.useFakeTimers();
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5); // zero jitter
		try {
			const errors: string[] = [];
			let calls = 0;
			const baseFetch = vi.fn(async (): Promise<Response> => {
				calls += 1;
				throw new Error("connection refused");
			});
			const unwatch = watchConversation(
				1,
				{ onError: (message) => errors.push(message) },
				{
					baseUrl: "http://127.0.0.1:1",
					reconnectBaseMs: 10,
					fetch: baseFetch as unknown as typeof globalThis.fetch,
				},
			);
			// Drive the whole ladder: 1 initial + 9 retries = 10 attempts;
			// the 10th failure's give-up check consumes the 11th connect.
			await vi.advanceTimersByTimeAsync(1_000_000);
			expect(calls).toBe(10);
			// 10 failure notices + the ONE give-up notice — and no more.
			expect(errors).toHaveLength(11);
			expect(errors.at(-1)).toBe("giving up after 10 failed reconnects");
			// The ladder is dead: further time makes no further attempts.
			await vi.advanceTimersByTimeAsync(1_000_000);
			expect(calls).toBe(10);
			expect(errors).toHaveLength(11);
			unwatch();

			// A success between failures resets the consecutive cap: 9
			// failures, then one stream that OPENS (the cap resets) and hangs
			// the read — no close, no error, no further attempt. The first
			// cap window (10) is consumed by the first 9 failures + this
			// open, proving the reset cleared them.
			let attempts2 = 0;
			const recoverable = vi.fn(async (): Promise<Response> => {
				attempts2 += 1;
				if (attempts2 === 10) {
					// An OK SSE response whose stream delivers one snapshot and
					// then NEVER closes (the abort signal ends the read). A
					// completed body would be another server-close failure; a
					// hanging one is the honest "open stream" shape.
					const frame =
						'event: snapshot\ndata: {"conversation":{"id":1},"entries":[]}\n\n';
					let aborted = false;
					const stream = new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(frame));
						},
						pull() {
							// Never enqueues: the read hangs until cancel (the
							// watcher's abort), so no close event fires.
							return aborted ? undefined : new Promise(() => {});
						},
						cancel() {
							aborted = true;
						},
					});
					return new Response(stream, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				}
				throw new Error("connection refused");
			});
			const errors2: string[] = [];
			const unwatch2 = watchConversation(
				1,
				{ onError: (message) => errors2.push(message) },
				{
					baseUrl: "http://127.0.0.1:1",
					reconnectBaseMs: 10,
					fetch: recoverable as unknown as typeof globalThis.fetch,
				},
			);
			await vi.advanceTimersByTimeAsync(500_000);
			unwatch2();
			// 9 failures + the open: the 10th connect is the SUCCESS (the
			// give-up check at its top would have fired had the 9 counted).
			expect(attempts2).toBe(10);
			expect(
				errors2.some((message) => message.startsWith("giving up")),
			).toBe(false);
		} finally {
			randomSpy.mockRestore();
			vi.useRealTimers();
		}
	});
});

describe("authorization header (Task 7: the token seam)", () => {
	/** A header-recording SSE server: one snapshot, then held open. */
	async function headerRecordingServer(): Promise<{
		seen: Record<string, string | string[] | undefined>[];
		baseUrl: string;
		close(): Promise<void>;
	}> {
		const seen: Record<string, string | string[] | undefined>[] = [];
		const server = http.createServer((request, response) => {
			seen.push(request.headers);
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			});
			response.write(
				`event: snapshot\ndata: ${JSON.stringify({ conversation: { id: 1 }, entries: [], docs: {}, steer: { busy: false, queued: 0 } })}\n`,
			);
			request.on("close", () => response.end());
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address() as AddressInfo;
		return {
			seen,
			baseUrl: `http://127.0.0.1:${address.port}`,
			close: () =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		};
	}

	test("a token adds authorization: Bearer on the stream connect", async () => {
		const { seen, baseUrl, close } = await headerRecordingServer();
		const unwatch = watchConversation(
			1,
			{},
			{
				baseUrl,
				token: "sgr_stream_token",
				reconnectBaseMs: 1,
				reconnectMaxMs: 1,
			},
		);
		await vi.waitFor(() => {
			expect(seen.length).toBeGreaterThanOrEqual(1);
		});
		expect(seen[0]?.authorization).toBe("Bearer sgr_stream_token");
		unwatch();
		await close();
	});

	test("no token: the stream connect carries no authorization header", async () => {
		const { seen, baseUrl, close } = await headerRecordingServer();
		const unwatch = watchConversation(1, {}, { baseUrl, reconnectBaseMs: 1, reconnectMaxMs: 1 });
		await vi.waitFor(() => {
			expect(seen.length).toBeGreaterThanOrEqual(1);
		});
		expect(seen[0]?.authorization).toBeUndefined();
		unwatch();
		await close();
	});
});
