/**
 * Layout blocks (UI-blocks U1 Task 1, spec §5.2): `stack`, `columns`,
 * `grid`, `section`. Width tokens s/m/l are 16/24/32 rem; the
 * structural fallbacks of §12.3 read the container's measured rem:
 * `columns` stacks when the sum of `minWidth`s exceeds the container,
 * `grid` takes as many `minItemWidth` columns as fit.
 */

import { useState, type CSSProperties, type ReactNode } from "react";
import { bound, boundString, useSurfaceData } from "./context";
import type { Block, Field, Size, Tone } from "@sigrun/shared/blocks";
import { toneColor } from "./tones";
import { useWidthRem } from "./width";

/** The webui's width tokens (spec §5.2: s/m/l = 16/24/32 rem). */
const SIZE_REM: Readonly<Record<Size, number>> = { s: 16, m: 24, l: 32 };

/** The gap sizes (half the token ladder reads better as spacing). */
const GAP_REM: Readonly<Record<Size, number>> = { s: 0.5, m: 1, l: 1.5 };

// ─── stack ────────────────────────────────────────────────────────────────

/** A stack: children in a vertical flow with a gap (spec §5.2). */
export function StackBlockView(props: {
	block: { readonly gap?: Size };
	children: ReactNode;
}): ReactNode {
	const gap = props.block.gap ?? "m";
	return (
		<div
			className="blk blk-stack"
			data-block="stack"
			style={{ gap: `${GAP_REM[gap]}rem` } satisfies CSSProperties}
		>
			{props.children}
		</div>
	);
}

// ─── columns ──────────────────────────────────────────────────────────────

/** Columns side by side by weight, stacked when the minimums don't
 *  fit (spec §12.3). An unmeasured container renders side by side
 *  (the pre-measure default is `regular`). */
export function ColumnsBlockView(props: {
	block: {
		readonly children: readonly {
			readonly weight?: number;
			readonly minWidth?: Size;
			readonly block: Block;
		}[];
	};
	render(block: Block): ReactNode;
}): ReactNode {
	const rem = useWidthRem();
	const minimum = props.block.children.reduce(
		(sum, child) => sum + (child.minWidth !== undefined ? SIZE_REM[child.minWidth] : 0),
		0,
	);
	const stacked = rem !== null && minimum > rem;
	return (
		<div className="blk blk-columns" data-block="columns" data-stacked={stacked}>
			{props.block.children.map((child, index) => (
				<div
					key={index}
					className="blk-column"
					style={
						stacked
							? undefined
							: { flexGrow: child.weight ?? 1, flexBasis: 0 }
					}
				>
					{props.render(child.block)}
				</div>
			))}
		</div>
	);
}

// ─── grid ─────────────────────────────────────────────────────────────────

/** As many `minItemWidth` columns as fit (spec §5.2/§12.3): CSS grid
 *  with `auto-fill, minmax(min, 1fr)`; `span` caps at the columns
 *  available (the cap is a grid-column clamp). */
export function GridBlockView(props: {
	block: {
		readonly minItemWidth: Size;
		readonly children: readonly {
			readonly span?: 1 | 2 | "full";
			readonly block: Block;
		}[];
	};
	render(block: Block): ReactNode;
}): ReactNode {
	// Unmeasured keeps auto-fill's own judgement (the CSS handles the
	// fallback); measured compact forces the single column of §12.3.
	const rem = useWidthRem();
	const template =
		rem !== null && SIZE_REM[props.block.minItemWidth] > rem
			? "1fr"
			: `repeat(auto-fill, minmax(${SIZE_REM[props.block.minItemWidth]}rem, 1fr))`;
	return (
		<div
			className="blk blk-grid"
			data-block="grid"
			style={{ gridTemplateColumns: template }}
		>
			{props.block.children.map((child, index) => (
				<div
					key={index}
					className="blk-grid-item"
					data-span={child.span ?? 1}
					style={{ gridColumn: spanOf(child.span) }}
				>
					{props.render(child.block)}
				</div>
			))}
		</div>
	);
}

/** A `span` value as a CSS grid-column span (`"full"` spans everything). */
function spanOf(span: 1 | 2 | "full" | undefined): string | undefined {
	if (span === undefined) return undefined;
	if (span === "full") return "1 / -1";
	return `span ${span}`;
}

// ─── section ──────────────────────────────────────────────────────────────

/** A section: titled grouping for blocks (and fields, inside forms —
 *  `children` takes both, the renderer dispatches). */
export function SectionBlockView(props: {
	block: {
		readonly title?: string | { readonly $: string };
		readonly subtitle?: string | { readonly $: string };
		readonly tone?: Tone | { readonly $: string };
		readonly collapsible?: boolean;
		readonly collapsed?: boolean;
	};
	children: ReactNode;
}): ReactNode {
	const ctx = useSurfaceData();
	const title = boundString(ctx, props.block.title);
	const subtitle = boundString(ctx, props.block.subtitle);
	const boundTone = bound(ctx, props.block.tone);
	const tone = typeof boundTone === "string" ? boundTone : "neutral";
	const collapsible = props.block.collapsible ?? false;
	const [open, setOpen] = useState(!(props.block.collapsed ?? false));
	const expanded = collapsible ? open : true;
	return (
		<section
			className="blk blk-section"
			data-block="section"
			data-tone={tone}
		>
			{(title !== "" || subtitle !== "" || collapsible) && (
				<div className="blk-section-head">
					{collapsible ? (
						<button
							type="button"
							className="blk-section-toggle"
							aria-expanded={expanded}
							onClick={() => {
								setOpen(!open);
							}}
						>
							<span className="blk-section-caret" aria-hidden="true">
								{expanded ? "▾" : "▸"}
							</span>
							{title !== "" && (
								<span className="blk-section-title" dir="auto" style={toneColor(tone)}>
									{title}
								</span>
							)}
						</button>
					) : (
						title !== "" && (
							<div className="blk-section-title" dir="auto" style={toneColor(tone)}>
								{title}
							</div>
						)
					)}
					{subtitle !== "" && (
						<div className="blk-section-subtitle" dir="auto">
							{subtitle}
						</div>
					)}
				</div>
			)}
			{expanded && <div className="blk-section-body">{props.children}</div>}
		</section>
	);
}
