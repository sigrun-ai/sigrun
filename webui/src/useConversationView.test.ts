/**
 * The `useConversationView` hook driven by a stubbed EventSource factory
 * (Task 21) — no real server, no DOM (react-test-renderer). Covers the hook
 * contract: null id → idle; snapshot sets the view; delta frames fold into
 * it (the stream wrapper surfaces full folded revisions — never accumulate);
 * malformed frame → error status, stream survives; transport error →
 * reconnect → fresh snapshot; unmount closes; id change closes the old
 * stream and opens a new one.
 */

import { createElement, act } from "react";
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConversationViewWire } from "./api";
import type { EventSourceFactory, StreamMessageEvent } from "./stream";
import {
	useConversationView,
	type ConversationViewState,
} from "./useConversationView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { StubEventSource } from "./test-utils";

function harness() {
	const sources: StubEventSource[] = [];
	const urls: string[] = [];
	const factory: EventSourceFactory = (url) => {
		urls.push(url);
		const source = new StubEventSource();
		sources.push(source);
		return source;
	};
	let latest: ConversationViewState | undefined;
	function Probe(props: { id: number | null }) {
		latest = useConversationView(props.id, { createEventSource: factory });
		return null;
	}
	let renderer: TestRenderer.ReactTestRenderer;
	act(() => {
		renderer = TestRenderer.create(createElement(Probe, { id: null }));
	});
	const state = (): ConversationViewState => {
		if (latest === undefined) throw new Error("hook state never captured");
		return latest;
	};
	return {
		sources,
		urls,
		state,
		setId(id: number | null) {
			act(() => {
				renderer.update(createElement(Probe, { id }));
			});
		},
		emit(type: string, data = "", index = sources.length - 1) {
			act(() => {
				sources[index]?.emit(type, data);
			});
		},
		advance(ms: number) {
			act(() => {
				vi.advanceTimersByTime(ms);
			});
		},
		unmount() {
			act(() => {
				renderer.unmount();
			});
		},
	};
}

function view(id: number, marker: string): ConversationViewWire {
	return {
		conversation: { id },
		entries: [
			{
				id: 1,
				conversationId: id,
				kind: "pi.assistant",
				model: [
					{ role: "assistant", content: [{ type: "text", text: marker }] },
				],
			},
		],
		docs: {},
		steer: { busy: false, queued: 0 },
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("useConversationView", () => {
	test("a null conversation id is idle and opens no stream", () => {
		const h = harness();
		expect(h.state()).toEqual({
			view: null,
			status: "idle",
			frames: 0,
			error: null,
		});
		expect(h.sources).toHaveLength(0);
		h.unmount();
	});

	test("snapshot sets the view; delta frames fold into the held revision", () => {
		const h = harness();
		h.setId(7);
		expect(h.urls).toEqual(["/v1/conversations/7/stream"]);
		expect(h.state().status).toBe("connecting");
		h.emit("snapshot", JSON.stringify(view(7, "first")));
		expect(h.state().status).toBe("snapshot");
		expect(h.state().frames).toBe(1);
		const firstView = h.state().view;
		// A delta folds: the held view becomes the folded FULL revision.
		h.emit("delta", JSON.stringify({
			entries: {
				append: [
					{
						id: 2,
						conversationId: 7,
						kind: "pi.assistant",
						model: [
							{ role: "assistant", content: [{ type: "text", text: "second" }] },
						],
					},
				],
			},
		}));
		expect(h.state().status).toBe("live");
		expect(h.state().frames).toBe(2);
		// Folded revision: a different object carrying both entries, no
		// in-place merge.
		expect(h.state().view).not.toBe(firstView);
		expect(h.state().view?.entries.map((entry) => entry.id)).toEqual([1, 2]);
		expect(
			h.state().view?.entries[1]?.model?.[0]?.content,
		).toEqual([{ type: "text", text: "second" }]);
		h.unmount();
	});

	test("a malformed frame surfaces error status; the stream survives and a good frame recovers", () => {
		const h = harness();
		h.setId(7);
		h.emit("snapshot", JSON.stringify(view(7, "good")));
		h.emit("delta", "{broken");
		expect(h.state().status).toBe("error");
		expect(h.state().error).toMatch(/malformed/i);
		expect(h.state().frames).toBe(1); // the bad frame did not count
		expect(h.state().view?.entries[0]?.model?.[0]?.content).toEqual([
			{ type: "text", text: "good" },
		]);
		expect(h.sources[0]?.closed).toBe(false); // stream survives
		h.emit("delta", JSON.stringify({ steer: { busy: true, queued: 0 } }));
		expect(h.state().status).toBe("live");
		expect(h.state().error).toBeNull();
		expect(h.state().view?.steer).toEqual({ busy: true, queued: 0 });
		expect(h.state().frames).toBe(2);
		h.unmount();
	});

	test("a transport error reconnects; the re-attach snapshot restores the view", () => {
		vi.useFakeTimers();
		const h = harness();
		h.setId(7);
		h.emit("snapshot", JSON.stringify(view(7, "first")));
		h.emit("error");
		expect(h.state().status).toBe("error");
		expect(h.state().error).toBeTruthy();
		expect(h.sources[0]?.closed).toBe(true);
		h.advance(250);
		expect(h.sources).toHaveLength(2);
		expect(h.urls[1]).toBe("/v1/conversations/7/stream");
		h.emit("snapshot", JSON.stringify(view(7, "fresh")), 1);
		expect(h.state().status).toBe("snapshot");
		expect(h.state().error).toBeNull();
		expect(h.state().frames).toBe(2); // frames keep counting across reconnect
		h.unmount();
	});

	test("unmount closes the stream", () => {
		const h = harness();
		h.setId(7);
		const source = h.sources[0]!;
		expect(source.closed).toBe(false);
		h.unmount();
		expect(source.closed).toBe(true);
	});

	test("changing the conversation id closes the old stream, opens a new one, and resets the view", () => {
		const h = harness();
		h.setId(7);
		h.emit("snapshot", JSON.stringify(view(7, "seven")));
		expect(h.state().frames).toBe(1);
		h.setId(8);
		expect(h.sources[0]?.closed).toBe(true);
		expect(h.urls).toEqual([
			"/v1/conversations/7/stream",
			"/v1/conversations/8/stream",
		]);
		expect(h.state().status).toBe("connecting");
		expect(h.state().view).toBeNull();
		expect(h.state().frames).toBe(0);
		h.emit("snapshot", JSON.stringify(view(8, "eight")), 1);
		expect(h.state().status).toBe("snapshot");
		expect(h.state().frames).toBe(1);
		expect(h.state().view?.conversation.id).toBe(8);
		h.unmount();
	});

	test("switching back to a null id closes the stream and returns to idle", () => {
		const h = harness();
		h.setId(7);
		h.emit("snapshot", JSON.stringify(view(7, "seven")));
		h.setId(null);
		expect(h.sources[0]?.closed).toBe(true);
		expect(h.state()).toEqual({
			view: null,
			status: "idle",
			frames: 0,
			error: null,
		});
		h.unmount();
	});
});
