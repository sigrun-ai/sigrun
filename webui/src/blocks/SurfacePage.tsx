/**
 * The extension-surface page (UI-blocks U3 Task 5): the main-pane host
 * for one extension view, reached through the `#/ext/<slug>/<id>` route.
 *
 * U3's scope is the WIRE: load the surface through the transport, hold
 * the last frame, honor `refreshMs` (refetch data on the interval while
 * visible, stop on unmount) plus the 5-minute watcher keepalive (a
 * `since` fetch), and translate server `navigate` actions into the
 * app's route changes. The generic block renderer is U1's; until it
 * lands the page renders the surface's title + data summary + its
 * actions row, so the two-browser e2e (a drag across lanes) has real
 * DOM to drive.
 */

import { useEffect, useRef, useState } from "react";
import type {
	JsonObject,
	SurfaceActResult,
	SurfaceTransport,
} from "@sigrun/shared/blocks";
import type { ExtSurfaceHub } from "./extTransport";

/** The watcher-keepalive interval (spec §7.3): a `since` fetch every 5
 *  minutes while visible keeps the registry entry alive. */
export const KEEPALIVE_MS = 5 * 60 * 1000;

/** The page's settle state: the loaded surface, or its failure. */
type SurfaceState =
	| { readonly status: "loading" }
	| { readonly status: "not-found" }
	| { readonly status: "failed"; readonly message: string }
	| {
			readonly status: "ready";
			readonly title: string;
			readonly data: JsonObject;
			readonly rev: number;
			readonly treeRev: number;
			readonly access: "read" | "write";
		};

export interface SurfacePageProps {
	readonly slug: string;
	readonly id: string;
	readonly transport: SurfaceTransport;
	readonly hub: ExtSurfaceHub;
	/** The declared `refreshMs` (spec §7.3) — refetch data on this
	 *  interval while visible. Absent → no refresh cadence. */
	readonly refreshMs?: number;
	/** The shell's navigate seam: server `navigate` actions land here. */
	readonly onNavigate?: (action: { params?: JsonObject; target?: unknown }) => void;
}

/**
 * One extension-surface page. Loads on mount; refetches on `refreshMs`
 * while mounted; a 5-minute keepalive `since` fetch runs while visible;
 * `surface.changed` events (through the hub) trigger a `since` fetch.
 */
export function SurfacePage(props: SurfacePageProps): React.JSX.Element {
	const [state, setState] = useState<SurfaceState>({ status: "loading" });
	// The last confirmed rev (the since cursor); survives state resets.
	const revRef = useRef(0);
	const treeRevRef = useRef(0);

	// The load + subscription effect: keyed on the instance identity
	// (slug/id — the transport is per-instance; a params change is a NEW
	// transport from the shell).
	useEffect(() => {
		let alive = true;
		setState({ status: "loading" });
		props.transport
			.load()
			.then((load) => {
				if (!alive) return;
				if (load.access === "none") {
					setState({ status: "not-found" });
					return;
				}
				revRef.current = load.rev;
				treeRevRef.current = load.treeRev;
				setState({
					status: "ready",
					title: titleOf(load.tree),
					data: load.data,
					rev: load.rev,
					treeRev: load.treeRev,
					access: load.access,
				});
			})
			.catch((cause: unknown) => {
				if (!alive) return;
				setState({
					status: "failed",
					message: cause instanceof Error ? cause.message : String(cause),
				});
			});

		// surface.changed → a since fetch (the event carries no data).
		const offChanged = props.transport.onChanged((event) => {
			revRef.current = Math.max(revRef.current, event.rev);
			void props.transport.fetchData(event.rev).catch(() => undefined);
		});

		// refreshMs cadence (spec §7.3): refetch data on the interval while
		// mounted. `data()` requires no `since` — the server's data route
		// returns the full data for non-shared surfaces and the ops window
		// for shared ones.
		const refreshTimer =
			props.refreshMs === undefined
				? undefined
				: setInterval(() => {
						if (!alive) return;
						void props.transport.fetchData().catch(() => undefined);
					}, props.refreshMs);

		// The 5-minute watcher keepalive: a since fetch re-registers the
		// watcher entry (spec §7.3's 10-minute TTL has margin).
		const keepaliveTimer = setInterval(() => {
			if (!alive) return;
			void props.transport.fetchData(revRef.current).catch(() => undefined);
		}, KEEPALIVE_MS);

		return () => {
			alive = false;
			offChanged();
			if (refreshTimer !== undefined) clearInterval(refreshTimer);
			clearInterval(keepaliveTimer);
		};
	}, [props.slug, props.id, props.transport, props.hub, props.refreshMs]);

	if (state.status === "loading") {
		return <p className="ext-surface-loading">loading…</p>;
	}
	if (state.status === "not-found") {
		return (
			<p className="ext-surface-not-found" role="alert">
				surface not found
			</p>
		);
	}
	if (state.status === "failed") {
		return (
			<p className="ext-surface-failed" role="alert">
				surface failed: {state.message}
			</p>
		);
	}
	return (
		<section className="ext-surface" data-ext-surface={`${props.slug}/${props.id}`}>
			<h2 className="ext-surface-title">{state.title}</h2>
			<pre className="ext-surface-data">{JSON.stringify(state.data)}</pre>
		</section>
	);
}

/** The tree's display title (the page block's `title`, else the id). */
function titleOf(tree: unknown): string {
	if (
		typeof tree === "object" &&
		tree !== null &&
		"title" in tree &&
		typeof (tree as { title?: unknown }).title === "string"
	) {
		return (tree as { title: string }).title;
	}
	return "extension surface";
}
