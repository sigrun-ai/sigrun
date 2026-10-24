/**
 * U0 Task 2 — typebox schemas, `validateTree` with JSON-path errors,
 * placement rules (§5.7), limits (§4.5), and image-source rules (§11.1).
 *
 * The fixtures in `test/fixtures/blocks/` are the gallery corpus (U1/U2
 * reuse them): one valid sample per block, display and field. The matrix
 * tests below derive every placement expectation from `PLACEMENT_RULES`,
 * then pin the table's literal cells so the data cannot drift from
 * spec §5.7.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BLOCK_SET_VERSION,
	ICON_NAMES,
	type Block,
	type JsonObject,
	type Placement,
	type SectionBlock,
	type Tree,
} from "@sigrun/shared/blocks";
import { LIMITS, PLACEMENT_RULES, validateData, validateTree } from "../src/blocks/validate.js";
import type { ValidateResult, ValidationError } from "../src/blocks/validate.js";
import { checkImageSource } from "../src/blocks/images.js";
import { FIXTURES, VALID_PLACEMENTS, fixture } from "./fixtures/blocks/samples.js";

const ALL_PLACEMENTS = VALID_PLACEMENTS;

/** All distinct block types a fixture tree contains (recursively). */
function blockTypes(node: unknown): Set<string> {
	const found = new Set<string>();
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			value.forEach(walk);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const record = value as Record<string, unknown>;
		if (typeof record.type === "string") found.add(record.type);
		Object.values(record).forEach(walk);
	};
	walk(node);
	return found;
}

/** Whether a tree carries a binding anywhere OUTSIDE a collection's
 *  item template (the ambient ruling's line: bindings live in item
 *  templates only). */
function hasNonItemBinding(node: unknown): boolean {
	const walk = (value: unknown, insideItem: boolean): boolean => {
		if (Array.isArray(value)) return value.some((v) => walk(v, insideItem));
		if (typeof value !== "object" || value === null) return false;
		const record = value as Record<string, unknown>;
		if (!insideItem && typeof record.$ === "string") return true;
		return Object.entries(record).some(([key, v]) =>
			walk(v, insideItem || key === "item"),
		);
	};
	return walk(node, false);
}

/** The error list of a failed validation (throws if it passed). */
function errorsOf(
	result: ValidateResult | { ok: true } | { ok: false; errors: ValidationError[] },
): { path: string; message: string }[] {
	if (result.ok) throw new Error("expected validation to fail");
	return result.errors;
}

/** Wrap a block into a minimal single-block tree. */
function treeOf(root: Block): Tree {
	return { v: BLOCK_SET_VERSION, root };
}

// ─── PLACEMENT_RULES: the §5.7 table as data ──────────────────────────────

describe("PLACEMENT_RULES (spec §5.7)", () => {
	it("covers every placement", () => {
		for (const placement of ALL_PLACEMENTS) {
			expect(PLACEMENT_RULES[placement]).toBeDefined();
		}
	});

	it("pins the table's literal cells", () => {
		// page: root, required in view; root without sidebar in panel; nowhere else.
		expect(PLACEMENT_RULES.view.blocks.has("page")).toBe(true);
		expect(PLACEMENT_RULES.view.rootBlock).toBe("page");
		expect(PLACEMENT_RULES.panel.blocks.has("page")).toBe(true);
		expect(PLACEMENT_RULES.panel.rootBlock).toBe("page");
		expect(PLACEMENT_RULES.panel.pageSidebar).toBe(false);
		expect(PLACEMENT_RULES.view.pageSidebar).toBe(true);
		for (const placement of ["settings", "chat", "interaction", "ambient"] as const) {
			expect(PLACEMENT_RULES[placement].blocks.has("page")).toBe(false);
		}

		// layout blocks: view/panel all; settings section only; chat all;
		// interaction stack+section; ambient stack+columns.
		expect(PLACEMENT_RULES.view.blocks.has("columns")).toBe(true);
		expect(PLACEMENT_RULES.view.blocks.has("grid")).toBe(true);
		expect(PLACEMENT_RULES.settings.blocks.has("section")).toBe(true);
		expect(PLACEMENT_RULES.settings.blocks.has("stack")).toBe(false);
		expect(PLACEMENT_RULES.settings.blocks.has("columns")).toBe(false);
		expect(PLACEMENT_RULES.chat.blocks.has("stack")).toBe(true);
		expect(PLACEMENT_RULES.chat.blocks.has("columns")).toBe(true);
		expect(PLACEMENT_RULES.chat.blocks.has("grid")).toBe(true);
		expect(PLACEMENT_RULES.interaction.blocks.has("stack")).toBe(true);
		expect(PLACEMENT_RULES.interaction.blocks.has("section")).toBe(true);
		expect(PLACEMENT_RULES.interaction.blocks.has("columns")).toBe(false);
		expect(PLACEMENT_RULES.ambient.blocks.has("stack")).toBe(true);
		expect(PLACEMENT_RULES.ambient.blocks.has("columns")).toBe(true);
		expect(PLACEMENT_RULES.ambient.blocks.has("section")).toBe(false);

		// content blocks: markdown/fields/callout/diff/details everywhere.
		for (const placement of ALL_PLACEMENTS) {
			for (const type of ["markdown", "fields", "callout", "diff", "details"]) {
				expect(PLACEMENT_RULES[placement].blocks.has(type)).toBe(true);
			}
		}

		// stat/meter/log: everywhere but settings and interaction.
		for (const type of ["stat", "meter", "log"]) {
			for (const placement of ["view", "panel", "chat", "ambient"] as const) {
				expect(PLACEMENT_RULES[placement].blocks.has(type)).toBe(true);
			}
			for (const placement of ["settings", "interaction"] as const) {
				expect(PLACEMENT_RULES[placement].blocks.has(type)).toBe(false);
			}
		}

		// chart/image/tree: view, panel, chat only.
		for (const type of ["chart", "image", "tree"]) {
			for (const placement of ["view", "panel", "chat"] as const) {
				expect(PLACEMENT_RULES[placement].blocks.has(type)).toBe(true);
			}
			for (const placement of ["settings", "interaction", "ambient"] as const) {
				expect(PLACEMENT_RULES[placement].blocks.has(type)).toBe(false);
			}
		}

		// collection: everywhere; display limits in settings/interaction/ambient.
		for (const placement of ALL_PLACEMENTS) {
			expect(PLACEMENT_RULES[placement].blocks.has("collection")).toBe(true);
		}
		expect(PLACEMENT_RULES.settings.collectionDisplays).toEqual(["list", "table"]);
		expect(PLACEMENT_RULES.interaction.collectionDisplays).toEqual(["list"]);
		expect(PLACEMENT_RULES.ambient.collectionDisplays).toEqual(["list"]);

		// form: everywhere but ambient; root-required in settings+interaction.
		expect(PLACEMENT_RULES.ambient.blocks.has("form")).toBe(false);
		for (const placement of ["view", "panel", "settings", "chat", "interaction"] as const) {
			expect(PLACEMENT_RULES[placement].blocks.has("form")).toBe(true);
		}
		expect(PLACEMENT_RULES.settings.rootBlock).toBe("form");
		expect(PLACEMENT_RULES.interaction.rootBlock).toBe("form");

		// fields allowed in forms.
		expect([...PLACEMENT_RULES.view.fields].sort()).toEqual([
			"choice",
			"date",
			"daterange",
			"datetime",
			"file",
			"list",
			"longtext",
			"number",
			"secret",
			"text",
			"toggle",
		]);
		expect(PLACEMENT_RULES.settings.fields.has("file")).toBe(false);
		expect(PLACEMENT_RULES.chat.fields.has("secret")).toBe(false);
		expect([...PLACEMENT_RULES.interaction.fields].sort()).toEqual([
			"choice",
			"longtext",
			"number",
			"secret",
			"text",
			"toggle",
		]);
		expect(PLACEMENT_RULES.ambient.fields.size).toBe(0);
	});
});

// ─── the fixture matrix: every sample × its allowed placements ────────────

describe("the fixture corpus covers the block set", () => {
	it("has a corpus set per placement and one sample per block, display and field", () => {
		for (const dir of ALL_PLACEMENTS) {
			expect(FIXTURES[dir].length, dir).toBeGreaterThan(0);
		}
		// one sample per block type (root type of each view/panel sample)
		const rootTypes = new Set<string>();
		for (const sample of [...FIXTURES.view, ...FIXTURES.chat]) {
			rootTypes.add((sample.tree.root as { type: string }).type);
		}
		for (const type of [
			"page",
			"stack",
			"columns",
			"grid",
			"section",
			"markdown",
			"fields",
			"stat",
			"callout",
			"image",
			"chart",
			"meter",
			"log",
			"tree",
			"diff",
			"details",
			"collection",
			"form",
		]) {
			expect(rootTypes.has(type), `corpus root covers ${type}`).toBe(true);
		}
		// every display (root-level in chat, which allows every display)
		const displays = new Set<string>();
		for (const sample of FIXTURES.chat) {
			const root = sample.tree.root as { type: string; display?: string };
			if (root.type === "collection" && root.display) displays.add(root.display);
		}
		for (const display of ["list", "table", "lanes", "grid", "calendar"]) {
			expect(displays.has(display), `collection display ${display}`).toBe(true);
		}
		// every field type (a text field somewhere in the settings corpus)
		const fieldTypes = new Set<string>();
		const collectFields = (value: unknown): void => {
			if (Array.isArray(value)) {
				value.forEach(collectFields);
				return;
			}
			if (typeof value !== "object" || value === null) return;
			const record = value as Record<string, unknown>;
			if (record.type === "form") {
				const walk = (fields: unknown): void => {
					if (!Array.isArray(fields)) return;
					for (const f of fields) {
						const field = f as { type: string };
						if (field.type === "section") {
							walk((f as { children: unknown[] }).children);
						} else {
							fieldTypes.add(field.type);
						}
					}
				};
				walk(record.children);
			}
			Object.values(record).forEach(collectFields);
		};
		for (const sample of [...FIXTURES.settings, ...FIXTURES.chat]) collectFields(sample.tree);
		for (const field of [
			"text",
			"longtext",
			"number",
			"toggle",
			"choice",
			"date",
			"datetime",
			"daterange",
			"secret",
			"file",
			"list",
		]) {
			expect(fieldTypes.has(field), `field ${field}`).toBe(true);
		}
	});

	it("every fixture file on disk is loaded by the corpus loader", () => {
		const dir = join(import.meta.dirname, "fixtures", "blocks");
		const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
		expect(files.length).toBeGreaterThan(0);
		const loaded = new Set<string>();
		for (const placement of ALL_PLACEMENTS) {
			for (const sample of FIXTURES[placement]) loaded.add(`${sample.name}.json`);
		}
		for (const file of files) {
			expect(loaded.has(file), `${file} missing from the corpus`).toBe(true);
		}
	});
});

describe("fixtures validate for their placements (spec §5.7)", () => {
	for (const dir of ALL_PLACEMENTS) {
		it(`every ${dir} fixture validates in ${dir}`, () => {
			for (const sample of FIXTURES[dir]) {
				const result = validateTree(sample.tree, { placement: dir });
				expect(result.ok, `${sample.name} must validate`).toBe(true);
			}
		});

		it(`every ${dir} fixture also validates in every placement its block types allow`, () => {
			for (const sample of FIXTURES[dir]) {
				const types = blockTypes(sample.tree.root);
				for (const placement of ALL_PLACEMENTS) {
					const allAllowed = [...types].every((type) =>
						PLACEMENT_RULES[placement].blocks.has(type),
					);
					if (!allAllowed) continue;
					// A pinned root shape (page/form) is a §5.7 cell too: a
					// bare-root sample never validates there, whatever its
					// block types. The own-placement loop above covers it.
					const rootType = (sample.tree.root as { type: string }).type;
					if (PLACEMENT_RULES[placement].rootBlock && rootType !== PLACEMENT_RULES[placement].rootBlock) {
						continue;
					}
					// A collection display the placement limits (§5.7's
					// display cells) is part of the same matrix: skip when the
					// sample's root display is outside the allowed set.
					const allowedDisplays = PLACEMENT_RULES[placement].collectionDisplays;
					const rootDisplay = (sample.tree.root as { type: string; display?: string }).display;
					if (allowedDisplays && rootType === "collection" && rootDisplay && !allowedDisplays.includes(rootDisplay)) {
						continue;
					}
					// panel forbids a page root's sidebar (§5.7); ambient's
					// one-line rule needs `ambientPlace` (§9.2) — skip, covered below.
					if (placement === "panel" && rootType === "page" && sample.name === "page-sidebar") continue;
					// The ambient literal-rows ruling (2026-10-24): bindings are OUT
					// of ambient outside item templates (no data document), so a
					// fixture carrying any non-item binding never validates there.
					// Skip that cross-placement cell.
					if (placement === "ambient" && hasNonItemBinding(sample.tree.root)) continue;
					const result = validateTree(sample.tree, { placement });
					expect(
						result.ok,
						`${sample.name} should validate in ${placement} (its block types are allowed there)`,
					).toBe(true);
				}
			}
		});
	}

	it("a fixture with a disallowed block fails with that block's path (matrix-derived)", () => {
		// chart is view/panel/chat only; in interaction it must fail at the
		// chart block's path (spec §5.7's own example).
		const tree = treeOf({
			type: "stack",
			children: [
				{ type: "markdown", text: "x" },
				{ type: "chart", x: { kind: "time" }, series: [] },
				{ type: "markdown", text: "y" },
			],
		});
		const errs = errorsOf(validateTree(tree, { placement: "interaction" }));
		const err = errs.find((e) => e.path === "root.children[1]");
		expect(err).toBeDefined();
		expect(err?.message).toContain("chart");
		expect(err?.message).toContain("not allowed in interaction");
	});

	it("field fixtures fail in placements that reject the field type (matrix-derived)", () => {
		for (const sample of FIXTURES.settings) {
			if (!sample.name.startsWith("field-")) continue;
			const field = ((sample.tree.root as unknown as { children: { type: string }[] }).children[0] ?? { type: "" }).type;
			for (const placement of ALL_PLACEMENTS) {
				if (PLACEMENT_RULES[placement].fields.has(field)) continue;
				const result = validateTree(sample.tree, { placement });
				expect(result.ok, `${sample.name} must fail in ${placement}`).toBe(false);
			}
		}
	});

	it("a settings collection with display lanes fails naming display", () => {
		const tree = treeOf({
			type: "collection",
			id: "c",
			items: { $: "/items" },
			display: "lanes",
			item: { title: { $: "./t" } },
		});
		const errs = errorsOf(validateTree(tree, { placement: "settings" }));
		expect(errs.some((e) => e.path === "root.display")).toBe(true);
	});

	it("a settings form with a file field fails naming the field", () => {
		const tree = treeOf({
			type: "form",
			id: "f",
			bind: "/x",
			mode: "submit",
			children: [
				{ type: "file", name: "logo", label: "Logo", onUpload: "up" },
				{ type: "text", name: "title", label: "Title" },
			],
		});
		const errs = errorsOf(validateTree(tree, { placement: "settings" }));
		const err = errs.find((e) => e.path === "root.children[0]");
		expect(err).toBeDefined();
		expect(err?.message).toContain("file");
		expect(err?.message).toContain("not allowed in settings");
	});

	it("an interaction form rejects file and daterange fields", () => {
		for (const field of [
			{ type: "file", name: "f", label: "F", onUpload: "up" },
			{ type: "daterange", name: "d", label: "D" },
		]) {
			const tree = treeOf({
				type: "form",
				id: "f",
				bind: "/x",
				mode: "submit",
				children: [field as unknown as SectionBlock],
			});
			const errs = errorsOf(validateTree(tree, { placement: "interaction" }));
			const err = errs.find((e) => e.path === "root.children[0]");
			expect(err, field.type).toBeDefined();
			expect(err?.message).toContain(field.type);
			expect(err?.message).toContain("not allowed");
		}
	});

	it("a chat form rejects a secret field", () => {
		const tree = treeOf({
			type: "form",
			id: "f",
			bind: "/x",
			mode: "submit",
			children: [{ type: "secret", name: "s", label: "S" }],
		});
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(
			errs.some((e) => e.path === "root.children[0]" && e.message.includes("not allowed")),
		).toBe(true);
	});

	it("a page in panel may not carry sidebar", () => {
		const tree = fixture("page-sidebar");
		const errs = errorsOf(validateTree(tree, { placement: "panel" }));
		expect(errs.some((e) => e.path === "root.sidebar")).toBe(true);
	});

	it("roots are enforced: settings requires a form root, view a page root", () => {
		const markdownTree = treeOf({ type: "markdown", text: "x" });
		expect(errorsOf(validateTree(markdownTree, { placement: "settings" })).length).toBeGreaterThan(0);
		expect(errorsOf(validateTree(markdownTree, { placement: "view" })).length).toBeGreaterThan(0);
		expect(validateTree(markdownTree, { placement: "chat" }).ok).toBe(true);
		const formTree = treeOf({
			type: "form",
			id: "f",
			bind: "/x",
			mode: "submit",
			children: [{ type: "text", name: "a", label: "A" }],
		});
		expect(validateTree(formTree, { placement: "settings" }).ok).toBe(true);
		expect(validateTree(formTree, { placement: "interaction" }).ok).toBe(true);
	});
});

// ─── schema-level rejections with paths ───────────────────────────────────

describe("schema errors carry paths", () => {
	it("rejects an unknown block type at its path", () => {
		const tree = { v: 1, root: { type: "carousel" } };
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(errs.some((e) => e.path === "root.type")).toBe(true);
	});

	it("rejects a missing required prop with its path", () => {
		const tree = treeOf({ type: "markdown" } as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(errs.some((e) => e.path === "root" && e.message.includes("text"))).toBe(true);
	});

	it("rejects a wrong prop type at its path", () => {
		const tree = treeOf({ type: "markdown", text: 3 } as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(errs.some((e) => e.path === "root.text")).toBe(true);
	});

	it("rejects a bad tone at its path", () => {
		const tree = treeOf({ type: "callout", tone: "shiny", title: "T" } as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(errs.some((e) => e.path === "root.tone")).toBe(true);
	});

	it("an unknown icon name errors at the icon prop", () => {
		// view surfaces root at `page` (§5.7); a bare stat root is not a
		// valid view tree, so nest the stat under a page's `main`.
		const page = treeOf({
			type: "page",
			title: "T",
			main: [{ type: "stat", label: "L", value: 1, icon: "sparkles" } as unknown as Block],
		});
		const errs = errorsOf(validateTree(page, { placement: "view" }));
		expect(errs.some((e) => e.path === "root.main[0].icon" && e.message.includes("icon"))).toBe(true);
		const okTree = treeOf({ type: "stat", label: "L", value: 1, icon: "chart" });
		expect(validateTree(okTree, { placement: "chat" }).ok).toBe(true);
		expect(ICON_NAMES).toContain("chart");
	});

	it("visibleAt accepts only atLeast:regular", () => {
		const tree = treeOf({
			type: "markdown",
			text: "x",
			visibleAt: "atLeast:wide",
		} as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(errs.some((e) => e.path === "root.visibleAt")).toBe(true);
		const ok = treeOf({ type: "markdown", text: "x", visibleAt: "atLeast:regular" });
		expect(validateTree(ok, { placement: "chat" }).ok).toBe(true);
	});

	it("formats accept currency:<ISO> and the fixed set", () => {
		// view roots at `page` (§5.7); chat takes a bare stat root.
		const bad = treeOf({ type: "stat", label: "L", value: 1, format: "monies" } as unknown as Block);
		expect(errorsOf(validateTree(bad, { placement: "chat" })).some((e) => e.path === "root.format")).toBe(true);
		const ok = treeOf({ type: "stat", label: "L", value: 1, format: "currency:EUR" });
		expect(validateTree(ok, { placement: "chat" }).ok).toBe(true);
	});
});

// ─── structural checks the schema cannot express ──────────────────────────

describe("structural props are literals (spec §4.2)", () => {
	it("display must be a literal", () => {
		const tree = treeOf({
			type: "collection",
			id: "c",
			items: { $: "/items" },
			display: { $: "/v" },
			item: { title: { $: "./t" } },
		} as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "view" }));
		const err = errs.find((e) => e.path === "root.display");
		expect(err?.message).toContain("display must be a literal");
	});

	it("groups must be literals", () => {
		const tree = treeOf({
			type: "collection",
			id: "c",
			items: { $: "/items" },
			display: "lanes",
			groupBy: "state",
			groups: { $: "/g" },
			item: { title: { $: "./t" } },
		} as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "view" }));
		expect(errs.some((e) => e.path === "root.groups")).toBe(true);
	});

	it("reorder must be a literal object", () => {
		const tree = treeOf({
			type: "collection",
			id: "c",
			items: { $: "/items" },
			display: "list",
			reorder: { $: "/r" },
			onMove: "m",
			item: { title: { $: "./t" } },
		} as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "view" }));
		expect(errs.some((e) => e.path === "root.reorder")).toBe(true);
	});

	it("mode must be a literal", () => {
		const tree = treeOf({
			type: "form",
			id: "f",
			bind: "/x",
			mode: { $: "/mode" },
			children: [],
		} as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(errs.some((e) => e.path === "root.mode")).toBe(true);
	});

	it("field names must be literals", () => {
		const tree = treeOf({
			type: "form",
			id: "f",
			bind: "/x",
			mode: "submit",
			children: [{ type: "text", name: { $: "/n" }, label: "L" }],
		} as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(errs.some((e) => e.path === "root.children[0].name")).toBe(true);
	});

	it("columns must be literals", () => {
		const tree = treeOf({
			type: "collection",
			id: "c",
			items: { $: "/items" },
			display: "table",
			columns: { $: "/cols" },
			item: { title: { $: "./t" } },
		} as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "view" }));
		expect(errs.some((e) => e.path === "root.columns")).toBe(true);
	});

	it("handler names must be literals", () => {
		const tree = treeOf({
			type: "collection",
			id: "c",
			items: { $: "/items" },
			display: "list",
			reorder: { within: true },
			onMove: { $: "/h" },
			item: { title: { $: "./t" } },
		} as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "view" }));
		expect(errs.some((e) => e.path === "root.onMove")).toBe(true);
	});
});

describe("relative bindings only inside item templates (spec §4.2)", () => {
	it("{$: './title'} at the root is rejected with its path", () => {
		const tree = treeOf({ type: "markdown", text: { $: "./title" } } as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(errs.some((e) => e.path === "root.text.$" && e.message.includes("./"))).toBe(true);
	});

	it("{$: './x'} inside a non-collection block (stat) is rejected", () => {
		const tree = treeOf({ type: "stat", label: "L", value: { $: "./v" } } as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "view" }));
		expect(errs.some((e) => e.path === "root.value.$")).toBe(true);
	});

	it("{$: './x'} inside a card template is fine", () => {
		const tree = treeOf({
			type: "collection",
			id: "c",
			items: { $: "/items" },
			display: "list",
			item: { title: { $: "./t" } },
		});
		expect(validateTree(tree, { placement: "chat" }).ok).toBe(true);
	});

	it("{$: './x'} in a bulk-action form is still outside an item template", () => {
		const tree = treeOf({
			type: "collection",
			id: "c",
			items: { $: "/items" },
			display: "table",
			bulkActions: [
				{
					id: "b",
					label: "B",
					onSubmit: "do",
					form: {
						v: 1,
						root: {
							type: "form",
							id: "bf",
							bind: "/bulk",
							mode: "submit",
							onSubmit: "do",
							children: [{ type: "text", name: "q", label: "Q", placeholder: { $: "./p" } }],
						},
					},
				},
			],
			item: { title: { $: "./t" } },
		});
		const errs = errorsOf(validateTree(tree, { placement: "view" }));
		expect(errs.some((e) => e.path === "root.bulkActions[0].form.root.children[0].placeholder.$")).toBe(
			true,
		);
	});

	it("a collection bulkActions form inside a view page validates clean (nested form ≠ surface root)", () => {
		// review finding 1: the root-block constraint must not re-apply to
		// the nested bulk-action form (view pins `page`, but the form lives
		// inside the page's main, where a `form` block is legal)
		const tree = treeOf({
			type: "page",
			title: "Jobs",
			main: [
				{
					type: "collection",
					id: "rows",
					items: { $: "/rows" },
					display: "table",
					bulkActions: [
						{
							id: "set-state",
							label: "Set state",
							onSubmit: "setState",
							form: {
								v: BLOCK_SET_VERSION,
								root: {
									type: "form",
									id: "set-state-form",
									bind: "/bulk",
									mode: "submit",
									onSubmit: "setState",
									children: [{ type: "text", name: "state", label: "State" }],
								},
							},
						},
					],
					item: { title: { $: "./title" } },
				},
			],
		});
		const result = validateTree(tree, { placement: "view" });
		expect(result.ok).toBe(true);
	});

	it("a missing or non-string block type errors instead of passing silently", () => {
		// review finding 2: {type: {$: "/t"}} and {type: 3} used to
		// validate OK — a soundness hole, and `type` is a structural literal
		for (const badType of [{ $: "/t" }, 3, undefined]) {
			const tree = { v: BLOCK_SET_VERSION, root: { type: badType } } as unknown as Tree;
			const errs = errorsOf(validateTree(tree, { placement: "chat" }));
			expect(errs.some((e) => e.path === "root.type"), JSON.stringify(badType)).toBe(true);
		}
	});

	it("a missing or non-string field type errors instead of passing silently", () => {
		// review finding 2, the checkField half: a form child without a
		// string type must error, not silently pass
		const tree = treeOf({
			type: "form",
			id: "f",
			bind: "/x",
			mode: "submit",
			children: [{ label: "L" }],
		} as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(errs.some((e) => e.path === "root.children[0].type")).toBe(true);
	});

	it("a javascript: onActivate URL is rejected in view", () => {
		// review finding 3: onActivate carries an Action and must run the
		// same open-scheme / turn / submit-name rules as button actions
		const tree = treeOf({
			type: "page",
			title: "T",
			main: [
				{
					type: "tree",
					id: "nav",
					nodes: { $: "/nav" },
					onActivate: { type: "open", url: "javascript:alert(1)" },
				},
			],
		});
		const errs = errorsOf(validateTree(tree, { placement: "view" }));
		expect(errs.some((e) => e.path === "root.main[0].onActivate.url")).toBe(true);
	});

	it("a turn: true onActivate is rejected outside chat", () => {
		const tree = treeOf({
			type: "tree",
			id: "nav",
			nodes: { $: "/nav" },
			onActivate: { type: "edit", name: "n", turn: true },
		} as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "view" }));
		expect(errs.some((e) => e.path === "root.onActivate.turn")).toBe(true);
		expect(validateTree(tree, { placement: "chat" }).ok).toBe(true);
	});

	it("binding-only props reject relative pointers: items, lines, nodes, series data, submitLabel", () => {
		// review finding 4: the hardcoded prop list missed the props that
		// ONLY take bindings — the generic walk must catch them too
		const cases: { tree: Tree; path: string }[] = [
			{
				tree: treeOf({ type: "collection", id: "c", items: { $: "./x" }, display: "list", item: { title: "t" } } as unknown as Block),
				path: "root.items.$",
			},
			{
				tree: treeOf({ type: "log", lines: { $: "./x" } } as unknown as Block),
				path: "root.lines.$",
			},
			{
				tree: treeOf({ type: "tree", nodes: { $: "./x" } } as unknown as Block),
				path: "root.nodes.$",
			},
			{
				tree: treeOf({ type: "fields", rows: [{ label: "L", value: { $: "./v" } }] } as unknown as Block),
				path: "root.rows[0].value.$",
			},
			{
				tree: treeOf({
					type: "chart",
					x: { kind: "time" },
					series: [{ name: "s", kind: "line", data: { $: "./d" } }],
				} as unknown as Block),
				path: "root.series[0].data.$",
			},
			{
				tree: treeOf({
					type: "form",
					id: "f",
					bind: "/x",
					mode: "submit",
					submitLabel: { $: "./l" },
					children: [],
				} as unknown as Block),
				path: "root.submitLabel.$",
			},
		];
		for (const { tree, path } of cases) {
			const errs = errorsOf(validateTree(tree, { placement: "chat" }));
			expect(errs.some((e) => e.path === path), path).toBe(true);
		}
	});

	it("absolute bindings on binding-only props stay legal everywhere", () => {
		const tree = treeOf({
			type: "collection",
			id: "c",
			items: { $: "/cards" },
			display: "list",
			item: { title: { $: "./title" } },
		});
		expect(validateTree(tree, { placement: "chat" }).ok).toBe(true);
		const log = treeOf({ type: "log", lines: { $: "/out" } });
		expect(validateTree(log, { placement: "chat" }).ok).toBe(true);
	});

	it("a stray block prop on a stack child does not skip it (wrapper skip is columns/grid only)", () => {
		// fix-round-2 guard: the wrapper-children skip must fire only for
		// columns/grid; in a stack, a child with a stray record `block` prop
		// is still an (unknown) block of its own
		const tree = {
			v: BLOCK_SET_VERSION,
			root: {
				type: "stack",
				children: [{ type: "carousel", block: { type: "markdown", text: "x" } }],
			},
		} as unknown as Tree;
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(errs.some((e) => e.path === "root.children[0].type" && e.message.includes("carousel"))).toBe(
			true,
		);
	});

	it("a stray block prop on a form child errors, not silence", () => {
		// fix-round-2 guard: the finding-2 literal-type check must not be
		// bypassed by a stray `block` prop in a form child
		const tree = treeOf({
			type: "form",
			id: "f",
			bind: "/x",
			mode: "submit",
			children: [{ label: "L", block: { type: "text", name: "n", label: "N" } }],
		} as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(errs.some((e) => e.path === "root.children[0].type")).toBe(true);
	});

	it("columns and grid wrapper children with real inner blocks still validate clean", () => {
		// fix-round-2 guard against over-narrowing: genuine wrapper
		// positions keep validating their inner blocks (and relative
		// bindings stay legal inside card templates under both)
		const columns = fixture("columns");
		expect(validateTree(columns, { placement: "chat" }).ok).toBe(true);
		const grid = fixture("grid");
		expect(validateTree(grid, { placement: "chat" }).ok).toBe(true);
		const nested = treeOf({
			type: "columns",
			children: [
				{ weight: 2, block: { type: "markdown", text: "left" } },
			{ block: { type: "stat", label: "Load", value: 0.42, format: "percent" } },
			],
		});
		expect(validateTree(nested, { placement: "chat" }).ok).toBe(true);
	});

	it("a columns child without block defers to the schema's required-prop error", () => {
		// cosmetic fix-round-2: {weight: 1} must not draw a misleading
		// "block type must be a literal string" at children[0].type
		const tree = treeOf({
			type: "columns",
			children: [{ weight: 1 }],
		} as unknown as Block);
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(errs.some((e) => e.path === "root.children[0]" && e.message.includes("block"))).toBe(
			true,
		);
		expect(errs.some((e) => e.path === "root.children[0].type")).toBe(false);
	});
});

describe("handlers (spec §6.1: a name with no handler fails validation)", () => {
	it("reorder without onMove errors at the reorder prop", () => {
		const tree = treeOf({
			type: "collection",
			id: "c",
			items: { $: "/items" },
			display: "list",
			reorder: { within: true },
			item: { title: { $: "./t" } },
		});
		const errs = errorsOf(validateTree(tree, { placement: "view" }));
		const err = errs.find((e) => e.path === "root.reorder");
		expect(err?.message).toContain("onMove");
	});

	it("onMove 'x' with handlers {y} errors 'no handler named x'", () => {
		const tree = treeOf({
			type: "collection",
			id: "c",
			items: { $: "/items" },
			display: "list",
			reorder: { within: true },
			onMove: "x",
			item: { title: { $: "./t" } },
		});
		const errs = errorsOf(validateTree(tree, { placement: "view", handlers: new Set(["y"]) }));
		const err = errs.find((e) => e.path === "root.onMove");
		expect(err?.message).toContain("no handler named x");
	});

	it("without handlers, names are free labels (chat)", () => {
		const tree = treeOf({
			type: "collection",
			id: "c",
			items: { $: "/items" },
			display: "list",
			reorder: { within: true },
			onMove: "anything",
			item: { title: { $: "./t" } },
		});
		expect(validateTree(tree, { placement: "chat" }).ok).toBe(true);
	});

	it("every handler-name prop is checked against the set", () => {
		const tree = treeOf({
			type: "stack",
			children: [
				{
					type: "collection",
					id: "c",
					items: { $: "/items" },
					display: "calendar",
					time: { start: "s", range: "month", onResize: "r1", onCreate: "c1" },
					item: { title: { $: "./t" } },
				},
				{ type: "tree", id: "t", nodes: { $: "/n" }, onExpand: "e1" },
				{
					type: "form",
					id: "f",
					bind: "/x",
					mode: "submit",
					onSubmit: "s1",
					children: [{ type: "file", name: "u", label: "U", onUpload: "u1" }],
				},
			],
		});
		const errs = errorsOf(validateTree(tree, { placement: "view", handlers: new Set(["ok"]) }));
		for (const path of [
			"root.children[0].time.onResize",
			"root.children[0].time.onCreate",
			"root.children[1].onExpand",
			"root.children[2].onSubmit",
			"root.children[2].children[0].onUpload",
		]) {
			expect(errs.some((e) => e.path === path), path).toBe(true);
		}
	});

	it("submit/move/edit action names are checked against the set", () => {
		const tree = treeOf({
			type: "callout",
			id: "co",
			tone: "info",
			title: "T",
			actions: [{ id: "a", label: "L", action: { type: "submit", name: "nope" } }],
		});
		const errs = errorsOf(validateTree(tree, { placement: "view", handlers: new Set(["yes"]) }));
		expect(errs.some((e) => e.path === "root.actions[0].action.name")).toBe(true);
	});

	it("turn: true outside chat is rejected with its path (spec §6.2)", () => {
		const viewTree = treeOf({
			type: "callout",
			id: "co",
			tone: "info",
			title: "T",
			actions: [{ id: "a", label: "L", action: { type: "submit", name: "s", turn: true } }],
		});
		const errs = errorsOf(validateTree(viewTree, { placement: "view" }));
		expect(errs.some((e) => e.path === "root.actions[0].action.turn")).toBe(true);

		const chatTree = treeOf({
			type: "callout",
			id: "co",
			tone: "info",
			title: "T",
			actions: [{ id: "a", label: "L", action: { type: "submit", name: "s", turn: true } }],
		});
		expect(validateTree(chatTree, { placement: "chat" }).ok).toBe(true);

		const formTree = treeOf({
			type: "form",
			id: "f",
			bind: "/x",
			mode: "submit",
			turn: true,
			children: [],
		});
		expect(errorsOf(validateTree(formTree, { placement: "view" })).length).toBeGreaterThan(0);
		expect(validateTree(formTree, { placement: "chat" }).ok).toBe(true);
	});
});

// ─── actions: open schemes ────────────────────────────────────────────────

describe("open action schemes (spec §6.1)", () => {
	it("rejects javascript: URLs", () => {
		const tree = treeOf({
			type: "callout",
			id: "c",
			tone: "info",
			title: "T",
			actions: [{ id: "a", label: "L", action: { type: "open", url: "javascript:alert(1)" } }],
		});
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(errs.some((e) => e.path === "root.actions[0].action.url")).toBe(true);
	});

	it("accepts https, http and mailto", () => {
		for (const url of [
			"https://example.invalid/x",
			"http://example.invalid/y",
			"mailto:a@example.invalid",
		]) {
			const tree = treeOf({
				type: "callout",
				id: "c",
				tone: "info",
				title: "T",
				actions: [{ id: "a", label: "L", action: { type: "open", url } }],
			});
			expect(validateTree(tree, { placement: "chat" }).ok, url).toBe(true);
		}
	});
});

// ─── versions ─────────────────────────────────────────────────────────────

describe("block-set version (spec §4.4)", () => {
	it("rejects a v2 tree with an unknown block against serverV 1", () => {
		const result = validateTree(
			{ v: 2, root: { type: "carousel" } },
			{ placement: "chat", serverV: 1 },
		);
		const errs = errorsOf(result);
		expect(errs.some((e) => e.message.includes("unsupported block-set version 2"))).toBe(true);
	});

	it("accepts a tree whose v matches the server", () => {
		const tree = treeOf({ type: "markdown", text: "x" });
		expect(validateTree(tree, { placement: "chat", serverV: BLOCK_SET_VERSION }).ok).toBe(true);
	});
});

// ─── ids ──────────────────────────────────────────────────────────────────

describe("ids (spec §4.1)", () => {
	it("rejects duplicate ids within a tree", () => {
		const tree = treeOf({
			type: "stack",
			children: [
				{ type: "markdown", text: "x", id: "dup" },
				{ type: "markdown", text: "y", id: "dup" },
			],
		});
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		expect(
			errs.some(
				(e) => e.message.includes("duplicate id") && e.message.includes('"dup"'),
			),
		).toBe(true);
	});

	it("requires ids on blocks that carry actions or inputs", () => {
		const noId = treeOf({
			type: "form",
			bind: "/x",
			mode: "submit",
			children: [{ type: "text", name: "a", label: "A" }],
		} as unknown as Block);
		const errs = errorsOf(validateTree(noId, { placement: "chat" }));
		expect(errs.some((e) => e.path === "root" && e.message.includes("id"))).toBe(true);
	});
});

// ─── limits (spec §4.5) ───────────────────────────────────────────────────

describe("LIMITS (spec §4.5)", () => {
	it("pins the table", () => {
		expect(LIMITS.chat).toEqual({ blocks: 200, treeBytes: 256 * 1024, dataBytes: 256 * 1024 });
		expect(LIMITS.interaction).toEqual({ blocks: 100, treeBytes: 64 * 1024, dataBytes: 64 * 1024 });
		expect(LIMITS.ambient).toEqual({ blocks: 100, treeBytes: 64 * 1024, dataBytes: 64 * 1024 });
		expect(LIMITS.view).toEqual({ blocks: 2000, treeBytes: 1024 * 1024, dataBytes: 4 * 1024 * 1024 });
		expect(LIMITS.panel).toEqual(LIMITS.view);
		expect(LIMITS.settings).toEqual(LIMITS.view);
	});

	it("201 blocks in chat fails with surface_too_large naming blocks", () => {
		const children = Array.from({ length: 200 }, (_, i) => ({ type: "markdown", text: `x${i}` }));
		children.push({ type: "markdown", text: "overflow" });
		const tree = treeOf({ type: "stack", children: children as unknown as Block[] });
		const errs = errorsOf(validateTree(tree, { placement: "chat" }));
		const err = errs.find((e) => e.message.includes("surface_too_large"));
		expect(err).toBeDefined();
		expect(err?.message).toContain("blocks");
	});

	it("200 blocks in chat passes the block limit", () => {
		const children = Array.from({ length: 199 }, (_, i) => ({ type: "markdown", text: `x${i}` }));
		const tree = treeOf({ type: "stack", children: children as unknown as Block[] });
		expect(validateTree(tree, { placement: "chat" }).ok).toBe(true);
	});

	it("counts a collection as one block", () => {
		const children = Array.from({ length: 199 }, (_, i) => ({
			type: "collection",
			id: `c${i}`,
			items: { $: `/items${i}` },
			display: "list",
			item: { title: { $: "./t" } },
		}));
		const tree = treeOf({ type: "stack", children: children as unknown as Block[] });
		expect(validateTree(tree, { placement: "chat" }).ok).toBe(true);
	});

	it("a 65,537-byte tree of 3-byte characters in interaction fails naming treeBytes", () => {
		// 21,846 × "€" = 65,538 UTF-8 bytes (over the 64 KiB tree limit).
		const text = "€".repeat(21846);
		const tree = treeOf({ type: "markdown", text });
		const errs = errorsOf(validateTree(tree, { placement: "interaction" }));
		const err = errs.find((e) => e.message.includes("surface_too_large"));
		expect(err).toBeDefined();
		expect(err?.message).toContain("treeBytes");
	});

	it("validateData enforces the data cap", () => {
		expect(validateData({ a: 1 }, "chat")).toMatchObject({ ok: true });
		const big: JsonObject = { text: "€".repeat(21846) };
		const errs = errorsOf(validateData(big, "interaction"));
		const err = errs.find((e) => e.message.includes("surface_too_large"));
		expect(err).toBeDefined();
		expect(err?.message).toContain("dataBytes");
		expect(validateData(big, "view").ok).toBe(true);
	});

	it("validateData rejects non-objects", () => {
		const errs = errorsOf(validateData([1, 2], "chat"));
		expect(errs.length).toBeGreaterThan(0);
	});
});

// ─── images (spec §11.1) ──────────────────────────────────────────────────

describe("checkImageSource (spec §11.1)", () => {
	it("rejects svg data URLs", () => {
		const r = checkImageSource("data:image/svg+xml;base64,PHN2Zy8+");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("svg");
	});

	it("rejects avif data URLs", () => {
		const r = checkImageSource("data:image/avif;base64,AAAA");
		expect(r.ok).toBe(false);
	});

	it("rejects 192 KiB + 1 of base64", () => {
		const b64 = "A".repeat(192 * 1024 + 1);
		const r = checkImageSource(`data:image/png;base64,${b64}`);
		expect(r.ok).toBe(false);
	});

	it("accepts 192 KiB of base64", () => {
		const b64 = "A".repeat(192 * 1024);
		const r = checkImageSource(`data:image/png;base64,${b64}`);
		expect(r).toMatchObject({ ok: true, kind: "data" });
	});

	it("rejects http: URLs", () => {
		const r = checkImageSource("http://example.invalid/x.png");
		expect(r.ok).toBe(false);
	});

	it("accepts asset: and https: sources", () => {
		expect(checkImageSource("asset:img/a.png")).toMatchObject({ ok: true, kind: "asset" });
		expect(checkImageSource("https://example.invalid/x.png")).toMatchObject({
			ok: true,
			kind: "https",
		});
	});

	it("rejects other schemes entirely", () => {
		expect(checkImageSource("ftp://example.invalid/x.png").ok).toBe(false);
		expect(checkImageSource("javascript:alert(1)").ok).toBe(false);
		expect(checkImageSource("data:text/html;base64,PGI+").ok).toBe(false);
	});

	it("validateTree checks image block srcs", () => {
		const tree = treeOf({
			type: "image",
			id: "i",
			src: "http://example.invalid/x.png",
			alt: "x",
		});
		const errs = errorsOf(validateTree(tree, { placement: "view" }));
		expect(errs.some((e) => e.path === "root.src")).toBe(true);
	});
});

// ─── ambient one-line rule (spec §9.2) ────────────────────────────────────

describe("ambient one-line rule (spec §9.2)", () => {
	it("a status root with two stacked markdowns fails", () => {
		const tree = treeOf({
			type: "stack",
			children: [
				{ type: "markdown", text: "a" },
				{ type: "markdown", text: "b" },
			],
		});
		const errs = errorsOf(validateTree(tree, { placement: "ambient", ambientPlace: "status" }));
		expect(errs.length).toBeGreaterThan(0);
	});

	it("a single markdown status line passes", () => {
		const tree = fixture("ambient-status");
		expect(validateTree(tree, { placement: "ambient", ambientPlace: "status" }).ok).toBe(true);
	});

	it("a footer root of three one-line columns passes", () => {
		const tree = fixture("ambient-footer");
		expect(validateTree(tree, { placement: "ambient", ambientPlace: "footer" }).ok).toBe(true);
	});

	it("a footer columns with a nested stack fails", () => {
		const tree = treeOf({
			type: "columns",
			children: [
				{
					block: {
						type: "stack",
						children: [
							{ type: "markdown", text: "a" },
							{ type: "markdown", text: "b" },
						],
					},
				},
			],
		});
		const errs = errorsOf(validateTree(tree, { placement: "ambient", ambientPlace: "footer" }));
		expect(errs.length).toBeGreaterThan(0);
	});

	it("a panel ambient root may stack freely", () => {
		const tree = fixture("ambient-panel");
		expect(validateTree(tree, { placement: "ambient", ambientPlace: "panel" }).ok).toBe(true);
	});

	it("a collection with bound items fails in ambient (controller ruling 2026-10-24: literal rows only)", () => {
		// Bindings are OUT of ambient placement: the envelope stays
		// unchanged (no data slot), so a collection whose `items` is a
		// binding has nothing to resolve against — the validator rejects
		// it. Reversible: extending the envelope (a data slot) remains open.
		const tree = treeOf({
			type: "collection",
			id: "goal",
			items: { $: "/rows" },
			display: "list",
			item: { title: { $: "./label" } },
		});
		for (const ambientPlace of ["status", "footer", "panel"] as const) {
			const errs = errorsOf(validateTree(tree, { placement: "ambient", ambientPlace }));
			expect(errs.some((e) => e.path === "root.items")).toBe(true);
		}
	});

	it("an ambient markdown.text binding fails validation naming the path", () => {
		// The same no-data-document ruling as bound items: an absolute
		// binding on ANY ambient prop outside an item template has nothing
		// to resolve against and would render blank — reject it.
		const tree = treeOf({ type: "markdown", text: { $: "/line" } });
		const errs = errorsOf(validateTree(tree, { placement: "ambient", ambientPlace: "status" }));
		expect(errs.some((e) => e.path === "root.text.$")).toBe(true);
		// …while the SAME tree is fine in a placement with a data document.
		expect(validateTree(tree, { placement: "chat" }).ok).toBe(true);
	});

	it("an ambient binding nested one level inside a wrapper fails at its path", () => {
		const tree = treeOf({
			type: "stack",
			children: [{ type: "markdown", text: { $: "/line" } }],
		});
		const errs = errorsOf(validateTree(tree, { placement: "ambient", ambientPlace: "panel" }));
		expect(errs.some((e) => e.path === "root.children[0].text.$")).toBe(true);
	});

	it("an ambient collection item template keeps its relative bindings", () => {
		const tree = treeOf({
			type: "collection",
			id: "goal",
			items: [{ id: "r1", label: "deploy" }],
			display: "list",
			item: { title: { $: "./label" } },
		});
		expect(validateTree(tree, { placement: "ambient", ambientPlace: "panel" }).ok).toBe(true);
	});

	it("a collection with a literal items array passes in ambient", () => {
		const tree = treeOf({
			type: "collection",
			id: "goal",
			// Literal rows: ambient collections have no data document, so
			// `items` is the array itself (the ruling's literal-row shape).
			items: [{ id: "r1", label: "deploy" }],
			display: "list",
			item: { title: { $: "./label" } },
		});
		expect(validateTree(tree, { placement: "ambient", ambientPlace: "panel" }).ok).toBe(true);
	});

	it("columns children must be line-level (a chart column in a footer fails)", () => {
		const tree = treeOf({
			type: "columns",
			children: [{ block: { type: "chart", x: { kind: "time" }, series: [] } }],
		});
		const errs = errorsOf(validateTree(tree, { placement: "ambient", ambientPlace: "footer" }));
		expect(errs.length).toBeGreaterThan(0);
	});
});

// ─── validateTree result shape ────────────────────────────────────────────

describe("validateTree result", () => {
	it("returns the tree on success", () => {
		const tree = fixture("markdown");
		const result = validateTree(tree, { placement: "chat" });
		if (!result.ok) throw new Error(result.errors.map((e: { message: string }) => e.message).join("; "));
		expect(result.tree).toEqual(tree);
	});

	it("rejects non-object input", () => {
		const errs = errorsOf(validateTree("nope", { placement: "chat" }));
		expect(errs.length).toBeGreaterThan(0);
	});

	it("rejects a tree missing root", () => {
		const errs = errorsOf(validateTree({ v: 1 }, { placement: "chat" }));
		expect(errs.length).toBeGreaterThan(0);
	});

	it("rejects unknown placements", () => {
		const tree = fixture("markdown");
		const result = validateTree(tree, { placement: "warp" as Placement });
		expect(result.ok).toBe(false);
	});
});
