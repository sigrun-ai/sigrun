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
import { UserEntry } from "./UserEntry";

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
});
