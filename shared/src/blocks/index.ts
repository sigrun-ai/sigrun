/**
 * `@sigrun/shared/blocks` — the block-set foundation (UI-blocks U0).
 *
 * One entry point for the wire types (§4/§5/§6.1), the data-op applier
 * (§4.3), the icon names (§10.2), display downsampling (§5.4), and the
 * channel-facing surface transport. Consumed by the server, the webui
 * and the TUI alike; re-exported for extensions through
 * `@sigrun/sigrun/blocks` (U0 Task 4).
 *
 * The runtime half is deliberately tiny and dependency-free: the purity
 * guard (`test/views-purity.test.ts`) holds every specifier inside
 * `shared/src/`.
 */

// ─── Runtime (pure, dependency-free) ──────────────────────────────────────
export { BLOCK_SET_VERSION } from "./types.js";
export { DataOpError, applyOps, resolvePointer } from "./ops.js";
export { ICON_NAMES } from "./icons.js";
export { lttb } from "./lttb.js";
export { formatValue } from "./format.js";
export { toText } from "./text.js";

// ─── Wire types (spec §4/§5/§6.1) ─────────────────────────────────────────
export type {
	Action,
	ActionButton,
	Bindable,
	Binding,
	Block,
	BlockBase,
	BulkAction,
	CalloutBlock,
	Card,
	CardBadge,
	CardMetric,
	CardMeta,
	CardStatus,
	ChartAxisX,
	ChartAxisY,
	ChartBlock,
	ChartSeries,
	ChartThreshold,
	ChoiceField,
	ChoiceOption,
	CollectionBlock,
	CollectionColumn,
	CollectionGroup,
	CollectionSort,
	CollectionTime,
	ColumnChild,
	ColumnsBlock,
	Confirm,
	CoreTarget,
	DataOp,
	DataOps,
	DataUpdate,
	DateField,
	DatePreset,
	DaterangeField,
	DatetimeField,
	DetailsBlock,
	DiffBlock,
	Field,
	FieldBase,
	FieldsBlock,
	FieldsRow,
	FileField,
	Format,
	FormBlock,
	GridBlock,
	GridChild,
	ImageBlock,
	ListField,
	LogBlock,
	LogLine,
	LongtextField,
	MarkdownBlock,
	MeterBlock,
	MeterThreshold,
	NumberField,
	PageBlock,
	PageEmpty,
	Placement,
	SectionBlock,
	SecretField,
	Size,
	StackBlock,
	StatBlock,
	TextField,
	ToggleField,
	Tone,
	Tree,
	TreeBlock,
	TreeNode,
	WidthCondition,
} from "./types.js";

export type { IconName } from "./icons.js";
export type { TextOptions } from "./text.js";

// ─── Transport (the channel-facing surface handle) ────────────────────────
export type {
	SurfaceAccess,
	SurfaceActErr,
	SurfaceActOk,
	SurfaceActResult,
	SurfaceChangedEvent,
	SurfaceFetch,
	SurfaceLoad,
	SurfaceTransport,
	SurfaceUploadBody,
} from "./transport.js";

// The JSON mirrors this contract builds on (the shared leaf's local
// declarations — re-exported so consumers of the blocks entry point
// don't need a second import site).
export type { JsonObject, JsonValue } from "../json.js";
