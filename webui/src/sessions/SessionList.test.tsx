/**
 * SessionList (Task 23a) against a stub fetch: conversations render with
 * their meta (pinned first, archived dimmed) and the new / switch / archive
 * actions hit the right §5 endpoints. The client is the REAL `createClient`
 * over the stub fetch so the tests also cover the wire paths.
 */

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test } from "vitest";
import {
	createClient,
	type ConversationMeta,
	type FetchLike,
} from "../api";
import { renderAsync } from "../test-utils";
import { SessionList } from "./SessionList";

type Call = { input: string; method?: string; body?: string };

/** A stub fetch routing by path prefix; handlers may mutate their fixtures. */
function makeFetch(routes: Record<string, (call: Call) => unknown>): {
	calls: Call[];
	fetchImpl: FetchLike;
} {
	const calls: Call[] = [];
	const fetchImpl: FetchLike = (input, init) => {
		const call: Call = { input, method: init?.method, body: init?.body };
		calls.push(call);
		for (const [prefix, handler] of Object.entries(routes)) {
			if (input.startsWith(prefix)) {
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => Promise.resolve(handler(call)),
				});
			}
		}
		return Promise.resolve({
			ok: false,
			status: 404,
			json: () => Promise.resolve({ error: "no route" }),
		});
	};
	return { calls, fetchImpl };
}

const META_DEFAULTS = {
	pinned: false,
	tagged: false,
	archived: false,
	draft: false,
	source: "webui",
} satisfies Partial<ConversationMeta>;

function makeHarness() {
	const conversations = [
		{ id: 1, root: true, entryCount: 3 },
		{ id: 2, root: false, entryCount: 5 },
		{ id: 3, root: false, entryCount: 1 },
	];
	const metas: Record<number, ConversationMeta> = {
		1: { ...META_DEFAULTS },
		2: { ...META_DEFAULTS, pinned: true },
		3: { ...META_DEFAULTS, archived: true },
	};
	const { calls, fetchImpl } = makeFetch({
		// Meta route MUST precede the list route (prefix matching).
		"/v1/conversations/": (call) => {
			const metaMatch = /^\/v1\/conversations\/(\d+)\/meta$/.exec(call.input);
			if (metaMatch !== null) {
				if (call.method === "PATCH") {
					const id = Number(metaMatch[1]);
					const patch = JSON.parse(call.body ?? "{}") as Record<
						string,
						unknown
					>;
					metas[id] = { ...metas[id], ...patch } as ConversationMeta;
					return {};
				}
				return metas[Number(metaMatch[1])];
			}
			throw new Error(`unexpected path ${call.input}`);
		},
		"/v1/conversations": (call) => {
			if (call.method === "POST") {
				const created = { id: 4, root: false, entryCount: 0 };
				conversations.push(created);
				metas[4] = { ...META_DEFAULTS };
				return { id: 4 };
			}
			return { conversations };
		},
	});
	const client = createClient({ fetch: fetchImpl });
	const selected: number[] = [];
	const props = {
		client,
		activeId: null as number | null,
		onSelect: (id: number) => selected.push(id),
	};
	return { calls, conversations, metas, props, selected };
}

async function click(instance: TestRenderer.ReactTestInstance): Promise<void> {
	await act(async () => {
		await (instance.props as { onClick: () => unknown }).onClick();
	});
}

describe("SessionList", () => {
	test("renders conversations with meta: pinned first, archived dimmed", async () => {
		const { props } = makeHarness();
		const renderer = await renderAsync(<SessionList {...props} />);
		const items = renderer.root.findAllByType("li");
		expect(items.map((li) => li.props.className as string)).toEqual([
			"session-item",
			"session-item",
			"session-item session-item-archived",
		]);
		// Pinned (#2) sorts first; the rest keep server order.
		const labels = items.map((li) =>
			(li.children[0] as TestRenderer.ReactTestInstance).children.join(""),
		);
		expect(labels[0]).toContain("#2");
		expect(labels[0]).toContain("pinned");
		expect(labels[1]).toContain("#1");
		expect(labels[2]).toContain("#3");
		expect(labels[2]).toContain("archived");
	});

	test("marks the active conversation", async () => {
		const { props } = makeHarness();
		const renderer = await renderAsync(
			<SessionList {...props} activeId={1} />,
		);
		const items = renderer.root.findAllByType("li");
		const active = items.filter((li) =>
			(li.props.className as string).includes("session-item-active"),
		);
		expect(active).toHaveLength(1);
		const activeLabel = active[0]
		?.findByProps({ className: "session-select" })
		.children.join("");
		expect(activeLabel).toContain("#1");
	});

	test("switch: clicking a conversation calls onSelect with its id", async () => {
		const { props, selected } = makeHarness();
		const renderer = await renderAsync(<SessionList {...props} />);
		const buttons = renderer.root.findAllByProps({
			className: "session-select",
		});
		await click(buttons[1]!); // #1 (pinned #2 sorts first)
		expect(selected).toEqual([1]);
	});

	test("archive: PATCHes { archived: true } and re-renders dimmed", async () => {
		const { calls, props } = makeHarness();
		const renderer = await renderAsync(<SessionList {...props} />);
		const archiveButtons = renderer.root.findAllByProps({
			className: "session-archive",
		});
		// #3 is already archived (no archive button); two buttons remain.
		expect(archiveButtons).toHaveLength(2);
		await click(archiveButtons[0]!); // archive #2 (pinned, first row)
		const patch = calls.find(
			(call) =>
				call.method === "PATCH" && call.input === "/v1/conversations/2/meta",
		);
		expect(patch?.body).toBe(JSON.stringify({ archived: true }));
		const items = renderer.root.findAllByType("li");
		// After the merge, #2 is archived AND pinned (pinned still first).
		expect(items[0]?.props.className).toBe(
			"session-item session-item-archived",
		);
	});

	test("new: POSTs /v1/conversations, reloads, selects the new id", async () => {
		const { calls, props, selected } = makeHarness();
		const renderer = await renderAsync(<SessionList {...props} />);
		const newButton = renderer.root.findByProps({
			className: "session-new",
		});
		await click(newButton);
		const post = calls.find(
			(call) => call.method === "POST" && call.input === "/v1/conversations",
		);
		expect(post).toBeDefined();
		expect(selected).toEqual([4]);
		const labels = renderer.root
			.findAllByProps({ className: "session-select" })
			.map((button) => button.children.join(""));
		expect(labels.some((label) => label.includes("#4"))).toBe(true);
	});
});
