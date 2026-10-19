/**
 * SessionList (B3, UI refresh): the grouped, searchable, fork-nested
 * conversation sidebar. Rows arrive pre-loaded (`rows` — App owns the
 * list via useConversationList), so these are pure-prop renders: group
 * order against a stubbed clock (fake timers freeze `new Date()`), fork
 * nesting with the ↳ lineage mark, search keeping a match's ANCESTORS
 * visible, the 200-char-name single-line contract, the archived toggle,
 * and the per-row ⋯ menu (Rename / Fork / Archive / Unarchive) plus the
 * Ctrl+K / ⌘K search focus (a stubbed window + document — the suite runs
 * under react-test-renderer with no DOM).
 *
 * Fixtures are synthetic (tests own their literals); `NOW` is local noon
 * so calendar-day grouping survives any runner timezone.
 */

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ConversationSummary } from "../api";
import { render } from "../test-utils";
import { SESSION_SEARCH_INPUT_ID, SessionList } from "./SessionList";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const NOW = new Date(2026, 9, 17, 12, 0, 0); // local noon, Oct 17 2026
const ago = (span: number): string =>
	new Date(NOW.getTime() - span).toISOString();

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

function makeProps(
	rows: readonly ConversationSummary[],
	init?: { readonly activeId?: number | null },
) {
	return {
		rows,
		activeId: init?.activeId ?? null,
		onSelect: vi.fn(),
		onNew: vi.fn(),
		onRename: vi.fn(async () => {}),
		onArchive: vi.fn(async () => {}),
		onFork: vi.fn(),
	};
}

type Props = ReturnType<typeof makeProps>;

/** The rendered conversation rows (`<li data-conversation-id>`), in order. */
function conversationItems(
	renderer: TestRenderer.ReactTestRenderer,
): TestRenderer.ReactTestInstance[] {
	return renderer.root
		.findAllByType("li")
		.filter((li) => li.props["data-conversation-id"] !== undefined);
}

function rowIds(renderer: TestRenderer.ReactTestRenderer): number[] {
	return conversationItems(renderer).map(
		(li) => li.props["data-conversation-id"] as number,
	);
}

function rowById(
	renderer: TestRenderer.ReactTestRenderer,
	id: number,
): TestRenderer.ReactTestInstance {
	const row = conversationItems(renderer).find(
		(li) => li.props["data-conversation-id"] === id,
	);
	if (row === undefined) throw new Error(`no sidebar row ${id}`);
	return row;
}

async function click(
	node: TestRenderer.ReactTestInstance,
): Promise<void> {
	await act(async () => {
		await (node.props as { onClick: () => unknown }).onClick();
	});
}

function keyDown(
	node: TestRenderer.ReactTestInstance,
	key: string,
): Promise<void> {
	return act(async () => {
		(node.props as { onKeyDown: (event: { key: string }) => void }).onKeyDown({
			key,
		});
	});
}

/** Drain the microtask queue (promise-chained state updates) inside act. */
async function flush(): Promise<void> {
	await act(async () => {
		for (let hop = 0; hop < 5; hop += 1) await Promise.resolve();
	});
}

/** Type into the search input (the sidebar's filter). */
async function typeSearch(
	renderer: TestRenderer.ReactTestRenderer,
	text: string,
): Promise<void> {
	const input = renderer.root.findByProps({ className: "session-search" });
	await act(async () => {
		(input.props as {
			onChange: (event: { target: { value: string } }) => void;
		}).onChange({ target: { value: text } });
	});
}

describe("SessionList", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	test("groups rows under Pinned / Today / Yesterday / Earlier headings in order", () => {
		const rows = [
			summary({
				id: 5,
				name: "Pinned north road",
				pinned: true,
				lastActivityAt: ago(30 * DAY),
			}),
			summary({
				id: 1,
				name: "Harbor dredging log",
				lastActivityAt: ago(30 * MINUTE),
			}),
			summary({
				id: 2,
				name: "Fog signal check",
				lastActivityAt: ago(18 * HOUR),
			}),
			summary({
				id: 3,
				name: "Heat pump sizing notes",
				lastActivityAt: ago(10 * DAY),
			}),
		];
		const renderer = render(<SessionList {...makeProps(rows)} />);
		const headings = renderer.root.findAllByProps({
			className: "session-group",
		});
		expect(headings.map((h) => h.props["data-age-group"])).toEqual([
			"Pinned",
			"Today",
			"Yesterday",
			"Earlier",
		]);
		expect(headings.map((h) => h.children.join(""))).toEqual([
			"Pinned",
			"Today",
			"Yesterday",
			"Earlier",
		]);
		// Rows render grouped under their heading, newest-first inside it.
		expect(rowIds(renderer)).toEqual([5, 1, 2, 3]);
	});

	test("a fork renders directly under its parent with the ↳ marker", () => {
		const rows = [
			summary({
				id: 1,
				name: "Static site notes",
				lastActivityAt: ago(30 * MINUTE),
			}),
			summary({
				id: 2,
				name: "Static site notes — Hugo deep dive",
				parent: { id: 1, at: 4 },
				lastActivityAt: ago(10 * MINUTE),
			}),
		];
		const renderer = render(<SessionList {...makeProps(rows)} />);
		expect(rowIds(renderer)).toEqual([1, 2]);
		const parent = rowById(renderer, 1);
		const fork = rowById(renderer, 2);
		expect(parent.props["data-depth"]).toBe(0);
		expect(fork.props["data-depth"]).toBe(1);
		// The lineage mark is real content (CSS ::before would not be).
		expect(fork.findAllByProps({ className: "session-fork-mark" })).toHaveLength(1);
		expect(parent.findAllByProps({ className: "session-fork-mark" })).toHaveLength(0);
	});

	test("search filters by displayName case-insensitively and keeps a match's ancestors", async () => {
		const rows = [
			summary({
				id: 1,
				name: "Static site notes",
				lastActivityAt: ago(30 * MINUTE),
			}),
			summary({
				id: 2,
				name: "Static site notes — Hugo deep dive",
				parent: { id: 1, at: 4 },
				lastActivityAt: ago(10 * MINUTE),
			}),
			summary({
				id: 3,
				name: "Paris weather",
				lastActivityAt: ago(3 * HOUR),
			}),
		];
		const renderer = render(<SessionList {...makeProps(rows)} />);
		await typeSearch(renderer, "hugo");
		// The matching fork AND its parent stay; the unrelated row goes.
		expect(rowIds(renderer)).toEqual([1, 2]);
		// Case-insensitive: uppercase still matches.
		await typeSearch(renderer, "HUGO");
		expect(rowIds(renderer)).toEqual([1, 2]);
		// No matches at all renders the quiet empty line.
		await typeSearch(renderer, "zeppelin");
		expect(rowIds(renderer)).toEqual([]);
		expect(
			renderer.root.findByProps({ className: "session-empty" }).children.join(""),
		).toContain("No matching conversations");
		// Clearing the query restores the full list.
		await typeSearch(renderer, "");
		expect(rowIds(renderer)).toEqual([1, 2, 3]);
	});

	test("a 200-char name renders in ONE ellipsis element; the row's height class is unchanged", () => {
		const long = "n".repeat(200);
		const rows = [
			summary({
				id: 1,
				name: long,
				lastActivityAt: ago(30 * MINUTE),
			}),
		];
		const renderer = render(<SessionList {...makeProps(rows)} />);
		const names = renderer.root.findAllByProps({ className: "session-name" });
		expect(names).toHaveLength(1);
		expect(names[0]!.children.join("")).toBe(long);
		// No long-name modifier class: the row's classes (and so its height)
		// are exactly the standard row's.
		expect(rowById(renderer, 1).props.className).toBe("session-item");
	});

	test("archived rows are hidden until the Archived toggle; then they render dimmed", async () => {
		const rows = [
			summary({
				id: 1,
				name: "Harbor dredging log",
				lastActivityAt: ago(30 * MINUTE),
			}),
			summary({
				id: 2,
				name: "Retired beacon audit",
				archived: true,
				lastActivityAt: ago(2 * HOUR),
			}),
		];
		const renderer = render(<SessionList {...makeProps(rows)} />);
		expect(rowIds(renderer)).toEqual([1]);
		const toggle = renderer.root.findByProps({
			className: "session-archived-toggle",
		});
		expect(toggle.props["aria-pressed"]).toBe(false);
		await click(toggle);
		expect(toggle.props["aria-pressed"]).toBe(true);
		expect(rowIds(renderer)).toEqual([1, 2]);
		expect(rowById(renderer, 2).props.className).toBe(
			"session-item session-item-archived",
		);
	});

	test("each row shows formatAge next to the name plus a focusable ⋯ menu button", () => {
		const rows = [
			summary({
				id: 1,
				name: "Harbor dredging log",
				lastActivityAt: ago(30 * MINUTE),
			}),
			summary({ id: 2, name: "Never used" }),
		];
		const renderer = render(<SessionList {...makeProps(rows)} />);
		const ages = renderer.root.findAllByProps({ className: "session-age" });
		expect(ages).toHaveLength(2);
		expect(ages[0]!.children.join("")).toBe("30m");
		// Never used → no stamp → no age text (formatAge's "" for undefined).
		expect(ages[1]!.children.join("")).toBe("");
		// The menu toggle is a real button on every row (keyboard-reachable;
		// CSS reveals it on hover/focus-within).
		for (const id of [1, 2]) {
			const toggle = rowById(renderer, id).findByProps({
				className: "session-menu-toggle",
			});
			expect(toggle.type).toBe("button");
			expect(toggle.props["aria-haspopup"]).toBe("menu");
		}
	});

	test("the ⋯ menu forwards Rename, Fork, and Archive", async () => {
		const rows = [
			summary({
				id: 1,
				name: "Harbor dredging log",
				lastActivityAt: ago(5 * MINUTE),
			}),
		];
		const props = makeProps(rows);
		const renderer = render(<SessionList {...props} />);
		await click(rowById(renderer, 1).findByProps({ className: "session-menu-toggle" }));
		const menu = renderer.root.findByProps({ className: "session-menu" });
		expect(
			menu
				.findAllByProps({ type: "button" })
				.map((button) => button.props["data-menu-action"]),
		).toEqual(["rename", "fork", "archive"]);
		// Fork forwards the row's id.
		await click(menu.findByProps({ "data-menu-action": "fork" }));
		expect(props.onFork).toHaveBeenCalledWith(1);
		// Archive forwards (id, true) for an unarchived row.
		await click(rowById(renderer, 1).findByProps({ className: "session-menu-toggle" }));
		await click(
			renderer.root
				.findByProps({ className: "session-menu" })
				.findByProps({ "data-menu-action": "archive" }),
		);
		expect(props.onArchive).toHaveBeenCalledWith(1, true);
		// Rename swaps the name for an inline input; Enter commits.
		await click(rowById(renderer, 1).findByProps({ className: "session-menu-toggle" }));
		await click(
			renderer.root
				.findByProps({ className: "session-menu" })
				.findByProps({ "data-menu-action": "rename" }),
		);
		const input = rowById(renderer, 1).findByProps({
			className: "session-rename-input",
		});
		act(() => {
			(input.props as {
				onChange: (event: { target: { value: string } }) => void;
			}).onChange({ target: { value: "Fjord walking routes" } });
		});
		await keyDown(input, "Enter");
		await flush();
		expect(props.onRename).toHaveBeenCalledWith(1, "Fjord walking routes");
		// The input closed once the rename resolved.
		expect(
			renderer.root.findAllByProps({ className: "session-rename-input" }),
		).toHaveLength(0);
	});

	test("the ⋯ menu's Share… is owner-only and forwards the row id (spec §5.9)", async () => {
		const rows = [
			summary({ id: 1, name: "Mine", owner: "alice" }),
			summary({ id: 2, name: "Someone else's", owner: "bob" }),
		];
		const props = {
			...makeProps(rows),
			currentUser: "alice",
			onShare: vi.fn(),
		};
		const renderer = render(<SessionList {...props} />);

		// The owner's row offers Share… FIRST; clicking forwards the id.
		await click(
			rowById(renderer, 1).findByProps({ className: "session-menu-toggle" }),
		);
		const mine = renderer.root.findByProps({ className: "session-menu" });
		expect(
			mine
				.findAllByProps({ type: "button" })
				.map((button) => button.props["data-menu-action"]),
		).toEqual(["share", "rename", "fork", "archive"]);
		await click(mine.findByProps({ "data-menu-action": "share" }));
		expect(props.onShare).toHaveBeenCalledWith(1);

		// A row someone else owns never offers it (the wire would 403 a
		// recipient's sharing patch — the menu must not offer it either).
		await click(
			rowById(renderer, 2).findByProps({ className: "session-menu-toggle" }),
		);
		const theirs = renderer.root.findByProps({ className: "session-menu" });
		expect(
			theirs
				.findAllByProps({ type: "button" })
				.map((button) => button.props["data-menu-action"]),
		).toEqual(["rename", "fork", "archive"]);
	});

	test("an archived row's menu offers Unarchive and forwards (id, false)", async () => {
		const rows = [
			summary({ id: 2, name: "Retired beacon audit", archived: true }),
		];
		const props = makeProps(rows);
		const renderer = render(<SessionList {...props} />);
		await click(
			renderer.root.findByProps({ className: "session-archived-toggle" }),
		);
		await click(
			rowById(renderer, 2).findByProps({ className: "session-menu-toggle" }),
		);
		const menu = renderer.root.findByProps({ className: "session-menu" });
		expect(menu.findByProps({ "data-menu-action": "archive" }).children.join("")).toBe(
			"Unarchive",
		);
		await click(menu.findByProps({ "data-menu-action": "archive" }));
		expect(props.onArchive).toHaveBeenCalledWith(2, false);
	});

	test("rename Esc cancels without calling onRename", async () => {
		const rows = [summary({ id: 1, name: "Harbor dredging log" })];
		const props = makeProps(rows);
		const renderer = render(<SessionList {...props} />);
		await click(
			rowById(renderer, 1).findByProps({ className: "session-menu-toggle" }),
		);
		await click(
			renderer.root
				.findByProps({ className: "session-menu" })
				.findByProps({ "data-menu-action": "rename" }),
		);
		const input = rowById(renderer, 1).findByProps({
			className: "session-rename-input",
		});
		act(() => {
			(input.props as {
				onChange: (event: { target: { value: string } }) => void;
			}).onChange({ target: { value: "discarded" } });
		});
		await keyDown(input, "Escape");
		expect(props.onRename).not.toHaveBeenCalled();
		expect(
			renderer.root.findAllByProps({ className: "session-rename-input" }),
		).toHaveLength(0);
	});

	test("clicking a row selects it; the active row carries the active class", async () => {
		const rows = [
			summary({ id: 1, name: "Harbor dredging log" }),
			summary({ id: 2, name: "Signal lamp repair" }),
		];
		const props = makeProps(rows, { activeId: 2 });
		const renderer = render(<SessionList {...props} />);
		expect(rowById(renderer, 2).props.className).toBe("session-item session-item-active");
		await click(rowById(renderer, 1).findByProps({ className: "session-select" }));
		expect(props.onSelect).toHaveBeenCalledWith(1);
	});

	test("the new button forwards onNew", async () => {
		const rows = [summary({ id: 1, name: "Harbor dredging log" })];
		const props = makeProps(rows);
		const renderer = render(<SessionList {...props} />);
		await click(renderer.root.findByProps({ className: "session-new" }));
		expect(props.onNew).toHaveBeenCalledTimes(1);
	});

	test("Ctrl+K and ⌘K focus the search input; other keys do not", async () => {
		interface FakeKeyEvent {
			key: string;
			ctrlKey: boolean;
			metaKey: boolean;
			preventDefault(): void;
		}
		const listeners = new Map<string, (event: FakeKeyEvent) => void>();
		const fakeWindow = {
			addEventListener(
				type: string,
				listener: (event: FakeKeyEvent) => void,
			): void {
				listeners.set(type, listener);
			},
			removeEventListener(
				type: string,
				listener: (event: FakeKeyEvent) => void,
			): void {
				if (listeners.get(type) === listener) listeners.delete(type);
			},
		};
		const focus = vi.fn();
		vi.stubGlobal("window", fakeWindow);
		vi.stubGlobal("document", {
			getElementById: (id: string) =>
				id === SESSION_SEARCH_INPUT_ID ? { focus } : null,
		});
		const renderer = render(
			<SessionList {...makeProps([summary({ id: 1, name: "One" })])} />,
		);
		const keydown = listeners.get("keydown");
		expect(keydown).toBeDefined();
		const fired = (init: Partial<FakeKeyEvent>): FakeKeyEvent => ({
			key: "",
			ctrlKey: false,
			metaKey: false,
			preventDefault: vi.fn(),
			...init,
		});
		const ctrlK = fired({ key: "k", ctrlKey: true });
		keydown!(ctrlK);
		expect(focus).toHaveBeenCalledTimes(1);
		expect(ctrlK.preventDefault).toHaveBeenCalledTimes(1);
		keydown!(fired({ key: "k", metaKey: true }));
		expect(focus).toHaveBeenCalledTimes(2);
		keydown!(fired({ key: "j", ctrlKey: true }));
		keydown!(fired({ key: "k" }));
		expect(focus).toHaveBeenCalledTimes(2);
		// Unmount detaches the listener.
		act(() => {
			renderer.unmount();
		});
		expect(listeners.has("keydown")).toBe(false);
	});
});
