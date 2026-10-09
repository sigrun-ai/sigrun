/**
 * The App shell (Task 23a): SessionList left, the chat center (EntryList
 * over `useConversationView(activeId)`), a right-panel placeholder, and the
 * empty composer footer slot (T23b fills it). Switching the active
 * conversation re-drives the view hook (a fresh stream opens, the stale one
 * closes). Stub fetch for the §5 HTTP calls; StubEventSource for the stream.
 */

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test } from "vitest";
import { App } from "./App";
import { createClient, type ConversationMeta, type FetchLike } from "./api";
import type { EventSourceFactory } from "./stream";
import {
	makeEntry,
	makeView,
	renderAsync,
	StubEventSource,
	textContent,
	textMessage,
} from "./test-utils";

type Call = { input: string; method?: string; body?: string };

function makeHarness() {
	const metas: Record<number, ConversationMeta> = {
		1: {
			pinned: false,
			tagged: [],
			archived: false,
			draft: { text: "", attachments: [] },
			source: "user",
		},
		2: {
			pinned: false,
			tagged: [],
			archived: false,
			draft: { text: "", attachments: [] },
			source: "user",
		},
	};
	const calls: Call[] = [];
	const fetchImpl: FetchLike = (input, init) => {
		calls.push({ input, method: init?.method, body: init?.body });
		const metaMatch = /^\/v1\/conversations\/(\d+)\/meta$/.exec(input);
		const body: unknown =
			metaMatch !== null
				? metas[Number(metaMatch[1])]
				: {
						conversations: [
							{ id: 1, root: true, entryCount: 2 },
							{ id: 2, root: false, entryCount: 1 },
						],
					};
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve(body),
		});
	};
	const sources: { url: string; source: StubEventSource }[] = [];
	const createEventSource: EventSourceFactory = (url) => {
		const source = new StubEventSource();
		sources.push({ url, source });
		return source;
	};
	const client = createClient({ fetch: fetchImpl });
	return { calls, client, createEventSource, sources };
}

async function clickByClass(
	renderer: TestRenderer.ReactTestRenderer,
	className: string,
	labelMatch: string,
): Promise<void> {
	const button = renderer.root
		.findAllByProps({ className })
		.find((node) => node.children.join("").includes(labelMatch));
	if (button === undefined) {
		throw new Error(`no .${className} containing ${labelMatch}`);
	}
	await act(async () => {
		await (button.props as { onClick: () => unknown }).onClick();
	});
}

describe("App shell", () => {
	test("composes sidebar + chat center + right placeholder + composer slot; no stream until a conversation is selected", async () => {
		const { client, createEventSource, sources } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const text = textContent(renderer.toJSON());
		// Sidebar conversations rendered.
		expect(text).toContain("#1");
		expect(text).toContain("#2");
		// Empty chat state + right placeholder; composer slot present but empty.
		expect(text).toContain("Select or create a conversation");
		expect(text).toContain("details");
		const composer = renderer.root.findByProps({
			className: "composer-slot",
		});
		expect(composer.children).toEqual([]);
		// No stream without an active conversation.
		expect(sources).toEqual([]);
	});

	test("selecting a conversation drives the view hook and renders the transcript", async () => {
		const { client, createEventSource, sources } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		await clickByClass(renderer, "session-select", "#2");
		expect(sources.map((s) => s.url)).toEqual(["/v1/conversations/2/stream"]);
		act(() => {
			sources[0]?.source.emit(
				"snapshot",
				JSON.stringify(
					makeView({
						id: 2,
						entries: [
							makeEntry(
								"pi.user",
								[textMessage("user", "hello from conversation two")],
								{ id: 10, conversationId: 2 },
							),
						],
					}),
				),
			);
		});
		const text = textContent(renderer.toJSON());
		expect(text).toContain("hello from conversation two");
	});

	test("switching the active id re-drives the view hook (new stream, old closed)", async () => {
		const { client, createEventSource, sources } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		await clickByClass(renderer, "session-select", "#1");
		await clickByClass(renderer, "session-select", "#2");
		expect(sources.map((s) => s.url)).toEqual([
			"/v1/conversations/1/stream",
			"/v1/conversations/2/stream",
		]);
		expect(sources[0]?.source.closed).toBe(true);
		expect(sources[1]?.source.closed).toBe(false);
	});
});
