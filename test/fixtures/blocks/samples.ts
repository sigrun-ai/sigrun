/**
 * The gallery corpus (UI-blocks U0 Task 2): one valid, minimal, literal-JSON
 * sample per block, display and field, keyed by the placement(s) the spec
 * §5.7 table allows it to appear in. Reused by the U1/U2 galleries.
 *
 * Files are literal JSON (no imports): later tasks load them through a
 * Vite alias / plain read. This manifest maps each file to the placements
 * where the sample is valid, so the matrix tests and both channels' galleries
 * share one source of truth.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Placement, Tree } from "@sigrun/shared/blocks";

/** The placements the block set defines (spec §3). */
export const VALID_PLACEMENTS: readonly Placement[] = [
	"view",
	"panel",
	"settings",
	"chat",
	"interaction",
	"ambient",
];

const DIR = join(import.meta.dirname);

/** One gallery sample: a name and its parsed tree. */
export interface Sample {
	name: string;
	tree: Tree;
}

const files = readdirSync(DIR)
	.filter((f) => f.endsWith(".json"))
	.sort();

/** Every fixture parsed from disk, keyed by file name. */
export const SAMPLES: readonly Sample[] = files.map((file) => ({
	name: file.slice(0, -".json".length),
	tree: JSON.parse(readFileSync(join(DIR, file), "utf8")) as Tree,
}));

/**
 * Per placement, the samples whose roots the §5.7 rules allow there:
 * a chat-legal sample also serves view/panel (any chat-legal block is
 * view/panel-legal); settings takes the field samples; ambient takes
 * its own three. Files never validate outside their listed placements
 * for root-shape reasons, which the matrix tests assert separately.
 */
const PLACEMENT_FILES: Readonly<Record<Placement, readonly string[]>> = {
	view: [
		// view surfaces root at `page` (§5.7); the corpus keeps both shells.
		// Every other sample appears inside `page.main` via `page.json` and
		// its content siblings; standalone single-block trees belong to the
		// chat corpus (any chat-legal block is view-legal as a nested child).
		"page",
		"page-sidebar",
	],
	panel: [
		// panel surfaces root at `page` without `sidebar` (§5.7).
		"page",
	],
	settings: [
		// settings surfaces root at a `form` (§5.7 "root, required");
		// content blocks appear nested inside that form, so the corpus's
		// bare-root samples live in chat (which pins no root).
		"form",
		"form-settings",
		// every field type (settings allows all but file)
		"field-text",
		"field-longtext",
		"field-number",
		"field-toggle",
		"field-choice",
		"field-date",
		"field-datetime",
		"field-daterange",
		"field-secret",
		"field-list",
	],
	chat: [
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
		"collection-list",
		"collection-table",
		"collection-lanes",
		"collection-grid",
		"collection-calendar",
		"form",
		"form-view",
		"form-inline",
		"form-chat",
		"chat-message",
		// the file field + its whole form live here too (chat allows all but secret)
		"field-file",
		"form-upload",
	],
	interaction: [
		// interaction surfaces root at a `form` too (§9.1: a root form
		// whose submit is the answer); bare-root samples live in chat.
		"interaction-form",
		"form-interaction",
		"field-text",
		"field-longtext",
		"field-number",
		"field-toggle",
		"field-choice",
		"field-secret",
	],
	ambient: [
		"stack",
		"columns",
		"markdown",
		"fields",
		"callout",
		"diff",
		"details",
		"stat",
		"meter",
		"log",
		// Literal rows: ambient collections never bind (the envelope has
		// no data document — the 2026-10-24 ruling).
		"collection-literal",
		"ambient-status",
		"ambient-footer",
		"ambient-panel",
	],
};

const fixtured = {} as Record<Placement, Sample[]>;
for (const placement of VALID_PLACEMENTS) {
	const names = new Set(PLACEMENT_FILES[placement]);
	fixtured[placement] = SAMPLES.filter((s) => names.has(s.name));
}

/** Samples grouped by the placements where they are valid. */
export const FIXTURES: Readonly<Record<Placement, readonly Sample[]>> = fixtured;

/** Look one sample up by file name (without `.json`). */
export function fixture(name: string): Tree {
	const sample = SAMPLES.find((s) => s.name === name);
	if (!sample) throw new Error(`no blocks fixture named "${name}"`);
	return sample.tree;
}
