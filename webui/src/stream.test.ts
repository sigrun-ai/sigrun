/**
 * The §5 conversation stream wrapper against a stubbed EventSource (Task 21).
 * No real server: the injectable `EventSourceFactory` seam is the point — the
 * spike (spikes/webui-transport) already proved the real-server path. Covers:
 * URL shaping, snapshot/view parsing, malformed-frame survival, and the
 * reconnect-with-backoff loop (reconnect = re-attach, fresh snapshot).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConversationViewWire } from "./api";
import {
	openConversationStream,
	type EventSourceLike,
	type StreamMessageEvent,
} from "./stream";

/** A scripted EventSource: tests emit events, the wrapper under test reacts. */
class StubEventSource implements EventSourceLike {
	closed = false;
	private readonly listeners = new Map<
		string,
		((event: StreamMessageEvent) => void)[]
	>();

	addEventListener(
		type: string,
		listener: (event: StreamMessageEvent) => void,
	): void {
		const list = this.listeners.get(type) ?? [];
		list.push(listener);
		this.listeners.set(type, list);
	}

	close(): void {
		this.closed = true;
	}

	emit(type: string, data = ""): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener({ data });
		}
	}
}

function stubFactory() {
	const sources: StubEventSource[] = [];
	const factoryCalls: string[] = [];
	const factory = (url: string) => {
		factoryCalls.push(url);
		const source = new StubEventSource();
		sources.push(source);
		return source;
	};
	return { sources, factory, urls: () => factoryCalls };
}

function view(id: number, marker: string): ConversationViewWire {
	return {
		conversation: { id },
		entries: [
			{
				id: 1,
				conversationId: id,
				kind: "pi.user",
				model: [{ role: "user", content: [{ type: "text", text: marker }] }],
			},
		],
		docs: {},
		steer: { busy: false, queued: 0 },
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("openConversationStream", () => {
	test("opens the §5 stream URL for the conversation (baseUrl-prefixed)", () => {
		const { factory, urls } = stubFactory();
		const handle = openConversationStream(
			7,
			{},
			"https://sigrun.example",
			{ createEventSource: factory },
		);
		expect(urls()).toEqual([
			"https://sigrun.example/v1/conversations/7/stream",
		]);
		handle.close();
	});

	test("snapshot and view frames parse and dispatch to their handlers", () => {
		const { sources, factory } = stubFactory();
		const snapshots: ConversationViewWire[] = [];
		const views: ConversationViewWire[] = [];
		const handle = openConversationStream(7, {
			onSnapshot: (v) => snapshots.push(v),
			onView: (v) => views.push(v),
		}, "", { createEventSource: factory });
		const source = sources[0]!;
		source.emit("open");
		source.emit("snapshot", JSON.stringify(view(7, "snap")));
		source.emit("view", JSON.stringify(view(7, "live")));
		expect(snapshots.map((v) => v.entries[0]?.model[0]?.content)).toEqual([
			[{ type: "text", text: "snap" }],
		]);
		expect(views).toHaveLength(1);
		expect(views[0]?.conversation.id).toBe(7);
		handle.close();
	});

	test("a malformed frame reports onError and the stream survives", () => {
		const { sources, factory } = stubFactory();
		const errors: string[] = [];
		const snapshots: ConversationViewWire[] = [];
		const handle = openConversationStream(7, {
			onSnapshot: (v) => snapshots.push(v),
			onError: (message) => errors.push(message),
		}, "", { createEventSource: factory });
		const source = sources[0]!;
		source.emit("snapshot", "{not json");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/malformed/i);
		expect(source.closed).toBe(false); // the stream stays open
		source.emit("snapshot", JSON.stringify(view(7, "recovered")));
		expect(snapshots).toHaveLength(1); // a later good frame still dispatches
		handle.close();
	});

	test("well-formed JSON that is not a view object is malformed too", () => {
		const { sources, factory } = stubFactory();
		const errors: string[] = [];
		const views: ConversationViewWire[] = [];
		const handle = openConversationStream(7, {
			onView: (v) => views.push(v),
			onError: (message) => errors.push(message),
		}, "", { createEventSource: factory });
		sources[0]!.emit("view", "42");
		sources[0]!.emit("view", "[1,2]");
		sources[0]!.emit("view", "null");
		expect(errors).toHaveLength(3);
		expect(views).toHaveLength(0);
		handle.close();
	});

	test("a transport error closes the source and reconnects with backoff; the re-attach gets a fresh snapshot", () => {
		vi.useFakeTimers();
		const { sources, factory } = stubFactory();
		const errors: string[] = [];
		const snapshots: ConversationViewWire[] = [];
		const handle = openConversationStream(7, {
			onSnapshot: (v) => snapshots.push(v),
			onError: (message) => errors.push(message),
		}, "", { createEventSource: factory });
		sources[0]!.emit("open");
		sources[0]!.emit("snapshot", JSON.stringify(view(7, "first")));
		sources[0]!.emit("error");
		expect(errors).toHaveLength(1);
		expect(sources[0]!.closed).toBe(true);
		expect(sources).toHaveLength(1); // not yet reconnected
		vi.advanceTimersByTime(249);
		expect(sources).toHaveLength(1);
		vi.advanceTimersByTime(1); // 250ms base backoff
		expect(sources).toHaveLength(2);
		// The re-attach re-opens and the server sends a fresh snapshot.
		sources[1]!.emit("open");
		sources[1]!.emit("snapshot", JSON.stringify(view(7, "fresh")));
		expect(snapshots).toHaveLength(2);
		handle.close();
	});

	test("consecutive failures back off exponentially, capped at 4s; a successful open resets", () => {
		vi.useFakeTimers();
		const { sources, factory } = stubFactory();
		const handle = openConversationStream(7, {}, "", {
			createEventSource: factory,
		});
		// 250, 500, 1000, 2000, 4000, then capped at 4000.
		const expectedDelays = [250, 500, 1000, 2000, 4000, 4000];
		for (const delay of expectedDelays) {
			const before = sources.length;
			sources[sources.length - 1]!.emit("error");
			vi.advanceTimersByTime(delay - 1);
			expect(sources).toHaveLength(before); // not before the delay elapses
			vi.advanceTimersByTime(1);
			expect(sources).toHaveLength(before + 1);
		}
		// A successful open resets the backoff ladder.
		sources[sources.length - 1]!.emit("open");
		sources[sources.length - 1]!.emit("error");
		vi.advanceTimersByTime(250);
		expect(sources[sources.length - 1]!.closed).toBe(false);
		handle.close();
	});

	test("close() cancels a pending reconnect and closes the live source", () => {
		vi.useFakeTimers();
		const { sources, factory } = stubFactory();
		const handle = openConversationStream(7, {}, "", {
			createEventSource: factory,
		});
		sources[0]!.emit("error");
		handle.close();
		vi.advanceTimersByTime(60_000);
		expect(sources).toHaveLength(1); // the pending reconnect never fires
	});

	test("frames arriving after close() are ignored", () => {
		const { sources, factory } = stubFactory();
		const snapshots: ConversationViewWire[] = [];
		const handle = openConversationStream(
			7,
			{ onSnapshot: (v) => snapshots.push(v) },
			"",
			{ createEventSource: factory },
		);
		handle.close();
		expect(sources[0]!.closed).toBe(true);
		sources[0]!.emit("snapshot", JSON.stringify(view(7, "late")));
		expect(snapshots).toHaveLength(0);
	});

	test("repeated error events on one source schedule a single reconnect", () => {
		vi.useFakeTimers();
		const { sources, factory } = stubFactory();
		const handle = openConversationStream(7, {}, "", {
			createEventSource: factory,
		});
		sources[0]!.emit("error");
		sources[0]!.emit("error");
		sources[0]!.emit("error");
		vi.advanceTimersByTime(250);
		expect(sources).toHaveLength(2); // one reconnect, not three
		handle.close();
	});
});
