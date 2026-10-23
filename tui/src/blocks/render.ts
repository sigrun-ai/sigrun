/**
 * The renderer's front door (UI-blocks U2 Task 1): one pi-tui
 * component per block, dispatched on `block.type`. Layout blocks come
 * from `layout.ts`, the simple content blocks from `content.ts`; later
 * tasks slot their blocks into the same dispatch.
 *
 * - `visibleAt` (spec §12.2) gates here so every block inherits it:
 *   `atLeast:regular` renders nothing in a compact pane. An unknown
 *   condition fails visible, matching §4.4's lean (a newer spec's
 *   blocks stay on screen).
 * - A type this client can't render yet (spec §4.4) shows the block's
 *   `fallback` text plus "Not supported in this client" — never
 *   dropped silently.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { Block } from "@sigrun/shared/blocks";
import { hiddenAtCompact, type BlockCtx } from "./context.js";
import { Lines, renderColumns, renderGrid, renderSection, renderStack } from "./layout.js";
import { renderContent } from "./content.js";
import { wrapPlain } from "./width.js";

// The renderer's public surface re-exports its seam types and the width
// classes so callers have ONE import site (`render.js`).
export { widthClassOf } from "./width.js";
export type { WidthClass } from "./width.js";
export type { BlockCtx, ViewState } from "./context.js";

/** The fallback notice (spec §4.4's exact words). */
export const NOT_SUPPORTED = "Not supported in this client";

/** A block this client can't render: its fallback text plus the notice. */
function unsupported(block: Block, ctx: BlockCtx): Component {
	return new Lines((width) => {
		const lines: string[] = [];
		const fallback = typeof block.fallback === "string" ? block.fallback : "";
		if (fallback !== "") lines.push(...wrapPlain(fallback, width));
		lines.push(ctx.theme.dim(NOT_SUPPORTED));
		return lines;
	});
}

/**
 * `visibleAt` as a width-aware wrapper: the same component answers
 * every pane width, so a resize re-evaluates the gate. Input handling
 * (button picks, the confirm gate) forwards to the inner component.
 */
class WidthGated implements Component {
	readonly #block: { readonly visibleAt?: string };
	readonly #inner: Component;

	constructor(block: { readonly visibleAt?: string }, inner: Component) {
		this.#block = block;
		this.#inner = inner;
	}

	render(width: number): string[] {
		if (hiddenAtCompact(this.#block, width)) return [];
		return this.#inner.render(width);
	}

	handleInput(data: string): void {
		// Input forwards to the inner component. Width cannot gate it here
		// (a component learns widths only while rendering); the host only
		// routes keys to components it shows, which is where hiding lands.
		this.#inner.handleInput?.(data);
	}

	invalidate(): void {
		this.#inner.invalidate();
	}
}

/** The type dispatch; unknown types answer `undefined` from content. */
function dispatch(block: Block, ctx: BlockCtx): Component {
	switch (block.type) {
		case "stack":
			return renderStack(block, ctx);
		case "columns":
			return renderColumns(block, ctx);
		case "grid":
			return renderGrid(block, ctx);
		case "section":
			return renderSection(block, ctx);
		default:
			return renderContent(block, ctx) ?? unsupported(block, ctx);
	}
}

/** Render any block as a pi-tui component (the renderer's dispatch). */
export function renderBlock(block: Block, ctx: BlockCtx): Component {
	return new WidthGated(block, dispatch(block, ctx));
}
