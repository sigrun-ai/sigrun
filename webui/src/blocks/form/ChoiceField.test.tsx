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
import { findButton, render, textContent } from "../../test-utils";
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

describe("choice: value shapes (§5.6)", () => {
	test("single: the selected id", () => {
		const { dispatch, renderer } = harness([
			{ type: "choice", name: "pick", label: "Pick", options: [...OPTIONS] },
		]);
		clickOption(renderer, "b");
		submit(renderer);
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ type: "submit" }),
			{ values: { pick: "b" } },
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
			values: { pick: ["a", { other: "extra" }] },
		});
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
