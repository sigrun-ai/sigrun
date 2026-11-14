/**
 * Choice field tests (UI-blocks U1 Task 5, spec §5.6): value shapes
 * (id; ids; {other: text}; ids plus {other} last), the preview layout
 * (beside at regular+, below at compact), and the allowOther row.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { createElement as h, act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";
import type { FormBlock, JsonObject } from "@sigrun/shared/blocks";
import { findButton, instanceText, render, textContent } from "../../test-utils";
import { SurfaceActionsContext, SurfaceDataContext } from "../context";
import { WidthContext } from "../width";
import { FormBlockView } from "./Form";

function harness(
	children: FormBlock["children"],
	init?: {
		readonly data?: JsonObject;
		readonly compact?: boolean;
	},
): {
	dispatch: ReturnType<typeof vi.fn>;
	renderer: TestRenderer.ReactTestRenderer;
} {
	const dispatch = vi.fn();
	const block = {
		type: "form",
		bind: "/f",
		mode: "submit",
		onSubmit: "save",
		submitLabel: "Save",
		children,
	} as FormBlock;
	const renderer = render(
		h(
			WidthContext.Provider,
			{ value: { widthClass: init?.compact === true ? "compact" : "regular", rem: init?.compact === true ? 20 : 50 } },
			h(
				SurfaceDataContext.Provider,
				{ value: { data: init?.data ?? {}, locale: "en-US" } },
				h(
					SurfaceActionsContext.Provider,
					{
						value: { dispatch, access: "write" as const, viewState: {}, serverErrors: {} },
					},
					h(FormBlockView, { block }),
				),
			),
		),
	);
	return { dispatch, renderer };
}

const OPTIONS = [
	{ id: "a", label: "Alpha", description: "The first", preview: "**Alpha** preview" },
	{ id: "b", label: "Beta", preview: "**Beta** preview text" },
	{ id: "c", label: "Gamma" },
] as const;

function clickOption(
	renderer: TestRenderer.ReactTestRenderer,
	id: string,
): void {
	const input = renderer.root.findAll(
		(node) => node.type === "input" && node.props.value === id,
	)[0];
	if (input === undefined) throw new Error(`no option ${id}`);
	act(() => {
		input.props.onChange({ target: { value: id, checked: true } });
	});
}

function submit(renderer: TestRenderer.ReactTestRenderer): void {
	act(() => {
		findButton(renderer, "Save").props.onClick();
	});
}

describe("choice: presentation", () => {
	test("dropdown presentation renders a combobox", () => {
		const { renderer } = harness([
			{
				type: "choice",
				name: "model",
				label: "Model",
				options: [
					{ id: "acme/alpha", label: "Alpha" },
					{ id: "acme/beta", label: "Beta" },
				],
				presentation: "dropdown",
			},
		]);
		expect(renderer.root.findAllByType("select")).toHaveLength(0);
		expect(
			renderer.root.findAll(
				(node) => node.type === "input" && node.props.role === "combobox",
			),
		).toHaveLength(1);
		expect(
			renderer.root.findAll(
				(node) => node.type === "input" && node.props.type === "radio",
			),
		).toHaveLength(0);
	});

	test("a dropdown renders its bound placeholder in the combobox", () => {
		const { renderer } = harness([
			{
				type: "choice",
				name: "model",
				label: "Chat model",
				options: [{ id: "acme/default", label: "A different model" }],
				presentation: "dropdown",
				placeholder: { $: "/systemDefault" },
			},
		], { data: { systemDefault: "System default (acme/runtime-default)" } });
		const combobox = renderer.root.findAll(
			(node) => node.type === "input" && node.props.role === "combobox",
		)[0];
		expect(combobox?.props.placeholder).toBe("System default (acme/runtime-default)");
	});

	test("multi choice ignores dropdown presentation", () => {
		const { renderer } = harness([
			{
				type: "choice",
				name: "models",
				label: "Models",
				options: [
					{ id: "acme/alpha", label: "Alpha" },
					{ id: "acme/beta", label: "Beta" },
				],
				multi: true,
				presentation: "dropdown",
			},
		]);
		expect(renderer.root.findAllByType("select")).toHaveLength(0);
		expect(
			renderer.root.findAll(
				(node) => node.type === "input" && node.props.type === "checkbox",
			),
		).toHaveLength(2);
	});
});

describe("choice: value shapes (§5.6)", () => {
	test("single: the selected id", () => {
		const { dispatch, renderer } = harness([
			{ type: "choice", name: "pick", label: "Pick", options: [...OPTIONS] },
		]);
		clickOption(renderer, "b");
		submit(renderer);
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ type: "submit" }),
			{ rev: 0, values: { pick: "b" } },
		);
	});

	test("multi: the ids", () => {
		const { dispatch, renderer } = harness([
			{ type: "choice", name: "pick", label: "Pick", options: [...OPTIONS], multi: true },
		]);
		clickOption(renderer, "a");
		clickOption(renderer, "c");
		submit(renderer);
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }), {
			rev: 0,
			values: { pick: ["a", "c"] },
		});
	});

	test("allowOther single: {other: text}", () => {
		const { dispatch, renderer } = harness([
			{ type: "choice", name: "pick", label: "Pick", options: [...OPTIONS], allowOther: {} },
		]);
		const other = renderer.root.findAll(
			(node) => node.type === "input" && node.props["aria-label"] === "Pick other text",
		)[0];
		act(() => {
			other.props.onChange({ target: { value: "something else" } });
		});
		submit(renderer);
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }), {
			rev: 0,
			values: { pick: { other: "something else" } },
		});
	});

	test("allowOther multi: ids plus {other} last", () => {
		const { dispatch, renderer } = harness([
			{ type: "choice", name: "pick", label: "Pick", options: [...OPTIONS], multi: true, allowOther: {} },
		]);
		clickOption(renderer, "a");
		const other = renderer.root.findAll(
			(node) => node.type === "input" && node.props["aria-label"] === "Pick other text",
		)[0];
		act(() => {
			other.props.onChange({ target: { value: "extra" } });
		});
		submit(renderer);
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }), {
			rev: 0,
			values: { pick: ["a", { other: "extra" }] },
		});
	});

	test('a dropdown without a placeholder has an empty combobox placeholder', () => {
		const { renderer } = harness([
			{
				type: "choice",
				name: "model",
				label: "Chat model",
				options: [{ id: "acme/default", label: "A different model" }],
				presentation: "dropdown",
			},
		]);
		const combobox = renderer.root.findAll(
			(node) => node.type === "input" && node.props.role === "combobox",
		)[0];
		expect(combobox?.props.placeholder).toBe("");
	});

	test('the allowOther row carries the "Type something" placeholder', () => {
		const { renderer } = harness([
			{ type: "choice", name: "pick", label: "Pick", options: [...OPTIONS], allowOther: {} },
		]);
		const other = renderer.root.findAll(
			(node) => node.type === "input" && node.props["aria-label"] === "Pick other text",
		)[0];
		expect(other.props.placeholder).toBe("Type something");
	});

	test('allowOther multi never submits a whitespace-only other', () => {
		const { dispatch, renderer } = harness([
			{ type: "choice", name: "pick", label: "Pick", options: [...OPTIONS], multi: true, allowOther: {} },
		]);
		clickOption(renderer, "a");
		const other = renderer.root.findAll(
			(node) => node.type === "input" && node.props["aria-label"] === "Pick other text",
		)[0];
		act(() => {
			other.props.onChange({ target: { value: "   " } });
		});
		submit(renderer);
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }), {
			rev: 0,
			values: { pick: ["a"] },
		});
	});
});

describe("choice: combobox", () => {
	const SEARCH_OPTIONS = [
		{ id: "ollama-cloud/glm-5.3-flash", label: "GLM 5.3 Flash (Ollama Cloud)" },
		{ id: "inferhub-openai/glm-5.3", label: "GLM 5.3 (InferHub)" },
		{ id: "pareto/glm-5.3-flash", label: "GLM 5.3 Flash (Pareto)" },
	];

	function combobox(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
		const input = renderer.root.findAll(
			(node) => node.type === "input" && node.props.role === "combobox",
		)[0];
		if (input === undefined) throw new Error("no combobox");
		return input;
	}

	function typeText(renderer: TestRenderer.ReactTestRenderer, text: string): void {
		act(() => {
			combobox(renderer).props.onChange({ target: { value: text } });
		});
	}

	function optionTexts(renderer: TestRenderer.ReactTestRenderer): string[] {
		return renderer.root
			.findAll((node) => node.type === "li" && node.props.role === "option")
			.map((option) => instanceText(option));
	}

	function keyDown(renderer: TestRenderer.ReactTestRenderer, key: string): void {
		act(() => {
			combobox(renderer).props.onKeyDown({
				key,
				preventDefault: () => {},
			});
		});
	}

	test("typing filters by every term over label or id", () => {
		const { renderer } = harness([
			{
				type: "choice",
				name: "model",
				label: "Model",
				options: SEARCH_OPTIONS,
				presentation: "dropdown",
			},
		]);

		typeText(renderer, "ollama flash");
		expect(optionTexts(renderer)).toEqual(["GLM 5.3 Flash (Ollama Cloud)"]);

		typeText(renderer, "glm-5.3-flash");
		expect(optionTexts(renderer)).toHaveLength(2);

		typeText(renderer, "PARETO");
		expect(optionTexts(renderer)).toEqual(["GLM 5.3 Flash (Pareto)"]);

		typeText(renderer, "zzz");
		expect(optionTexts(renderer)).toHaveLength(0);
	});

	test("Enter picks the highlighted option", () => {
		const { dispatch, renderer } = harness([
			{
				type: "choice",
				name: "model",
				label: "Model",
				options: SEARCH_OPTIONS,
				presentation: "dropdown",
			},
		]);

		typeText(renderer, "ollama flash");
		keyDown(renderer, "ArrowDown");
		keyDown(renderer, "Enter");
		submit(renderer);
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ type: "submit" }),
			{ rev: 0, values: { model: "ollama-cloud/glm-5.3-flash" } },
		);
	});

	test("multi keeps chips and removes on chip click", () => {
		const { dispatch, renderer } = harness([
			{
				type: "choice",
				name: "models",
				label: "Models",
				options: [
					{ id: "acme/a", label: "Alpha" },
					{ id: "acme/b", label: "Beta" },
					{ id: "acme/c", label: "Gamma" },
					{ id: "acme/d", label: "Delta" },
					{ id: "acme/e", label: "Epsilon" },
					{ id: "acme/f", label: "Zeta" },
				],
				multi: true,
			},
		]);

		// Type to filter and select via Enter.
		typeText(renderer, "Alpha");
		keyDown(renderer, "ArrowDown");
		keyDown(renderer, "Enter");

		// A chip should appear and the list should stay open.
		expect(renderer.root.findAllByProps({ className: "blk-combobox-chip" }).length).toBe(1);
		expect(optionTexts(renderer).length).toBeGreaterThan(0);

		// Select another option.
		typeText(renderer, "Beta");
		keyDown(renderer, "ArrowDown");
		keyDown(renderer, "Enter");

		submit(renderer);
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ type: "submit" }),
			{ rev: 0, values: { models: ["acme/a", "acme/b"] } },
		);
	});

	test("allowOther offers Use text and submits {other}", () => {
		const { dispatch, renderer } = harness([
			{
				type: "choice",
				name: "model",
				label: "Model",
				options: [
					{ id: "acme/alpha", label: "Alpha" },
					{ id: "acme/beta", label: "Beta" },
				],
				presentation: "dropdown",
				allowOther: { label: "Custom model" },
			},
		]);

		typeText(renderer, "custom/model");
		const useOption = renderer.root.findAll(
			(node) => node.type === "li" && node.props.role === "option" && instanceText(node).includes("Use"),
		);
		expect(useOption.length).toBe(1);
		expect(instanceText(useOption[0]!)).toContain("custom/model");

		keyDown(renderer, "ArrowDown");
		keyDown(renderer, "Enter");
		submit(renderer);
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ type: "submit" }),
			{ rev: 0, values: { model: { other: "custom/model" } } },
		);
	});
});

describe("choice: preview layout (§5.6/§12.3)", () => {
	test("preview markdown shows BESIDE the options at regular width", () => {
		const { renderer } = harness([
			{ type: "choice", name: "pick", label: "Pick", options: [...OPTIONS] },
		]);
		const input = renderer.root.findAll(
			(node) => node.type === "input" && node.props.value === "b",
		)[0];
		act(() => {
			input.props.onFocus();
		});
		const preview = renderer.root.findByProps({ "data-layout": "beside" });
		expect(preview).toBeDefined();
		expect(textContent(renderer.toJSON())).toContain("Beta");
	});

	test("preview markdown shows BELOW the options at compact width", () => {
		const { renderer } = harness(
			[{ type: "choice", name: "pick", label: "Pick", options: [...OPTIONS] }],
			{ compact: true },
		);
		const input = renderer.root.findAll(
			(node) => node.type === "input" && node.props.value === "b",
		)[0];
		act(() => {
			input.props.onFocus();
		});
		expect(renderer.root.findByProps({ "data-layout": "below" })).toBeDefined();
	});
});
