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

	/** The render context (rebuilt per view change — data updates flow
	 *  through SurfaceState's change events; the host re-renders). */
	#ctx(): BlockCtx {
		const view = this.#surface.view;
		return {
			data: view.data,
			theme: this.#theme,
			locale: this.#locale,
			access: view.access === "write" ? "write" : "read",
			unicode: this.#unicode,
			rev: view.rev,
			dispatch: (action, payload) => this.#surface.dispatch(action, payload),
			view: { values: this.#surface.viewValues },
			setView: (path, value) => this.#surface.setView(path, value),
			serverErrors: this.#surface.serverErrors,
			// The live read (fix wave C3): memoized block components
			// re-resolve the confirmed data + rev off the state, never the
			// construction-time snapshot.
			ctxRefresh: () => {
				const current = this.#surface.view;
				return { data: current.data, rev: current.rev };
			},
		};
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
		if (this.#component === undefined) {
			this.#component = renderBlock(view.tree.root, this.#ctx(), this.#options);
		}
		return this.#component.render(width);
	}

	/**
	 * Focus the field with this name in the rendered form (the settings
	 * view's search-resolve seam, U4 Task 4): forces the component to
	 * build (the render gate) and forwards to the form's focus-by-name.
	 * Returns false when the surface is not a form or has no such field.
	 */
	focusField(name: string): boolean {
		const view = this.#surface.view;
		if (view.status !== "ready" || view.tree === undefined) return false;
		if (this.#component === undefined) {
			this.#component = renderBlock(view.tree.root, this.#ctx(), this.#options);
		}
		const focusable = this.#component as {
			focusName?: (fieldName: string) => boolean;
		};
		return focusable.focusName?.(name) === true;
	}

	handleInput(data: string): void {
		const view = this.#surface.view;
		if (view.status === "error") {
			if (data === "r") void this.#surface.retry();
			return;
		}
		if (view.status !== "ready") return;
		// The root component was built against the CURRENT ctx; rebuild
		// statelessly so input handlers close over the live dispatch.
		this.#component?.handleInput?.(data);
	}

	invalidate(): void {
		this.#component?.invalidate();
	}

	/** The wrapped component (test introspection: forms expose state). */
	get inner(): Component | undefined {
		return this.#component;
	}
}
