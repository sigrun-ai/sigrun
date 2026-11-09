/**
 * Entries fields (settings rework Task 2): summary rows, in-place forms,
 * table identity and duplicate keys, and write-only nested secrets.
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
		(node) => node.type === "input" && node.props["aria-label"] === label,
	)[0];
	if (input === undefined) throw new Error(`no input labelled ${label}`);
	return input;
}

function changeInput(
	renderer: TestRenderer.ReactTestRenderer,
	label: string,
	value: string,
): void {
	act(() => {
		inputByLabel(renderer, label).props.onChange({ target: { value } });
	});
}

function clickButton(renderer: TestRenderer.ReactTestRenderer, label: string): void {
	const button = label.startsWith("Edit entry ")
		? renderer.root.findAllByType("button").find(
			(candidate) => candidate.props["aria-label"] === label,
		)
		: findButton(renderer, label);
	if (button === undefined) throw new Error(`no button labelled ${label}`);
	act(() => {
		button.props.onClick();
	});
}

function entryButton(
	renderer: TestRenderer.ReactTestRenderer,
	label: string,
	action: string,
): TestRenderer.ReactTestInstance {
	const button = renderer.root.findAllByType("button").find(
		(candidate) => candidate.props["aria-label"] === `${action} entry ${label}`,
	);
	if (button === undefined) throw new Error(`no ${action} button for ${label}`);
	return button;
}

const tableField = {
	type: "entries",
	name: "servers",
	label: "Servers",
	shape: "table",
	summary: ["url", "token"],
	keyLabel: "Server name",
	item: [
		{ type: "text", name: "url", label: "URL", default: "https://example.invalid" },
		{ type: "secret", name: "token", label: "Token" },
	],
} as const;

describe("entries field", () => {
	test("scalar table rows render and submit their stored value", () => {
		const field = {
			type: "entries",
			name: "thinking",
			label: "Thinking",
			shape: "table",
			summary: ["value"],
			item: [{ type: "choice", name: "value", label: "Level", options: [
				{ id: "low", label: "low" }, { id: "high", label: "high" },
			] }],
		} as const;
		const { dispatch, renderer } = harness([field], {
			f: { thinking: { "acme/model": "low" } },
		});
		expect(textContent(renderer.toJSON())).toContain("low");
		clickButton(renderer, "Edit entry acme/model");
		clickButton(renderer, "Save");
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }), {
			rev: 0,
			values: { thinking: { "acme/model": { value: "low", $from: "acme/model" } } },
		});
	});

	test("row summary shows summary fields and set/not set for secrets", () => {
		const stored = harness([tableField], {
			f: { servers: { alpha: { url: "https://alpha.example.invalid" } } },
			secrets: { "servers/alpha/token": "stored" },
		});
		const summary = textContent(stored.renderer.toJSON());
		expect(summary).toContain("alpha");
		expect(summary).toContain("https://alpha.example.invalid");
		expect(summary).toContain("set");
		expect(summary).not.toContain("stored");

		const unset = harness([tableField], {
			f: { servers: { alpha: { url: "https://alpha.example.invalid" } } },
		});
		expect(textContent(unset.renderer.toJSON())).toContain("not set");
	});

	test("clicking a row opens its form in place; a second click closes it", () => {
		const { renderer } = harness([tableField], {
			f: { servers: { alpha: { url: "https://alpha.example.invalid" } } },
		});
		expect(renderer.root.findAllByProps({ "aria-label": "URL" })).toHaveLength(0);
		clickButton(renderer, "Edit entry alpha");
		expect(inputByLabel(renderer, "URL").props.value).toBe("https://alpha.example.invalid");
		expect(inputByLabel(renderer, "Server name").props.value).toBe("alpha");
		clickButton(renderer, "Edit entry alpha");
		expect(renderer.root.findAllByProps({ "aria-label": "URL" })).toHaveLength(0);
	});

	test("add seeds defaults and opens the new entry", () => {
		const { dispatch, renderer } = harness([tableField], { f: {} });
		clickButton(renderer, "+ Add");
		expect(inputByLabel(renderer, "URL").props.value).toBe("https://example.invalid");
		expect(inputByLabel(renderer, "Server name").props.value).toBe("");
		clickButton(renderer, "Save");
		expect(dispatch).not.toHaveBeenCalled();
		expect(textContent(renderer.toJSON())).toContain("Server name is required");
	});

	test("two unnamed adds leave only the newest entry open", () => {
		const { renderer } = harness([tableField], { f: {} });
		clickButton(renderer, "+ Add");
		clickButton(renderer, "+ Add");
		expect(renderer.root.findAllByProps({ "aria-label": "URL" })).toHaveLength(1);
		expect(renderer.root.findAllByProps({ "aria-label": "Server name" })).toHaveLength(1);
		expect(renderer.root.findAllByProps({ "aria-expanded": true })).toHaveLength(1);
	});

	test("reordering an open array row keeps the same entry form open", () => {
		const arrayField = {
			type: "entries",
			name: "servers",
			label: "Servers",
			shape: "array",
			key: "name",
			summary: ["name"],
			reorder: true,
			item: [{ type: "text", name: "name", label: "Name" }],
		} as const;
		const { dispatch, renderer } = harness([arrayField], {
			f: { servers: [{ name: "alpha" }, { name: "beta" }] },
		});
		clickButton(renderer, "Edit entry alpha");
		expect(inputByLabel(renderer, "Name").props.value).toBe("alpha");
		const move = renderer.root.findAllByType("button").find(
			(button) => button.props["aria-label"] === "move entry 1 down",
		);
		if (move === undefined) throw new Error("no move-down button");
		act(() => {
			move.props.onClick();
		});
		expect(inputByLabel(renderer, "Name").props.value).toBe("alpha");
		changeInput(renderer, "Name", "alpha-renamed");
		clickButton(renderer, "Save");
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }), {
			rev: 0,
			values: {
				servers: [
					{ $from: "beta", name: "beta" },
					{ $from: "alpha", name: "alpha-renamed" },
				],
			},
		});
	});

	test("duplicate in a table suffixes -copy and drops $from", () => {
		const { dispatch, renderer } = harness([tableField], {
			f: { servers: { alpha: { url: "https://alpha.example.invalid" } } },
		});
		act(() => {
			entryButton(renderer, "alpha", "Duplicate").props.onClick();
		});
		clickButton(renderer, "Save");
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }), {
			rev: 0,
			values: {
				servers: {
					alpha: { $from: "alpha", url: "https://alpha.example.invalid", token: "" },
					"alpha-copy": { url: "https://alpha.example.invalid", token: "" },
				},
			},
		});
	});

	test("renaming a table entry keeps $from = old name", () => {
		const { dispatch, renderer } = harness([tableField], {
			f: { servers: { alpha: { url: "https://alpha.example.invalid" } } },
		});
		clickButton(renderer, "Edit entry alpha");
		changeInput(renderer, "Server name", "beta");
		clickButton(renderer, "Save");
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }), {
			rev: 0,
			values: {
				servers: {
					beta: { $from: "alpha", url: "https://alpha.example.invalid", token: "" },
				},
			},
		});
	});

	test("duplicate table key is a field error and blocks submit", () => {
		const { dispatch, renderer } = harness([tableField], {
			f: {
				servers: {
					alpha: { url: "https://alpha.example.invalid" },
					beta: { url: "https://beta.example.invalid" },
				},
			},
		});
		clickButton(renderer, "Edit entry beta");
		changeInput(renderer, "Server name", "alpha");
		clickButton(renderer, "Save");
		expect(dispatch).not.toHaveBeenCalled();
		expect(textContent(renderer.toJSON())).toContain("Server name must be unique");
	});

	test("a secret field inside an entry clears with an explicit action (submits null), never by emptying the input", () => {
		const { dispatch, renderer } = harness([tableField], {
			f: { servers: { alpha: { url: "https://alpha.example.invalid" } } },
			secrets: { "servers/alpha/token": "stored" },
		});
		clickButton(renderer, "Edit entry alpha");
		changeInput(renderer, "Token", "");
		clickButton(renderer, "Save");
		expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "submit" }), {
			rev: 0,
			values: {
				servers: { alpha: { $from: "alpha", url: "https://alpha.example.invalid", token: "" } },
			},
		});

		clickButton(renderer, "Clear Token");
		clickButton(renderer, "Save");
		expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "submit" }), {
			rev: 0,
			values: {
				servers: { alpha: { $from: "alpha", url: "https://alpha.example.invalid", token: null } },
			},
		});
	});
});
