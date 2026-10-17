/**
 * ModelPicker (B6): the composer toolbar's model pill — a keyboard-operable
 * button + popover list over the §5 catalog. Picking delegates to
 * `onPick` (the composer's `configure` call — failures stay in the
 * composer's error strip, so the component tests assert the delegation
 * only).
 */

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";
import type { ModelEntry } from "../api";
import { render } from "../test-utils";
import { ModelPicker } from "./ModelPicker";

const MODELS: readonly ModelEntry[] = [
	{
		id: "faux/one",
		provider: "faux",
		modelId: "one",
		name: "Faux One",
		contextWindow: 1000,
		maxTokens: 100,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 },
	},
	{
		id: "faux/two",
		provider: "faux",
		modelId: "two",
		name: "Faux Two",
		contextWindow: 4000,
		maxTokens: 400,
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 4, cacheRead: 1, cacheWrite: 1 },
	},
];

function toggleOf(renderer: TestRenderer.ReactTestRenderer) {
	return renderer.root.findByProps({ "data-picker": "model" });
}

function options(renderer: TestRenderer.ReactTestRenderer) {
	return renderer.root.findAllByProps({ role: "option" });
}

describe("ModelPicker", () => {
	test("the §6.1 picker convention: a catalog of one model (or none) renders nothing", () => {
		for (const models of [[], [MODELS[0]!]] as const) {
			const renderer = render(
				<ModelPicker
					models={models}
					current="faux/one"
					disabled={false}
					onPick={() => Promise.resolve()}
				/>,
			);
			expect(renderer.toJSON()).toBeNull();
		}
	});

	test("the toggle names the current model; the popover lists the catalog with the current marked", () => {
		const renderer = render(
			<ModelPicker
				models={MODELS}
				current="faux/one"
				disabled={false}
				onPick={() => Promise.resolve()}
			/>,
		);
		const toggle = toggleOf(renderer);
		expect(toggle.props["aria-haspopup"]).toBe("listbox");
		expect(toggle.props["aria-expanded"]).toBe(false);
		expect(toggle.children.join("")).toContain("Faux One");
		expect(renderer.root.findAllByProps({ role: "option" })).toEqual([]);
		act(() => {
			toggle.props.onClick();
		});
		expect(toggle.props["aria-expanded"]).toBe(true);
		expect(options(renderer).map((o) => o.props["data-model-id"])).toEqual([
			"faux/one",
			"faux/two",
		]);
		expect(
			renderer.root.findByProps({ "data-model-id": "faux/one" }).props[
				"aria-selected"
			],
		).toBe(true);
		expect(
			renderer.root.findByProps({ "data-model-id": "faux/two" }).props[
				"aria-selected"
			],
		).toBe(false);
	});

	test("clicking an item calls onPick(id) and closes the popover", async () => {
		const onPick = vi.fn(() => Promise.resolve());
		const renderer = render(
			<ModelPicker
				models={MODELS}
				current="faux/one"
				disabled={false}
				onPick={onPick}
			/>,
		);
		const toggle = toggleOf(renderer);
		act(() => {
			toggle.props.onClick();
		});
		await act(async () => {
			renderer.root.findByProps({ "data-model-id": "faux/two" }).props.onClick();
		});
		expect(onPick).toHaveBeenCalledWith("faux/two");
		expect(toggle.props["aria-expanded"]).toBe(false);
		expect(options(renderer)).toEqual([]);
	});

	test("keyboard: Enter opens at the current option, arrows move, Enter picks, Escape closes", async () => {
		const onPick = vi.fn(() => Promise.resolve());
		const renderer = render(
			<ModelPicker
				models={MODELS}
				current="faux/one"
				disabled={false}
				onPick={onPick}
			/>,
		);
		const toggle = toggleOf(renderer);
		const key = (k: string): void => {
			toggle.props.onKeyDown({ key: k, preventDefault: () => {} });
		};
		// Closed: Enter opens (the highlight starts ON the current option).
		act(() => {
			key("Enter");
		});
		expect(toggle.props["aria-expanded"]).toBe(true);
		expect(toggle.props["aria-activedescendant"]).toBe("composer-model-option-0");
		// Arrows move the highlight (aria-activedescendant names the option).
		act(() => {
			key("ArrowDown");
		});
		expect(toggle.props["aria-activedescendant"]).toBe("composer-model-option-1");
		act(() => {
			key("ArrowUp");
		});
		expect(toggle.props["aria-activedescendant"]).toBe("composer-model-option-0");
		// Enter picks the highlighted option.
		await act(async () => {
			key("Enter");
		});
		expect(onPick).toHaveBeenCalledWith("faux/one");
		expect(toggle.props["aria-expanded"]).toBe(false);
		// Escape closes without picking.
		act(() => {
			toggle.props.onClick();
		});
		act(() => {
			key("Escape");
		});
		expect(toggle.props["aria-expanded"]).toBe(false);
		expect(onPick).toHaveBeenCalledTimes(1);
	});

	test("disabled blocks the toggle", () => {
		const renderer = render(
			<ModelPicker
				models={MODELS}
				current="faux/one"
				disabled
				onPick={() => Promise.resolve()}
			/>,
		);
		expect(toggleOf(renderer).props.disabled).toBe(true);
	});
});
