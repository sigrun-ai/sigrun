/**
 * `toText` (UI-blocks spec §14.3): the deterministic plain-text
 * projection of a surface — headings, aligned tables, lists with
 * checkboxes and numbers, lanes as sections, charts as one summary
 * line per series. Used for the model's view of its own `show_blocks`
 * call, the default `fallback` text, extension unit tests, logs and
 * notifications.
 *
 * Determinism (spec §14.3): the same input, width and locale give the
 * same bytes, so model context stays cacheable. Three rules make that
 * hold:
 *
 * - object keys are visited in SCHEMA order, never insertion order —
 *   card slots, log lines, tree nodes and table cells are read through
 *   their named props, and anything rendered as JSON goes through
 *   `formatValue`'s sorted-key serializer;
 * - no clock reads in the render path: `TextOptions.timeZone` defaults
 *   to UTC (a datetime projection is stable across hosts; pass a zone
 *   to localize), and only the `relative` format consults `Date.now()`;
 * - unknown blocks render their `fallback`, else
 *   `[unsupported block: <type>]` (§4.4) — never a throw.
 */

import { resolvePointer } from "./ops.js";
import { formatValue } from "./format.js";
import type {
	Bindable,
	Block,
	BlockBase,
	Card,
	ChartBlock,
	ChoiceField,
	ChoiceOption,
	CollectionBlock,
	CollectionColumn,
	Field,
	FieldsRow,
	FormBlock,
	PageBlock,
	SectionBlock,
	Tree,
} from "./types.js";
import type { JsonObject, JsonValue } from "../json.js";

/** Options for `toText`: the width to wrap at, and the `Intl` locale. */
export interface TextOptions {
	/** Wrap target in columns (the §14.3 snapshots use 80 and 160). */
	width: number;
	/** BCP-47 locale for every `Intl` format. */
	locale: string;
	/**
	 * Time zone for datetime renders. Defaults to UTC inside `toText`
	 * (byte-stable projections across hosts); pass one to localize.
	 */
	timeZone?: string;
}

/** Everything a renderer needs; built once per `toText` call. */
interface Ctx {
	data: JsonObject;
	locale: string;
	timeZone: string;
	width: number;
}

/** Spec §12.1: `compact` is below 80 cells; `atLeast:regular` hides there. */
const REGULAR_WIDTH = 80;

/** The `Field` type literals (used to keep fields out of block walks). */
const FIELD_TYPES: ReadonlySet<string> = new Set([
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
]);

// ─── Small helpers ────────────────────────────────────────────────────────

/** A JSON object (not an array, not null). */
function isRecord(value: JsonValue | undefined): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A `{$: pointer}` binding. */
function isBinding(value: unknown): value is { $: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { $?: unknown }).$ === "string"
	);
}

/** Resolve a literal-or-binding prop; a missing path is `undefined`. */
function resolveBind(
	value: unknown,
	ctx: Ctx,
	item?: JsonValue,
): JsonValue | undefined {
	if (value === undefined || value === null) return undefined;
	if (isBinding(value)) return resolvePointer(ctx.data, value.$, item);
	return value as JsonValue;
}

/** Text of a JSON value: strings bare, everything else via `formatValue`. */
function textOf(value: JsonValue | undefined, ctx: Ctx): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	return formatValue(value, undefined, ctx.locale);
}

/** Resolve a bindable text prop (empty string for missing paths). */
function bindText(value: unknown, ctx: Ctx, item?: JsonValue): string {
	return textOf(resolveBind(value, ctx, item), ctx);
}

/** A value through `formatValue` (empty string for missing paths). */
function fmt(
	value: JsonValue | undefined,
	format: string | undefined,
	ctx: Ctx,
): string {
	return value === undefined || value === null
		? ""
		: formatValue(value, format, ctx.locale, ctx.timeZone);
}

/** `label: value` with no trailing whitespace when the value is empty. */
function labeled(label: string, value: string): string {
	return value === "" ? `${label}:` : `${label}: ${value}`;
}

/**
 * `label: value` for CARD slots: empty values drop the line entirely
 * (an unset optional slot is noise in a text projection, unlike a form
 * field, where an empty value is information).
 */
function cardLabeled(label: string, value: string): string | null {
	return value === "" ? null : `${label}: ${value}`;
}

/** Greedy word wrap (never splits a word; keeps blank lines). */
function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const paragraph of text.split("\n")) {
		const words = paragraph.split(/\s+/).filter((word) => word !== "");
		if (words.length === 0) {
			out.push("");
			continue;
		}
		let line = "";
		for (const word of words) {
			if (line === "") line = word;
			else if (line.length + 1 + word.length <= width) line += ` ${word}`;
			else {
				out.push(line);
				line = word;
			}
		}
		out.push(line);
	}
	return out;
}

/** Join rendered blocks with one blank line between non-empty groups. */
function joinBlocks(groups: readonly string[][]): string[] {
	const out: string[] = [];
	for (const group of groups) {
		if (group.length === 0) continue;
		if (out.length > 0) out.push("");
		out.push(...group);
	}
	return out;
}

/**
 * Join list ROWS: two consecutive single-line rows stay adjacent (a
 * tight list reads as a list); a multi-line row — or a row followed by
 * one — keeps the blank line so card content doesn't fuse.
 */
function joinRows(groups: readonly string[][]): string[] {
	const out: string[] = [];
	let lastWasSingle = false;
	for (const group of groups) {
		if (group.length === 0) continue;
		const single = group.length === 1;
		if (out.length > 0 && !(single && lastWasSingle)) out.push("");
		out.push(...group);
		lastWasSingle = single;
	}
	return out;
}

/** Is this node a `Field` (kept out of the block-only walks)? */
function isField(node: Block | Field): node is Field {
	return FIELD_TYPES.has(node.type);
}

/** A unit joins its value: `3%` (single character) vs `10 req/s`. */
function withUnit(text: string, unit: string): string {
	if (unit === "") return text;
	return unit.length === 1 ? `${text}${unit}` : `${text} ${unit}`;
}

// ─── Entry point ──────────────────────────────────────────────────────────

/**
 * Render `tree` against `data` as plain text (spec §14.3).
 * Deterministic per (input, width, locale): the same arguments give the
 * same bytes. Unknown blocks render their `fallback`, else
 * `[unsupported block: <type>]`.
 */
export function toText(tree: Tree, data: JsonObject, opts: TextOptions): string {
	const ctx: Ctx = {
		data,
		locale: opts.locale,
		timeZone: opts.timeZone ?? "UTC",
		width: Math.max(1, Math.floor(opts.width)),
	};
	const lines = renderBlock(tree.root, ctx);
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

// ─── Block dispatch ───────────────────────────────────────────────────────

/** Render one block to lines (empty lines list = renders nothing). */
function renderBlock(block: Block, ctx: Ctx): string[] {
	if (block.visibleAt === "atLeast:regular" && ctx.width < REGULAR_WIDTH) {
		return [];
	}
	switch (block.type) {
		case "page":
			return renderPage(block, ctx);
		case "stack":
			return renderBlocks(block.children, ctx);
		case "columns":
			return renderBlocks(block.children.map((child) => child.block), ctx);
		case "grid":
			return renderBlocks(block.children.map((child) => child.block), ctx);
		case "section":
			return renderSection(block, ctx);
		case "markdown":
			return wrap(bindText(block.text, ctx), ctx.width);
		case "fields":
			return renderFields(block.rows, ctx);
		case "stat":
			return renderStat(block, ctx);
		case "callout":
			return renderCallout(block, ctx);
		case "image":
			return [`[image: ${bindText(block.alt, ctx)}]`];
		case "chart":
			return renderChart(block, ctx);
		case "meter":
			return renderMeter(block, ctx);
		case "log":
			return renderLog(block, ctx);
		case "tree":
			return renderTree(block, ctx);
		case "diff":
			return renderDiff(block);
		case "details":
			return [formatValue(block.value, undefined, ctx.locale)];
		case "collection":
			return renderCollection(block, ctx);
		case "form":
			return renderForm(block, ctx);
		default: {
			// A block type this version does not know (§4.4): the block's
			// `fallback` text, else the unsupported marker. Never a throw.
			// SAFETY: `block` is `never` in this arm for the closed union, so
			// reading `type`/`fallback` off it via a structural cast is the
			// one sanctioned way to project an unknown-shape node.
			const unknown = block as unknown as { type?: string } & BlockBase;
			const type = unknown.type ?? "unknown";
			return unknown.fallback !== undefined && unknown.fallback !== ""
				? [unknown.fallback]
				: [`[unsupported block: ${type}]`];
		}
	}
}

/** Render a list of blocks, blank-line separated. */
function renderBlocks(blocks: readonly (Block | Field)[], ctx: Ctx): string[] {
	return joinBlocks(
		blocks
			.filter((child): child is Block => !isField(child))
			.map((child) => renderBlock(child, ctx)),
	);
}

// ─── Shell and layout ─────────────────────────────────────────────────────

/** The first collection in `main`, depth-first through layout blocks. */
function firstCollection(blocks: readonly (Block | Field)[]): CollectionBlock | undefined {
	for (const child of blocks) {
		if (isField(child)) continue;
		if (child.type === "collection") return child;
		let nested: readonly (Block | Field)[] | undefined;
		switch (child.type) {
			case "stack":
				nested = child.children;
				break;
			case "section":
				nested = child.children;
				break;
			case "columns":
				nested = child.children.map((column) => column.block);
				break;
			case "grid":
				nested = child.children.map((cell) => cell.block);
				break;
			default:
				nested = undefined;
		}
		if (nested !== undefined) {
			const found = firstCollection(nested);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

/** `page`: header, then sidebar, main and detail as labelled sections. */
function renderPage(page: PageBlock, ctx: Ctx): string[] {
	const head: string[] = [];
	const title = bindText(page.title, ctx);
	if (title !== "") head.push(`# ${title}`);
	const subtitle = bindText(page.subtitle, ctx);
	if (subtitle !== "") head.push(subtitle);
	const actionLabels = (page.actions ?? [])
		.map((button) => bindText(button.label, ctx))
		.filter((label) => label !== "");
	if (actionLabels.length > 0) head.push(`actions: ${actionLabels.join(", ")}`);

	// §5.1: the empty state replaces main when main's first collection
	// binds to a missing path, null or [].
	let main: string[];
	const collection = firstCollection(page.main);
	if (page.empty !== undefined && collection !== undefined) {
		const items = collection.items ? resolvePointer(ctx.data, collection.items.$) : undefined;
		if (!Array.isArray(items) || items.length === 0) {
			main = [page.empty.title];
			if (page.empty.hint !== undefined && page.empty.hint !== "") main.push(page.empty.hint);
			return joinBlocks([head, main]);
		}
	}
	main = renderBlocks(page.main, ctx);

	const sidebar =
		page.sidebar !== undefined && page.sidebar.length > 0
			? ["## Sidebar", ...renderBlocks(page.sidebar, ctx)]
			: [];
	const detail =
		page.detail !== undefined && page.detail.length > 0
			? ["## Detail", ...renderBlocks(page.detail, ctx)]
			: [];
	return joinBlocks([head, sidebar, main, detail]);
}

/** `section`: an `##` heading (plus subtitle) over its children. */
function renderSection(section: SectionBlock, ctx: Ctx): string[] {
	const head: string[] = [];
	const title = bindText(section.title, ctx);
	if (title !== "") head.push(`## ${title}`);
	const subtitle = bindText(section.subtitle, ctx);
	if (subtitle !== "") head.push(subtitle);
	return joinBlocks([head, renderBlocks(section.children, ctx)]);
}

// ─── Content blocks ───────────────────────────────────────────────────────

/** `fields`: one `label: value` line per row. */
function renderFields(rows: Bindable<readonly FieldsRow[]>, ctx: Ctx): string[] {
	const raw = resolveBind(rows, ctx);
	if (!Array.isArray(raw)) return [];
	const lines: string[] = [];
	for (const row of raw) {
		if (!isRecord(row)) continue;
		lines.push(labeled(`${bindText(row.label, ctx)}`, textOf(resolveBind(row.value, ctx), ctx)));
	}
	return lines;
}

/** `stat`: `label: value unit` plus an optional caption line. */
function renderStat(block: BindableStat, ctx: Ctx): string[] {
	const value = fmt(resolveBind(block.value, ctx), block.format, ctx);
	const unit = bindText(block.unit, ctx);
	const text = withUnit(value, unit);
	const label = bindText(block.label, ctx);
	const lines = [labeled(label, text)];
	const caption = bindText(block.caption, ctx);
	if (caption !== "") lines.push(caption);
	return lines;
}

/** The props of `stat` this projection reads. */
type BindableStat = {
	readonly label: Bindable<string>;
	readonly value: unknown;
	readonly unit?: unknown;
	readonly format?: string | undefined;
	readonly caption?: unknown;
};

/** `callout`: `[tone] title`, body, and its action labels. */
function renderCallout(block: BindableCallout, ctx: Ctx): string[] {
	const tone = bindText(block.tone, ctx);
	const title = bindText(block.title, ctx);
	const head = tone !== "" ? `[${tone}] ${title}` : title;
	const groups: string[][] = [[head]];
	const body = bindText(block.body, ctx);
	if (body !== "") groups.push(wrap(body, ctx.width));
	const actionLabels = (block.actions ?? [])
		.map((button) => bindText(button.label, ctx))
		.filter((label) => label !== "");
	if (actionLabels.length > 0) groups.push([`actions: ${actionLabels.join(", ")}`]);
	return joinBlocks(groups);
}

/** The props of `callout` this projection reads. */
type BindableCallout = {
	readonly tone: unknown;
	readonly title: unknown;
	readonly body?: unknown;
	readonly actions?: readonly { label: unknown }[] | undefined;
};

/** `chart`: one summary line per series (min, max, latest, count). */
function renderChart(block: ChartBlock, ctx: Ctx): string[] {
	const out: string[] = [];
	const title = bindText(block.title, ctx);
	if (title !== "") out.push(`## ${title}`);
	const unit = block.y?.unit !== undefined ? bindText(block.y.unit, ctx) : "";
	const format = block.y?.format;
	const fmtPoint = (value: number): string =>
		withUnit(fmt(value, format, ctx), unit);
	for (const series of block.series) {
		const name = bindText(series.name, ctx);
		const points = seriesPoints(series.data, ctx);
		if (points.length === 0) {
			out.push(`${name}: no data`);
			continue;
		}
		let min = points[0][1];
		let max = points[0][1];
		for (const [, y] of points) {
			if (y < min) min = y;
			if (y > max) max = y;
		}
		const latest = points[points.length - 1][1];
		out.push(
			`${name}: min ${fmtPoint(min)}, max ${fmtPoint(max)}, latest ${fmtPoint(latest)} ` +
				`(${points.length} point${points.length === 1 ? "" : "s"})`,
		);
	}
	for (const threshold of block.thresholds ?? []) {
		const at = fmt(threshold.at, "number", ctx);
		const label = bindText(threshold.label, ctx);
		out.push(label !== "" ? `threshold: ${label} at ${at}` : `threshold at ${at}`);
	}
	return out;
}

/** Validate a series' points down to `[number, number]` tuples. */
function seriesPoints(data: unknown, ctx: Ctx): [number, number][] {
	const raw = resolveBind(data, ctx);
	if (!Array.isArray(raw)) return [];
	const points: [number, number][] = [];
	for (const entry of raw) {
		if (
			Array.isArray(entry) &&
			entry.length >= 2 &&
			typeof entry[0] === "number" &&
			typeof entry[1] === "number"
		) {
			points.push([entry[0], entry[1]]);
		}
	}
	return points;
}

/** `meter`: `label: value`, or the bare value when it has no label. */
function renderMeter(block: BindableMeter, ctx: Ctx): string[] {
	const text = fmt(resolveBind(block.value, ctx), block.format, ctx);
	const label = bindText(block.label, ctx);
	return [label === "" ? text : labeled(label, text)];
}

/** The props of `meter` this projection reads. */
type BindableMeter = {
	readonly value: unknown;
	readonly format?: string | undefined;
	readonly label?: unknown;
};

/** `log`: one line per entry: `time [level] text`. */
function renderLog(block: BindableLog, ctx: Ctx): string[] {
	const raw = resolveBind(block.lines, ctx);
	if (!Array.isArray(raw)) return [];
	const lines: string[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const parts: string[] = [];
		const at = entry.at;
		if (at !== undefined && at !== null) {
			parts.push(formatValue(at, "time", ctx.locale, ctx.timeZone));
		}
		if (typeof entry.level === "string" && entry.level !== "") {
			parts.push(`[${entry.level}]`);
		}
		if (typeof entry.text === "string") parts.push(entry.text);
		lines.push(parts.join(" ").trimEnd());
	}
	return lines;
}

/** The props of `log` this projection reads. */
type BindableLog = { readonly lines: unknown };

/** `tree`: indented node labels. */
function renderTree(block: BindableTreeNodes, ctx: Ctx): string[] {
	const raw = resolveBind(block.nodes, ctx);
	if (!Array.isArray(raw)) return [];
	const lines: string[] = [];
	const walk = (node: JsonValue, depth: number): void => {
		if (!isRecord(node)) return;
		const label = typeof node.label === "string" ? node.label : "";
		lines.push(`${" ".repeat(depth * 2)}${label}`);
		if (Array.isArray(node.children)) {
			for (const child of node.children) walk(child, depth + 1);
		}
	};
	for (const node of raw) walk(node, 0);
	return lines;
}

/** The props of `tree` this projection reads. */
type BindableTreeNodes = { readonly nodes: unknown };

/** `diff`: `- `/`+ ` prefixed before/after lines under the path. */
function renderDiff(block: { before: string; after: string; path?: string }): string[] {
	const out: string[] = [];
	if (block.path !== undefined && block.path !== "") out.push(`--- ${block.path}`);
	for (const line of block.before.split("\n")) out.push(`- ${line}`);
	for (const line of block.after.split("\n")) out.push(`+ ${line}`);
	return out;
}

// ─── Collection ───────────────────────────────────────────────────────────

/** Render a `collection` in its display's text shape. */
function renderCollection(block: CollectionBlock, ctx: Ctx): string[] {
	const raw = block.items ? resolvePointer(ctx.data, block.items.$) : undefined;
	const items = (Array.isArray(raw) ? raw : []).filter(isRecord);
	const ordered = sortedItems(items, block.sort);
	if (block.display === "table" && block.columns !== undefined && block.columns.length > 0) {
		return renderTable(block.columns, ordered, ctx);
	}
	if (block.display === "grid") return renderGrid(block, ordered, ctx);
	if (block.display === "calendar" && block.time !== undefined) {
		return renderCalendar(block, ordered, ctx);
	}
	if (block.groupBy !== undefined && block.groupBy !== "") {
		return renderGrouped(block, ordered, ctx, block.display === "lanes");
	}
	return renderList(block, ordered, ctx, 0);
}

/** Apply the declared initial `sort` (stable; numeric when both are numbers). */
function sortedItems(
	items: readonly JsonObject[],
	sort: { field: string; dir: "asc" | "desc" } | undefined,
): JsonObject[] {
	if (sort === undefined) return [...items];
	const rawOf = (item: JsonObject): JsonValue => item[sort.field] ?? null;
	const sign = sort.dir === "desc" ? -1 : 1;
	return [...items].sort((a, b) => {
		const left = rawOf(a);
		const right = rawOf(b);
		if (typeof left === "number" && typeof right === "number") {
			if (left === right) return 0;
			return (left < right ? -1 : 1) * sign;
		}
		const leftKey = left === null ? "" : String(left);
		const rightKey = right === null ? "" : String(right);
		if (leftKey === rightKey) return 0;
		return (leftKey < rightKey ? -1 : 1) * sign;
	});
}

/** One resolved group: its heading and its items. */
interface Group {
	title: string;
	items: JsonObject[];
}

/**
 * Group items by `groupBy`: declared groups in declared order, then
 * unseen values in first-appearance ITEM order (never object-key
 * order). With no `groups`, every distinct value gets its own group.
 */
function groupItems(
	block: CollectionBlock,
	items: readonly JsonObject[],
	ctx: Ctx,
): Group[] {
	const by = block.groupBy as string;
	const groups: Group[] = [];
	const indexById = new Map<string, number>();
	for (const declared of block.groups ?? []) {
		indexById.set(declared.id, groups.length);
		groups.push({ title: bindText(declared.title, ctx), items: [] });
	}
	for (const item of items) {
		const value = item[by];
		const id = value === undefined || value === null ? "" : String(value);
		const index = indexById.get(id);
		if (index !== undefined) {
			groups[index].items.push(item);
			continue;
		}
		indexById.set(id, groups.length);
		groups.push({ title: id, items: [item] });
	}
	return groups;
}

/** Grouped rendering (`list` with `groupBy`, and `lanes` as sections). */
function renderGrouped(
	block: CollectionBlock,
	items: readonly JsonObject[],
	ctx: Ctx,
	asLanes: boolean,
): string[] {
	const groups: string[][] = [];
	for (const group of groupItems(block, items, ctx)) {
		const head = group.title !== "" ? [`## ${group.title}`] : [];
		const rows = group.items.map((item, index) =>
			listRow(block, item, index + 1, ctx, asLanes ? 1 : 0),
		);
		groups.push([...head, ...joinRows(rows)]);
	}
	return joinBlocks(groups);
}

/** Ungrouped `list` rows. */
function renderList(
	block: CollectionBlock,
	items: readonly JsonObject[],
	ctx: Ctx,
	depth: number,
): string[] {
	const rows = items.map((item, index) => listRow(block, item, index + 1, ctx, depth));
	return joinRows(rows);
}

/** One list row: the headline with its prefixes, then the card slots. */
function listRow(
	block: CollectionBlock,
	item: JsonObject,
	number: number,
	ctx: Ctx,
	depth: number,
): string[] {
	const indent = depth * 2;
	let prefix = "";
	if (block.numbered === true) prefix += `${number}. `;
	if (block.checkable !== undefined) {
		prefix += item[block.checkable] === true ? "[x] " : "[ ] ";
	}
	const title = bindText(block.item.title, ctx, item);
	const head = `${" ".repeat(indent)}${prefix}${title}`.trimEnd();
	const card = cardLines(block.item, item, ctx, indent + 2);

	const nested: string[] = [];
	if (block.children !== undefined && block.children !== "") {
		const raw = item[block.children];
		if (Array.isArray(raw)) {
			const children = raw.filter(isRecord);
			nested.push(
				...joinRows(
					children.map((child, index) => listRow(block, child, index + 1, ctx, depth + 1)),
				),
			);
		}
	}
	return [head, ...card, ...nested];
}

/**
 * The card slots below the title (§5.5.1 slot order): eyebrow above
 * the headline is folded into the caller; here subtitle, body, image,
 * badges, meta, metrics, status, deps. Tone, icon, actions and quiet
 * are visual or interactive and carry no text.
 */
function cardLines(card: Card, item: JsonValue, ctx: Ctx, indent: number): string[] {
	const lines: string[] = [];
	const pad = " ".repeat(indent);
	const push = (line: string): void => {
		if (line.trim() !== "") lines.push(line);
	};
	const pushLabeled = (label: string, value: string): void => {
		const line = cardLabeled(label, value);
		if (line !== null) lines.push(`${pad}${line}`);
	};

	const subtitle = bindText(card.subtitle, ctx, item);
	push(`${pad}${subtitle}`);
	const body = bindText(card.body, ctx, item);
	for (const line of wrap(body, Math.max(1, ctx.width - indent))) {
		push(`${pad}${line}`);
	}
	const image = bindText(card.image, ctx, item);
	pushLabeled("image", image);

	const badges = (card.badges ?? [])
		.map((badge) => bindText(badge.text, ctx, item))
		.filter((text) => text !== "");
	pushLabeled("badges", badges.join(", "));

	const metaParts: string[] = [];
	for (const entry of card.meta ?? []) {
		if ("person" in entry) {
			const name = bindText(entry.person.name, ctx, item);
			if (name !== "") metaParts.push(name);
		} else if ("time" in entry) {
			const at = resolveBind(entry.time, ctx, item);
			const text = at === undefined ? "" : fmt(at, entry.format ?? "datetime", ctx);
			if (text !== "") metaParts.push(text);
		} else {
			const text = bindText(entry.text, ctx, item);
			if (text !== "") metaParts.push(text);
		}
	}
	pushLabeled("meta", metaParts.join(" · "));

	for (const metric of card.metrics ?? []) {
		const label = bindText(metric.label, ctx, item);
		const value = fmt(resolveBind(metric.value, ctx, item), metric.format, ctx);
		pushLabeled(label, value);
	}

	if (card.status !== undefined) {
		pushLabeled("status", bindText(card.status.label, ctx, item));
	}

	const depsRaw = resolveBind(card.deps, ctx, item);
	if (Array.isArray(depsRaw)) {
		const deps = depsRaw.filter((dep): dep is string => typeof dep === "string");
		pushLabeled("after", deps.join(", "));
	}
	return lines;
}

/** `grid`: each item as its own small card. */
function renderGrid(
	block: CollectionBlock,
	items: readonly JsonObject[],
	ctx: Ctx,
): string[] {
	return joinBlocks(
		items.map((item) => {
			const title = bindText(block.item.title, ctx, item);
			return [title, ...cardLines(block.item, item, ctx, 2)];
		}),
	);
}

/** `calendar`: agenda lines — `start  title` per item, in data order. */
function renderCalendar(
	block: CollectionBlock,
	items: readonly JsonObject[],
	ctx: Ctx,
): string[] {
	const time = block.time;
	if (time === undefined) return [];
	const lines: string[] = [];
	for (const item of items) {
		const at = item[time.start];
		const when =
			at === undefined || at === null ? "" : `${fmt(at, "datetime", ctx)}  `;
		const title = bindText(block.item.title, ctx, item);
		lines.push(`${when}${title}`.trimEnd());
	}
	return lines;
}

/** `table`: aligned columns, `priority: low` columns last. */
function renderTable(
	columns: readonly CollectionColumn[],
	items: readonly JsonObject[],
	ctx: Ctx,
): string[] {
	const ordered = [
		...columns.filter((column) => column.priority !== "low"),
		...columns.filter((column) => column.priority === "low"),
	];
	const header = ordered.map((column) => bindText(column.label, ctx));
	const rows = items.map((item) =>
		ordered.map((column) => fmt(item[column.field], column.format, ctx)),
	);

	const widths = ordered.map((_, index) => {
		let width = header[index].length;
		for (const row of rows) width = Math.max(width, row[index].length);
		return width;
	});
	const cells = (values: readonly string[]): string =>
		values
			.map((value, index) =>
				index === values.length - 1 ? value : value.padEnd(widths[index]),
			)
			.join("  ");

	const lines = [cells(header)];
	lines.push(
		ordered.map((_, index) => "-".repeat(widths[index])).join("  "),
	);
	for (const row of rows) lines.push(cells(row));
	return lines;
}

// ─── Form and fields ──────────────────────────────────────────────────────

/** `form`: its fields (sections as `##` headings) and the submit label. */
function renderForm(block: FormBlock, ctx: Ctx): string[] {
	const groups: string[][] = [];
	const root = block.bind === "/" ? "" : block.bind;
	for (const child of block.children) {
		if (child.type === "section") {
			const head: string[] = [];
			const title = bindText(child.title, ctx);
			if (title !== "") head.push(`## ${title}`);
			const fields = (child.children as readonly (Block | Field)[])
				.filter((entry): entry is Field => isField(entry))
				.map((field) => fieldLines(field, `${root}/${field.name}`, ctx));
			groups.push(joinBlocks([head, ...fields]));
		} else {
			groups.push(fieldLines(child, `${root}/${child.name}`, ctx));
		}
	}
	const submit = bindText(block.submitLabel, ctx);
	if (submit !== "") groups.push([`submit: ${submit}`]);
	return joinBlocks(groups);
}

/** One field's `label: value` lines (choices list their options). */
function fieldLines(field: Field, path: string, ctx: Ctx): string[] {
	const label = bindText(field.label, ctx);
	const value = resolvePointer(ctx.data, path);
	switch (field.type) {
		case "toggle":
			return [`${labeled(label, value === true ? "true" : "false")}`];
		case "secret":
		case "file": {
			const set = value !== undefined && value !== null && value !== "";
			return [labeled(label, set ? "set" : "not set")];
		}
		case "choice":
			return choiceLines(field, label, value, ctx);
		case "list": {
			const entries = Array.isArray(value) ? value : [];
			const lines = [labeled(label, "")];
			for (const entry of entries) {
				const text =
					entry === null || entry === undefined
						? ""
						: typeof entry === "object"
							? formatValue(entry as JsonValue, undefined, ctx.locale)
							: textOf(entry, ctx);
				lines.push(`  - ${text}`);
			}
			return lines;
		}
		case "date":
		case "datetime":
			return [labeled(label, fmt(value, field.type, ctx))];
		case "number":
			return [labeled(label, fmt(value, field.format, ctx))];
		default:
			return [labeled(label, textOf(value, ctx))];
	}
}

/** A choice: the current selection plus its options as checkbox rows. */
function choiceLines(
	field: ChoiceField,
	label: string,
	value: JsonValue | undefined,
	ctx: Ctx,
): string[] {
	// Spec §5.6: the value is the selected id (single) or ids (multi);
	// with `allowOther` and text entered it is `{other: text}` (single)
	// or the ids plus `{other: text}` as the last element (multi).
	const selected: string[] = [];
	let other: string | null = null;
	const readEntry = (entry: JsonValue): void => {
		if (typeof entry === "string") selected.push(entry);
		else if (
			isRecord(entry) &&
			typeof entry.other === "string" &&
			entry.other !== ""
		) {
			other = entry.other;
		}
	};
	if (Array.isArray(value)) {
		for (const entry of value) readEntry(entry);
	} else if (value !== undefined) {
		readEntry(value);
	}
	const summary = other === null ? selected.join(", ") : [...selected, `other: ${other}`].join(", ");
	const lines = [labeled(label, summary)];
	const options = resolveBind(field.options, ctx);
	if (Array.isArray(options)) {
		for (const option of options) {
			if (!isRecord(option)) continue;
			// SAFETY: `isRecord` proved a JsonObject; the option shape is
			// then read field-by-field with typeof guards, so the cast only
			// names the already-checked structure.
			const choice = option as unknown as ChoiceOption;
			if (typeof choice.id !== "string") continue;
			const mark = selected.includes(choice.id) ? "[x]" : "[ ]";
			const optionLabel = bindText(choice.label, ctx);
			lines.push(`  ${mark} ${optionLabel}`);
		}
	}
	return lines;
}
