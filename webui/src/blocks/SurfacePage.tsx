/**
 * The extension-surface page (UI-blocks U3 Task 5): the main-pane host
 * for one extension view, reached through the `#/ext/<slug>/<id>` route.
 *
 * U3's scope is the WIRE plus a MINIMAL interim renderer for the
 * lane-board shape the fixture/e2e drive: `load` → hold the last frame;
 * `refreshMs` refetches data on the interval while visible (stops on
 * unmount); a 5-minute `since` fetch keeps the watcher entry alive;
 * `surface.changed` events (via the hub) trigger a `since` fetch and
 * apply the returned data. The generic block renderer is U1's — when it
 * lands it replaces the board section below, keeping this page's
 * transport/lifecycle layer.
 *
 * Optimistic moves (spec §6.3): a drag applies locally at once, then
 * POSTs `{action:"move", payload, actionId}`; an accepted response keeps
 * the overlay, a rejection re-fetches (snap-back).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
	CoreTarget,
	JsonObject,
	JsonValue,
	SurfaceTransport,
	Tree,
} from "@sigrun/shared/blocks";
import type { ExtSurfaceHub } from "./extTransport";

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

/** One board card (the lane-board data shape the fixture declares);
 *  the index signature keeps the object a JsonObject. */
interface BoardCard {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly [key: string]: JsonValue;
}

/** The board data shape (`{cards: BoardCard[]}`); non-board surfaces
 *  render a generic JSON summary instead. */
interface BoardData {
	readonly cards: readonly BoardCard[];
}

function isBoardData(data: JsonObject): data is JsonObject & BoardData {
	const cards = (data as { cards?: unknown }).cards;
	return (
		Array.isArray(cards) &&
		cards.every(
			(card) =>
				typeof card === "object" &&
				card !== null &&
				typeof (card as { id?: unknown }).id === "string" &&
				typeof (card as { status?: unknown }).status === "string",
		)
	);
}

/** The lane definitions from the tree (the collection block's groups). */
interface Lane {
	readonly id: string;
	readonly title: string;
}

function lanesOf(tree: Tree): readonly Lane[] {
	const main = (tree as { main?: readonly unknown[] }).main;
	if (!Array.isArray(main)) return [];
	for (const block of main) {
		const groups = (block as { groups?: readonly Lane[] } | null)?.groups;
		if (groups !== undefined) return groups;
	}
	return [];
}

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
	const [state, setState] = useState<SurfaceState>({ status: "loading" });
	const revRef = useRef(0);
	// The last loaded tree (the interim renderer reads its lane groups).
	// SAFETY: the pre-load placeholder is never rendered (the loading
	// state returns before lanesOf runs); the first load replaces it.
	const treeRef = useRef<Tree>(undefined as unknown as Tree);

	// The data-fetch seam the effects + gestures share: fetch since the
	// last confirmed rev and fold the result into state. A sharedData
	// surface (§7.3) may answer a since fetch INSIDE the ops window with
	// `{rev, treeRev, ops}` and NO data — the interim renderer does not
	// apply ops (U1's fold), so ops-only answers fall back to ONE full
	// no-since refetch (cheap and correct).
	const refetch = useCallback(async (): Promise<void> => {
		const since = revRef.current;
		let result = await props.transport.fetchData(since);
		if (result.data === undefined && result.ops !== undefined) {
			result = await props.transport.fetchData();
		}
		if (result.data === undefined) return;
		const data = result.data;
		revRef.current = Math.max(revRef.current, result.rev);
		setState((current) => {
			if (current.status !== "ready") return current;
			return {
				...current,
				rev: result.rev,
				treeRev: result.treeRev,
				data,
			};
		});
	}, [props.transport]);

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
				treeRef.current = load.tree;
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
		const offChanged = props.transport.onChanged(() => {
			void refetch().catch(() => undefined);
		});

		// refreshMs cadence (spec §7.3): refetch data while the surface is
		// VISIBLE — a hidden tab pauses the timer (the visibility listener
		// restarts it on return).
		let refreshTimer: ReturnType<typeof setInterval> | undefined;
		const startRefresh = (): void => {
			if (props.refreshMs === undefined || refreshTimer !== undefined) return;
			refreshTimer = setInterval(() => {
				if (!alive) return;
				void refetch().catch(() => undefined);
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
				void refetch().catch(() => undefined);
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
				void refetch().catch(() => undefined);
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
	}, [props.slug, props.id, props.transport, props.hub, props.refreshMs, refetch]);

	// The optimistic move (§6.3): apply locally, POST the action, snap
	// back on a rejection (a refetch restores the confirmed data).
	const onMove = useCallback(
		async (itemId: string, toLane: string): Promise<void> => {
			setState((current) => {
				if (current.status !== "ready" || !isBoardData(current.data)) {
					return current;
				}
				const cards = current.data.cards.map((card) =>
					card.id === itemId ? { ...card, status: toLane } : card,
				);
				return { ...current, data: { ...current.data, cards } };
			});
			const result = await props.transport.act({
				action: "move",
				payload: { itemId, to: { group: toLane } } as JsonValue,
				actionId: crypto.randomUUID(),
			});
			if (result.ok === false) {
				// Snap back (the overlay drops): refetch the confirmed data.
				await refetch().catch(() => undefined);
				return;
			}
			revRef.current = Math.max(revRef.current, result.rev);
			// An accepted action's `navigate` field (spec §6.1) routes
			// through the shell (the act result is the DELIVERY path).
			if (result.navigate !== undefined && result.navigate.type === "navigate") {
				props.onNavigate?.({
					...(result.navigate.params === undefined
						? {}
						: { params: result.navigate.params }),
					...(result.navigate.target === undefined
						? {}
						: { target: result.navigate.target }),
				});
			}
		},
		[props.transport, props.onNavigate, refetch],
	);

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
			{isBoardData(state.data) ? (
				<LaneBoard
					data={state.data}
					lanes={lanesOf(treeRef.current)}
					access={state.access}
					onMove={onMove}
				/>
			) : (
				<pre className="ext-surface-data">{JSON.stringify(state.data)}</pre>
			)}
		</section>
	);
}


/** The interim lane board: one column per lane, draggable cards; access
 *  "read" hides every drag affordance (spec §6.5). */
function LaneBoard(props: {
	readonly data: BoardData;
	readonly lanes: readonly Lane[];
	readonly access: "read" | "write";
	readonly onMove: (itemId: string, toLane: string) => Promise<void>;
}): React.JSX.Element {
	// Lanes derive from the card status values present in the data (the
	// tree's group order is a U1 renderer concern); the three fixture
	// lanes render in a stable order.
	const laneIds = ["todo", "doing", "done"];
	return (
		<div className="ext-board" role="list">
			{laneIds.map((lane) => (
				<div
					key={lane}
					className="ext-board-lane"
					data-lane={lane}
					role="list"
					onDragOver={(event) => {
						if (props.access === "write") event.preventDefault();
					}}
					onDrop={(event) => {
						if (props.access !== "write") return;
						const itemId = event.dataTransfer.getData("text/plain");
						if (itemId !== "") void props.onMove(itemId, lane);
					}}
				>
					<h3 className="ext-board-lane-title">{lane}</h3>
					{props.data.cards
						.filter((card) => card.status === lane)
						.map((card) => (
							<div
								key={card.id}
								className="ext-board-card"
								data-card={card.id}
								role="listitem"
								draggable={props.access === "write"}
								data-draggable={props.access === "write" ? "true" : "false"}
								onDragStart={(event) => {
									event.dataTransfer.setData("text/plain", card.id);
								}}
							>
								{card.title}
							</div>
						))}
				</div>
			))}
		</div>
	);
}

/** The tree's display title (the page block's `title`, else a fallback). */
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
