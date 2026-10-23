/**
 * The typed builders (spec §14.1): one function per block and field,
 * plus `bind(pointer)` and `tree(root)`. Builders return plain JSON —
 * there is no runtime besides them.
 *
 * Each builder takes its block's props object and returns the block
 * with the `type` literal stamped in. The literal is spread LAST, so a
 * stray `type` inside a JavaScript caller's props object can never
 * override it; TypeScript callers cannot pass one at all (`Props` omits
 * it). The tree BLOCK builder is exported as `treeBlock`, keeping the
 * `tree` name for the version-stamping root wrapper.
 *
 * `tree(root)` stamps {@link BLOCK_SET_VERSION} from the shared wire
 * package — the version the SERVER validates against, which is why
 * extensions import these builders from `@sigrun/sigrun/blocks` (the
 * host-linked copy, spec §14.1) instead of bundling their own.
 */

import { BLOCK_SET_VERSION } from "@sigrun/shared/blocks";
import type {
	Binding,
	Block,
	CalloutBlock,
	Card,
	ChartBlock,
	ChoiceField,
	CollectionBlock,
	ColumnsBlock,
	DateField,
	DaterangeField,
	DatetimeField,
	DetailsBlock,
	DiffBlock,
	FieldsBlock,
	FileField,
	FormBlock,
	GridBlock,
	ImageBlock,
	ListField,
	LogBlock,
	LongtextField,
	MarkdownBlock,
	MeterBlock,
	NumberField,
	PageBlock,
	SectionBlock,
	SecretField,
	StackBlock,
	StatBlock,
	TextField,
	ToggleField,
	Tree,
	TreeBlock,
} from "@sigrun/shared/blocks";

/** One block/field's props: the wire shape minus the `type` literal. */
type Props<T> = Omit<T, "type">;

/** `bind("/cards")` → `{ $: "/cards" }` — a pointer into the surface's data model (§4.2). */
export function bind(pointer: string): Binding {
	return { $: pointer };
}

/** Wrap a root block with the server's block-set version (§4.4). */
export function tree(root: Block): Tree {
	return { v: BLOCK_SET_VERSION, root };
}

// ─── Shell (§5.1) ─────────────────────────────────────────────────────────

export function page(props: Props<PageBlock>): PageBlock {
	return { ...props, type: "page" };
}

// ─── Layout (§5.2) ────────────────────────────────────────────────────────

export function stack(props: Props<StackBlock>): StackBlock {
	return { ...props, type: "stack" };
}

export function columns(props: Props<ColumnsBlock>): ColumnsBlock {
	return { ...props, type: "columns" };
}

export function grid(props: Props<GridBlock>): GridBlock {
	return { ...props, type: "grid" };
}

export function section(props: Props<SectionBlock>): SectionBlock {
	return { ...props, type: "section" };
}

// ─── Content (§5.3) ───────────────────────────────────────────────────────

export function markdown(props: Props<MarkdownBlock>): MarkdownBlock {
	return { ...props, type: "markdown" };
}

export function fields(props: Props<FieldsBlock>): FieldsBlock {
	return { ...props, type: "fields" };
}

export function stat(props: Props<StatBlock>): StatBlock {
	return { ...props, type: "stat" };
}

export function callout(props: Props<CalloutBlock>): CalloutBlock {
	return { ...props, type: "callout" };
}

export function image(props: Props<ImageBlock>): ImageBlock {
	return { ...props, type: "image" };
}

// ─── Chart (§5.4) ─────────────────────────────────────────────────────────

export function chart(props: Props<ChartBlock>): ChartBlock {
	return { ...props, type: "chart" };
}

// ─── Meter / log / tree / diff / details (§5.3) ───────────────────────────

export function meter(props: Props<MeterBlock>): MeterBlock {
	return { ...props, type: "meter" };
}

export function log(props: Props<LogBlock>): LogBlock {
	return { ...props, type: "log" };
}

/** The tree BLOCK builder (§5.3) — `tree` is the root wrapper. */
export function treeBlock(props: Props<TreeBlock>): TreeBlock {
	return { ...props, type: "tree" };
}

export function diff(props: Props<DiffBlock>): DiffBlock {
	return { ...props, type: "diff" };
}

export function details(props: Props<DetailsBlock>): DetailsBlock {
	return { ...props, type: "details" };
}

// ─── Collection (§5.5) and the card template (§5.5.1) ────────────────────

export function collection(props: Props<CollectionBlock>): CollectionBlock {
	return { ...props, type: "collection" };
}

/** The collection item template (§5.5.1) — a slot bundle, not a block. */
export function card(props: Card): Card {
	return { ...props };
}

// ─── Form and fields (§5.6) ───────────────────────────────────────────────

export function form(props: Props<FormBlock>): FormBlock {
	return { ...props, type: "form" };
}

export function text(props: Props<TextField>): TextField {
	return { ...props, type: "text" };
}

export function longtext(props: Props<LongtextField>): LongtextField {
	return { ...props, type: "longtext" };
}

export function number(props: Props<NumberField>): NumberField {
	return { ...props, type: "number" };
}

export function toggle(props: Props<ToggleField>): ToggleField {
	return { ...props, type: "toggle" };
}

export function choice(props: Props<ChoiceField>): ChoiceField {
	return { ...props, type: "choice" };
}

export function date(props: Props<DateField>): DateField {
	return { ...props, type: "date" };
}

export function datetime(props: Props<DatetimeField>): DatetimeField {
	return { ...props, type: "datetime" };
}

export function daterange(props: Props<DaterangeField>): DaterangeField {
	return { ...props, type: "daterange" };
}

export function secret(props: Props<SecretField>): SecretField {
	return { ...props, type: "secret" };
}

export function file(props: Props<FileField>): FileField {
	return { ...props, type: "file" };
}

export function list(props: Props<ListField>): ListField {
	return { ...props, type: "list" };
}
