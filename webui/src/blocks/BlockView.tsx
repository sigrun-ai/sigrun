/**
 * BlockView (UI-blocks U1 Task 1): the renderer's front door — one
 * component per block, dispatched on `block.type`. Everything a block
 * needs arrives through the two contexts (`SurfaceData`,
 * `SurfaceActions`); this module only routes.
 *
 * Unknown block types (spec §4.4) render the block's `fallback` text
 * plus "Not supported in this client" — never dropped silently. A
 * newer block than this client supports looks exactly the same (the
 * `v` gate lives in the server and the surface loaders).
 *
 * `visibleAt` (spec §12.2) hides blocks in compact containers; the
 * check lives here so every block inherits it.
 */

import type { ReactNode } from "react";
import type { Block, Field, WidthCondition } from "@sigrun/shared/blocks";
import "./blocks.css";
import { ChartBlockView } from "./chart";
import {
	CalloutBlockView,
	DetailsBlockView,
	DiffBlockView,
	FieldsBlockView,
	ImageBlockView,
	MarkdownBlockView,
	StatBlockView,
} from "./content";
import { LogBlockView } from "./log";
import { FormBlockView } from "./form/Form";
import { CollectionBlockView } from "./collection/Collection";
import { MeterBlockView } from "./meter";
import { TreeBlockView } from "./treeview";
import {
	ColumnsBlockView,
	GridBlockView,
	SectionBlockView,
	StackBlockView,
} from "./layout";
import { useWidthClass } from "./width";

/** The fallback notice (spec §4.4's exact words). */
export const NOT_SUPPORTED = "Not supported in this client";

/** Whether `visibleAt` (spec §12.2) holds at the current width class. */
function visibleAt(condition: WidthCondition | undefined, widthClass: string): boolean {
	if (condition === undefined) return true;
	// `atLeast:regular` — hidden in compact containers, the only
	// condition v1 defines; an unknown condition fails visible (a
	// newer spec's blocks stay on screen, matching §4.4's lean).
	if (condition === "atLeast:regular") return widthClass !== "compact";
	return true;
}

/** Render any block (the renderer's dispatch). */
export function BlockView(props: { block: Block }): ReactNode {
	const block = props.block;
	const widthClass = useWidthClass();
	if (!visibleAt(block.visibleAt, widthClass)) return null;
	return renderKnown(block);
}

/** The type dispatch — Task 2+ slots its blocks in here. */
function renderKnown(block: Block): ReactNode {
	switch (block.type) {
		case "stack":
			return (
				<StackBlockView block={block}>
					{block.children.map((child, index) => (
						<BlockView key={index} block={child} />
					))}
				</StackBlockView>
			);
		case "columns":
			return (
				<ColumnsBlockView block={block} render={renderChild} />
			);
		case "grid":
			return <GridBlockView block={block} render={renderChild} />;
		case "section":
			return (
				<SectionBlockView block={block}>
					{block.children.map((child, index) =>
						isBlock(child) ? <BlockView key={index} block={child} /> : null,
					)}
				</SectionBlockView>
			);
		case "markdown":
			return <MarkdownBlockView block={block} />;
		case "fields":
			return <FieldsBlockView block={block} />;
		case "stat":
			return <StatBlockView block={block} />;
		case "callout":
			return <CalloutBlockView block={block} />;
		case "image":
			return <ImageBlockView block={block} />;
		case "diff":
			return <DiffBlockView block={block} />;
		case "details":
			return <DetailsBlockView block={block} />;
		case "collection":
			return <CollectionBlockView block={block} />;
		case "chart":
			return <ChartBlockView block={block} />;
		case "meter":
			return <MeterBlockView block={block} />;
		case "log":
			return <LogBlockView block={block} />;
		case "tree":
			return <TreeBlockView block={block} />;
		case "form":
			return <FormBlockView block={block} />;
		default:
			// A type this client doesn't know: the fallback text plus the
			// notice (§4.4). `fallback` is optional; when absent the server
			// has filled it with the `toText` projection.
			return (
				<div className="blk blk-unsupported" dir="auto">
					{block.fallback !== undefined && block.fallback !== "" && (
						<p>{block.fallback}</p>
					)}
					<p className="blk-unsupported-note">{NOT_SUPPORTED}</p>
				</div>
			);
	}
}

/** Whether a `Block | Field` union member is a block (fields render
 *  inside forms — Task 5 owns them; sections hold both). */
function isBlock(child: Block | Field): child is Block {
	const FIELD_TYPES: ReadonlySet<string> = new Set([
		"text", "longtext", "number", "toggle", "choice",
		"date", "datetime", "daterange", "secret", "file", "list",
	]);
	return !FIELD_TYPES.has(child.type);
}

/** Render a nested block (the layout blocks' `render` prop). */
function renderChild(block: Block): ReactNode {
	return <BlockView block={block} />;
}
