/**
 * SessionList (Task 23a) against a stub fetch: conversations render with
 * their summary metadata (pinned first, archived dimmed) and the new /
 * switch / archive actions hit the right §5 endpoints. The client is the
 * REAL `createClient` over the stub fetch so the tests also cover the
 * wire paths. UI refresh A1: the summary carries `name`/`archived`/
 * `pinned` — one list request, no per-row meta GET (the archive PATCH
 * stays a meta write).
 */

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test } from "vitest";
import { createClient, type FetchLike } from "../api";
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
					text: () => Promise.resolve(String(handler(call))),
				});
			}
		}
		return Promise.resolve({
			ok: false,
			status: 404,
			json: () => Promise.resolve({ error: "no route" }),
			text: () => Promise.resolve(String({ error: "no route" })),
		});
	};
	return { calls, fetchImpl };
}

/** The stub's mutable summary fixture (the wire shape, minus readonly). */
interface StubSummary {
	id: number;
	root: boolean;
	entryCount: number;
	archived: boolean;
	pinned: boolean;
	name?: string;
}

function makeHarness() {
	const conversations: StubSummary[] = [
		{ id: 1, root: true, entryCount: 3, archived: false, pinned: false },
		{ id: 2, root: false, entryCount: 5, archived: false, pinned: true },
		{ id: 3, root: false, entryCount: 1, archived: true, pinned: false },
	];
	const { calls, fetchImpl } = makeFetch({
		// The meta route (the archive action's PATCH) MUST precede the list
		// route (prefix matching). The archive flip mutates the SUMMARY the
		// list serves — the server-side merge the reload re-reads.
		"/v1/conversations/": (call) => {
			const metaMatch = /^\/v1\/conversations\/(\d+)\/meta$/.exec(call.input);
			if (metaMatch !== null && call.method === "PATCH") {
				const id = Number(metaMatch[1]);
				const patch = JSON.parse(call.body ?? "{}") as Record<
					string,
					unknown
				>;
				const summary = conversations.find((one) => one.id === id);
				if (summary !== undefined && patch.archived === true) {
					summary.archived = true;
				}
				return {};
			}
			throw new Error(`unexpected path ${call.input}`);
		},
		"/v1/conversations": (call) => {
			if (call.method === "POST") {
				const created = {
					id: 4,
					root: false,
					entryCount: 0,
					archived: false,
					pinned: false,
				};
				conversations.push(created);
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
	return { calls, conversations, props, selected };
}

async function click(instance: TestRenderer.ReactTestInstance): Promise<void> {
	await act(async () => {
		await (instance.props as { onClick: () => unknown }).onClick();
	});
}

describe("SessionList", () => {
	test("renders conversations with summary metadata: pinned first, archived dimmed", async () => {
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

	test("a named session renders its name in place of the fallback title", async () => {
		const { conversations, props } = makeHarness();
		// Give #1 a name BEFORE the first load (the stub fetch serves the
		// same mutable array the component's list GET reads).
		const named = conversations.find((one) => one.id === 1);
		named!.name = "Debugging the fork";
		const renderer = await renderAsync(<SessionList {...props} />);
		const labels = renderer.root
			.findAllByProps({ className: "session-select" })
			.map((button) => button.children.join(""));
		// Pinned #2 sorts first, so #1 is the second row: named.
		expect(labels[1]).toContain("Debugging the fork");
		expect(labels[1]).not.toContain("#1");
		// Unnamed sessions render the fallback title as before.
		expect(labels[0]).toContain("#2");
		expect(labels[2]).toContain("#3");
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
