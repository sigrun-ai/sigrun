/**
 * SurfaceState (UI-blocks U2 Task 4, spec §6.3): the confirmed-data plus
 * optimistic-overlay model every TUI surface renders through — the TUI
 * port of U1's `useSurface.ts`, with EXACTLY the same overlay rules:
 *
 * - **Confirmed data** changes ONLY from server data or ops (load,
 *   fetch, accepted actions carrying ops).
 * - **The overlay** is a list of pending moves `{actionId, payload,
 *   target, untilRev?}`, keyed by `actionId`; the rendered `view` is
 *   confirmed data with the overlay applied on top.
 * - `{ok: true, rev, ops}` → apply the ops to confirmed, drop the entry.
 * - `{ok: true, rev}` (no ops) → keep the entry with `untilRev = rev`
 *   until a fetch at ≥ that rev arrives, then drop it — the item stays
 *   where the user dropped it with no snap-back flicker.
 * - `{ok: false}` or the 10 s timeout → drop the entry and surface a
 *   NOTICE. U1 toasts; the TUI's notice is a line the app flashes in
 *   the status bar — `SurfaceState` collects `notices` and the host
 *   drains them through `consumeNotices` (the status-bar wiring is the
 *   app's seam, Task 6's surface host).
 * - A `rev` gap (ops land behind the announced rev) or a `DataOpError`
 *   applying ops → a full refetch.
 * - `access: "none"` → the not-found state (§6.5); a `treeRev` change
 *   → a full reload.
 *
 * The overlay locates a move in the data by scanning the loaded tree
 * for the collection whose `onMove` handler name matches the action —
 * identical to U1 (a move against an unknown handler still goes to the
 * transport, unoverlaid).
 */

import type {
	Action,
	CollectionBlock,
	JsonObject,
	JsonValue,
	SurfaceFetch,
	SurfaceTransport,
	Tree,
} from "@sigrun/shared/blocks";
import { DataOpError, applyOps, resolvePointer } from "@sigrun/shared/blocks";

/** An action has 10 s to answer before it counts as a reject (§6.3). */
export const ACT_TIMEOUT_MS = 10_000;

/** The notice cap: pending notices drop oldest-first past 50 (a flood
 *  of failures must not grow the list without bound; the host drains
 *  them through `consumeNotices`). */
export const NOTICE_CAP = 50;

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

/** The snapshot a render reads (the brief's `ViewState`). */
export interface SurfaceView {
	readonly status: "loading" | "ready" | "notFound" | "error";
	readonly tree?: Tree;
	/** Confirmed data with the overlay applied — what blocks render. */
	readonly data: JsonObject;
	readonly rev: number;
	readonly treeRev: number;
	readonly access: "none" | "read" | "write";
	/** Pending notice lines (drain via {@link SurfaceState.consumeNotices}). */
	readonly notices: readonly string[];
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
function findMoveTarget(tree: Tree | undefined, name: string): MoveTarget | undefined {
	if (tree === undefined) return undefined;
	const found = findCollection(tree.root, name);
	if (found === undefined) return undefined;
	if (typeof found.items.$ !== "string") return undefined;
	return {
		itemsPath: found.items.$,
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
	const at = to.index < lanePositions.length ? lanePositions[to.index] ?? next.length : next.length;
	next.splice(at, 0, moved);
	return writeItems(data, target.itemsPath, next);
}

/** The surface state container (class shape — the TUI has no hook layer). */
export class SurfaceState {
	readonly #transport: SurfaceTransport;
	#status: SurfaceView["status"] = "loading";
	#tree: Tree | undefined;
	#confirmed: JsonObject = {};
	#rev = 0;
	#treeRev = 0;
	#access: "none" | "read" | "write" = "read";
	#overlay: OverlayEntry[] = [];
	#notices: string[] = [];
	/** Server-side field errors from the latest rejected action
	 *  (`{error: {field}}`, spec §5.6), keyed by field name; a success
	 *  clears them. */
	#serverErrors: Readonly<Record<string, string>> = {};
	/** The channel-owned `/view/` branch (spec §6.2): live forms bound
	 *  under `/view/` write it through {@link SurfaceState.setView}; it
	 *  never reaches the transport. */
	#viewBranch: JsonObject = {};
	#actionSeq = 0;
	/** The highest rev a change event announced (gap detect). */
	#announcedRev = 0;
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #listeners = new Set<() => void>();
	#unsubscribe: (() => void) | undefined;

	constructor(transport: SurfaceTransport) {
		this.#transport = transport;
	}

	/** The current snapshot: confirmed data with the overlay applied. */
	get view(): SurfaceView {
		let data = this.#confirmed;
		for (const entry of this.#overlay) {
			data = applyMoveOverlay(data, entry);
		}
		return {
			status: this.#status,
			tree: this.#tree,
			data,
			rev: this.#rev,
			treeRev: this.#treeRev,
			access: this.#access,
			notices: this.#notices,
		};
	}

	/** Subscribe to state changes (returns the unsubscribe). */
	onChange(cb: () => void): () => void {
		this.#listeners.add(cb);
		return () => {
			this.#listeners.delete(cb);
		};
	}

	#emit(): void {
		for (const listener of [...this.#listeners]) listener();
	}

	#notice(message: string): void {
		this.#notices = [...this.#notices, message].slice(-NOTICE_CAP);
		this.#emit();
	}

	/** Drain the pending notices (the host flashes them in the status bar). */
	consumeNotices(): readonly string[] {
		const drained = this.#notices;
		this.#notices = [];
		return drained;
	}

	/** The channel-owned `/view/` branch (spec §6.2) — a BlockCtx's
	 *  `view.values` reads this object. */
	get viewValues(): JsonObject {
		return this.#viewBranch;
	}

	/** The server field errors from the latest rejected action. */
	get serverErrors(): Readonly<Record<string, string>> {
		return this.#serverErrors;
	}

	/** Write a pointer under the `/view/` branch (the form's live
	 *  `/view/`-bound flush lands here; the write never dispatches). */
	setView(path: string, value: JsonValue): void {
		const tokens = path
			.replace(/^\/+/, "")
			.split("/")
			.filter((token) => token !== "")
			.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
		const write = (node: JsonObject, depth: number): JsonObject => {
			if (depth >= tokens.length) {
				return typeof value === "object" && value !== null && !Array.isArray(value)
					? { ...(value as JsonObject) }
					: node;
			}
			const key = tokens[depth] as string;
			if (depth === tokens.length - 1) return { ...node, [key]: value };
			const child = node[key];
			const childObject: JsonObject =
				typeof child === "object" && child !== null && !Array.isArray(child)
					? (child as JsonObject)
					: {};
			return { ...node, [key]: write(childObject, depth + 1) };
		};
		if (tokens.length === 0) {
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				this.#viewBranch = { ...(value as JsonObject) };
			}
		} else {
			this.#viewBranch = write(this.#viewBranch, 0);
		}
		this.#emit();
	}

	/** Refetch the confirmed data NOW (a settings save's follow-through,
	 *  U4 Task 4 round-2: the settings transport is outside the
	 *  surface.changed hub, so an accepted save must pull the fresh
	 *  data itself — the pending-restart callout reads the refetched
	 *  meta block). `fullRefetch` is the private move-overlay path;
	 *  this is the public probe surface. */
	async refresh(): Promise<void> {
		await this.#fullRefetch();
	}

	/** Reload after an error (SurfaceView's `r` key). */
	async retry(): Promise<void> {
		this.#status = "loading";
		this.#emit();
		await this.#doLoad();
	}

	/** Load the tree and initial data; subscribe to change events. */
	async load(): Promise<void> {
		await this.#doLoad();
		if (this.#unsubscribe === undefined) {
			this.#unsubscribe = this.#transport.onChanged((event) => {
				this.#announcedRev = Math.max(this.#announcedRev, event.rev);
				if (event.treeRev !== this.#treeRev) {
					void this.#doLoad();
					return;
				}
				void (async (): Promise<void> => {
					try {
						this.#applyFetch(await this.#transport.fetchData(this.#rev));
					} catch {
						// Keep confirmed; the next event retries (§7.3).
					}
				})();
			});
		}
	}

	/** Stop listening and cancel every pending action timer. */
	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
	}

	async #doLoad(): Promise<void> {
		try {
			const result = await this.#transport.load();
			if (result.access === "none") {
				this.#status = "notFound";
				this.#access = "none";
				this.#emit();
				return;
			}
			this.#announcedRev = result.rev;
			this.#status = "ready";
			this.#tree = result.tree;
			this.#confirmed = result.data;
			this.#rev = result.rev;
			this.#treeRev = result.treeRev;
			this.#access = result.access;
			this.#overlay = [];
			this.#emit();
		} catch {
			this.#status = "error";
			this.#emit();
		}
	}

	#dropEntry(actionId: string): void {
		const timer = this.#timers.get(actionId);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.#timers.delete(actionId);
		}
		this.#overlay = this.#overlay.filter((entry) => entry.actionId !== actionId);
		this.#emit();
	}

	#applyFetch(result: SurfaceFetch): void {
		if (result.treeRev !== this.#treeRev) {
			void this.#doLoad();
			return;
		}
		if (result.data !== undefined) {
			this.#confirmed = result.data;
			this.#rev = result.rev;
			this.#overlay = this.#overlay.filter(
				(entry) => entry.untilRev === undefined || result.rev < entry.untilRev,
			);
			this.#emit();
			return;
		}
		if (result.ops !== undefined) {
			// Gap: the ops land behind the rev the event announced.
			if (result.rev < this.#announcedRev) {
				void this.#fullRefetch();
				return;
			}
			try {
				this.#confirmed = applyOps(this.#confirmed, result.ops);
			} catch (error) {
				if (error instanceof DataOpError) {
					void this.#fullRefetch();
					return;
				}
				throw error;
			}
			this.#rev = result.rev;
			this.#overlay = this.#overlay.filter(
				(entry) => entry.untilRev === undefined || result.rev < entry.untilRev,
			);
			this.#emit();
		}
	}

	async #fullRefetch(): Promise<void> {
		try {
			this.#applyFetch(await this.#transport.fetchData());
		} catch {
			// A failed refetch keeps the last confirmed data; the next
			// event or keepalive retries (§7.3).
		}
	}

	/** Dispatch an action to the surface; a move joins the overlay first. */
	dispatch(action: Action, payload: JsonValue): void {
		const payloadObject: JsonObject =
			typeof payload === "object" && payload !== null && !Array.isArray(payload)
				? (payload as JsonObject)
				: {};
		const actionId = `act-${(this.#actionSeq += 1)}`;
		const name = "name" in action ? action.name : action.type;
		const isMove = action.type === "move";
		if (isMove) {
			const target = findMoveTarget(this.#tree, name);
			this.#overlay = [...this.#overlay, { actionId, payload: payloadObject, target }];
			this.#timers.set(
				actionId,
				setTimeout(() => {
					this.#dropEntry(actionId);
					this.#notice("The action timed out");
				}, ACT_TIMEOUT_MS),
			);
			this.#emit();
		}
		void this.#transport
			.act({ action: name, payload, actionId })
			.then((result) => {
				// A move whose entry is already gone (the 10 s timeout fired)
				// is STALE: no ops, no notice — the user already saw it fail.
				if (
					isMove &&
					!this.#overlay.some((entry) => entry.actionId === actionId)
				) {
					return;
				}
				if (!result.ok) {
					if (isMove) this.#dropEntry(actionId);
					// A rejected action's `{error: {field}}` surfaces under
					// that field (spec §5.6); an unfielded rejection clears
					// any previous field error.
					this.#serverErrors =
						result.error.field === undefined
							? {}
							: { [result.error.field]: result.error.message };
					this.#notice(result.error.message);
					// A "changed by someone else" rejection means the
					// confirmed data (and the rev the form rides) is stale —
					// refetch so the NEXT save carries the current rev (U4
					// Task 4 round-2: without it, the form rev is pinned and
					// every retry rejects the same way).
					if (result.error.message === "changed by someone else") {
						void this.#fullRefetch();
					}
					return;
				}
				this.#serverErrors = {};
				if (result.toast !== undefined) this.#notice(result.toast);
				if (!isMove) {
					// A non-move accept (the settings save): the rev already
					// bumped server-side (the optimistic check needs the form's
					// NEXT submit to carry it), and the fresh data (the core
					// sections' meta block — the pending-restart callout) only
					// lands via a fetch (the settings transport is outside the
					// surface.changed hub — the app owns the probe).
					this.#rev = result.rev;
					void this.#fullRefetch();
					return;
				}
				if (result.ops !== undefined) {
					try {
						this.#confirmed = applyOps(this.#confirmed, result.ops);
					} catch (error) {
						if (error instanceof DataOpError) {
							void this.#fullRefetch();
							return;
						}
						throw error;
					}
					this.#rev = result.rev;
					const timer = this.#timers.get(actionId);
					if (timer !== undefined) {
						clearTimeout(timer);
						this.#timers.delete(actionId);
					}
					this.#overlay = this.#overlay.filter((entry) => entry.actionId !== actionId);
					this.#emit();
				} else {
					// Accept without ops: hold the entry until confirmed reaches
					// the accepted rev (no snap-back flicker, §6.3).
					const timer = this.#timers.get(actionId);
					if (timer !== undefined) {
						clearTimeout(timer);
						this.#timers.delete(actionId);
					}
					this.#rev = Math.max(this.#rev, result.rev);
					this.#overlay = this.#overlay.map((entry) =>
						entry.actionId === actionId ? { ...entry, untilRev: result.rev } : entry,
					);
					this.#emit();
				}
			})
			.catch(() => {
				if (isMove) this.#dropEntry(actionId);
				this.#notice("The action failed");
			});
	}
}
