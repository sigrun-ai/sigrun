/**
 * ThinkingPicker (B6): the composer toolbar's thinking pill. ALWAYS
 * rendered regardless of the catalog's `reasoning` flag — /v1/models
 * reports `reasoning:false` for models that do think (glm-5.3-flash), so
 * the flag must never gate the control (the design spec's binding ruling).
 */

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";
import { render } from "../test-utils";
import { THINKING_LEVELS, ThinkingPicker } from "./ThinkingPicker";

function toggleOf(renderer: TestRenderer.ReactTestRenderer) {
	return renderer.root.findByProps({ "data-picker": "thinking" });
}

function options(renderer: TestRenderer.ReactTestRenderer) {
	return renderer.root.findAllByProps({ role: "option" });
}

describe("ThinkingPicker", () => {
	test("always renders; with nothing picked this session the label shows the default", () => {
		const renderer = render(
			<ThinkingPicker current={null} onPick={() => Promise.resolve()} />,
		);
		const toggle = toggleOf(renderer);
		expect(toggle.props["aria-haspopup"]).toBe("listbox");
		expect(toggle.children.join("")).toContain("Thinking: default");
	});

	test("the popover lists the levels /thinking accepts, in order, with the current marked", () => {
		const renderer = render(
			<ThinkingPicker current="high" onPick={() => Promise.resolve()} />,
		);
		expect(toggleOf(renderer).children.join("")).toContain("Thinking: high");
		act(() => {
			toggleOf(renderer).props.onClick();
		});
		expect(
			options(renderer).map((o) => o.props["data-thinking-level"]),
		).toEqual([...THINKING_LEVELS]);
		expect(
			renderer.root.findByProps({ "data-thinking-level": "high" }).props[
				"aria-selected"
			],
		).toBe(true);
	});

	test("clicking a level calls onPick(level) and closes the popover", async () => {
		const onPick = vi.fn(() => Promise.resolve());
		const renderer = render(
			<ThinkingPicker current={null} onPick={onPick} />,
		);
		act(() => {
			toggleOf(renderer).props.onClick();
		});
		await act(async () => {
			renderer.root.findByProps({ "data-thinking-level": "medium" }).props.onClick();
		});
		expect(onPick).toHaveBeenCalledWith("medium");
		expect(toggleOf(renderer).props["aria-expanded"]).toBe(false);
		expect(options(renderer)).toEqual([]);
	});

	test("keyboard: Enter opens, arrows move, Enter picks, Escape closes without picking", async () => {
		const onPick = vi.fn(() => Promise.resolve());
		const renderer = render(
			<ThinkingPicker current={null} onPick={onPick} />,
		);
		const toggle = toggleOf(renderer);
		const key = (k: string): void => {
			toggle.props.onKeyDown({ key: k, preventDefault: () => {} });
		};
		act(() => {
			key("Enter");
		});
		expect(toggle.props["aria-expanded"]).toBe(true);
		expect(toggle.props["aria-activedescendant"]).toBe("composer-thinking-option-0");
		act(() => {
			key("ArrowDown");
			key("ArrowDown");
		});
		expect(toggle.props["aria-activedescendant"]).toBe("composer-thinking-option-2");
		await act(async () => {
			key("Enter");
		});
		expect(onPick).toHaveBeenCalledWith(THINKING_LEVELS[2]);
		act(() => {
			toggle.props.onClick();
		});
		act(() => {
			key("Escape");
		});
		expect(toggle.props["aria-expanded"]).toBe(false);
		expect(onPick).toHaveBeenCalledTimes(1);
	});
});
