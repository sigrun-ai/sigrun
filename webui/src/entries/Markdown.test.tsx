/**
 * Markdown (B5, UI refresh): the shared markdown renderer — GFM tables
 * become filterable (the filter bar appears once data rows pass
 * TABLE_FILTER_MIN_ROWS; filtering is a case-insensitive substring over
 * row text and the bar counts `<visible> of <total> rows`), fenced code
 * renders with its language in a header and a Copy button, links open in
 * a new tab with rel="noreferrer", and the two variants ("prose" serif /
 * "bubble" sans) carry their own stacks.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render, stubClipboard, textContent } from "../test-utils";
import { Markdown, TABLE_FILTER_MIN_ROWS } from "./Markdown";

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A GFM pipe table with `rows` data rows (Zola is row 6). */
function generatorsTable(rows: number): string {
	const body: string[] = [];
	for (let index = 0; index < rows; index += 1) {
		const row = ["Hugo", "Astro", "Eleventy", "Docusaurus", "Jekyll", "Zola"][
			index % 6
		];
		body.push(`| ${row} ${index + 1} | yes |`);
	}
	return `| Generator | i18n |\n| --- | --- |\n${body.join("\n")}`;
}

describe("Markdown: filterable tables", () => {
	test("a 7-row table renders the filter bar; filtering \"zola\" leaves 1 row and \"1 of 7 rows\"", () => {
		const renderer = render(
			h(Markdown, { source: generatorsTable(7), variant: "prose" }),
		);
		expect(
			renderer.root.findAllByProps({ "aria-label": "Filter rows" }),
		).toHaveLength(1);
		act(() => {
			renderer.root.findByProps({ "aria-label": "Filter rows" }).props.onChange(
				{ target: { value: "zola" } },
			);
		});
		const text = textContent(renderer.toJSON());
		expect(text).toContain("1 of 7 rows");
		expect(text).toContain("Zola 6");
		expect(text).not.toContain("Hugo 1");
		// One header row + the one surviving data row.
		expect(renderer.root.findAllByType("tr")).toHaveLength(2);
		renderer.unmount();
	});

	test(`a ${TABLE_FILTER_MIN_ROWS}-row table renders no filter bar (threshold is >)`, () => {
		const renderer = render(
			h(Markdown, { source: generatorsTable(6), variant: "prose" }),
		);
		expect(
			renderer.root.findAllByProps({ "aria-label": "Filter rows" }),
		).toHaveLength(0);
		// Unfiltered: the header row + all 6 data rows.
		expect(renderer.root.findAllByType("tr")).toHaveLength(7);
		renderer.unmount();
	});

	test("an unfiltered 7-row table counts all rows", () => {
		const renderer = render(
			h(Markdown, { source: generatorsTable(7), variant: "prose" }),
		);
		expect(textContent(renderer.toJSON())).toContain("7 of 7 rows");
		renderer.unmount();
	});
});

describe("Markdown: code blocks", () => {
	test("a fenced ts block shows ts in its header and Copy writes the code text", () => {
		const writeText = stubClipboard();
		const renderer = render(
			h(Markdown, { source: "```ts\nconst answer = 42;\n```", variant: "prose" }),
		);
		expect(
			renderer.root.findByProps({ className: "md-code-lang" }).children,
		).toEqual(["ts"]);
		act(() => {
			renderer.root.findByProps({ className: "md-code-copy" }).props.onClick();
		});
		expect(writeText).toHaveBeenCalledWith("const answer = 42;");
		renderer.unmount();
	});

	test("an unlabelled fence falls back to the text language", () => {
		const renderer = render(
			h(Markdown, { source: "```\nplain fence\n```", variant: "prose" }),
		);
		expect(
			renderer.root.findByProps({ className: "md-code-lang" }).children,
		).toEqual(["text"]);
		renderer.unmount();
	});
});

describe("Markdown: variants and links", () => {
	test("emphasis renders real elements — **bold** becomes <strong>", () => {
		const renderer = render(
			h(Markdown, { source: "a **bold** move", variant: "bubble" }),
		);
		const strongs = renderer.root.findAllByType("strong");
		expect(strongs).toHaveLength(1);
		expect(strongs[0]?.children).toEqual(["bold"]);
		renderer.unmount();
	});

	test("the variant rides the wrapper class (prose vs bubble)", () => {
		const prose = render(h(Markdown, { source: "x", variant: "prose" }));
		expect(prose.toJSON()).toMatchObject({
			props: { className: "md md-prose" },
		});
		prose.unmount();
		const bubble = render(h(Markdown, { source: "x", variant: "bubble" }));
		expect(bubble.toJSON()).toMatchObject({
			props: { className: "md md-bubble" },
		});
		bubble.unmount();
	});

	test("links open in a new tab with rel=noreferrer", () => {
		const renderer = render(
			h(Markdown, {
				source: "[docs](https://example.invalid/guide)",
				variant: "prose",
			}),
		);
		const link = renderer.root.findByType("a");
		expect(link.props.href).toBe("https://example.invalid/guide");
		expect(link.props.target).toBe("_blank");
		expect(link.props.rel).toBe("noreferrer");
		renderer.unmount();
	});
});
