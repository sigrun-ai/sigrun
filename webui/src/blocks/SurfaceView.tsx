/**
 * SurfaceView (UI-blocks U1 Task 6): the component host for a
 * `useSurface` result — loading, not-found, error-with-retry, ready.
 * The ready state provides the renderer's two contexts
 * (`SurfaceData` = the confirmed-plus-overlay view, `SurfaceActions` =
 * dispatch/access/viewState/setView) and renders the tree's root block
 * inside the width-measuring container.
 */

import { useMemo, type ReactNode } from "react";
import type { JsonObject, SurfaceTransport } from "@sigrun/shared/blocks";
import { BlockView } from "./BlockView";
import { SurfaceActionsContext, SurfaceDataContext } from "./context";
import { ContainerWidth } from "./width";
import { useSurface } from "./useSurface";

/** Render the surface a transport serves (spec §6.3 states). */
export function SurfaceView(props: {
	readonly transport: SurfaceTransport;
}): ReactNode {
	const surface = useSurface(props.transport);
	// The `/view/` branch (a form writing it publishes to siblings via
	// `/view/...` bindings). `viewState` carries the view branch alone;
	// the form strips the `/view/` prefix itself.
	const locale = navigator.language;
	const actionsCtx = useMemo(
		() => ({
			dispatch: surface.dispatch,
			access: surface.access,
			viewState:
				typeof surface.view.view === "object" &&
				surface.view.view !== null &&
				!Array.isArray(surface.view.view)
					? (surface.view.view as JsonObject)
					: ({} as JsonObject),
			setView: surface.setView,
		}),
		[surface.dispatch, surface.access, surface.view, surface.setView],
	);
	if (surface.status === "loading") {
		return (
			<div className="blk-surface" data-surface="loading">
				<p>loading…</p>
			</div>
		);
	}
	if (surface.status === "notFound") {
		return (
			<div className="blk-surface" data-surface="not-found">
				<p>surface not found</p>
			</div>
		);
	}
	if (surface.status === "error") {
		return (
			<div className="blk-surface" data-surface="error" role="alert">
				<p>something went wrong</p>
				<button
					type="button"
					data-surface-retry=""
					onClick={() => surface.retry()}
				>
					Retry
				</button>
			</div>
		);
	}
	return (
		<div className="blk-surface" data-surface="ready">
			<SurfaceDataContext.Provider value={{ data: surface.view, locale }}>
				<SurfaceActionsContext.Provider value={actionsCtx}>
					<ContainerWidth>
						{surface.tree !== undefined && (
							<BlockView block={surface.tree.root} />
						)}
					</ContainerWidth>
					{surface.toasts.map((toast, index) => (
						<p key={index} className="blk-surface-toast" role="status">
							{toast}
						</p>
					))}
				</SurfaceActionsContext.Provider>
			</SurfaceDataContext.Provider>
		</div>
	);
}
