/**
 * The extension PANEL host (UI-blocks U3 Task 5, spec §7.1): renders the
 * active panel surface in the right panel through the generic block
 * renderer (`SurfaceView` over the transport). The panel owns the
 * cadence lifecycle — it exists ONLY while its tab is active, so
 * closing the tab unmounts this component and stops every fetch (the
 * stop-when-hidden rule).
 */

import { useEffect } from "react";
import type {
	CoreTarget,
	JsonObject,
	SurfaceTransport,
} from "@sigrun/shared/blocks";
import { SurfaceView } from "./SurfaceView";

export interface ExtPanelHostProps {
	readonly slug: string;
	readonly id: string;
	readonly transport: SurfaceTransport;
	/** The declared `refreshMs` (§7.1); absent → no refetch cadence. */
	readonly refreshMs?: number;
	/** The shell's navigate seam (server `navigate` actions land here). */
	readonly onNavigate?: (action: {
		params?: JsonObject;
		target?: CoreTarget;
	}) => void;
}

/** One extension panel surface. Unmounting (the tab closing) stops the
 *  refresh cadence AND drops the watcher registration (no more fetches
 *  carry the stream header for this instance). */
export function ExtPanelHost(props: ExtPanelHostProps): React.JSX.Element {
	useEffect(() => {
		let alive = true;
		// The declared cadence (§7.1): refetch while the panel is OPEN
		// (unmount = hidden = the cleanup stops the timer).
		const timer =
			props.refreshMs === undefined
				? undefined
				: setInterval(() => {
						if (!alive) return;
						void props.transport.fetchData().catch(() => undefined);
					}, props.refreshMs);
		return () => {
			alive = false;
			if (timer !== undefined) clearInterval(timer);
		};
	}, [props.slug, props.id, props.transport, props.refreshMs]);

	return (
		<section
			className="ext-panel"
			data-ext-panel={`${props.slug}/${props.id}`}
		>
			<SurfaceView transport={props.transport} onNavigate={props.onNavigate} />
		</section>
	);
}
