/**
 * U0 Task 4 — the typed builders (`src/blocks/builders.ts`, spec §14.1):
 * one builder per block and field, plus `bind(pointer)` and `tree(root)`
 * (`→ {v: BLOCK_SET_VERSION, root}`); the tree BLOCK builder is
 * `treeBlock` to avoid the clash.
 *
 * Builders return plain JSON typed against the shared wire types — there
 * is no runtime besides them. This suite pins the builder semantics
 * against CURRENT SOURCE (`../src/blocks/…`), so a stale `dist/` never
 * masks a builder regression; the HOST-LINK half of this task (the
 * `@sigrun/sigrun` self-link and the `./blocks` exports entry) lives in
 * test/packages.test.ts.
 */

import { describe, expect, test } from "vitest";
import {
	BLOCK_SET_VERSION,
	type CollectionGroup,
	type Tree,
} from "@sigrun/shared/blocks";
import * as builders from "../src/blocks/builders.js";
import {
	bind,
	callout,
	card,
	chart,
	choice,
	collection,
	columns,
	date,
	datetime,
	daterange,
	details,
	diff,
	fields,
	file,
	form,
	grid,
	image,
	list,
	log,
	longtext,
	markdown,
	meter,
	number,
	page,
	section,
	secret,
	stack,
	stat,
	text,
	toggle,
	tree,
	treeBlock,
} from "../src/blocks/builders.js";
import { validateTree } from "../src/blocks/validate.js";

describe("the builder surface (§14.1)", () => {
	test("exports exactly one builder per block and field, plus bind, tree and treeBlock", () => {
		// 18 block builders (the tree block as `treeBlock`) + `card` (the
		// collection item template) + 11 field builders + `bind` + `tree`.
		expect(Object.keys(builders).sort()).toEqual([
			"bind",
			"callout",
			"card",
			"chart",
			"choice",
			"collection",
			"columns",
			"date",
			"daterange",
			"datetime",
			"details",
			"diff",
			"fields",
			"file",
			"form",
			"grid",
			"image",
			"list",
			"log",
			"longtext",
			"markdown",
			"meter",
			"number",
			"page",
			"secret",
			"section",
			"stack",
			"stat",
			"text",
			"toggle",
			"tree",
			"treeBlock",
		]);
		for (const [name, fn] of Object.entries(builders)) {
			expect(typeof fn, name).toBe("function");
		}
	});

	test("every block builder returns plain JSON stamped with its block type", () => {
		expect(page({ title: "T", main: [] }).type).toBe("page");
		expect(stack({ children: [] }).type).toBe("stack");
		expect(
			columns({ children: [{ block: markdown({ text: "x" }) }] }).type,
		).toBe("columns");
		expect(grid({ minItemWidth: "m", children: [] }).type).toBe("grid");
		expect(section({ children: [] }).type).toBe("section");
		expect(markdown({ text: "x" }).type).toBe("markdown");
		expect(fields({ rows: [] }).type).toBe("fields");
		expect(stat({ label: "L", value: 1 }).type).toBe("stat");
		expect(callout({ tone: "info", title: "T" }).type).toBe("callout");
		expect(image({ src: "https://cdn.example.invalid/a.png", alt: "a" }).type).toBe(
			"image",
		);
		expect(
			chart({
				x: { kind: "time" },
				series: [{ name: "s", kind: "line", data: bind("/series") }],
			}).type,
		).toBe("chart");
		expect(meter({ value: 0.5 }).type).toBe("meter");
		expect(log({ lines: bind("/logs") }).type).toBe("log");
		expect(treeBlock({ nodes: bind("/nodes") }).type).toBe("tree");
		expect(diff({ before: "a", after: "b" }).type).toBe("diff");
		expect(details({ value: { k: 1 } }).type).toBe("details");
		expect(
			collection({
				items: bind("/items"),
				item: card({ title: "t" }),
				display: "list",
			}).type,
		).toBe("collection");
		expect(
			form({ id: "f", bind: "/form", mode: "submit", children: [] }).type,
		).toBe("form");
	});

	test("every field builder returns plain JSON stamped with its field type", () => {
		expect(text({ name: "a", label: "A" }).type).toBe("text");
		expect(longtext({ name: "a", label: "A" }).type).toBe("longtext");
		expect(number({ name: "a", label: "A" }).type).toBe("number");
		expect(toggle({ name: "a", label: "A" }).type).toBe("toggle");
		expect(choice({ name: "a", label: "A", options: [] }).type).toBe("choice");
		expect(date({ name: "a", label: "A" }).type).toBe("date");
		expect(datetime({ name: "a", label: "A" }).type).toBe("datetime");
		expect(daterange({ name: "a", label: "A" }).type).toBe("daterange");
		expect(secret({ name: "a", label: "A" }).type).toBe("secret");
		expect(file({ name: "a", label: "A", onUpload: "upload" }).type).toBe("file");
		expect(
			list({ name: "a", label: "A", item: text({ name: "b", label: "B" }) })
				.type,
		).toBe("list");
	});

	test("bind wraps a pointer; tree stamps the server's block-set version", () => {
		expect(bind("/cards")).toEqual({ $: "/cards" });
		expect(tree(markdown({ text: "x" }))).toEqual({
			v: BLOCK_SET_VERSION,
			root: { type: "markdown", text: "x" },
		});
	});

	test("builders carry props verbatim and inject no keys of their own", () => {
		const built = stat({ label: "CPU", value: 0.42, format: "percent", tone: "good" });
		expect(built).toEqual({
			type: "stat",
			label: "CPU",
			value: 0.42,
			format: "percent",
			tone: "good",
		});
		expect(Object.keys(built).sort()).toEqual([
			"format",
			"label",
			"tone",
			"type",
			"value",
		]);
	});
});

describe("builders against validateTree (§14.1 + §14.2)", () => {
	test("tree(page(...)) deep-equals the hand-written JSON and validates in view", () => {
		const built = tree(page({ title: "T", main: [markdown({ text: "x" })] }));
		const handWritten: Tree = {
			v: BLOCK_SET_VERSION,
			root: { type: "page", title: "T", main: [{ type: "markdown", text: "x" }] },
		};
		expect(built).toEqual(handWritten);
		expect(validateTree(built, { placement: "view" })).toEqual({
			ok: true,
			tree: handWritten,
		});
	});

	test("the §14.1 board example validates in view with its handler declared", () => {
		// The spec's example, with `groups` as a literal (§14.1's
		// `bind("./assignee")` person form adapted to the wire shape: a
		// card `person` meta is `{user, name}`, never a bare binding).
		const lanes: readonly CollectionGroup[] = [
			{ id: "todo", title: "To do" },
			{ id: "doing", title: "In progress" },
			{ id: "done", title: "Done" },
		];
		const board = tree(
			page({
				title: "Board",
				main: [
					collection({
						id: "cards",
						items: bind("/cards"),
						display: "lanes",
						groupBy: "status",
						groups: lanes,
						reorder: { within: true, across: true },
						onMove: "move",
						item: card({
							title: bind("./title"),
							meta: [
								{
									person: {
										user: bind("./assignee"),
										name: bind("./assigneeName"),
									},
								},
							],
						}),
					}),
				],
			}),
		);
		expect(
			validateTree(board, { placement: "view", handlers: new Set(["move"]) }).ok,
		).toBe(true);
		// The handler-name contract stays loud: the same tree with no
		// declared `move` handler fails (§6.1).
		expect(
			validateTree(board, { placement: "view", handlers: new Set([]) }).ok,
		).toBe(false);
	});

	test("field builders compose into a settings form that validates", () => {
		const settings = tree(
			form({
				id: "preferences",
				bind: "/preferences",
				mode: "submit",
				children: [
					text({ name: "displayName", label: "Display name", required: true }),
					choice({
						name: "theme",
						label: "Theme",
						options: [
							{ id: "system", label: "System" },
							{ id: "dark", label: "Dark" },
						],
					}),
					toggle({ name: "beta", label: "Beta features" }),
					list({
						name: "shortcuts",
						label: "Shortcuts",
						item: text({ name: "key", label: "Key" }),
					}),
				],
			}),
		);
		expect(validateTree(settings, { placement: "settings" }).ok).toBe(true);
	});

	test("treeBlock (the tree BLOCK builder) validates inside a view page", () => {
		const built = tree(
			page({
				title: "Files",
				main: [
					treeBlock({ id: "files", nodes: bind("/files"), onExpand: "expand" }),
				],
			}),
		);
		expect(
			validateTree(built, { placement: "view", handlers: new Set(["expand"]) })
				.ok,
		).toBe(true);
	});
});
