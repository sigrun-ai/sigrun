/**
 * useConversationList (B3, UI refresh; events stream in core hardening W3
 * Task 4): App's lifted conversation list — loads on mount, subscribes to
 * ONE shared `/v1/events` EventSource (conversation.* events refetch),
 * and on a busy → idle transition reloads immediately AND again after 5 s
 * (the auto-namer's fresh name appears without a manual reload). Fake
 * timers drive the settle schedule; the stub fetch counts list GETs and
 * can flip its payload or fail; the injected StubEventSource emits
 * `conversation.changed` frames.
 *
 * The W3 contract: NO interval polling — advancing 60 s of fake time
 * fires ZERO list GETs beyond the mount load; a `conversation.changed`
 * event fires exactly one refetch.
 */

import { act, useEffect } from "react";
import type TestRenderer from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createClient, type ConversationSummary, type FetchLike, type SigrunClient } from "../api";
import { renderAsync, StubEventSource } from "../test-utils";
import {
	useConversationList,
	type UseConversationListResult,
} from "./useConversationList";

const SETTLE_MS = 5_000;

function summary(
	fields: Partial<ConversationSummary> & Pick<ConversationSummary, "id">,
): ConversationSummary {
	return {
		root: false,
		archived: false,
		pinned: false,
		access: "write",
		...fields,
	};
}

function makeHarness(init?: { readonly listFails?: boolean }) {
	const conversations: ConversationSummary[] = [
		summary({ id: 1, root: true, name: "Tide table rewrite" }),
		summary({ id: 2, name: "Moor line inspection" }),
	];
	let listCalls = 0;
	let listFails = init?.listFails ?? false;
	const fetchImpl: FetchLike = (input, init2) => {
		if (input !== "/v1/conversations" || (init2?.method ?? "GET") !== "GET") {
			return Promise.reject(new Error(`unexpected fetch ${input}`));
		}
		listCalls += 1;
		if (listFails) {
			return Promise.resolve({
				ok: false,
				status: 500,
				json: () => Promise.resolve({}),
				text: () => Promise.resolve(""),
			});
		}
		return Promise.resolve({
			ok: true,
			status: 200,
			// A copy per call — a real response is freshly parsed JSON, and a
			// same-reference setRows would bail out of re-rendering.
			json: () => Promise.resolve({ conversations: [...conversations] }),
			text: () => Promise.resolve(""),
		});
	};
	const events = new StubEventSource();
	// U3 Task 4 seam: surface fetches the hook issues (X-Sigrun-Stream +
	// the reconnect re-fetch fan-out) are recorded here.
	const surfaceRequests: { url: string; headers: Record<string, string> }[] = [];
	const fetchSurfaceImpl = (async (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		surfaceRequests.push({
			url: String(input),
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		return {
			ok: true,
			status: 200,
			json: () => Promise.resolve({}),
			text: () => Promise.resolve(""),
		} as Response;
	}) as typeof fetch;
	return {
		client: createClient({ fetch: fetchImpl }),
		conversations,
		events,
		calls: () => listCalls,
		createEventSource: () => events,
		fetchSurfaceImpl,
		surfaceFetches: () => surfaceRequests.length,
		lastSurfaceRequest: () => surfaceRequests[surfaceRequests.length - 1],
		surfaceRequestUrls: () => surfaceRequests.map((request) => request.url),
	};
}

/** Top-level hook host; `renderer.update` flips the busy input. */
function Host(props: {
	client: SigrunClient;
	busy: boolean;
	createEventSource: () => StubEventSource;
	fetchImpl?: typeof fetch;
	capture: (api: UseConversationListResult) => void;
}) {
	const api = useConversationList(props.client, {
		busy: props.busy,
		createEventSource: props.createEventSource,
		...(props.fetchImpl === undefined
			? {}
			: { fetchImpl: props.fetchImpl }),
	});
	useEffect(() => {
		props.capture(api);
	});
	return (
		<p className="list-echo">
			{api.rows.map((row) => row.name ?? `#${row.id}`).join("|")}
		</p>
	);
}

async function renderHost(harness: ReturnType<typeof makeHarness>, busy: boolean) {
	let api: UseConversationListResult | undefined;
	const capture = (next: UseConversationListResult) => {
		api = next;
	};
	const renderer = await renderAsync(
		<Host
			client={harness.client}
			busy={busy}
			createEventSource={harness.createEventSource}
			fetchImpl={harness.fetchSurfaceImpl}
			capture={capture}
		/>,
	);
	const getApi = () => {
		if (api === undefined) throw new Error("hook api not captured");
		return api;
	};
	const setBusy = async (next: boolean) => {
		await act(async () => {
			renderer.update(
				<Host
					client={harness.client}
					busy={next}
					createEventSource={harness.createEventSource}
					fetchImpl={harness.fetchSurfaceImpl}
					capture={capture}
				/>,
			);
		});
	};
	const advance = async (ms: number) => {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});
	};
	const emit = async (type: string, data = "{}") => {
		await act(async () => {
			harness.events.emit(type, data);
			// Let the refetch promise settle.
			await Promise.resolve();
			await Promise.resolve();
		});
	};
	const text = () => {
		const json = renderer.toJSON();
		if (json === null || Array.isArray(json)) throw new Error("no echo");
		return (json.children ?? []).join("");
	};
	return { advance, emit, getApi, renderer, setBusy, text };
}

describe("useConversationList", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	test("loads rows on mount; error stays null", async () => {
		const harness = makeHarness();
		const { getApi, text } = await renderHost(harness, false);
		expect(harness.calls()).toBe(1);
		expect(getApi().rows.map((row) => row.id)).toEqual([1, 2]);
		expect(getApi().error).toBeNull();
		expect(text()).toBe("Tide table rewrite|Moor line inspection");
	});

	test("W3: no polling — 60 s of fake time fires zero further list GETs", async () => {
		const harness = makeHarness();
		const { advance } = await renderHost(harness, false);
		expect(harness.calls()).toBe(1);
		await advance(60_000);
		expect(harness.calls()).toBe(1);
	});

	test("W3: a conversation.changed event refetches the list once", async () => {
		const harness = makeHarness();
		const { emit, text } = await renderHost(harness, false);
		expect(harness.calls()).toBe(1);
		harness.conversations.push(summary({ id: 3, name: "Chart corrections" }));
		await emit("conversation.changed");
		expect(harness.calls()).toBe(2);
		expect(text()).toContain("Chart corrections");
	});

	test("W3: a conversation.created event also refetches", async () => {
		const harness = makeHarness();
		const { emit } = await renderHost(harness, false);
		expect(harness.calls()).toBe(1);
		await emit("conversation.created");
		expect(harness.calls()).toBe(2);
	});

	test("busy → idle reloads immediately, then again after 5 s", async () => {
		const harness = makeHarness();
		const { advance, setBusy } = await renderHost(harness, false);
		expect(harness.calls()).toBe(1);
		await setBusy(true);
		expect(harness.calls()).toBe(1); // going busy does not reload
		await setBusy(false);
		expect(harness.calls()).toBe(2); // the immediate post-idle reload
		await advance(SETTLE_MS - 1);
		expect(harness.calls()).toBe(2);
		await advance(1);
		expect(harness.calls()).toBe(3); // the settle reload (fresh auto-name pickup)
	});

	test("a failed load sets error and keeps rows empty", async () => {
		const harness = makeHarness({ listFails: true });
		const { getApi } = await renderHost(harness, false);
		expect(getApi().rows).toEqual([]);
		expect(getApi().error).toContain(
			"sigrun api: GET /v1/conversations failed with status 500",
		);
	});

	test("U3 Task 4: the hello frame's streamId is exposed; surface fetches send X-Sigrun-Stream", async () => {
		const harness = makeHarness();
		const { getApi, emit } = await renderHost(harness, false);
		expect(getApi().streamId).toBeUndefined();
		await emit("hello", JSON.stringify({ streamId: "stream-abc-123" }));
		expect(getApi().streamId).toBe("stream-abc-123");
		// A surface fetch through the hook's own seam carries the stream
		// header once the hello landed.
		await getApi().fetchSurface("acme", "board");
		expect(harness.lastSurfaceRequest()?.headers["x-sigrun-stream"]).toBe(
			"stream-abc-123",
		);
	});

	test("U3 Task 4: channels ignore unknown event types (x.unknown: no error, no reload)", async () => {
		const harness = makeHarness();
		const { getApi, emit } = await renderHost(harness, false);
		expect(harness.calls()).toBe(1);
		await emit("x.unknown", "{}");
		expect(harness.calls()).toBe(1);
		expect(getApi().error).toBeNull();
	});

	test("U3 Task 4: after a reconnect with a new streamId, every visible surface is re-fetched", async () => {
		const harness = makeHarness();
		const { getApi, emit } = await renderHost(harness, false);
		await emit("hello", JSON.stringify({ streamId: "stream-one" }));
		expect(getApi().streamId).toBe("stream-one");
		// Register two visible surfaces (the channel's tracking).
		getApi().noteSurfaceVisible("acme", "board");
		getApi().noteSurfaceVisible("acme", "stats");
		expect(harness.surfaceFetches()).toBe(0);
		// The reconnect: a NEW hello with a NEW streamId re-fetches every
		// visible surface (re-registering the stream's watcher entries).
		await emit("hello", JSON.stringify({ streamId: "stream-two" }));
		expect(getApi().streamId).toBe("stream-two");
		expect(harness.surfaceFetches()).toBe(2);
		expect(harness.lastSurfaceRequest()?.headers["x-sigrun-stream"]).toBe(
			"stream-two",
		);
	});

	test("U3 Task 5 fix: two INSTANCES of one surface (different params) each re-register after a re-hello", async () => {
		const harness = makeHarness();
		const { getApi, emit } = await renderHost(harness, false);
		await emit("hello", JSON.stringify({ streamId: "stream-one" }));
		// Two instances of the same surface, keyed by their params.
		getApi().noteSurfaceVisible("acme", "board", { board: "b1" });
		getApi().noteSurfaceVisible("acme", "board", { board: "b2" });
		getApi().noteSurfaceVisible("acme", "board"); // the default instance
		await emit("hello", JSON.stringify({ streamId: "stream-two" }));
		expect(harness.surfaceFetches()).toBe(3);
		// Each re-fetch carries its OWN params (its own watcher entry).
		const urls = harness.surfaceRequestUrls();
		expect(urls).toContain(
			`/v1/ext/acme/surfaces/board?params=${encodeURIComponent('{"board":"b1"}')}`,
		);
		expect(urls).toContain(
			`/v1/ext/acme/surfaces/board?params=${encodeURIComponent('{"board":"b2"}')}`,
		);
		expect(urls).toContain("/v1/ext/acme/surfaces/board");
	});
});
