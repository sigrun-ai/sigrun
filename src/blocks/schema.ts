/**
 * The typebox wire schemas for every block and field (spec §5/§6.1),
 * each compiled once into its own `Validator` (spec §14.2 validation).
 *
 * Design notes:
 * - Schemas are the wire contract, so they deliberately do NOT set
 *   `additionalProperties: false`: unknown props pass through and
 *   channels ignore them (the block-set version governs what exists).
 * - `Tone`, `IconName` and `Format` are enums/patterns built from the
 *   shared constants; an unknown icon name fails here, at the icon
 *   prop's own path.
 * - Bindable props are `Union([literal, Binding])` throughout; the
 *   literal-ness of STRUCTURAL props (`display`, `groups`, `reorder`,
 *   `mode`, field `name`s, `columns`, handler names) is enforced by the
 *   second walk in `validate.ts`, not the schema, so the error can say
 *   "must be a literal" instead of an anyOf mismatch.
 * - Child slots (`children`, `sidebar`, `main`, `detail`,
 *   `columns[].block`, `collection.item`, `form` children, a field's
 *   `list.item`, `page.switcher`, a bulk action's `form.root`) are
 *   deliberately loose here (any object): `validate.ts` walks the tree
 *   and validates every child node against ITS compiled validator, so
 *   one broken block is one precise error instead of a union mismatch
 *   per sibling branch.
 * - `Compile` (typebox/compile) builds each validator; its errors are
 *   read from `instancePath`, relative to the node the validator ran
 *   against.
 */

import { Compile } from "typebox/compile";
import type { Validator } from "typebox/compile";
import { Type } from "typebox";
import { ICON_NAMES } from "@sigrun/shared/blocks";

// ─── atoms ────────────────────────────────────────────────────────────────

/** Any JSON value (spec: null, boolean, number, string, array, object). */
const JsonValue = Type.Unsafe({
	anyOf: [
		{ type: "null" },
		{ type: "boolean" },
		{ type: "number" },
		{ type: "string" },
		{ type: "array", items: { $ref: "JsonValue" } },
		{ type: "object" },
	],
});

/** A JSON Pointer binding into the data model (spec §4.2). */
const Binding = Type.Object({ $: Type.String() });

/** Meaning-based tones (spec §10.1). */
const Tone = Type.Unsafe({
	type: "string",
	enum: ["neutral", "accent", "good", "warn", "bad", "info"],
});

/** Icons: the closed 49-name set (spec §10.2). */
const IconName = Type.Unsafe({ type: "string", enum: ICON_NAMES });

/** Width tokens `s`/`m`/`l`. */
const Size = Type.Unsafe({ type: "string", enum: ["s", "m", "l"] });

/** The one width condition with a case (spec §12.2). */
const WidthCondition = Type.Unsafe({ type: "string", enum: ["atLeast:regular"] });

/** The v1 format set (spec §5.3), including `currency:<ISO 4217>`. */
const Format = Type.Unsafe({
	anyOf: [
		{
			type: "string",
			enum: [
				"number",
				"compact",
				"percent",
				"bytes",
				"duration",
				"datetime",
				"date",
				"time",
				"relative",
			],
		},
		{ type: "string", pattern: "^currency:[A-Za-z]{3}$" },
	],
});

/** `T | Binding` unions for bindable props (referenced by name). */
const BindableString = Type.Union([Type.String(), Type.Ref("Binding")]);
const BindableNumber = Type.Union([Type.Number(), Type.Ref("Binding")]);
const BindableBoolean = Type.Union([Type.Boolean(), Type.Ref("Binding")]);
const BindableJsonValue = Type.Union([Type.Ref("JsonValue"), Type.Ref("Binding")]);
const BindableTone = Type.Union([Type.Ref("Tone"), Type.Ref("Binding")]);
const BindableIcon = Type.Union([Type.Ref("IconName"), Type.Ref("Binding")]);

/** Any object: the loose child slots (validated by the walk, not here). */
const AnyObject = Type.Object({}, { additionalProperties: true });

/** Props every block may carry (spec §4.1). */
const BlockBase = {
	id: Type.Optional(Type.String()),
	visibleAt: Type.Optional(WidthCondition),
	fallback: Type.Optional(Type.String()),
};

// ─── actions (spec §6.1, verbatim) ────────────────────────────────────────

const CoreTarget = Type.Union([
	Type.Object({ conversation: Type.Integer() }),
	Type.Object({ job: Type.String() }),
	Type.Object({ settings: Type.String() }),
	Type.Object({
		view: Type.Object({
			extension: Type.String(),
			id: Type.String(),
			params: Type.Optional(Type.Object({}, { additionalProperties: true })),
		}),
	}),
]);

const Confirm = Type.Object({
	title: Type.String(),
	body: Type.Optional(Type.String()),
	tone: Type.Optional(Type.Unsafe({ type: "string", enum: ["bad", "warn"] })),
	confirmLabel: Type.Optional(Type.String()),
});

const Action = Type.Union([
	Type.Object({
		type: Type.Literal("submit"),
		name: Type.String(),
		turn: Type.Optional(Type.Boolean()),
		confirm: Type.Optional(Type.Ref("Confirm")),
	}),
	Type.Object({
		type: Type.Literal("navigate"),
		params: Type.Optional(Type.Object({}, { additionalProperties: true })),
		target: Type.Optional(Type.Ref("CoreTarget")),
	}),
	Type.Object({
		type: Type.Literal("move"),
		name: Type.String(),
		turn: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		type: Type.Literal("edit"),
		name: Type.String(),
		turn: Type.Optional(Type.Boolean()),
	}),
	Type.Object({ type: Type.Literal("open"), url: Type.String() }),
	Type.Object({
		type: Type.Literal("copy"),
		text: Type.Union([Type.String(), Type.Ref("Binding")]),
	}),
	Type.Object({ type: Type.Literal("restart"), confirm: Type.Optional(Type.Ref("Confirm")) }),
]);

/** A block-offered button (spec §6.1). */
const ActionButton = Type.Object({
	id: Type.String(),
	label: BindableString,
	icon: Type.Optional(Type.Ref("IconName")),
	action: Type.Ref("Action"),
});

// ─── field fragments (spec §5.6) ──────────────────────────────────────────

/** The props every field type shares (spec §5.6). */
const FieldBase = {
	name: Type.String(),
	label: BindableString,
	help: Type.Optional(BindableString),
	placeholder: Type.Optional(BindableString),
	required: Type.Optional(Type.Boolean()),
	disabled: Type.Optional(Type.Boolean()),
	/** §13; settings only. */
	apply: Type.Optional(Type.Unsafe({ type: "string", enum: ["live", "restart"] })),
	min: Type.Optional(Type.Number()),
	max: Type.Optional(Type.Number()),
	minLength: Type.Optional(Type.Integer()),
	maxLength: Type.Optional(Type.Integer()),
	pattern: Type.Optional(Type.String()),
};

/** A `choice` option (spec §5.6). */
const ChoiceOption = Type.Object({
	id: Type.String(),
	label: BindableString,
	description: Type.Optional(BindableString),
	tone: Type.Optional(Type.Ref("Tone")),
	recommended: Type.Optional(Type.Boolean()),
	preview: Type.Optional(Type.String()),
});

// ─── block schemas (spec §5.1–5.5); child slots are loose ─────────────────

const PageBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("page"),
	title: BindableString,
	subtitle: Type.Optional(BindableString),
	switcher: Type.Optional(AnyObject),
	actions: Type.Optional(Type.Array(Type.Ref("ActionButton"))),
	sidebar: Type.Optional(Type.Array(AnyObject)),
	main: Type.Array(AnyObject),
	detail: Type.Optional(Type.Array(AnyObject)),
	empty: Type.Optional(
		Type.Object({
			icon: Type.Ref("IconName"),
			title: Type.String(),
			hint: Type.Optional(Type.String()),
		}),
	),
});

const StackBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("stack"),
	children: Type.Array(AnyObject),
	gap: Type.Optional(Size),
});

const ColumnsBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("columns"),
	children: Type.Array(
		Type.Object({
			weight: Type.Optional(Type.Number()),
			minWidth: Type.Optional(Size),
			block: AnyObject,
		}),
	),
});

const GridBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("grid"),
	minItemWidth: Size,
	children: Type.Array(
		Type.Object({
			span: Type.Optional(Type.Unsafe({ type: ["integer", "string"], enum: [1, 2, "full"] })),
			block: AnyObject,
		}),
	),
});

const SectionBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("section"),
	title: Type.Optional(BindableString),
	subtitle: Type.Optional(BindableString),
	tone: Type.Optional(BindableTone),
	collapsible: Type.Optional(Type.Boolean()),
	collapsed: Type.Optional(Type.Boolean()),
	children: Type.Array(AnyObject),
});

const MarkdownBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("markdown"),
	text: BindableString,
});

const FieldsRow = Type.Object({
	label: BindableString,
	value: BindableJsonValue,
	tone: Type.Optional(BindableTone),
	icon: Type.Optional(BindableIcon),
});

const FieldsBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("fields"),
	rows: Type.Union([Type.Array(FieldsRow), Type.Ref("Binding")]),
});

const StatBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("stat"),
	label: BindableString,
	value: BindableJsonValue,
	unit: Type.Optional(BindableString),
	format: Type.Optional(Format),
	tone: Type.Optional(BindableTone),
	icon: Type.Optional(BindableIcon),
	size: Type.Optional(Size),
	caption: Type.Optional(BindableString),
	sparkline: Type.Optional(Type.Array(Type.Number())),
});

const CalloutBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("callout"),
	tone: BindableTone,
	title: BindableString,
	body: Type.Optional(BindableString),
	actions: Type.Optional(Type.Array(Type.Ref("ActionButton"))),
});

const ImageBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("image"),
	src: BindableString,
	alt: BindableString,
});

const ChartBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("chart"),
	title: Type.Optional(BindableString),
	x: Type.Object({
		kind: Type.Unsafe({ type: "string", enum: ["time", "category", "number"] }),
		format: Type.Optional(Format),
		label: Type.Optional(BindableString),
	}),
	y: Type.Optional(
		Type.Object({
			format: Type.Optional(Format),
			unit: Type.Optional(BindableString),
			label: Type.Optional(BindableString),
			min: Type.Optional(Type.Number()),
			max: Type.Optional(Type.Number()),
		}),
	),
	series: Type.Array(
		Type.Object({
			name: BindableString,
			kind: Type.Unsafe({ type: "string", enum: ["line", "area", "bar"] }),
			data: Type.Union([
				Type.Ref("Binding"),
				Type.Array(Type.Tuple([Type.Number(), Type.Number()])),
			]),
		}),
	),
	stacked: Type.Optional(Type.Boolean()),
	thresholds: Type.Optional(
		Type.Array(
			Type.Object({
				at: Type.Number(),
				tone: Type.Ref("Tone"),
				label: Type.Optional(BindableString),
			}),
		),
	),
});

const MeterBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("meter"),
	value: BindableNumber,
	min: Type.Optional(Type.Number()),
	max: Type.Optional(Type.Number()),
	label: Type.Optional(BindableString),
	format: Type.Optional(Format),
	thresholds: Type.Optional(
		Type.Array(Type.Object({ at: Type.Number(), tone: Type.Ref("Tone") })),
	),
});

const LogBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("log"),
	lines: Type.Ref("Binding"),
	follow: Type.Optional(Type.Boolean()),
	wrap: Type.Optional(Type.Boolean()),
	tones: Type.Optional(Type.Record(Type.String(), Type.Ref("Tone"))),
});

const TreeBlockSchema = Type.Object({
	...BlockBase,
	type: Type.Literal("tree"),
	nodes: Type.Ref("Binding"),
	onExpand: Type.Optional(Type.String()),
	onActivate: Type.Optional(Type.Ref("Action")),
});

const DiffBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("diff"),
	before: Type.String(),
	after: Type.String(),
	path: Type.Optional(Type.String()),
	lang: Type.Optional(Type.String()),
});

const DetailsBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("details"),
	value: Type.Ref("JsonValue"),
});

// ─── collection (spec §5.5) and the card template (§5.5.1) ────────────────

const CardMeta = Type.Union([
	Type.Object({ icon: Type.Optional(BindableIcon), text: BindableString }),
	Type.Object({
		person: Type.Object({ user: BindableString, name: BindableString }),
	}),
	Type.Object({ time: BindableString, format: Type.Optional(Format) }),
]);

const Card = Type.Object({
	eyebrow: Type.Optional(BindableString),
	title: BindableString,
	subtitle: Type.Optional(BindableString),
	body: Type.Optional(BindableString),
	image: Type.Optional(BindableString),
	icon: Type.Optional(BindableIcon),
	badges: Type.Optional(
		Type.Array(Type.Object({ text: BindableString, tone: Type.Optional(BindableTone) })),
	),
	meta: Type.Optional(Type.Array(CardMeta)),
	metrics: Type.Optional(
		Type.Array(
			Type.Object({
				label: BindableString,
				value: BindableJsonValue,
				format: Type.Optional(Format),
			}),
		),
	),
	tone: Type.Optional(BindableTone),
	actions: Type.Optional(Type.Array(Type.Ref("ActionButton"))),
	status: Type.Optional(
		Type.Object({
			label: BindableString,
			tone: Type.Optional(BindableTone),
			spinner: Type.Optional(BindableBoolean),
		}),
	),
	quiet: Type.Optional(BindableBoolean),
	deps: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Ref("Binding")])),
});

const BulkAction = Type.Object({
	id: Type.String(),
	label: BindableString,
	icon: Type.Optional(Type.Ref("IconName")),
	onSubmit: Type.String(),
	form: Type.Optional(Type.Object({ v: Type.Number(), root: AnyObject })),
});

const CollectionBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("collection"),
	items: Type.Ref("Binding"),
	item: AnyObject,
	display: Type.Unsafe({
		type: "string",
		enum: ["list", "table", "lanes", "grid", "calendar"],
	}),
	groupBy: Type.Optional(Type.String()),
	groups: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String(),
				title: BindableString,
				tone: Type.Optional(Type.Ref("Tone")),
				collapsed: Type.Optional(Type.Boolean()),
			}),
		),
	),
	sort: Type.Optional(
		Type.Object({
			field: Type.String(),
			dir: Type.Unsafe({ type: "string", enum: ["asc", "desc"] }),
		}),
	),
	select: Type.Optional(Type.Unsafe({ type: "string", enum: ["single", "multi"] })),
	bulkActions: Type.Optional(Type.Array(BulkAction)),
	checkable: Type.Optional(Type.String()),
	reorder: Type.Optional(
		Type.Object({
			within: Type.Optional(Type.Boolean()),
			across: Type.Optional(Type.Boolean()),
		}),
	),
	children: Type.Optional(Type.String()),
	numbered: Type.Optional(Type.Boolean()),
	onMove: Type.Optional(Type.String()),
	onCheck: Type.Optional(Type.String()),
	onActivate: Type.Optional(Type.Ref("Action")),
	columns: Type.Optional(
		Type.Array(
			Type.Object({
				field: Type.String(),
				label: BindableString,
				format: Type.Optional(Format),
				cell: Type.Optional(
					Type.Unsafe({ type: "string", enum: ["text", "meter", "badge"] }),
				),
				sortable: Type.Optional(Type.Boolean()),
				priority: Type.Optional(Type.Unsafe({ type: "string", enum: ["high", "low"] })),
				width: Type.Optional(Size),
			}),
		),
	),
	time: Type.Optional(
		Type.Object({
			start: Type.String(),
			end: Type.Optional(Type.String()),
			allDay: Type.Optional(Type.String()),
			range: Type.Unsafe({ type: "string", enum: ["month", "week", "day", "agenda"] }),
			onResize: Type.Optional(Type.String()),
			onCreate: Type.Optional(Type.String()),
		}),
	),
	overflow: Type.Optional(Type.Unsafe({ type: "string", enum: ["wrap", "scroll"] })),
});

// ─── fields (spec §5.6) ───────────────────────────────────────────────────

const TextField = Type.Object({
	...FieldBase,
	type: Type.Literal("text"),
	kind: Type.Optional(
		Type.Unsafe({ type: "string", enum: ["plain", "search", "email", "url"] }),
	),
	suggest: Type.Optional(Type.Ref("Binding")),
});

const LongtextField = Type.Object({
	...FieldBase,
	type: Type.Literal("longtext"),
	syntax: Type.Optional(
		Type.Unsafe({ type: "string", enum: ["plain", "markdown", "code"] }),
	),
	lang: Type.Optional(Type.String()),
	rows: Type.Optional(Type.Integer()),
});

const NumberField = Type.Object({
	...FieldBase,
	type: Type.Literal("number"),
	step: Type.Optional(Type.Number()),
	format: Type.Optional(Format),
});

const ToggleField = Type.Object({
	...FieldBase,
	type: Type.Literal("toggle"),
});

const ChoiceField = Type.Object({
	...FieldBase,
	type: Type.Literal("choice"),
	options: Type.Union([Type.Array(ChoiceOption), Type.Ref("Binding")]),
	multi: Type.Optional(Type.Boolean()),
	allowOther: Type.Optional(Type.Object({ label: Type.Optional(Type.String()) })),
});

const DateField = Type.Object({
	...FieldBase,
	type: Type.Literal("date"),
});

const DatetimeField = Type.Object({
	...FieldBase,
	type: Type.Literal("datetime"),
});

const DaterangeField = Type.Object({
	...FieldBase,
	type: Type.Literal("daterange"),
	presets: Type.Optional(
		Type.Array(
			Type.Object({ id: Type.String(), label: Type.String(), duration: Type.String() }),
		),
	),
});

const SecretField = Type.Object({
	...FieldBase,
	type: Type.Literal("secret"),
});

const FileField = Type.Object({
	...FieldBase,
	type: Type.Literal("file"),
	accept: Type.Optional(Type.String()),
	maxBytes: Type.Optional(Type.Integer()),
	multi: Type.Optional(Type.Boolean()),
	onUpload: Type.String(),
});

const ListField = Type.Object({
	...FieldBase,
	type: Type.Literal("list"),
	item: AnyObject,
	reorder: Type.Optional(Type.Boolean()),
});

const FormBlock = Type.Object({
	...BlockBase,
	type: Type.Literal("form"),
	bind: Type.String(),
	mode: Type.Unsafe({ type: "string", enum: ["submit", "live", "inline"] }),
	onSubmit: Type.Optional(Type.String()),
	submitLabel: Type.Optional(BindableString),
	turn: Type.Optional(Type.Boolean()),
	children: Type.Array(AnyObject),
});

// ─── compiling one validator per node kind ────────────────────────────────

/** The shared `$defs` every per-node cyclic compile resolves refs against. */
const DEFS = {
	JsonValue,
	Binding,
	Tone,
	IconName,
	BindableTone,
	BindableIcon,
	CoreTarget,
	Confirm,
	Action,
	ActionButton,
} as const;

/** Compile one schema as the root of its own cyclic definition set. */
function compileSelf(self: Parameters<typeof Type.Cyclic>[0][string]): Validator {
	return Compile(Type.Cyclic({ ...DEFS, Self: self }, "Self"));
}

/** One compiled validator per block type, keyed by its `type` literal. */
const BLOCK_ENTRIES: readonly (readonly [string, ReturnType<typeof compileSelf>])[] = [
	["page", compileSelf(PageBlock)],
	["stack", compileSelf(StackBlock)],
	["columns", compileSelf(ColumnsBlock)],
	["grid", compileSelf(GridBlock)],
	["section", compileSelf(SectionBlock)],
	["markdown", compileSelf(MarkdownBlock)],
	["fields", compileSelf(FieldsBlock)],
	["stat", compileSelf(StatBlock)],
	["callout", compileSelf(CalloutBlock)],
	["image", compileSelf(ImageBlock)],
	["chart", compileSelf(ChartBlock)],
	["meter", compileSelf(MeterBlock)],
	["log", compileSelf(LogBlock)],
	["tree", compileSelf(TreeBlockSchema)],
	["diff", compileSelf(DiffBlock)],
	["details", compileSelf(DetailsBlock)],
	["collection", compileSelf(CollectionBlock)],
	["form", compileSelf(FormBlock)],
];

/** One compiled validator per block type, keyed by its `type` literal. */
export const BLOCK_VALIDATORS: ReadonlyMap<string, Validator> = new Map(BLOCK_ENTRIES);

/** One compiled validator per field type, keyed by its `type` literal. */
const FIELD_ENTRIES: readonly (readonly [string, ReturnType<typeof compileSelf>])[] = [
	["text", compileSelf(TextField)],
	["longtext", compileSelf(LongtextField)],
	["number", compileSelf(NumberField)],
	["toggle", compileSelf(ToggleField)],
	["choice", compileSelf(ChoiceField)],
	["date", compileSelf(DateField)],
	["datetime", compileSelf(DatetimeField)],
	["daterange", compileSelf(DaterangeField)],
	["secret", compileSelf(SecretField)],
	["file", compileSelf(FileField)],
	["list", compileSelf(ListField)],
];

/** One compiled validator per field type, keyed by its `type` literal. */
export const FIELD_VALIDATORS: ReadonlyMap<string, Validator> = new Map(FIELD_ENTRIES);

/** The compiled validator for `Action` objects (spec §6.1). */
export const ACTION_VALIDATOR: Validator = compileSelf(Action);

/** The compiled validator for action buttons (spec §6.1). */
export const ACTION_BUTTON_VALIDATOR: Validator = compileSelf(ActionButton);

/** The compiled validator for a collection's card template (spec §5.5.1). */
export const CARD_VALIDATOR: Validator = compileSelf(Card);
