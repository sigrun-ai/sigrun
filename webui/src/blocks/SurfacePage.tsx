/**
 * The extension-surface page (UI-blocks U3 Task 5): the main-pane host
 * for one extension view, reached through the `#/ext/<slug>/<id>` route.
 *
 * The surface renders through the generic block renderer
 * (`SurfaceView` over the transport). The page keeps its lifecycle:
 * the declared `refreshMs` refetch cadence while visible and the
 * 5-minute watcher keepalive (`since` fetch) — both pause while the
 * tab is hidden and stop on unmount. The surface hook's own
 * `surface.changed` subscription applies data/tree updates; the
 * cadence fetches carry the current rev as `since`.
 */

import { useEffect, useRef } from "react";
import type {
	CoreTarget,
	JsonObject,
	SurfaceTransport,
} from "@sigrun/shared/blocks";
import type { ExtSurfaceHub } from "./extTransport";
import { SurfaceView } from "./SurfaceView";

/** The watcher-keepalive interval (spec §7.3): a `since` fetch every 5
 *  minutes while visible keeps the registry entry alive. */
export const KEEPALIVE_MS = 5 * 60 * 1000;

/** The document-visibility seam (spec §7.3's "while visible" rule): the
 *  refresh + keepalive cadences pause while the tab is hidden. A host
 *  without `document` (the test renderer) counts as VISIBLE.
 *  Resolved per call — tests swap the global per test. */
function documentVisible(): boolean {
	const doc = (globalThis as { document?: { visibilityState?: string } }).document;
	return doc?.visibilityState !== "hidden";
}

export interface SurfacePageProps {
	readonly slug: string;
	readonly id: string;
	readonly transport: SurfaceTransport;
	readonly hub: ExtSurfaceHub;
	/** The declared `refreshMs` (spec §7.3). Absent → no refresh cadence. */
	readonly refreshMs?: number;
	/** The shell's navigate seam (server `navigate` actions land here). */
	readonly onNavigate?: (action: {
		params?: JsonObject;
		target?: CoreTarget;
	}) => void;
}

/** One extension-surface page. */
export function SurfacePage(props: SurfacePageProps): React.JSX.Element {
	// The keepalive/cadence fetch carries the current rev as `since`
	// (spec §7.3). The page tracks it from the transport's change
	// events (the hook's own subscription applies the data); the ref
	// keeps the interval from re-arming on every data change.
	const revRef = useRef(0);

	useEffect(() => {
		let alive = true;
		const offChanged = props.transport.onChanged((event) => {
			revRef.current = Math.max(revRef.current, event.rev);
		});
		const refetch = (): void => {
			void props.transport.fetchData(revRef.current).catch(() => undefined);
		};

		// refreshMs cadence (spec §7.3): refetch data while the surface is
		// VISIBLE — a hidden tab pauses the timer (the visibility listener
		// restarts it on return).
		let refreshTimer: ReturnType<typeof setInterval> | undefined;
		const startRefresh = (): void => {
			if (props.refreshMs === undefined || refreshTimer !== undefined) return;
			refreshTimer = setInterval(() => {
				if (!alive) return;
				refetch();
			}, props.refreshMs);
		};
		const stopRefresh = (): void => {
			if (refreshTimer !== undefined) clearInterval(refreshTimer);
			refreshTimer = undefined;
		};

		// The 5-minute watcher keepalive (spec §7.3's 10-minute TTL
		// margin): same visibility rule — a hidden tab's entry may lapse
		// (the surface re-registers on return).
		let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
		const startKeepalive = (): void => {
			if (keepaliveTimer !== undefined) return;
			keepaliveTimer = setInterval(() => {
				if (!alive) return;
				refetch();
			}, KEEPALIVE_MS);
		};
		const stopKeepalive = (): void => {
			if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
			keepaliveTimer = undefined;
		};

		// Document visibility: pause both cadences while hidden, resume
		// (with an immediate refetch — the missed window applies) on
		// visible. The listener is absent in hosts without document.
		const doc = (
			globalThis as {
				document?: {
					addEventListener(t: string, l: () => void): void;
					removeEventListener(t: string, l: () => void): void;
				};
			}
		).document;
		const onVisibility = (): void => {
			if (documentVisible()) {
				startRefresh();
				startKeepalive();
				refetch();
			} else {
				stopRefresh();
				stopKeepalive();
			}
		};
		if (documentVisible()) {
			startRefresh();
			startKeepalive();
		}
		doc?.addEventListener("visibilitychange", onVisibility);

		return () => {
			alive = false;
			offChanged();
			doc?.removeEventListener("visibilitychange", onVisibility);
			stopRefresh();
			stopKeepalive();
		};
	}, [props.slug, props.id, props.transport, props.hub, props.refreshMs]);

	return (
		<section className="ext-surface" data-ext-surface={`${props.slug}/${props.id}`}>
			<SurfaceView transport={props.transport} onNavigate={props.onNavigate} />
		</section>
	);
}
