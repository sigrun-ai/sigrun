/**
 * UserEntry (B4, UI refresh): a `pi.user` TURN — the right-aligned bubble
 * (text parts + path markers for uploads) plus the user's MessageActions
 * (Copy / Edit / Fork from here). The turn root carries
 * data-turn-kind="user" + data-entry-id for the outline (B5).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h } from "react";
import { describe, expect, test, vi } from "vitest";
import {
	findButton,
	makeEntry,
	render,
	textContent,
	textMessage,
	userTurnEntry,
} from "../test-utils";
import { MessageActions } from "./MessageActions";
import { UserEntry, userText } from "./UserEntry";

const noop = (): void => {};

describe("UserEntry", () => {
	test("renders the user's text parts as right-aligned bubbles", () => {
		const entry = makeEntry("pi.user", [
			textMessage("user", "first part"),
			textMessage("user", "second message"),
		]);
		const renderer = render(h(UserEntry, { entry, onFork: noop, onEdit: noop }));
		const text = textContent(renderer.toJSON());
		expect(text).toContain("first part");
		expect(text).toContain("second message");
		renderer.unmount();
	});

	test("non-text parts render as path markers alongside the text", () => {
		const entry = makeEntry("pi.user", [
			{
				role: "user",
				content: [
					{ type: "image", path: "uploads/cat.png" },
					{ type: "text", text: "what is this" },
					{ type: "file", path: "uploads/notes.txt" },
				],
			},
		]);
		const renderer = render(h(UserEntry, { entry, onFork: noop, onEdit: noop }));
		const text = textContent(renderer.toJSON());
		expect(text).toContain("uploads/cat.png");
		expect(text).toContain("uploads/notes.txt");
		expect(text).toContain("what is this");
		renderer.unmount();
	});

	test("string content renders as-is", () => {
		const entry = makeEntry("pi.user", [
			{ role: "user", content: "plain string" },
		]);
		const renderer = render(h(UserEntry, { entry, onFork: noop, onEdit: noop }));
		expect(textContent(renderer.toJSON())).toContain("plain string");
		renderer.unmount();
	});

	test("the turn root carries data-turn-kind and data-entry-id", () => {
		const renderer = render(
			h(UserEntry, { entry: userTurnEntry(5, "hi"), onFork: noop, onEdit: noop }),
		);
		expect(renderer.toJSON()).toMatchObject({
			props: {
				className: "turn turn-user",
				"data-turn-kind": "user",
				"data-entry-id": 5,
			},
		});
		renderer.unmount();
	});

	test("user text renders as Markdown: **bold** becomes <strong>", () => {
		const renderer = render(
			h(UserEntry, { entry: userTurnEntry(1, "a **bold** move"), onFork: noop, onEdit: noop }),
		);
		const strongs = renderer.root.findAllByType("strong");
		expect(strongs).toHaveLength(1);
		expect(strongs[0]?.children).toEqual(["bold"]);
		renderer.unmount();
	});

	test("renders MessageActions with Copy, Edit, and Fork from here", () => {
		const onFork = vi.fn();
		const onEdit = vi.fn();
		const renderer = render(
			h(UserEntry, {
				entry: userTurnEntry(1, "hello there"),
				onFork,
				onEdit,
			}),
		);
		const fork = findButton(renderer, "Fork from here");
		act(() => {
			fork.props.onClick();
		});
		expect(onFork).toHaveBeenCalledTimes(1);
		act(() => {
			findButton(renderer, "Edit").props.onClick();
		});
		expect(onEdit).toHaveBeenCalledTimes(1);
		expect(renderer.root.findAllByType(MessageActions)).toHaveLength(1);
		renderer.unmount();
	});

	// ── Task 2c: the expanded-user chip ─────────────────────────────────
	// An expanded submission is ONE entry (kind `sigrun.user.expanded`,
	// `data {typed, command}`, the EXPANDED text on `model`): the bubble
	// shows the TYPED text; a chip names the command and DISCLOSES the
	// expanded text on demand (never by default).

	/** An expanded-user entry fixture: typed `/review concurrency`, admitted
	 *  text "Review with focus: concurrency". */
	function expandedTurnEntry(id = 3) {
		return makeEntry(
			"sigrun.user.expanded",
			[textMessage("user", "Review with focus: concurrency")],
			{
				id,
				data: { typed: "/review concurrency", command: "review" },
			},
		);
	}

	test("an expanded entry shows the TYPED text and the chip; the expanded text stays hidden", () => {
		const renderer = render(
			h(UserEntry, {
				entry: expandedTurnEntry(),
				onFork: noop,
				onEdit: noop,
			}),
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("/review concurrency");
		expect(text).toContain("expanded from /review");
		// The admitted (expanded) text is NOT shown by default — the typed
		// line is the bubble, the rest waits behind the chip.
		expect(text).not.toContain("Review with focus: concurrency");
		renderer.unmount();
	});

	test("clicking the chip reveals the full expanded text; clicking again hides it", () => {
		const renderer = render(
			h(UserEntry, {
				entry: expandedTurnEntry(),
				onFork: noop,
				onEdit: noop,
			}),
		);
		const chip = renderer.root.findByProps({ className: "entry-expanded-chip" });
		expect(chip.props["aria-expanded"]).toBe(false);
		act(() => {
			chip.props.onClick();
		});
		expect(chip.props["aria-expanded"]).toBe(true);
		expect(textContent(renderer.toJSON())).toContain(
			"Review with focus: concurrency",
		);
		act(() => {
			chip.props.onClick();
		});
		expect(textContent(renderer.toJSON())).not.toContain(
			"Review with focus: concurrency",
		);
		renderer.unmount();
	});

	test("userText returns the TYPED text for an expanded entry (Copy/Edit source)", () => {
		// Edit re-sends the COMMAND (the server re-expands), Copy copies what
		// the user wrote — both read userText.
		expect(userText(expandedTurnEntry())).toBe("/review concurrency");
		expect(userText(userTurnEntry(1, "plain"))).toBe("plain");
	});

	test("an expanded entry with attachments keeps their path markers", () => {
		const entry = makeEntry(
			"sigrun.user.expanded",
			[
				{
					role: "user",
					content: [
						{ type: "text", text: "Review with focus: api" },
						{ type: "image", path: "uploads/shot.png" },
					],
				},
			],
			{ data: { typed: "/review api", command: "review" } },
		);
		const renderer = render(
			h(UserEntry, { entry, onFork: noop, onEdit: noop }),
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("/review api");
		expect(text).toContain("uploads/shot.png");
		renderer.unmount();
	});
});
