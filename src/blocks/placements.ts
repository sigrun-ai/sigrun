/**
 * The placement rules of spec §5.7, as data: which blocks, which
 * collection displays and which form fields each placement allows,
 * plus the root-block and `page.sidebar` constraints the table carries.
 *
 * `validateTree` walks a tree against these rules; the tests pin the
 * table's literal cells so this data cannot drift from the spec.
 */

/** One row of the §5.7 table. */
export interface PlacementRule {
	/** Blocks allowed anywhere in the tree. */
	readonly blocks: ReadonlySet<string>;
	/** The only legal root block type, when the placement pins it. */
	readonly rootBlock?: "page" | "form";
	/** Whether a root `page` may carry `sidebar` (panel: no). */
	readonly pageSidebar: boolean;
	/** Collection displays allowed (`undefined`: all five). */
	readonly collectionDisplays?: readonly string[];
	/** Field types allowed in `form` blocks. */
	readonly fields: ReadonlySet<string>;
}

const ALL_BLOCKS = [
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
] as const;

const ALL_FIELDS = [
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
] as const;

function rule(init: {
	blocks: readonly string[];
	rootBlock?: "page" | "form";
	pageSidebar?: boolean;
	collectionDisplays?: readonly string[];
	fields: readonly string[];
}): PlacementRule {
	return {
		blocks: new Set(init.blocks),
		rootBlock: init.rootBlock,
		pageSidebar: init.pageSidebar ?? true,
		collectionDisplays: init.collectionDisplays,
		fields: new Set(init.fields),
	};
}

const CONTENT = ["markdown", "fields", "callout", "diff", "details"] as const;
const STAT_METER_LOG = ["stat", "meter", "log"] as const;
const CHART_IMAGE_TREE = ["chart", "image", "tree"] as const;
const ALL_COLLECTION_DISPLAYS = ["list", "table", "lanes", "grid", "calendar"] as const;

/** The placement names, kept local so this module has no imports. */
type PlacementName = "view" | "panel" | "settings" | "chat" | "interaction" | "ambient";

/** Spec §5.7, one row per placement. */
export const PLACEMENT_RULES: Readonly<Record<PlacementName, PlacementRule>> = {
	// view: everything; a required page root.
	view: rule({
		blocks: ALL_BLOCKS,
		rootBlock: "page",
		pageSidebar: true,
		fields: ALL_FIELDS,
	}),
	// panel: everything but a sidebar on the page root.
	panel: rule({
		blocks: ALL_BLOCKS,
		rootBlock: "page",
		pageSidebar: false,
		fields: ALL_FIELDS,
	}),
	// settings: section + content + stat-free; forms only at the root;
	// collections limited to list/table; all fields but file.
	settings: rule({
		blocks: ["section", ...CONTENT, "collection", "form"],
		rootBlock: "form",
		collectionDisplays: ["list", "table"],
		fields: ALL_FIELDS.filter((f) => f !== "file"),
	}),
	// chat: everything but page; all fields but secret.
	chat: rule({
		blocks: ALL_BLOCKS.filter((b) => b !== "page"),
		fields: ALL_FIELDS.filter((f) => f !== "secret"),
	}),
	// interaction: stack/section layout, content, list collections, and a
	// required form root with the ask-user subset of fields.
	interaction: rule({
		blocks: ["stack", "section", ...CONTENT, "collection", "form"],
		rootBlock: "form",
		collectionDisplays: ["list"],
		fields: ["text", "longtext", "number", "toggle", "choice", "secret"],
	}),
	// ambient: stack/columns layout, content, stat/meter/log, list
	// collections; no forms (§9.2 records render read-only state).
	ambient: rule({
		blocks: ["stack", "columns", ...CONTENT, ...STAT_METER_LOG, "collection"],
		collectionDisplays: ["list"],
		fields: [],
	}),
};
