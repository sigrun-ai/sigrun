/**
 * The extension PANEL host (UI-blocks U3 Task 5, spec §7.1): renders the
 * active panel surface in the right panel. Scope is the wire: load the
 * surface through the transport, render the title + data summary (the
 * generic block renderer is U1's), and own the cadence lifecycle — the
 * panel exists ONLY while its tab is active, so closing the tab unmounts
 * this component and stops every fetch (the stop-when-hidden rule).
 */

import { useEffect, useState } from "react";
import type { JsonObject, SurfaceTransport } from "@sigrun/shared/blocks";

export interface ExtPanelHostProps {
	readonly slug: string;
	readonly id: string;
	readonly transport: SurfaceTransport;
	/** The declared `refreshMs` (§7.1); absent → no refetch cadence. */
	readonly refreshMs?: number;
}

type PanelState =
	| { readonly status: "loading" }
	| { readonly status: "not-found" }
	| { readonly status: "failed"; readonly message: string }
	| {
			readonly status: "ready";
			readonly title: string;
			readonly data: JsonObject;
			readonly rev: number;
	  };

/** The tree's display title (a page block's `title`, else the id). */
function titleOf(tree: unknown, fallback: string): string {
	const title = (tree as { title?: unknown } | null)?.title;
	return typeof title === "string" && title !== "" ? title : fallback;
}

/** One extension panel surface. Unmounting (the tab closing) stops the
 *  refresh cadence AND drops the watcher registration (no more fetches
 *  carry the stream header for this instance). */
export function ExtPanelHost(props: ExtPanelHostProps): React.JSX.Element {
	const [state, setState] = useState<PanelState>({ status: "loading" });

	useEffect(() => {
		let alive = true;
		setState({ status: "loading" });
		const refetch = async (): Promise<void> => {
			const current = await props.transport.fetchData();
			if (!alive) return;
			setState((previous) =>
				previous.status === "ready"
					? {
							...previous,
							rev: current.rev,
							data: current.data ?? previous.data,
						}
					: previous,
			);
		};
		props.transport
			.load()
			.then((load) => {
				if (!alive) return;
				if (load.access === "none") {
					setState({ status: "not-found" });
					return;
				}
				setState({
					status: "ready",
					title: titleOf(load.tree, props.id),
					data: load.data,
					rev: load.rev,
				});
			})
			.catch((cause: unknown) => {
				if (!alive) return;
				setState({
					status: "failed",
					message: cause instanceof Error ? cause.message : String(cause),
				});
			});

		// The declared cadence (§7.1): refetch while the panel is OPEN
		// (unmount = hidden = the cleanup stops the timer).
		const timer =
			props.refreshMs === undefined
				? undefined
				: setInterval(() => {
						if (!alive) return;
						void refetch().catch(() => undefined);
					}, props.refreshMs);
		return () => {
			alive = false;
			if (timer !== undefined) clearInterval(timer);
		};
	}, [props.slug, props.id, props.transport, props.refreshMs]);

	if (state.status === "loading") {
		return <p className="ext-panel-loading">loading…</p>;
	}
	if (state.status === "not-found") {
		return <p className="ext-panel-not-found">this panel isn't available</p>;
	}
	if (state.status === "failed") {
		return (
			<p className="ext-panel-failed" role="alert">
				panel failed to load: {state.message}
			</p>
		);
	}
	return (
		<section
			className="ext-panel"
			data-ext-panel={`${props.slug}/${props.id}`}
		>
			<h3 className="ext-panel-title">{state.title}</h3>
			<pre className="ext-panel-data">{JSON.stringify(state.data)}</pre>
		</section>
	);
}
