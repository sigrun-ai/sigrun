/**
 * SurfaceView (UI-blocks U2 Task 5, the port of U1's `SurfaceView.tsx`):
 * the component host for a `SurfaceState` — loading, not-found, an
 * error line with `r` to retry, ready. Ready builds the render context
 * (the confirmed-plus-overlay data, the `/view/` branch, server field
 * errors, dispatch and access) and renders the tree's root block.
 *
 * `handleInput` forwards to the rendered root component while ready;
 * while error is showing, `r` retries the load (spec §12.3's fallback
 * posture: an error never strands the surface).
 */

import type { Component } from "@earendil-works/pi-tui";
import type { Tree } from "@sigrun/shared/blocks";
import type { TuiTheme } from "../theme.js";
import type { BlockCtx } from "./context.js";
import { renderBlock, type RenderOptions } from "./render.js";
import type { SurfaceState } from "./surface.js";
import { truncate } from "./width.js";

/** The state lines (U1's wording, terminal-cased). */
export const SURFACE_LOADING = "loading…";
export const SURFACE_NOT_FOUND = "surface not found";
export const SURFACE_ERROR = "something went wrong — r to retry";

export class SurfaceView implements Component {
	readonly #surface: SurfaceState;
	readonly #theme: TuiTheme;
	readonly #locale: string;
	readonly #unicode: boolean;
	readonly #options: RenderOptions;
	#component: Component | undefined;
	/** The ONE mutable render context (fix round 2): the cached root
	 *  component holds this object by reference, so a post-settle
	 *  `setAccess("read")` reaches the form's `#readOnly` — refreshing
	 *  `data`/`access` per render instead of rebuilding the component
	 *  keeps typed state. */
	#ctx: BlockCtx | undefined;

	constructor(
		surface: SurfaceState,
		opts: {
			theme: TuiTheme;
			locale?: string;
			unicode: boolean;
			options?: RenderOptions;
		},
	) {
		this.#surface = surface;
		this.#theme = opts.theme;
		this.#locale = opts.locale ?? "en";
		this.#unicode = opts.unicode;
		this.#options = opts.options ?? {};
	}

	/** The render context, refreshed from `#surface.view` on every
	 *  access (data updates and access swaps flow through to the
	 *  cached component's `#readOnly`/binding reads). */
	#context(): BlockCtx {
		const view = this.#surface.view;
		if (this.#ctx === undefined) {
			this.#ctx = {
				data: view.data,
				theme: this.#theme,
				locale: this.#locale,
				access: view.access === "write" ? "write" : "read",
				unicode: this.#unicode,
				dispatch: (action, payload) => this.#surface.dispatch(action, payload),
				view: { values: this.#surface.viewValues },
				setView: (path, value) => this.#surface.setView(path, value),
				serverErrors: this.#surface.serverErrors,
			};
			return this.#ctx;
		}
		const ctx = this.#ctx;
		ctx.data = view.data;
		ctx.access = view.access === "write" ? "write" : "read";
		ctx.serverErrors = this.#surface.serverErrors;
		return ctx;
	}

	render(width: number): string[] {
		const view = this.#surface.view;
		if (view.status === "loading") {
			return [truncate(this.#theme.dim(SURFACE_LOADING), width)];
		}
		if (view.status === "notFound") {
			return [truncate(this.#theme.dim(SURFACE_NOT_FOUND), width)];
		}
		if (view.status === "error") {
			return [truncate(this.#theme.fg("bad")(SURFACE_ERROR), width)];
		}
		if (view.tree === undefined) return [];
		return this.#readyComponent(view.tree).render(width);
	}

	/** Build the ready-state root component on demand (a key can arrive
	 *  before the first render — the interaction prompter's answer keys
	 *  must not wait for a paint). */
	#readyComponent(tree: Tree): Component {
		if (this.#component === undefined) {
			this.#component = renderBlock(tree.root, this.#context(), this.#options);
		} else {
			// The component is cached: refresh the shared context so it
			// renders against the CURRENT view (access, data, errors).
			this.#context();
		}
		return this.#component;
	}

	handleInput(data: string): void {
		const view = this.#surface.view;
		if (view.status === "error") {
			if (data === "r") void this.#surface.retry();
			return;
		}
		if (view.status !== "ready" || view.tree === undefined) return;
		// Build on demand: a key can arrive before the first paint (the
		// interaction prompter's answer keys route here directly).
		this.#readyComponent(view.tree).handleInput?.(data);
	}

	invalidate(): void {
		this.#component?.invalidate();
	}

	/** The wrapped component (test introspection AND the interaction
	 *  prompter's pre-paint key routing: forms expose state). */
	get inner(): Component | undefined {
		const view = this.#surface.view;
		if (view.status !== "ready" || view.tree === undefined) {
			return this.#component;
		}
		return this.#readyComponent(view.tree);
	}
}
