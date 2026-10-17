/**
 * useConversationList (B3, UI refresh): App's lifted conversation list —
 * loads on mount, polls every 10 s while the document is visible, and on
 * a busy → idle transition reloads immediately AND again after 5 s (the
 * auto-namer's fresh name appears without a manual reload). Fake timers
 * drive the schedule; the stub fetch counts list GETs and can flip its
 * payload or fail. The suite runs without a DOM, so the visibility gate
 * is exercised by stubbing `document` (absent document reads as visible).
 */

import { act, useEffect } from "react";
import type TestRenderer from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createClient, type ConversationSummary, type FetchLike, type SigrunClient } from "../api";
import { renderAsync } from "../test-utils";
import {
	useConversationList,
	type UseConversationListResult,
} from "./useConversationList";

const POLL_MS = 10_000;
const SETTLE_MS = 5_000;

function summary(
	fields: Partial<ConversationSummary> & Pick<ConversationSummary, "id">,
): ConversationSummary {
	return {
		root: false,
		entryCount: 1,
		archived: false,
		pinned: false,
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
	return {
		client: createClient({ fetch: fetchImpl }),
		conversations,
		calls: () => listCalls,
	};
}

/** Top-level hook host; `renderer.update` flips the busy input. */
function Host(props: {
	client: SigrunClient;
	busy: boolean;
	capture: (api: UseConversationListResult) => void;
}) {
	const api = useConversationList(props.client, { busy: props.busy });
	useEffect(() => {
		props.capture(api);
	});
	return (
		<p className="list-echo">
			{api.rows.map((row) => row.name ?? `#${row.id}`).join("|")}
		</p>
	);
}

async function renderHost(client: SigrunClient, busy: boolean) {
	let api: UseConversationListResult | undefined;
	const capture = (next: UseConversationListResult) => {
		api = next;
	};
	const renderer = await renderAsync(
		<Host client={client} busy={busy} capture={capture} />,
	);
	const getApi = () => {
		if (api === undefined) throw new Error("hook api not captured");
		return api;
	};
	const setBusy = async (next: boolean) => {
		await act(async () => {
			renderer.update(
				<Host client={client} busy={next} capture={capture} />,
			);
		});
	};
	const advance = async (ms: number) => {
		await act(async () => {
			// advanceTimersByTimeAsync fires the interval AND drains the
			// microtask queue, so the tick's fetch → setState fully lands.
			await vi.advanceTimersByTimeAsync(ms);
		});
	};
	const text = () => {
		const json = renderer.toJSON();
		if (json === null || Array.isArray(json)) throw new Error("no echo");
		return (json.children ?? []).join("");
	};
	return { advance, getApi, renderer, setBusy, text };
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
		const { client, calls } = makeHarness();
		const { getApi, text } = await renderHost(client, false);
		expect(calls()).toBe(1);
		expect(getApi().rows.map((row) => row.id)).toEqual([1, 2]);
		expect(getApi().error).toBeNull();
		expect(text()).toBe("Tide table rewrite|Moor line inspection");
	});

	test("polls every 10 s while the document is visible; served updates appear", async () => {
		const { client, conversations, calls } = makeHarness();
		const { advance, text } = await renderHost(client, false);
		expect(calls()).toBe(1);
		await advance(POLL_MS);
		expect(calls()).toBe(2);
		await advance(POLL_MS);
		expect(calls()).toBe(3);
		// The poll is a live reload: a newly served row appears on the next tick.
		conversations.push(summary({ id: 3, name: "Chart corrections" }));
		await advance(POLL_MS);
		expect(calls()).toBe(4);
		expect(text()).toContain("Chart corrections");
	});

	test("a hidden document pauses the poll", async () => {
		const { client, calls } = makeHarness();
		const { advance } = await renderHost(client, false);
		expect(calls()).toBe(1);
		vi.stubGlobal("document", { visibilityState: "hidden" });
		await advance(6 * POLL_MS);
		expect(calls()).toBe(1);
	});

	test("busy → idle reloads immediately, then again after 5 s", async () => {
		const { client, calls } = makeHarness();
		const { advance, setBusy } = await renderHost(client, false);
		expect(calls()).toBe(1);
		await setBusy(true);
		expect(calls()).toBe(1); // going busy does not reload
		await setBusy(false);
		expect(calls()).toBe(2); // the immediate post-idle reload
		await advance(SETTLE_MS - 1);
		expect(calls()).toBe(2);
		await advance(1);
		expect(calls()).toBe(3); // the settle reload (fresh auto-name pickup)
	});

	test("a failed load sets error and keeps rows empty", async () => {
		const { client } = makeHarness({ listFails: true });
		const { getApi } = await renderHost(client, false);
		expect(getApi().rows).toEqual([]);
		expect(getApi().error).toContain(
			"sigrun api: GET /v1/conversations failed with status 500",
		);
	});
});
