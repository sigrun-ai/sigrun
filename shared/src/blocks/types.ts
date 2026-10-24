/**
 * The block-set wire types (UI-blocks U0, spec §4/§5/§6.1/§12.2).
 *
 * Types only (plus the one version constant): the runtime half lives in
 * `ops.ts`/`lttb.ts`/`icons.ts`, and everything here is the CHANNEL
 * CONTRACT both clients (webui, tui) and the server share. Purity is
 * guarded by `test/views-purity.test.ts`: every specifier resolves
 * inside `shared/src/`, imports are type-only, and there is no
 * dependency beyond the leaf itself.
 *
 * Convention: a prop that can change at runtime is `T | Binding`
 * (spec §4.2). STRUCTURAL props — `type`, `id`, `display`, `groupBy`,
 * `groups`, `reorder`, `select`, `mode`, field `name`s, `columns`, and
 * every handler name — are literals, never bindings.
 */

import type { IconName } from "./icons.js";
import type { JsonObject, JsonValue } from "../json.js";

/** The block-set version this module defines (spec §4.4: this spec is `v: 1`). */
export const BLOCK_SET_VERSION = 1;

/** Meaning-based colouring (spec §10.1); each maps to the active theme's tokens. */
export type Tone = "neutral" | "accent" | "good" | "warn" | "bad" | "info";

/** Channel-defined width tokens (the webui maps s/m/l to 16/24/32 rem, the TUI to 30/45/60 cells). */
export type Size = "s" | "m" | "l";

/** A JSON Pointer into the surface's data model (spec §4.2). */
export type Binding = { $: string };

/** Anything a block can show whose value lives in the data model. */
export type Bindable<T> = T | Binding;

/** Where a surface appears (spec §3); each placement allows a subset of blocks (§5.7). */
export type Placement = "view" | "panel" | "settings" | "chat" | "interaction" | "ambient";

/**
 * The only width-dependent thing a block can say (spec §12.2): hidden in
 * a compact container. Other values are added when a case needs them.
 */
export type WidthCondition = "atLeast:regular";

/** The value formats (spec §5.3), used on `stat`, `meter`, table columns and chart axes. */
export type Format =
	| "number"
	| "compact"
	| "percent"
	| `currency:${string}`
	| "bytes"
	| "duration"
	| "datetime"
	| "date"
	| "time"
	| "relative";

// ─── Actions (spec §6.1, verbatim) ────────────────────────────────────────

export type Action =
	| { type: "submit"; name: string; turn?: boolean; confirm?: Confirm }
	| { type: "navigate"; params?: JsonObject; target?: CoreTarget }
	| { type: "move"; name: string; turn?: boolean }
	| { type: "edit"; name: string; turn?: boolean } // checkbox toggles, inline field edits
	| { type: "open"; url: string } // https, http or mailto; new tab / OSC 8 link
	| { type: "copy"; text: string | Binding }
	| { type: "restart"; confirm?: Confirm }; // core, admin, settings only

export type Confirm = {
	title: string;
	body?: string;
	tone?: "bad" | "warn";
	confirmLabel?: string;
};

export type CoreTarget =
	| { conversation: number }
	| { job: string }
	| { settings: string }
	| { view: { extension: string; id: string; params?: JsonObject } };

/** A block-offered button (spec §6.1): where `Action` objects appear. */
export interface ActionButton {
	id: string;
	label: Bindable<string>;
	icon?: IconName;
	action: Action;
}

// ─── Block bases ──────────────────────────────────────────────────────────

/** Props every block may carry (spec §4.1). */
export interface BlockBase {
	/** Required on blocks that carry actions or inputs; unique within the tree. */
	readonly id?: string;
	readonly visibleAt?: WidthCondition;
	/** Plain text a channel shows when it can't render the block. */
	readonly fallback?: string;
}

/** A block tree: the root block plus the version it was written against. */
export type Tree = { v: number; root: Block };

// ─── Shell (spec §5.1) ────────────────────────────────────────────────────

/** The state shown instead of `main` when main's first collection is empty. */
export interface PageEmpty {
	icon: IconName;
	title: string;
	hint?: string;
}

export interface PageBlock extends BlockBase {
	readonly type: "page";
	readonly title: Bindable<string>;
	readonly subtitle?: Bindable<string>;
	/** A `choice` field in the header; selecting navigates. */
	readonly switcher?: ChoiceField;
	readonly actions?: readonly ActionButton[];
	/** Blocks for the list column. */
	readonly sidebar?: readonly Block[];
	readonly main: readonly Block[];
	/** Blocks for a side pane, shown when non-empty. */
	readonly detail?: readonly Block[];
	readonly empty?: PageEmpty;
}

// ─── Layout (spec §5.2) ───────────────────────────────────────────────────

export interface StackBlock extends BlockBase {
	readonly type: "stack";
	readonly children: readonly Block[];
	readonly gap?: Size;
}

export interface ColumnChild {
	readonly weight?: number;
	readonly minWidth?: Size;
	readonly block: Block;
}

export interface ColumnsBlock extends BlockBase {
	readonly type: "columns";
	readonly children: readonly ColumnChild[];
}

export interface GridChild {
	readonly span?: 1 | 2 | "full";
	readonly block: Block;
}

export interface GridBlock extends BlockBase {
	readonly type: "grid";
	readonly minItemWidth: Size;
	readonly children: readonly GridChild[];
}

export interface SectionBlock extends BlockBase {
	readonly type: "section";
	readonly title?: Bindable<string>;
	readonly subtitle?: Bindable<string>;
	readonly tone?: Bindable<Tone>;
	readonly collapsible?: boolean;
	readonly collapsed?: boolean;
	/** Blocks; inside a `form`, fields and nested `section`s. */
	readonly children: readonly (Block | Field)[];
}

// ─── Content (spec §5.3) ──────────────────────────────────────────────────

export interface MarkdownBlock extends BlockBase {
	readonly type: "markdown";
	readonly text: Bindable<string>;
}

export interface FieldsRow {
	readonly label: Bindable<string>;
	readonly value: Bindable<JsonValue>;
	readonly tone?: Bindable<Tone>;
	readonly icon?: Bindable<IconName>;
}

export interface FieldsBlock extends BlockBase {
	readonly type: "fields";
	readonly rows: Bindable<readonly FieldsRow[]>;
}

export interface StatBlock extends BlockBase {
	readonly type: "stat";
	readonly label: Bindable<string>;
	readonly value: Bindable<JsonValue>;
	readonly unit?: Bindable<string>;
	readonly format?: Format;
	readonly tone?: Bindable<Tone>;
	readonly icon?: Bindable<IconName>;
	readonly size?: Size;
	readonly caption?: Bindable<string>;
	readonly sparkline?: Bindable<readonly number[]>;
}

export interface CalloutBlock extends BlockBase {
	readonly type: "callout";
	readonly tone: Bindable<Tone>;
	readonly title: Bindable<string>;
	/** Markdown. */
	readonly body?: Bindable<string>;
	readonly actions?: readonly ActionButton[];
}

export interface ImageBlock extends BlockBase {
	readonly type: "image";
	readonly src: Bindable<string>;
	/** Required. */
	readonly alt: Bindable<string>;
}

// ─── Chart (spec §5.4) ────────────────────────────────────────────────────

export interface ChartAxisX {
	readonly kind: "time" | "category" | "number";
	readonly format?: Format;
	readonly label?: Bindable<string>;
}

export interface ChartAxisY {
	readonly format?: Format;
	readonly unit?: Bindable<string>;
	readonly label?: Bindable<string>;
	readonly min?: number;
	readonly max?: number;
}

export interface ChartSeries {
	readonly name: Bindable<string>;
	readonly kind: "line" | "area" | "bar";
	readonly data: Binding | readonly [number, number][];
}

export interface ChartThreshold {
	readonly at: number;
	readonly tone: Tone;
	readonly label?: Bindable<string>;
}

export interface ChartBlock extends BlockBase {
	readonly type: "chart";
	readonly title?: Bindable<string>;
	readonly x: ChartAxisX;
	readonly y?: ChartAxisY;
	readonly series: readonly ChartSeries[];
	/** Stack `area` and `bar` series. */
	readonly stacked?: boolean;
	/** Drawn as horizontal rules. */
	readonly thresholds?: readonly ChartThreshold[];
}

// ─── Meter / log / tree / diff / details (spec §5.3) ─────────────────────

export interface MeterThreshold {
	readonly at: number;
	readonly tone: Tone;
}

export interface MeterBlock extends BlockBase {
	readonly type: "meter";
	readonly value: Bindable<number>;
	/** Default 0. */
	readonly min?: number;
	/** Default 1. */
	readonly max?: number;
	readonly label?: Bindable<string>;
	readonly format?: Format;
	readonly thresholds?: readonly MeterThreshold[];
}

export interface LogLine {
	readonly at?: number | string;
	readonly level?: string;
	readonly text: string;
}

export interface LogBlock extends BlockBase {
	readonly type: "log";
	readonly lines: Binding;
	readonly follow?: boolean;
	readonly wrap?: boolean;
	/** Per-level tones; default `error`→bad, `warn`→warn, `info`→neutral, `debug`→subtle. */
	readonly tones?: Readonly<Record<string, Tone>>;
}

export interface TreeNode {
	readonly id: string;
	readonly label: string;
	readonly icon?: IconName;
	readonly hasChildren?: boolean;
	readonly children?: readonly TreeNode[];
}

export interface TreeBlock extends BlockBase {
	readonly type: "tree";
	readonly nodes: Binding;
	/** Handler for lazy children; it returns `DataOps` inserting them. */
	readonly onExpand?: string;
	readonly onActivate?: Action;
}

export interface DiffBlock extends BlockBase {
	readonly type: "diff";
	readonly before: string;
	readonly after: string;
	readonly path?: string;
	readonly lang?: string;
}

export interface DetailsBlock extends BlockBase {
	readonly type: "details";
	/** Opaque JSON; shown collapsed and pretty-printed. */
	readonly value: JsonValue;
}

// ─── Collection (spec §5.5) and card slots (§5.5.1) ──────────────────────

/** One inline fact of a card's `meta` slot (spec §5.5.1). */
export type CardMeta =
	| { icon?: Bindable<IconName>; text: Bindable<string> }
	| { person: { user: Bindable<string>; name: Bindable<string> } }
	| { time: Bindable<string>; format?: Format };

export interface CardMetric {
	readonly label: Bindable<string>;
	readonly value: Bindable<JsonValue>;
	readonly format?: Format;
}

export interface CardBadge {
	readonly text: Bindable<string>;
	readonly tone?: Bindable<Tone>;
}

export interface CardStatus {
	readonly label: Bindable<string>;
	readonly tone?: Bindable<Tone>;
	readonly spinner?: Bindable<boolean>;
}

/**
 * The card template (spec §5.5.1): every slot except `title` is
 * optional; each takes a binding relative to the item.
 */
export interface Card {
	readonly eyebrow?: Bindable<string>;
	readonly title: Bindable<string>;
	readonly subtitle?: Bindable<string>;
	/** Markdown, clamped to 4 lines in lists and lanes. */
	readonly body?: Bindable<string>;
	readonly image?: Bindable<string>;
	readonly icon?: Bindable<IconName>;
	readonly badges?: readonly CardBadge[];
	readonly meta?: readonly CardMeta[];
	readonly metrics?: readonly CardMetric[];
	/** Accent stripe / TUI marker. */
	readonly tone?: Bindable<Tone>;
	/** Up to 3 buttons, then an overflow menu. */
	readonly actions?: readonly ActionButton[];
	readonly status?: CardStatus;
	/** The item is folded away by default behind an "N more" toggle. */
	readonly quiet?: Bindable<boolean>;
	/** Ids of items this one depends on ("after: …" markers). */
	readonly deps?: Bindable<readonly string[]>;
}

export interface CollectionGroup {
	readonly id: string;
	readonly title: Bindable<string>;
	readonly tone?: Tone;
	readonly collapsed?: boolean;
}

export interface CollectionSort {
	readonly field: string;
	readonly dir: "asc" | "desc";
}

export interface BulkAction {
	readonly id: string;
	readonly label: Bindable<string>;
	readonly icon?: IconName;
	readonly onSubmit: string;
	readonly form?: Tree;
}

export interface CollectionColumn {
	readonly field: string;
	readonly label: Bindable<string>;
	readonly format?: Format;
	readonly cell?: "text" | "meter" | "badge";
	readonly sortable?: boolean;
	readonly priority?: "high" | "low";
	readonly width?: Size;
}

export interface CollectionTime {
	/** Item field names. */
	readonly start: string;
	readonly end?: string;
	readonly allDay?: string;
	readonly range: "month" | "week" | "day" | "agenda";
	/** Enables dragging an item's end. */
	readonly onResize?: string;
	/** Enables drag-to-create; payload `{start, end}`. */
	readonly onCreate?: string;
}

export interface CollectionBlock extends BlockBase {
	readonly type: "collection";
	/** Binding to an array (each item has a unique `id`) — or the array
	 *  itself as literal rows, the only legal shape in ambient placement
	 *  (the ambient envelope carries no data document). */
	readonly items: Binding | readonly JsonValue[];
	/** The card template. */
	readonly item: Card;
	readonly display: "list" | "table" | "lanes" | "grid" | "calendar";
	/** Item field to group on. */
	readonly groupBy?: string;
	/** Ordered groups; with `lanes` these are the lanes. */
	readonly groups?: readonly CollectionGroup[];
	readonly sort?: CollectionSort;
	readonly select?: "single" | "multi";
	readonly bulkActions?: readonly BulkAction[];
	/** Item field holding a boolean; toggling calls `onCheck`. */
	readonly checkable?: string;
	/** Requires `onMove`. */
	readonly reorder?: { within?: boolean; across?: boolean };
	/** Item field holding nested items (indented in `list`). */
	readonly children?: string;
	/** `list` only. */
	readonly numbered?: boolean;
	/** Handler names (spec §6.1). */
	readonly onMove?: string;
	readonly onCheck?: string;
	/** An `Action` run when an item is activated. */
	readonly onActivate?: Action;
	/** `table` only. */
	readonly columns?: readonly CollectionColumn[];
	/** `calendar` only. */
	readonly time?: CollectionTime;
	/** `grid` only: `wrap` (default) or `scroll` (one horizontal row). */
	readonly overflow?: "wrap" | "scroll";
}

// ─── Form and fields (spec §5.6) ──────────────────────────────────────────

/** Props shared by every field type (spec §5.6). */
export interface FieldBase {
	/** The path its value is read from and written to, relative to the form's `bind`. */
	readonly name: string;
	readonly label: Bindable<string>;
	readonly help?: Bindable<string>;
	readonly placeholder?: Bindable<string>;
	readonly required?: boolean;
	readonly disabled?: boolean;
	/** §13; settings only. */
	readonly apply?: "live" | "restart";
	readonly min?: number;
	readonly max?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly pattern?: string;
}

export interface TextField extends FieldBase {
	readonly type: "text";
	readonly kind?: "plain" | "search" | "email" | "url";
	/** Binding to strings. */
	readonly suggest?: Binding;
}

export interface LongtextField extends FieldBase {
	readonly type: "longtext";
	readonly syntax?: "plain" | "markdown" | "code";
	readonly lang?: string;
	readonly rows?: number;
}

export interface NumberField extends FieldBase {
	readonly type: "number";
	readonly step?: number;
	readonly format?: Format;
}

export interface ToggleField extends FieldBase {
	readonly type: "toggle";
}

export interface ChoiceOption {
	readonly id: string;
	readonly label: Bindable<string>;
	readonly description?: Bindable<string>;
	readonly tone?: Tone;
	readonly recommended?: boolean;
	/** Markdown shown beside the options while one is focused (interactions). */
	readonly preview?: string;
}

export interface ChoiceField extends FieldBase {
	readonly type: "choice";
	/** Literal or binding. */
	readonly options: Bindable<readonly ChoiceOption[]>;
	readonly multi?: boolean;
	readonly allowOther?: { label?: string };
}

export interface DateField extends FieldBase {
	readonly type: "date";
}

export interface DatetimeField extends FieldBase {
	readonly type: "datetime";
}

export interface DatePreset {
	readonly id: string;
	readonly label: string;
	readonly duration: string;
}

export interface DaterangeField extends FieldBase {
	readonly type: "daterange";
	readonly presets?: readonly DatePreset[];
}

/** Write-only; the channel shows `set (stored)` / `set (env)` / `not set` from a bound status. */
export interface SecretField extends FieldBase {
	readonly type: "secret";
}

export interface FileField extends FieldBase {
	readonly type: "file";
	/** MIME patterns. */
	readonly accept?: string;
	readonly maxBytes?: number;
	readonly multi?: boolean;
	/** Handler; uploads through the surface's upload route. */
	readonly onUpload: string;
}

export interface ListField extends FieldBase {
	readonly type: "list";
	/** Fields for one entry (a repeatable group). */
	readonly item: Field;
	readonly reorder?: boolean;
	readonly min?: number;
	readonly max?: number;
}

export type Field =
	| TextField
	| LongtextField
	| NumberField
	| ToggleField
	| ChoiceField
	| DateField
	| DatetimeField
	| DaterangeField
	| SecretField
	| FileField
	| ListField;

export interface FormBlock extends BlockBase {
	readonly type: "form";
	/** Path of the object the fields read and write. */
	readonly bind: string;
	/** `submit` (a Save/Send button), `live` (every change after 300 ms), `inline` (one row). */
	readonly mode: "submit" | "live" | "inline";
	readonly onSubmit?: string;
	readonly submitLabel?: Bindable<string>;
	/** Chat only (§6.2). */
	readonly turn?: boolean;
	/** Fields and `section`s grouping them. */
	readonly children: readonly (Field | SectionBlock)[];
}

// ─── The closed block set (spec §5) ───────────────────────────────────────

export type Block =
	| PageBlock
	| StackBlock
	| ColumnsBlock
	| GridBlock
	| SectionBlock
	| MarkdownBlock
	| FieldsBlock
	| StatBlock
	| CalloutBlock
	| ImageBlock
	| ChartBlock
	| MeterBlock
	| LogBlock
	| TreeBlock
	| DiffBlock
	| DetailsBlock
	| CollectionBlock
	| FormBlock;

// ─── Data updates (spec §4.3) ─────────────────────────────────────────────

export type DataOp =
	| { op: "set"; path: string; value: JsonValue }
	| { op: "remove"; path: string }
	| { op: "insert"; path: string; value: JsonValue } // path ends in an array index or "-"
	| { op: "move"; from: string; path: string }; // array reorder / cross-array move

/** What extensions and tools hand the server (no rev). */
export type DataOps = { ops: DataOp[] };

/** What the server sends channels (it assigns the monotonic `rev`). */
export type DataUpdate = { rev: number; ops: DataOp[] };
