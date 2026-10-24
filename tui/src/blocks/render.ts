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
import type { Block, JsonObject } from "@sigrun/shared/blocks";
import { hiddenAtCompact, type BlockCtx } from "./context.js";
import { Lines, renderColumns, renderGrid, renderSection, renderStack } from "./layout.js";
import { renderContent } from "./content.js";
import { renderChart } from "./chart.js";
import { renderMeter } from "./meter.js";
import { LogComponent } from "./log.js";
import { TreeComponent } from "./treeview.js";
import { ImageComponent } from "./image.js";
import type { ImageOptions } from "./image.js";
import { renderCollection } from "./collection/collection.js";
import { FormComponent } from "./form/form.js";
import { PageComponent } from "./page.js";
import { wrapPlain } from "./width.js";

// The renderer's public surface re-exports its seam types and the width
// classes so callers have ONE import site (`render.js`).
export { widthClassOf } from "./width.js";
export type { WidthClass } from "./width.js";
export type { BlockCtx, ViewState } from "./context.js";
export type { ImageOptions } from "./image.js";

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

	/** Dispose forwards too (a form's pending live debounce must not
	 *  outlive its surface host). */
	dispose(): void {
		(this.#inner as { dispose?: () => void }).dispose?.();
	}

	/** Form introspection forwards (tests and hosts read the wrapped
	 *  form's values/focus — the wrapper is transparent). */
	get values(): JsonObject | undefined {
		return this.#inner instanceof FormComponent ? this.#inner.values : undefined;
	}

	get focusIndex(): number | undefined {
		return this.#inner instanceof FormComponent ? this.#inner.focusIndex : undefined;
	}

	/** Focus-by-name forward (the settings view's search-resolve seam). */
	focusName(name: string): boolean {
		return this.#inner instanceof FormComponent ? this.#inner.focusName(name) : false;
	}

	get step(): number | undefined {
		return this.#inner instanceof FormComponent ? this.#inner.step : undefined;
	}

	get submittedOnce(): boolean | undefined {
		return this.#inner instanceof FormComponent ? this.#inner.submittedOnce : undefined;
	}

	/** Page introspection forwards (the wrapper is transparent for the
	 *  page shell's overlay/detail state too). */
	get hasOverlay(): boolean | undefined {
		return this.#inner instanceof PageComponent ? this.#inner.hasOverlay : undefined;
	}

	get detailPushed(): boolean | undefined {
		return this.#inner instanceof PageComponent ? this.#inner.detailPushed : undefined;
	}

	get sidebarOpen(): boolean | undefined {
		return this.#inner instanceof PageComponent ? this.#inner.sidebarOpen : undefined;
	}

	get menuKind(): "switcher" | "actions" | null | undefined {
		return this.#inner instanceof PageComponent ? this.#inner.menuKind : undefined;
	}

	setSideBySide(sideBySide: boolean): void {
		if (this.#inner instanceof PageComponent) this.#inner.setSideBySide(sideBySide);
	}
}

/** The type dispatch; unknown types answer `undefined` from content. */
function dispatch(block: Block, ctx: BlockCtx, options: RenderOptions): Component {
	switch (block.type) {
		case "stack":
			return renderStack(block, ctx);
		case "columns":
			return renderColumns(block, ctx);
		case "grid":
			return renderGrid(block, ctx);
		case "section":
			return renderSection(block, ctx);
		case "chart":
			return renderChart(block, ctx);
		case "meter":
			return renderMeter(block, ctx);
		case "log":
			return new LogComponent(block, ctx);
		case "tree":
			return new TreeComponent(block, ctx);
		case "image":
			return new ImageComponent(block, ctx, options);
		case "collection": {
			const component = renderCollection(block, ctx);
			return component ?? unsupported(block, ctx);
		}
		case "form":
			return new FormComponent(block, ctx, {
				interaction: options.interaction === true,
			});
		case "page":
			return new PageComponent(block, ctx, options);
		default:
			return renderContent(block, ctx) ?? unsupported(block, ctx);
	}
}

/** The seams `renderBlock` threads to the blocks that need them. */
export type RenderOptions = ImageOptions & {
	/** Whether the form sits in an interaction placement (§9.1 stepper). */
	interaction?: boolean;
};

/** Render any block as a pi-tui component (the renderer's dispatch). */
export function renderBlock(block: Block, ctx: BlockCtx, options: RenderOptions = {}): Component {
	return new WidthGated(block, dispatch(block, ctx, options));
}
