/**
 * SurfaceView (UI-blocks U1 Task 6): the component host for a
 * `useSurface` result — loading, not-found, error-with-retry, ready.
 * The ready state provides the renderer's two contexts
 * (`SurfaceData` = the confirmed-plus-overlay view, `SurfaceActions` =
 * dispatch/access/viewState/setView) and renders the tree's root block
 * inside the width-measuring container.
 */

import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import type {
	CoreTarget,
	JsonObject,
	SurfaceTransport,
} from "@sigrun/shared/blocks";
import { BlockView } from "./BlockView";
import { SurfaceActionsContext, SurfaceDataContext } from "./context";
import { ContainerWidth } from "./width";
import { useSurface } from "./useSurface";

/** Render the surface a transport serves (spec §6.3 states). */
export function SurfaceView(props: {
	readonly transport: SurfaceTransport;
	/** Poll for fresh data at this cadence (spec §7.3). */
	readonly refreshMs?: number;
	/** Host visibility gate for the poll (hidden tabs do not poll). */
	readonly visible?: () => boolean;
	/** Additional host cadence (the watcher keepalive). Its full-data
	 *  refresh applies through the same surface fetch path. */
	readonly keepaliveMs?: number;
	/** The shell's navigate seam: `navigate` actions and accepted act
	 *  results carrying `navigate` land here (spec §6.1). */
	readonly onNavigate?: (action: {
		params?: JsonObject;
		target?: CoreTarget;
	}) => void;
}): ReactNode {
	const surface = useSurface(props.transport, {
		onNavigate: props.onNavigate,
		refreshMs: props.refreshMs,
		visible: props.visible,
	});
	const keepaliveMs = props.keepaliveMs;
	const visible = props.visible;
	const refresh = surface.refresh;
	// The keepalive callback must be STABLE (useCallback): a new identity
	// per render re-arms the interval effect below every time the hook
	// re-renders (the surface's own data updates churn it), restarting
	// the 5-minute clock and never letting a tick fire mid-edit.
	const refreshStable = useCallback(async (): Promise<void> => {
		await refresh();
	}, [refresh]);
	useEffect(() => {
		if (keepaliveMs === undefined) return undefined;
		const timer = setInterval(() => {
			if (visible !== undefined && !visible()) return;
			void refreshStable();
		}, keepaliveMs);
		const doc = (
			globalThis as {
				document?: {
					addEventListener(t: string, l: () => void): void;
					removeEventListener(t: string, l: () => void): void;
				};
			}
		).document;
		const onVisibility = (): void => {
			if (visible === undefined || visible()) void refreshStable();
		};
		doc?.addEventListener("visibilitychange", onVisibility);
		return () => {
			clearInterval(timer);
			doc?.removeEventListener("visibilitychange", onVisibility);
		};
	}, [keepaliveMs, visible, refreshStable]);
	// The `/view/` branch (a form writing it publishes to siblings via
	// `/view/...` bindings). `viewState` carries the view branch alone;
	// the form strips the `/view/` prefix itself.
	const locale = navigator.language;
	const actionsCtx = useMemo(
		() => ({
			dispatch: surface.dispatch,
			access: surface.access,
			rev: surface.rev,
			viewState:
				typeof surface.view.view === "object" &&
				surface.view.view !== null &&
				!Array.isArray(surface.view.view)
					? (surface.view.view as JsonObject)
					: ({} as JsonObject),
			setView: surface.setView,
			serverErrors: surface.serverErrors,
		}),
		[
			surface.dispatch,
			surface.access,
			surface.rev,
			surface.view,
			surface.setView,
			surface.serverErrors,
		],
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
