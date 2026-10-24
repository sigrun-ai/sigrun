/**
 * useSurface (UI-blocks U1 Task 4, spec §6.3): the confirmed-data plus
 * optimistic-overlay model every surface renders through.
 *
 * - **Confirmed data** changes ONLY from server data or ops (load,
 *   fetch, accepted actions carrying ops).
 * - **The overlay** is a list of pending moves `{actionId, payload,
 *   target, untilRev?}`; the rendered `view` is confirmed data with the
 *   overlay applied on top.
 * - `{ok: true, rev, ops}` → apply the ops to confirmed, drop the entry.
 * - `{ok: true, rev}` (no ops) → keep the entry with `untilRev = rev`
 *   until a fetch at ≥ that rev arrives, then drop it — the item stays
 *   where the user dropped it with no snap-back flicker.
 * - `{ok: false}` or the 10 s timeout → drop the entry and toast.
 * - A `rev` gap (a fetch lands behind the announced rev) or a
 *   `DataOpError` applying ops → full refetch.
 *
 * The overlay needs to know WHERE a move lives in the data (the items
 * binding, the `groupBy` field, the `time` fields): `dispatch` derives
 * it by scanning the loaded tree for the collection whose `onMove`
 * handler name matches the action, and stamps it on the entry.
 *
 * Toasts are a MINIMAL local list (the webui has no shared toast store
 * yet); SurfaceView renders them inline as `role="status"` paragraphs
 * beneath the tree.
 */

import { useEffect, useRef, useState } from "react";
import type {
	Action,
	CollectionBlock,
	JsonObject,
	JsonValue,
	SurfaceAccess,
	SurfaceFetch,
	SurfaceTransport,
	Tree,
} from "@sigrun/shared/blocks";
import { DataOpError, applyOps, resolvePointer } from "@sigrun/shared/blocks";

/** An action has 10 s to answer before it counts as a reject (§6.3). */
export const ACT_TIMEOUT_MS = 10_000;

/** Where a move applies in the data (found by scanning the tree for
 *  the collection owning the `onMove` handler name). */
interface MoveTarget {
	readonly itemsPath: string;
	readonly groupBy?: string;
	readonly timeStart?: string;
	readonly timeEnd?: string;
}

/** A pending move in the optimistic overlay. */
interface OverlayEntry {
	readonly actionId: string;
	readonly payload: JsonObject;
	readonly target?: MoveTarget;
	/** Set on accept-without-ops: drop once confirmed reaches this rev. */
	readonly untilRev?: number;
}

/** The snapshot the hook renders from. */
interface Snapshot {
	readonly status: "loading" | "ready" | "notFound" | "error";
	readonly tree?: Tree;
	readonly confirmed: JsonObject;
	readonly rev: number;
	readonly treeRev: number;
	readonly access: SurfaceAccess;
	readonly overlay: readonly OverlayEntry[];
	readonly toasts: readonly string[];
	/** The channel-owned `/view/` branch (spec §6.2). */
	readonly viewState: JsonObject;
	/** Server-side field errors from rejected actions, keyed by the
	 *  field name the server named (spec §5.6); cleared on the next
	 *  accepted act or `/view/` edit. */
	readonly serverErrors: Readonly<Record<string, string>>;
}

/** Immutably write `value` at the `/view/`-relative pointer `path`
 *  (the same tokenisation `resolvePointer` uses, minus the leading
 *  `/view/` the caller already strips). */
function writeViewPath(
	viewState: JsonObject,
	path: string,
	value: JsonValue,
): JsonObject {
	const tokens = path
		.replace(/^\/+/, "")
		.split("/")
		.filter((token) => token !== "")
		.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
	if (tokens.length === 0) {
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as JsonObject)
			: viewState;
	}
	const rebuild = (node: JsonValue, depth: number): JsonValue => {
		if (depth === tokens.length) return value;
		const record: JsonObject =
			typeof node === "object" && node !== null && !Array.isArray(node)
				? { ...(node as JsonObject) }
				: {};
		const key = tokens[depth] as string;
		record[key] = rebuild(record[key] as JsonValue, depth + 1);
		return record;
	};
	return rebuild(viewState, 0) as JsonObject;
}

/** What consumers get (the brief's interface, plus `toasts` until the
 *  app grows a notification surface). */
export interface SurfaceState {
	readonly status: "loading" | "ready" | "notFound" | "error";
	readonly tree?: Tree;
	/** Confirmed data with the overlay applied — what blocks render. */
	readonly view: JsonObject;
	readonly access: "read" | "write";
	dispatch(action: Action, payload: JsonValue): void;
	/** Write the `/view/` branch (spec §6.2): the channel-owned
	 *  view-only state sibling blocks read via `/view/...` bindings. */
	setView(path: string, value: JsonValue): void;
	retry(): void;
	readonly toasts: readonly string[];
	/** Server-side field errors from rejected actions (spec §5.6),
	 *  keyed by field name; rendered under the named form field. */
	readonly serverErrors: Readonly<Record<string, string>>;
}

/** A move payload's `from`/`to` endpoint (spec §6.3 step 2). */
interface MoveSpot {
	readonly group?: string;
	readonly index?: number;
	readonly start?: string;
	readonly end?: string;
}

/** Recursive block search (children/main/sidebar/detail, plus the
 *  columns/grid `{block}` wrapper). */
function findCollection(block: unknown, name: string): CollectionBlock | undefined {
	if (typeof block !== "object" || block === null || Array.isArray(block)) {
		return undefined;
	}
	const record = block as JsonObject;
	if (record.type === "collection") {
		const collection = block as CollectionBlock;
		if (collection.onMove === name) return collection;
	}
	for (const key of ["children", "main", "sidebar", "detail"] as const) {
		const nested = record[key];
		if (Array.isArray(nested)) {
			for (const child of nested) {
				const wrapped =
					typeof child === "object" && child !== null && !Array.isArray(child)
						? (child as JsonObject).block
						: undefined;
				const hit = findCollection(child, name) ?? findCollection(wrapped, name);
				if (hit !== undefined) return hit;
			}
		}
	}
	return undefined;
}

/** The move target for a handler name (undefined when no collection
 *  declares it — the action still goes to the transport, unoverlaid). */
function findMoveTarget(
	tree: Tree | undefined,
	name: string,
): MoveTarget | undefined {
	if (tree === undefined) return undefined;
	const found = findCollection(tree.root, name);
	if (found === undefined) return undefined;
	// Literal rows (the ambient shape) have no data path to overlay.
	const items = found.items;
	if (
		typeof items !== "object" ||
		Array.isArray(items) ||
		!("$" in items)
	) {
		return undefined;
	}
	return {
		itemsPath: items.$,
		groupBy: found.groupBy,
		timeStart: found.time?.start,
		timeEnd: found.time?.end,
	};
}

/** Read a move endpoint from a payload value. */
function spot(value: JsonValue | undefined): MoveSpot | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as JsonObject;
	return {
		group: typeof record.group === "string" ? record.group : undefined,
		index: typeof record.index === "number" ? record.index : undefined,
		start: typeof record.start === "string" ? record.start : undefined,
		end: typeof record.end === "string" ? record.end : undefined,
	};
}

/** Write the items array back at its pointer, immutably along the path. */
function writeItems(
	data: JsonObject,
	itemsPath: string,
	items: readonly JsonValue[],
): JsonObject {
	const tokens = itemsPath
		.replace(/^\//, "")
		.split("/")
		.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
	if (tokens.length === 0) return data;
	const rebuild = (node: JsonValue, depth: number): JsonValue => {
		if (depth === tokens.length) return [...items];
		if (Array.isArray(node)) {
			const index = Number(tokens[depth]);
			const copy = [...node];
			copy[index] = rebuild(copy[index] as JsonValue, depth + 1);
			return copy;
		}
		if (typeof node === "object" && node !== null) {
			const record = node as JsonObject;
			const key = tokens[depth] as string;
			return { ...record, [key]: rebuild(record[key] as JsonValue, depth + 1) };
		}
		return node;
	};
	return rebuild(data, 0) as JsonObject;
}

/** Apply one overlay entry to `data` (unknown shapes leave the data
 *  untouched so a stale entry never corrupts the render). */
function applyMoveOverlay(data: JsonObject, entry: OverlayEntry): JsonObject {
	const target = entry.target;
	if (target === undefined) return data;
	const payload = entry.payload;
	const itemId = typeof payload.itemId === "string" ? payload.itemId : undefined;
	const to = spot(payload.to);
	if (itemId === undefined || to === undefined) return data;
	const items = resolvePointer(data, target.itemsPath);
	if (!Array.isArray(items)) return data;
	const fromIndex = items.findIndex(
		(item) =>
			typeof item === "object" &&
			item !== null &&
			!Array.isArray(item) &&
			(item as JsonObject).id === itemId,
	);
	if (fromIndex < 0) return data;
	const item = items[fromIndex] as JsonObject;
	const next = [...items];
	next.splice(fromIndex, 1);

	// A time move (calendar): set start/end, keep the item's position.
	if (to.start !== undefined && target.timeStart !== undefined) {
		const moved: JsonObject = { ...item, [target.timeStart]: to.start };
		if (to.end !== undefined && target.timeEnd !== undefined) {
			moved[target.timeEnd] = to.end;
		}
		next.splice(fromIndex, 0, moved);
		return writeItems(data, target.itemsPath, next);
	}

	// A group/index move (lanes, list reorder).
	if (to.group === undefined || to.index === undefined) return data;
	const moved: JsonObject =
		target.groupBy === undefined ? item : { ...item, [target.groupBy]: to.group };
	const lanePositions = next
		.map((entry, index) => ({ entry, index }))
		.filter(
			({ entry }) =>
				target.groupBy !== undefined &&
				typeof entry === "object" &&
				entry !== null &&
				!Array.isArray(entry) &&
				(entry as JsonObject)[target.groupBy] === to.group,
		)
		.map(({ index }) => index);
	const at =
		to.index < lanePositions.length
			? lanePositions[to.index] ?? next.length
			: next.length;
	next.splice(at, 0, moved);
	return writeItems(data, target.itemsPath, next);
}

/** The surface hook. */
export function useSurface(transport: SurfaceTransport): SurfaceState {
	const [snapshot, setSnapshot] = useState<Snapshot>({
		status: "loading",
		confirmed: {},
		rev: 0,
		treeRev: 0,
		access: "read",
		overlay: [],
		toasts: [],
		viewState: {},
		serverErrors: {},
	});
	// Async callbacks read the latest snapshot through this ref.
	const ref = useRef(snapshot);
	ref.current = snapshot;
	const actionSeq = useRef(0);
	/** The highest rev a `surface.changed` event announced (gap detect). */
	const announcedRev = useRef(0);
	const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

	const toast = (message: string): void => {
		setSnapshot((s) => ({ ...s, toasts: [...s.toasts, message] }));
	};

	const dropEntry = (actionId: string): void => {
		const timer = timers.current.get(actionId);
		if (timer !== undefined) {
			clearTimeout(timer);
			timers.current.delete(actionId);
		}
		setSnapshot((s) => ({
			...s,
			overlay: s.overlay.filter((entry) => entry.actionId !== actionId),
		}));
	};

	const applyFetch = (result: SurfaceFetch): void => {
		const s = ref.current;
		if (result.treeRev !== s.treeRev) {
			void doLoad();
			return;
		}
		if (result.data !== undefined) {
			setSnapshot({
				...s,
				confirmed: result.data,
				rev: result.rev,
				overlay: s.overlay.filter(
					(entry) => entry.untilRev === undefined || result.rev < entry.untilRev,
				),
			});
			return;
		}
		if (result.ops !== undefined) {
			// Gap: the ops land behind the rev the event announced.
			if (result.rev < announcedRev.current) {
				void fullRefetch();
				return;
			}
			try {
				setSnapshot({
					...s,
					confirmed: applyOps(s.confirmed, result.ops),
					rev: result.rev,
					overlay: s.overlay.filter(
						(entry) => entry.untilRev === undefined || result.rev < entry.untilRev,
					),
				});
			} catch (error) {
				if (error instanceof DataOpError) {
					void fullRefetch();
					return;
				}
				throw error;
			}
		}
	};

	const fullRefetch = async (): Promise<void> => {
		try {
			applyFetch(await transport.fetchData());
		} catch {
			// A failed refetch keeps the last confirmed data; the next
			// event or keepalive retries (§7.3).
		}
	};

	const doLoad = async (): Promise<void> => {
		try {
			const result = await transport.load();
			if (result.access === "none") {
				setSnapshot((s) => ({ ...s, status: "notFound", access: "none" }));
				return;
			}
			announcedRev.current = result.rev;
			const serverView = result.data.view;
			setSnapshot((s) => ({
				...s,
				status: "ready",
				tree: result.tree,
				confirmed: result.data,
				rev: result.rev,
				treeRev: result.treeRev,
				access: result.access,
				overlay: [],
				// Seed the `/view/` branch from the server's `view`
				// document (§6.2); local `setView` writes layer on top.
				viewState:
					typeof serverView === "object" &&
					serverView !== null &&
					!Array.isArray(serverView)
						? (serverView as JsonObject)
						: s.viewState,
			}));
		} catch {
			setSnapshot((s) => ({ ...s, status: "error" }));
		}
	};

	useEffect(() => {
		void doLoad();
		const unsubscribe = transport.onChanged((event) => {
			announcedRev.current = Math.max(announcedRev.current, event.rev);
			if (event.treeRev !== ref.current.treeRev) {
				void doLoad();
				return;
			}
			void (async (): Promise<void> => {
				try {
					applyFetch(await transport.fetchData(ref.current.rev));
				} catch {
					// Keep confirmed; the next event retries.
				}
			})();
		});
		const timersAtMount = timers.current;
		return () => {
			unsubscribe();
			for (const timer of timersAtMount.values()) clearTimeout(timer);
		};
		// The transport is the surface's identity; a new transport re-runs.
	}, [transport]);

	const dispatch = (action: Action, payload: JsonValue): void => {
		const s = ref.current;
		const payloadObject: JsonObject =
			typeof payload === "object" && payload !== null && !Array.isArray(payload)
				? (payload as JsonObject)
				: {};
		const actionId = `act-${(actionSeq.current += 1)}`;
		const name = "name" in action ? action.name : action.type;
		const isMove = action.type === "move";
		if (isMove) {
			const target = findMoveTarget(s.tree, name);
			setSnapshot({
				...s,
				overlay: [...s.overlay, { actionId, payload: payloadObject, target }],
			});
			timers.current.set(
				actionId,
				setTimeout(() => {
					dropEntry(actionId);
					toast("The action timed out");
				}, ACT_TIMEOUT_MS),
			);
		}
		void transport
			.act({ action: name, type: action.type, payload, actionId })
			.then((result) => {
				// A move whose entry is already gone (10 s timeout fired, or
				// an earlier settle dropped it) is STALE: no toast, no ops —
				// the user already saw the timeout outcome.
				if (
					isMove &&
					!ref.current.overlay.some((entry) => entry.actionId === actionId)
				) {
					return;
				}
				if (!result.ok) {
					if (isMove) dropEntry(actionId);
					toast(result.error.message);
					// §5.6: a rejection naming a field renders its message
					// under that field (SurfaceActions.serverErrors), in
					// addition to the global toast.
					if (typeof result.error.field === "string") {
						const field = result.error.field;
						const message = result.error.message;
						setSnapshot((s) => ({
							...s,
							serverErrors: { [field]: message },
						}));
					}
					return;
				}
				// An accepted act supersedes any outstanding server field
				// error (§5.6).
				setSnapshot((s) =>
					Object.keys(s.serverErrors).length > 0
						? { ...s, serverErrors: {} }
						: s,
				);
				if (result.toast !== undefined) toast(result.toast);
				if (!isMove) return;
				if (result.ops !== undefined) {
					const current = ref.current;
					try {
						setSnapshot({
							...current,
							confirmed: applyOps(current.confirmed, result.ops),
							rev: result.rev,
							overlay: current.overlay.filter(
								(entry) => entry.actionId !== actionId,
							),
						});
					} catch (error) {
						if (error instanceof DataOpError) {
							void fullRefetch();
							return;
						}
						throw error;
					}
					const timer = timers.current.get(actionId);
					if (timer !== undefined) {
						clearTimeout(timer);
						timers.current.delete(actionId);
					}
				} else {
					// Accept without ops: keep the entry until confirmed
					// reaches the accepted rev (no snap-back flicker).
					const timer = timers.current.get(actionId);
					if (timer !== undefined) {
						clearTimeout(timer);
						timers.current.delete(actionId);
					}
					setSnapshot((current) => ({
						...current,
						rev: Math.max(current.rev, result.rev),
						overlay: current.overlay.map((entry) =>
							entry.actionId === actionId
								? { ...entry, untilRev: result.rev }
								: entry,
						),
					}));
				}
			})
			.catch(() => {
				if (isMove) dropEntry(actionId);
				toast("The action failed");
			});
	};

	/** Write the `/view/` branch (spec §6.2): the channel-owned
	 *  view-only state sibling blocks read via `/view/...` bindings. */
	const setView = (path: string, value: JsonValue): void => {
		setSnapshot((s) => ({
			...s,
			viewState: writeViewPath(s.viewState, path, value),
			// An edit supersedes any outstanding server field error (§5.6).
			serverErrors: {},
		}));
	};

	// The rendered view: confirmed with every overlay entry applied in
	// dispatch order (§6.3 step 5 — server data never touches it).
	let view = snapshot.confirmed;
	for (const entry of snapshot.overlay) {
		view = applyMoveOverlay(view, entry);
	}
	// The `/view/` branch rides the returned `view` object (seeded from
	// the server's `view` document) so bindings read it like any path;
	// merged only when non-empty so a surface without view state renders
	// exactly its confirmed data.
	if (Object.keys(snapshot.viewState).length > 0) {
		view = { ...view, view: snapshot.viewState };
	}

	return {
		status: snapshot.status,
		tree: snapshot.tree,
		view,
		access: snapshot.access === "write" ? "write" : "read",
		dispatch,
		setView,
		retry: (): void => {
			setSnapshot((s) => ({ ...s, status: "loading" }));
			void doLoad();
		},
		toasts: snapshot.toasts,
		serverErrors: snapshot.serverErrors,
	};
}
