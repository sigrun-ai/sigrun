/**
 * The extension-surface page (UI-blocks U3 Task 5): the main-pane host
 * for one extension view, reached through the `#/ext/<slug>/<id>` route.
 *
 * The surface renders through the generic block renderer
 * (`SurfaceView` over the transport). The surface hook owns the
 * declared `refreshMs` poll: each tick fetches since the current rev
 * and applies the result, healing a missed surface.changed event. The
 * 5-minute watcher keepalive applies through the same path; both
 * cadences pause while the tab is hidden and stop on unmount.
 */

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
	return (
		<section className="ext-surface" data-ext-surface={`${props.slug}/${props.id}`}>
			<SurfaceView
				transport={props.transport}
				refreshMs={props.refreshMs}
				keepaliveMs={KEEPALIVE_MS}
				visible={documentVisible}
				onNavigate={props.onNavigate}
			/>
		</section>
	);
}
