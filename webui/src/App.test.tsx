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
import {
	createClient,
	type ApprovalWire,
	type ConversationMeta,
	type FetchLike,
	type MetaResponse,
} from "./api";
import { PINNED_SCHEMA_VERSION } from "./schema-version";
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

function makeMeta(init?: {
	readonly schemaVersion?: string;
}): MetaResponse {
	return {
		harnessVersion: "1.0.2",
		schemaVersion: init?.schemaVersion ?? PINNED_SCHEMA_VERSION,
		extensions: [
			{ name: "memory", status: "ok" },
			{ name: "approvals", status: "ok" },
		],
		health: { backup: "unconfigured", memory: "ok", providers: "ok" },
		capabilities: { backup: false, channels: ["webui"] },
	};
}

function makeHarness(init?: {
	readonly approvals?: readonly ApprovalWire[];
	readonly meta?: MetaResponse;
	readonly metaFails?: boolean;
}) {
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
	let approvals = init?.approvals ?? [];
	const calls: Call[] = [];
	const fetchImpl: FetchLike = (input, init2) => {
		calls.push({ input, method: init2?.method, body: init2?.body });
		if (input === "/v1/meta") {
			if (init?.metaFails === true) {
				return Promise.resolve({
					ok: false,
					status: 500,
					json: () => Promise.resolve({}),
				text: () => Promise.resolve(String({})),
				});
			}
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve(init?.meta ?? makeMeta()),
				text: () => Promise.resolve(String(init?.meta ?? makeMeta())),
			});
		}
		const metaMatch = /^\/v1\/conversations\/(\d+)\/meta$/.exec(input);
		let body: unknown;
		if (metaMatch !== null) body = metas[Number(metaMatch[1])];
		else if (input === "/v1/models") body = { models: [] };
		else if (/^\/v1\/conversations\/\d+\/files\?/.test(input)) {
			body = { entries: [] };
		} else if (/^\/v1\/conversations\/\d+\/approvals$/.test(input)) {
			body = { approvals };
		} else {
			body = {
				conversations: [
					{ id: 1, root: true, entryCount: 2 },
					{ id: 2, root: false, entryCount: 1 },
				],
			};
		}
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve(body),
			text: () => Promise.resolve(String(body)),
		});
	};
	const sources: { url: string; source: StubEventSource }[] = [];
	const createEventSource: EventSourceFactory = (url) => {
		const source = new StubEventSource();
		sources.push({ url, source });
		return source;
	};
	const client = createClient({ fetch: fetchImpl });
	return {
		calls,
		client,
		createEventSource,
		sources,
		setApprovals(next: readonly ApprovalWire[]) {
			approvals = next;
		},
	};
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
	test("boots past the schema gate on a matching schemaVersion and renders the top bar with the meta badges", async () => {
		const { client, createEventSource } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const text = textContent(renderer.toJSON());
		// The TopBar mounts with the meta-fed badges.
		expect(text).toContain("sigrun");
		expect(text).toContain("memory");
		expect(text).toContain("backup: unconfigured");
		// The shell renders beneath it; the boot-time default selection picks
		// the root conversation, so the transcript area is live (not the
		// no-selection placeholder).
		expect(text).not.toContain("Select or create a conversation");
		expect(
			renderer.root.findAllByProps({ className: "top-bar" }),
		).toHaveLength(1);
	});

	test("a schemaVersion mismatch REFUSES to render (fail loud, spec §5)", async () => {
		const { client, createEventSource } = makeHarness({
			meta: makeMeta({ schemaVersion: "0".repeat(64) }),
		});
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("schema");
		expect(text).toContain(PINNED_SCHEMA_VERSION.slice(0, 12));
		// The shell does NOT render behind the refusal.
		expect(
			renderer.root.findAllByProps({ className: "session-list" }),
		).toHaveLength(0);
		expect(
			renderer.root.findAllByProps({ className: "composer" }),
		).toHaveLength(0);
	});

	test("a meta fetch failure refuses to render (unverifiable schema is a mismatch-class failure)", async () => {
		const { client, createEventSource } = makeHarness({ metaFails: true });
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("schema");
		expect(
			renderer.root.findAllByProps({ className: "session-list" }),
		).toHaveLength(0);
	});

	test("composes sidebar + chat center + workspace right panel + composer slot; the boot-time default selects the root conversation and opens its stream", async () => {
		const { client, createEventSource, sources } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		const text = textContent(renderer.toJSON());
		// Sidebar conversations rendered.
		expect(text).toContain("#1");
		expect(text).toContain("#2");
		// The boot-time default selection picked the root conversation (id 1)
		// and opened its stream — the composer is live without a click.
		expect(text).not.toContain("Select or create a conversation");
		const composer = renderer.root.findByProps({
			className: "composer-slot",
		});
		expect(composer.findAllByProps({ className: "composer" })).toHaveLength(
			1,
		);
		expect(sources.map((s) => s.url)).toEqual(["/v1/conversations/1/stream"]);
	});

	test("selecting a conversation drives the view hook and renders the transcript + the workspace browser", async () => {
		const { calls, client, createEventSource, sources } = makeHarness();
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		// The boot default selected the root (id 1) and opened its stream.
		expect(sources.map((s) => s.url)).toEqual(["/v1/conversations/1/stream"]);
		await clickByClass(renderer, "session-select", "#2");
		expect(sources.map((s) => s.url)).toEqual([
			"/v1/conversations/1/stream",
			"/v1/conversations/2/stream",
		]);
		// sources[1] is conversation 2's stream (sources[0] is the boot-selected root).
		act(() => {
			sources[1]?.source.emit(
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
		// The right-panel browser listed conversation 2's workspace root.
		expect(calls.map((c) => c.input)).toContain(
			"/v1/conversations/2/files?path=.",
		);
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

	// THE T22 P1 DIVERGENCE (pinned): approval cards are sourced from the
	// `GET /v1/conversations/:id/approvals` ENDPOINT (which evaluates the
	// gating join server-side), refreshed per view frame — NEVER from the
	// view's `docs["pi.live"].tools` slots. pi-durable marks not-yet-started
	// calls `pending` regardless of gating, so a slot-derived card would
	// render for an UNGATED tool and 404 on click. These two tests pin both
	// halves: the endpoint drives the card; the slots do not.
	test("a pending approval from listApprovals renders a card; a frame that empties the endpoint clears it", async () => {
		const { client, createEventSource, sources, setApprovals } =
			makeHarness({
				approvals: [
					{
						callId: "call-1",
						toolName: "bash",
						status: "pending",
						arguments: { command: "echo hi" },
					},
				],
			});
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		await clickByClass(renderer, "session-select", "#1");
		// First frame: the approval strip refetches and renders the card.
		await act(async () => {
			sources[0]?.source.emit("view", JSON.stringify(makeView({ id: 1 })));
		});
		expect(
			renderer.root.findAllByProps({ className: "approval-card" }),
		).toHaveLength(1);
		// A decision landed server-side; the next frame refetches an empty
		// list and the card clears.
		setApprovals([]);
		await act(async () => {
			sources[0]?.source.emit("view", JSON.stringify(makeView({ id: 1 })));
		});
		expect(
			renderer.root.findAllByProps({ className: "approval-card" }),
		).toHaveLength(0);
	});

	test("a pending TOOL SLOT in the view does NOT render a card (the slot-derived path is wrong)", async () => {
		const { client, createEventSource, sources } = makeHarness(); // endpoint: empty
		const renderer = await renderAsync(
			<App client={client} createEventSource={createEventSource} />,
		);
		await clickByClass(renderer, "session-select", "#1");
		// The frame carries a pending tool slot (an ungated queued call —
		// pi-durable marks not-yet-started calls pending regardless of
		// gating) but the approvals ENDPOINT is empty: no card may render.
		const viewWithPendingSlot = makeView({
			id: 1,
			docs: {
				"pi.live": {
					tools: [
						{ callId: "call-9", name: "bash", status: "pending" },
					],
				},
			},
		});
		await act(async () => {
			sources[0]?.source.emit(
				"view",
				JSON.stringify(viewWithPendingSlot),
			);
		});
		expect(
			renderer.root.findAllByProps({ className: "approval-card" }),
		).toHaveLength(0);
	});
});
