/**
 * MessageActions (B4, UI refresh): the quiet per-turn action row — Copy
 * (clipboard write, label flips to "Copied" for 1.5 s), Edit (user turns
 * only), Fork from here, and the assistant's right-aligned meta label.
 * Buttons are real focusable buttons (hover-only VISIBILITY, never
 * hover-only reachability).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { findButton, render, stubClipboard } from "../test-utils";
import { MessageActions } from "./MessageActions";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("MessageActions", () => {
	test("user turns render Copy, Edit, and Fork from here", () => {
		const renderer = render(
			h(MessageActions, {
				kind: "user",
				text: "hello",
				onFork: () => {},
				onEdit: () => {},
			}),
		);
		expect(findButton(renderer, "Copy")).toBeDefined();
		expect(findButton(renderer, "Edit")).toBeDefined();
		expect(findButton(renderer, "Fork from here")).toBeDefined();
		renderer.unmount();
	});

	test("assistant turns render Copy and Fork from here, never Edit", () => {
		const renderer = render(
			h(MessageActions, {
				kind: "assistant",
				text: "hi",
				onFork: () => {},
				onEdit: () => {},
			}),
		);
		expect(findButton(renderer, "Copy")).toBeDefined();
		expect(findButton(renderer, "Fork from here")).toBeDefined();
		const edits = renderer.root
			.findAllByType("button")
			.filter((button) =>
				(button.children ?? []).some(
					(child) => typeof child === "string" && child === "Edit",
				),
			);
		expect(edits).toHaveLength(0);
		renderer.unmount();
	});

	test("the meta label renders when known, absent otherwise", () => {
		const withMeta = render(
			h(MessageActions, {
				kind: "assistant",
				text: "hi",
				onFork: () => {},
				meta: "faux/m1 · 120 tokens",
			}),
		);
		expect(
			withMeta.root.findByProps({ className: "message-meta" }).children,
		).toEqual(["faux/m1 · 120 tokens"]);
		withMeta.unmount();
		const withoutMeta = render(
			h(MessageActions, { kind: "assistant", text: "hi", onFork: () => {} }),
		);
		expect(
			withoutMeta.root.findAllByProps({ className: "message-meta" }),
		).toHaveLength(0);
		withoutMeta.unmount();
	});

	test("Copy writes the text and flips its label to Copied for 1.5 s", () => {
		vi.useFakeTimers();
		const writeText = stubClipboard();
		const renderer = render(
			h(MessageActions, {
				kind: "assistant",
				text: "The root has `bin` and `etc`.",
				onFork: () => {},
			}),
		);
		act(() => {
			findButton(renderer, "Copy").props.onClick();
		});
		expect(writeText).toHaveBeenCalledWith("The root has `bin` and `etc`.");
		expect(findButton(renderer, "Copied")).toBeDefined();
		act(() => {
			vi.advanceTimersByTime(1500);
		});
		expect(findButton(renderer, "Copy")).toBeDefined();
		renderer.unmount();
	});

	test("Edit and Fork from here call their handlers", () => {
		const onFork = vi.fn();
		const onEdit = vi.fn();
		const renderer = render(
			h(MessageActions, {
				kind: "user",
				text: "hello",
				onFork,
				onEdit,
			}),
		);
		act(() => {
			findButton(renderer, "Fork from here").props.onClick();
		});
		expect(onFork).toHaveBeenCalledTimes(1);
		act(() => {
			findButton(renderer, "Edit").props.onClick();
		});
		expect(onEdit).toHaveBeenCalledTimes(1);
		renderer.unmount();
	});
});
