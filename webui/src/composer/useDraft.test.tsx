/**
 * useDraft (Task 23b): the per-session persistent composer draft.
 * Restores on switch (GET `/v1/conversations/:id/meta` → `draft.text`) and
 * saves on change (debounced PATCH with a draft sub-merge). Server-side
 * meta, not localStorage — the draft survives a reload.
 *
 * Test host: a minimal component drives the hook through setText while fake
 * timers control the debounce window. The stub fetch records the meta PATCH
 * bodies.
 */

import { act, useEffect } from "react";
import type TestRenderer from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createClient, type ConversationMeta, type FetchLike } from "../api";
import { renderAsync, textContent } from "../test-utils";
import { useDraft } from "./useDraft";

function metaWithDraft(text: string): ConversationMeta {
	return {
		pinned: false,
		tagged: [],
		archived: false,
		draft: { text, attachments: [] },
		source: "user",
	};
}

function makeHarness() {
	const calls: { input: string; method?: string; body?: string }[] = [];
	const metaById = new Map<number, ConversationMeta>();
	const fetchImpl: FetchLike = (input, init) => {
		calls.push({ input, method: init?.method, body: init?.body });
		const metaMatch = /^\/v1\/conversations\/(\d+)\/meta$/.exec(input);
		if (metaMatch === null) throw new Error(`unexpected fetch ${input}`);
		const id = Number(metaMatch[1]);
		const body: unknown = metaById.get(id) ?? metaWithDraft("");
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve(body),
		});
	};
	const client = createClient({ fetch: fetchImpl });
	return { calls, client, metaById };
}

/** Top-level hook host; `renderer.update` switches the conversation id. */
function Host(props: {
	client: ReturnType<typeof createClient>;
	conversationId: number;
	capture: (api: { setText(text: string): void }) => void;
}) {
	const draft = useDraft(props.client, props.conversationId);
	useEffect(() => {
		props.capture({ setText: draft.setText });
	});
	return <p className="draft-echo">{draft.text}</p>;
}

async function renderHost(
	client: ReturnType<typeof createClient>,
	initialId: number,
) {
	let api: { setText(text: string): void } | undefined;
	const capture = (next: { setText(text: string): void }) => {
		api = next;
	};
	const renderer = await renderAsync(
		<Host client={client} conversationId={initialId} capture={capture} />,
	);
	const getApi = () => {
		if (api === undefined) throw new Error("hook api not captured");
		return api;
	};
	const switchTo = async (id: number) => {
		await act(async () => {
			renderer.update(
				<Host client={client} conversationId={id} capture={capture} />,
			);
		});
	};
	return { renderer, getApi, switchTo };
}

async function setText(
	renderer: TestRenderer.ReactTestRenderer,
	api: { setText(text: string): void },
	text: string,
): Promise<void> {
	await act(async () => {
		api.setText(text);
	});
}

describe("useDraft", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("restores the served draft text on mount", async () => {
		const { client, metaById } = makeHarness();
		metaById.set(1, metaWithDraft("half-finished reply"));
		const { renderer } = await renderHost(client, 1);
		expect(textContent(renderer.toJSON())).toBe("half-finished reply");
	});

	test("switching conversations restores THAT conversation's draft", async () => {
		const { client, metaById } = makeHarness();
		metaById.set(1, metaWithDraft("first draft"));
		metaById.set(2, metaWithDraft("second draft"));
		const { renderer, switchTo } = await renderHost(client, 1);
		expect(textContent(renderer.toJSON())).toBe("first draft");
		await switchTo(2);
		expect(textContent(renderer.toJSON())).toBe("second draft");
	});

	test("a change PATCHes the draft after the debounce window (not before)", async () => {
		const { calls, client } = makeHarness();
		const { renderer, getApi } = await renderHost(client, 1);
		await setText(renderer, getApi(), "typing…");
		// The PATCH has NOT fired yet — still inside the debounce window.
		expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
		await act(async () => {
			vi.advanceTimersByTime(600);
		});
		const patches = calls.filter((c) => c.method === "PATCH");
		expect(patches).toEqual([
			{
				input: "/v1/conversations/1/meta",
				method: "PATCH",
				body: JSON.stringify({ draft: { text: "typing…" } }),
			},
		]);
	});

	test("rapid edits coalesce into ONE debounced PATCH with the latest text", async () => {
		const { calls, client } = makeHarness();
		const { renderer, getApi } = await renderHost(client, 1);
		await setText(renderer, getApi(), "a");
		await setText(renderer, getApi(), "ab");
		await setText(renderer, getApi(), "abc");
		await act(async () => {
			vi.advanceTimersByTime(600);
		});
		const patches = calls.filter((c) => c.method === "PATCH");
		expect(patches).toHaveLength(1);
		expect(patches[0]?.body).toBe(
			JSON.stringify({ draft: { text: "abc" } }),
		);
	});

	test("restored text does NOT echo back as a PATCH (no restore feedback loop)", async () => {
		const { calls, client, metaById } = makeHarness();
		metaById.set(1, metaWithDraft("served draft"));
		await renderHost(client, 1);
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
	});

	test("a pending save flushes on conversation switch (the draft is never stranded in the debounce window)", async () => {
		const { calls, client } = makeHarness();
		const { renderer, getApi, switchTo } = await renderHost(client, 1);
		await setText(renderer, getApi(), "unsent words");
		await switchTo(2);
		const patches = calls.filter((c) => c.method === "PATCH");
		expect(patches.map((c) => c.body)).toContain(
			JSON.stringify({ draft: { text: "unsent words" } }),
		);
	});
});
