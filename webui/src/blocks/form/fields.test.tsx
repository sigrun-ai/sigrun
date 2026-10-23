/**
 * Secret, file, list and daterange field tests (UI-blocks U1 Task 5,
 * spec §5.6): the secret's status-only render, the file pre-dispatch
 * checks, the list's min/max add-remove-reorder, and daterange presets.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { createElement as h, act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";
import type { FormBlock, JsonObject } from "@sigrun/shared/blocks";
import { findButton, render, textContent } from "../../test-utils";
import { SurfaceActionsContext, SurfaceDataContext } from "../context";
import { FormBlockView } from "./Form";

function harness(
	children: FormBlock["children"],
	data: JsonObject,
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
			SurfaceDataContext.Provider,
			{ value: { data, locale: "en-US" } },
			h(
				SurfaceActionsContext.Provider,
				{
					value: { dispatch, access: "write" as const, viewState: {}, serverErrors: {} },
				},
				h(FormBlockView, { block }),
			),
		),
	);
	return { dispatch, renderer };
}

function inputByLabel(
	renderer: TestRenderer.ReactTestRenderer,
	label: string,
): TestRenderer.ReactTestInstance {
	const input = renderer.root.findAll(
		(node) =>
			(node.type === "input" || node.type === "textarea") &&
			node.props["aria-label"] === label,
	)[0];
	if (input === undefined) throw new Error(`no input labelled ${label}`);
	return input;
}

describe("secret (§5.6/§15)", () => {
	test("never renders a value; shows set (stored)", () => {
		const { renderer } = harness(
			[{ type: "secret", name: "apiKey", label: "API key" }],
			{ f: { apiKey: "stored" } },
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("set (stored)");
		// the input itself is empty — the secret never echoes back
		expect(inputByLabel(renderer, "API key").props.value).toBe("");
	});

	test("shows set (env) and not set from the bound status", () => {
		const env = harness(
			[{ type: "secret", name: "apiKey", label: "API key" }],
			{ f: { apiKey: "env" } },
		);
		expect(textContent(env.renderer.toJSON())).toContain("set (env)");
		const unset = harness(
			[{ type: "secret", name: "apiKey", label: "API key" }],
			{ f: {} },
		);
		expect(textContent(unset.renderer.toJSON())).toContain("not set");
	});

	test("sends only what the user typed", () => {
		const { dispatch, renderer } = harness(
			[{ type: "secret", name: "apiKey", label: "API key" }],
			{ f: { apiKey: "stored" } },
		);
		act(() => {
			inputByLabel(renderer, "API key").props.onChange({
				target: { value: "sk-acme-new" },
			});
		});
		act(() => {
			findButton(renderer, "Save").props.onClick();
		});
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }), {
			values: { apiKey: "sk-acme-new" },
		});
	});
});

describe("file (§5.6)", () => {
	const fileField = {
		type: "file",
		name: "attachment",
		label: "Attachment",
		accept: "image/*",
		maxBytes: 100,
		onUpload: "uploadFile",
	} as const;

	function change(
		renderer: TestRenderer.ReactTestRenderer,
		files: readonly { name: string; size: number; type: string }[],
	): void {
		const input = inputByLabel(renderer, "Attachment");
		act(() => {
			input.props.onChange({ target: { files } });
		});
	}

	test("checks accept before dispatching onUpload", () => {
		const { dispatch, renderer } = harness([fileField as never], { f: {} });
		change(renderer, [{ name: "notes.txt", size: 10, type: "text/plain" }]);
		expect(dispatch).not.toHaveBeenCalled();
		expect(textContent(renderer.toJSON())).toContain("not an accepted type");
	});

	test("checks maxBytes before dispatching onUpload", () => {
		const { dispatch, renderer } = harness([fileField], { f: {} });
		change(renderer, [{ name: "big.png", size: 10_000, type: "image/png" }]);
		expect(dispatch).not.toHaveBeenCalled();
		expect(textContent(renderer.toJSON())).toContain("larger than 100 bytes");
	});

	test("a passing file dispatches onUpload", () => {
		const { dispatch, renderer } = harness([fileField], { f: {} });
		change(renderer, [{ name: "logo.png", size: 50, type: "image/png" }]);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith(
			{ type: "submit", name: "uploadFile", turn: false },
			{
				field: "attachment",
				files: [{ name: "logo.png", size: 50, type: "image/png" }],
			},
		);
	});
});

describe("list (§5.6)", () => {
	const listField = {
		type: "list",
		name: "tags",
		label: "Tags",
		item: { type: "text", name: "tag", label: "Tag" },
		min: 1,
		max: 3,
		reorder: true,
	} as const;

	function tagInput(
		renderer: TestRenderer.ReactTestRenderer,
		index: number,
	): TestRenderer.ReactTestInstance {
		const inputs = renderer.root.findAll(
			(node) => node.type === "input" && node.props["aria-label"] === "Tag",
		);
		const input = inputs[index];
		if (input === undefined) throw new Error(`no tag input ${index}`);
		return input;
	}

	test("add/remove within min/max", () => {
		const { dispatch, renderer } = harness([listField as never], {
			f: { tags: ["alpha"] },
		});
		// at min (1): remove disabled
		expect(findButton(renderer, "Remove").props.disabled).toBe(true);
		// add twice → at max (3), Add disables
		act(() => {
			findButton(renderer, "Add").props.onClick();
		});
		act(() => {
			findButton(renderer, "Add").props.onClick();
		});
		expect(findButton(renderer, "Add").props.disabled).toBe(true);
		expect(
			renderer.root.findAll(
				(node) => node.type === "input" && node.props["aria-label"] === "Tag",
			),
		).toHaveLength(3);
		// remove works above min
		act(() => {
			renderer.root
				.findAllByType("button")
				.filter((button) =>
					(button.children ?? []).some(
						(child) => typeof child === "string" && child === "Remove",
					),
				)[0]
				?.props.onClick();
		});
		expect(
			renderer.root.findAll(
				(node) => node.type === "input" && node.props["aria-label"] === "Tag",
			),
		).toHaveLength(2);
		expect(dispatch).not.toHaveBeenCalled();
	});

	test("reorder moves entries", () => {
		const { dispatch, renderer } = harness(
			[{ ...listField, min: 0 } as never],
			{ f: { tags: ["alpha", "beta"] } },
		);
		act(() => {
			renderer.root
				.findAllByType("button")
				.filter(
					(button) => button.props["aria-label"] === "move entry 1 down",
				)[0]
				?.props.onClick();
		});
		expect(tagInput(renderer, 0).props.value).toBe("beta");
		expect(tagInput(renderer, 1).props.value).toBe("alpha");
		// the submitted values follow the reordered entries
		act(() => {
			findButton(renderer, "Save").props.onClick();
		});
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }), {
			values: { tags: ["beta", "alpha"] },
		});
	});
});

describe("daterange (§5.6)", () => {
	test("a preset fills both dates", () => {
		const { dispatch, renderer } = harness(
			[
				{
					type: "daterange",
					name: "window",
					label: "Window",
					presets: [{ id: "week", label: "Last 7 days", duration: "P7D" }],
				} as never,
			],
			{ f: { window: {} } },
		);
		act(() => {
			findButton(renderer, "Last 7 days").props.onClick();
		});
		const start = inputByLabel(renderer, "Window start").props.value;
		const end = inputByLabel(renderer, "Window end").props.value;
		expect(start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		const days =
			(new Date(end as string).getTime() - new Date(start as string).getTime()) /
			86_400_000;
		expect(days).toBe(7);
		act(() => {
			findButton(renderer, "Save").props.onClick();
		});
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }), {
			values: { window: { start, end } },
		});
	});
});
