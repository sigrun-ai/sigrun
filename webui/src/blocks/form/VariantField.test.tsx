/** Variant fields (settings rework Task 2): switching options keeps only
 *  the selected option's fields in the submitted entry. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { createElement as h, act } from "react";
import type TestRenderer from "react-test-renderer";
import { expect, test, vi } from "vitest";
import type { FormBlock, JsonObject } from "@sigrun/shared/blocks";
import { findButton, render } from "../../test-utils";
import { SurfaceActionsContext, SurfaceDataContext } from "../context";
import { FormBlockView } from "./Form";

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

test("variant switch hides the other option's fields and drops their values", () => {
	const dispatch = vi.fn();
	const block = {
		type: "form",
		bind: "/f",
		mode: "submit",
		onSubmit: "save",
		submitLabel: "Save",
		children: [
			{
				type: "variant",
				name: "connection",
				label: "Connection",
				discriminator: "transport",
				options: [
					{
						id: "http",
						label: "HTTP",
						children: [{ type: "text", name: "url", label: "URL" }],
					},
					{
						id: "stdio",
						label: "Standard I/O",
						children: [{ type: "text", name: "command", label: "Command" }],
					},
				],
			},
		],
	} as FormBlock;
	const data: JsonObject = {
		f: {
			connection: { transport: "http", url: "https://example.invalid" },
		},
	};
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

	const select = renderer.root.findByProps({ "aria-label": "Connection" });
	expect(select.props.value).toBe("http");
	expect(inputByLabel(renderer, "URL").props.value).toBe("https://example.invalid");
	act(() => {
		select.props.onChange({ target: { value: "stdio" } });
	});
	expect(renderer.root.findAllByProps({ "aria-label": "URL" })).toHaveLength(0);
	expect(inputByLabel(renderer, "Command").props.value).toBe("");
	act(() => {
		findButton(renderer, "Save").props.onClick();
	});
	expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "submit" }), {
		rev: 0,
		values: { connection: { transport: "stdio", command: "" } },
	});
});
