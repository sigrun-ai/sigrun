/**
 * Markdown (B5, UI refresh + UI-blocks U1 Task 1): the shared markdown
 * renderer — GFM tables become filterable (the filter bar appears once
 * data rows pass TABLE_FILTER_MIN_ROWS; filtering is a case-insensitive
 * substring over row text and the bar counts `<visible> of <total>
 * rows`), fenced code renders with its language in a header and a Copy
 * button, links open in a new tab with rel="noreferrer", and the two
 * variants ("prose" serif / "bubble" sans) carry their own stacks.
 *
 * UI-blocks U1 (spec §15) adds the explicit link allowlist: the shared
 * `safeUrlTransform` passes `https:`, `http:` and `mailto:` through and
 * returns `""` for every other scheme, applied by BOTH the chat
 * `Markdown` renderer and the block renderer — a `tel:` or
 * `javascript:` link renders its text without the anchor.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { render, stubClipboard, textContent } from "../test-utils";
import { Markdown, safeUrlTransform, TABLE_FILTER_MIN_ROWS } from "./Markdown";

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

// ─── safeUrlTransform (spec §15) ─────────────────────────────────────────

describe("safeUrlTransform", () => {
	test("allows https, http and mailto", () => {
		expect(safeUrlTransform("https://example.invalid/x")).toBe(
			"https://example.invalid/x",
		);
		expect(safeUrlTransform("http://example.invalid/x")).toBe(
			"http://example.invalid/x",
		);
		expect(safeUrlTransform("mailto:support@example.invalid")).toBe(
			"mailto:support@example.invalid",
		);
	});

	test("returns the empty string for every other scheme", () => {
		expect(safeUrlTransform("tel:123")).toBe("");
		expect(safeUrlTransform("javascript:x")).toBe("");
		expect(safeUrlTransform("irc://example.invalid/#acme")).toBe("");
		expect(safeUrlTransform("data:text/html;base64,eHg=")).toBe("");
		expect(safeUrlTransform("vbscript:msgbox")).toBe("");
	});

	test("relative and protocol-relative URLs are not allowed", () => {
		expect(safeUrlTransform("//example.invalid/x")).toBe("");
		expect(safeUrlTransform("/v1/something")).toBe("");
	});

	test("whitespace and control characters cannot smuggle a scheme", () => {
		expect(safeUrlTransform(" javascript:x")).toBe("");
		expect(safeUrlTransform("java\tscript:x")).toBe("");
		// A leading control is whitespace to a browser (WHATWG strips it),
		// not a smuggle — the cleaned https URL is what would load.
		expect(safeUrlTransform("\nhttps://example.invalid/x")).toBe(
			"https://example.invalid/x",
		);
	});
});

describe("Markdown: safe links", () => {
	test("tel: and javascript: links render as text, not anchors", () => {
		const renderer = render(
			h(Markdown, {
				source: "call [tel:123](tel:123) or [javascript:x](javascript:x)",
				variant: "prose",
			}),
		);
		expect(renderer.root.findAllByType("a")).toHaveLength(0);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("tel:123");
		expect(text).toContain("javascript:x");
		renderer.unmount();
	});

	test("https links keep opening in a new tab with rel=noreferrer", () => {
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

	test("autolinks and images follow the same allowlist", () => {
		const renderer = render(
			h(Markdown, {
				source: "<tel:123> and ![x](javascript:x)",
				variant: "prose",
			}),
		);
		expect(renderer.root.findAllByType("a")).toHaveLength(0);
		expect(renderer.root.findAllByType("img")).toHaveLength(0);
		renderer.unmount();
	});

	test("an allowed mailto autolink renders an anchor", () => {
		const renderer = render(
			h(Markdown, {
				source: "<mailto:support@example.invalid>",
				variant: "prose",
			}),
		);
		const link = renderer.root.findByType("a");
		expect(link.props.href).toBe("mailto:support@example.invalid");
		renderer.unmount();
	});

	test("raw HTML stays escaped", () => {
		const renderer = render(
			h(Markdown, {
				source: '<img src=x onerror="alert(1)">',
				variant: "prose",
			}),
		);
		expect(renderer.root.findAllByType("img")).toHaveLength(0);
		expect(textContent(renderer.toJSON())).toContain("onerror");
		renderer.unmount();
	});
});

// ─── the renderer's own behaviours (B5, unchanged) ────────────────────────

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

describe("Markdown: variants and emphasis", () => {
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

	test("an ordinary paragraph renders unchanged", () => {
		const renderer = render(
			h(Markdown, { source: "plain acme text", variant: "bubble" }),
		);
		expect(textContent(renderer.toJSON())).toContain("plain acme text");
		act(() => {
			renderer.unmount();
		});
	});
});
