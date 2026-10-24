/**
 * The surface service (UI-blocks U3 Task 2, spec §7.1–§7.3): renders
 * and refetches extension surfaces over the loader's flattened
 * `ExtensionSurfaceBinding` list, enforcing the per-principal access
 * contract (§6.5) server-side:
 *
 * - `render` validates the extension's tree against its placement with
 *   `handlers` = the surface's action keys, caches the verdict per
 *   `(slug, id, key, principal.user)` for 60 s, and keeps per-instance
 *   revision state (`rev`, `treeRev`, and the shared-data op log);
 * - `data` refetches principal-specific surfaces by calling the
 *   extension's `data()` on EVERY fetch; for a surface without `data()`
 *   (and without `refreshMs`) the fetch re-runs `render` (the brief's
 *   ruling; spec §7.1's "data refetch would re-run render");
 * - `sharedData` surfaces keep the last {@link SHARED_OPS_WINDOW} ops
 *   passed to `changed`/`bumpRev` per instance; a `since` inside the
 *   window answers `{rev, treeRev, ops}`, a stale `since` falls back to
 *   a full `data()` call;
 * - `none` is indistinguishable from an unknown id (the routes map both
 *   to the same 404 body).
 *
 * Errors: a render/data throw, or an invalid tree, throws
 * {@link SurfaceFailedError} carrying the validation errors; the route
 * maps it to `500 surface_failed` (bodies carry `errors` only when
 * `server.dev`). The extension stays loaded.
 */

import type { JsonObject, Tree } from "@sigrun/shared/blocks";
import type { DataOps, JsonValue } from "@sigrun/shared/blocks";
import type { ImageSign } from "../images/rewrite.js";
import { rewriteImages } from "../images/rewrite.js";
import { validateTree, type ValidationError } from "../../blocks/validate.js";
import type {
	ActionResult,
	Principal,
	SurfaceAccessLevel,
	SurfaceDef,
	UploadedFile,
} from "../../extension.js";
import type { ExtensionSurfaceBinding } from "../../harness/loader.js";
import { AccessCache } from "./access-cache.js";
import { ActionDedup } from "./dedup.js";
import { eventKey, instanceKey as defaultInstanceKey } from "./instance.js";
import { sniffMime } from "./mime.js";
import { ActionRateLimit } from "./rate-limit.js";
import { WatcherRegistry } from "./watchers.js";

/** The shared-data op-log window (spec §7.3): the last 100 updates. */
export const SHARED_OPS_WINDOW = 100;

/** The action timeout (spec §6.3): 10 s, then the action is a reject. */
export const ACTION_TIMEOUT_MS = 10 * 1000;

/** The body sent for a timed-out handler (spec §6.3 step 4). */
const TIMED_OUT_RESULT: ActionResult = {
	ok: false,
	error: { message: "timed out" },
};

/**
 * The action route's response (spec §6.3 step 3): the handler's
 * ActionResult, wrapped server-side — an accept carries the assigned
 * `rev` and, for an accept WITH ops, the `ops` echoed back.
 */
export type ActionResponse =
	| {
			readonly ok: true;
			readonly rev: number;
			readonly ops?: DataOps["ops"];
			readonly navigate?: Extract<
				ActionResult,
				{ readonly ok: true }
			>["navigate"];
			readonly toast?: string;
		}
	| Extract<ActionResult, { readonly ok: false }>;

/** Errors `act` reports without calling the handler. */
export class ActionRateLimitedError extends Error {
	constructor() {
		super("rate limited");
		this.name = "ActionRateLimitedError";
	}
}

export class UnknownActionError extends Error {
	constructor(action: string) {
		super(`unknown action: ${action}`);
		this.name = "UnknownActionError";
	}
}

/** A plain record (the tree walk's node shape). */
type Rec = Record<string, unknown>;

/**
 * The internal surface.changed event (UI-blocks U3 Task 4): the wire
 * shape PLUS the resolved watching-stream list, computed at publish
 * time (the watcher registry keys on the PLAIN instance key; the wire's
 * hashed `k` can never be reversed). The events route's visibility case
 * reads `streams` and strips it before delivery (spec §7.3: the event
 * carries no data — and no routing metadata either).
 */
export interface SurfaceChangedInternal {
	readonly type: "surface.changed";
	readonly slug: string;
	readonly id: string;
	readonly k: string;
	readonly rev: number;
	readonly treeRev: number;
	/** The watching streams (registry answer at publish time). */
	readonly streams: readonly string[];
}

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Yield every node of a block tree, structurally (the walk only reads
 * `children`, `fields`, `item`, and each field's own props — a tree
 * validated at render time is the expected input, but an unvalidated
 * def tree walks the same way).
 */
function* walkNodes(root: Rec): Generator<Rec> {
	yield root;
	// The tree record itself: descend its `root`. Blocks descend their
	// `children` (stack/section/form/columns…), a page's `main`, a
	// collection's `item` template, and a form's field lists; a `list`
	// field's `item` field recurses the same way.
	const childLists = [
		root.root,
		root.children,
		root.fields,
		root.main,
		root.sidebar,
		root.detail,
	];
	for (const list of childLists) {
		if (Array.isArray(list)) {
			for (const child of list) {
				if (isRec(child)) {
					if (isRec(child.block)) {
						// columns/grid wrappers: `{weight?, block}`
						yield* walkNodes(child.block);
					} else {
						yield* walkNodes(child);
					}
				}
			}
		} else if (isRec(list)) {
			yield* walkNodes(list);
		}
	}
	if (isRec(root.item)) yield* walkNodes(root.item);
}

/** A render/data failure (throw or invalid tree) → 500 surface_failed. */
export class SurfaceFailedError extends Error {
	readonly errors: readonly ValidationError[] | undefined;

	constructor(message: string, errors?: readonly ValidationError[]) {
		super(message);
		this.name = "SurfaceFailedError";
		this.errors = errors;
	}
}

/** The render route's result (spec §7.2). */
export interface RenderResult {
	readonly tree: Tree;
	readonly data: JsonObject;
	readonly rev: number;
	readonly treeRev: number;
	readonly access: SurfaceAccessLevel;
}

/** The data route's result: full data, or ops since `since`. */
export interface DataResult {
	readonly rev: number;
	readonly treeRev: number;
	readonly data?: JsonObject;
	readonly ops?: readonly unknown[];
}

/** Access re-resolution: `accessFor` outcome, cache or re-render. */
export type SurfaceAccess = SurfaceAccessLevel;

/** Per-instance live state (memory-only; spec §7.3 revs are per process). */
interface InstanceState {
	rev: number;
	treeRev: number;
	/** Retained ops (sharedData only): each with the rev it produced. */
	ops: { readonly rev: number; readonly ops: readonly unknown[] }[];
	/** The `file` fields of the last rendered tree: name → maxBytes. */
	fileFields: Map<string, number>;
}

/** One located surface: its binding plus its def. */
interface Located {
	readonly slug: string;
	readonly def: SurfaceDef<"view" | "panel">;
}

/**
 * The render/data service over `opened.extensionSurfaces`. Holds the
 * access cache and the per-instance revision state.
 */
export class SurfaceService {
	private readonly bindings: readonly ExtensionSurfaceBinding[];
	private readonly cache: AccessCache;
	private readonly instances = new Map<string, InstanceState>();
	private readonly dedup = new ActionDedup();
	private readonly rateLimit = new ActionRateLimit();
	private readonly maxUploadBytes: number;
	private readonly watchers: WatcherRegistry;
	private readonly publishChanged: ((event: SurfaceChangedInternal) => void) | undefined;
	/** The image-signer (U7 Task 1, spec §11.2): every tree/data response passes through the rewriter before leaving the server. */
	private readonly imageSign: ImageSign | undefined;

	constructor(
		bindings: readonly ExtensionSurfaceBinding[],
		options?: {
			maxUploadBytes?: number;
			/** The watcher registry (Task 4); defaults to a private one. */
			watchers?: WatcherRegistry;
			/** The hub publish (Task 4): bumpRev fans out surface.changed. */
			publishChanged?: (event: SurfaceChangedInternal) => void;
			/** Signs https image URLs into expiring proxy URLs (U7 Task 1); absent = pass-through. */
			imageSign?: ImageSign;
		},
	) {
		this.bindings = bindings;
		this.cache = new AccessCache();
		this.maxUploadBytes = options?.maxUploadBytes ?? Number.MAX_SAFE_INTEGER;
		this.watchers = options?.watchers ?? new WatcherRegistry();
		this.publishChanged = options?.publishChanged;
		this.imageSign = options?.imageSign;
	}

	/** The watcher registry (the events route reads it per event). */
	get watcherRegistry(): WatcherRegistry {
		return this.watchers;
	}

	/** Find one surface def by slug + id. */
	private locate(slug: string, id: string): Located | undefined {
		for (const binding of this.bindings) {
			if (binding.extension !== slug) continue;
			const def = binding.defs.find((entry) => entry.id === id);
			if (def !== undefined) return { slug, def };
		}
		return undefined;
	}

	/** The instance key: the surface's own `instanceKey` or the default. */
	private keyFor(
		def: SurfaceDef<"view" | "panel">,
		params: JsonObject,
	): string {
		if (def.instanceKey !== undefined) return def.instanceKey(params);
		return defaultInstanceKey(params);
	}

	/** The per-instance state, created on first touch (revs start at 0). */
	private stateFor(slug: string, id: string, key: string): InstanceState {
		const composite = `${slug}\u0001${id}\u0001${key}`;
		let state = this.instances.get(composite);
		if (state === undefined) {
			state = { rev: 0, treeRev: 0, ops: [], fileFields: new Map() };
			this.instances.set(composite, state);
		}
		return state;
	}

	/**
	 * Render one surface instance for one principal. Throws
	 * SurfaceFailedError on an extension throw or an invalid tree; returns
	 * `undefined` when the surface id is unknown or access is `none`.
	 */
	async render(
		slug: string,
		id: string,
		params: JsonObject,
		principal: Principal,
		_stream?: string,
	): Promise<RenderResult | undefined> {
		const located = this.locate(slug, id);
		if (located === undefined) return undefined;
		const key = this.keyFor(located.def, params);
		const result = await this.callRender(located, key, params, principal);
		const validation = validateTree(result.tree, {
			placement: located.def.placement,
			handlers: new Set(Object.keys(located.def.actions ?? {})),
		});
		if (!validation.ok) {
			throw new SurfaceFailedError(
				`surface ${slug}/${id} returned an invalid tree`,
				validation.errors,
			);
		}
		this.cache.set(slug, id, key, principal.user, result.access);
		if (result.access === "none") return undefined;
		// The watcher registration (Task 4, spec §7.3): a fetch carrying
		// `X-Sigrun-Stream` creates/refreshes the entry with the access the
		// fetch resolved — the events route reads the STORED access, never
		// re-rendering per event.
		if (_stream !== undefined) {
			this.watchers.touch(_stream, principal.user ?? "", slug, id, key, result.access);
		}
		const state = this.stateFor(slug, id, key);
		// Record the tree's file-field caps for the upload route (spec
		// §7.1: the field's maxBytes, clamped by server.maxUploadBytes).
		state.fileFields.clear();
		for (const node of walkNodes(validation.tree as Rec)) {
			if (node.type === "file" && typeof node.name === "string") {
				if (typeof node.maxBytes === "number") {
					state.fileFields.set(node.name, node.maxBytes);
				}
			}
		}
		return {
			// SAFETY: the rewriter is a structural JSON walk returning the same
			// shape; `Tree` (interfaces) has no implicit index signature, so the
			// generic JsonValue round-trip needs the bridge cast.
			tree: this.rewriteForWire(
				validation.tree as unknown as JsonValue,
			) as unknown as Tree,
			data: this.rewriteForWire(result.data),
			rev: state.rev,
			treeRev: state.treeRev,
			access: result.access,
		};
	}

	/**
	 * Fetch one instance's data. Principal-specific surfaces call
	 * `data()` on every fetch (or re-run `render` when no `data()` exists
	 * — the data-less fallback ruling). `sharedData` surfaces answer from
	 * the op log when `since` is inside the window. Returns `undefined`
	 * for unknown ids and `none` access alike.
	 */
	async data(
		slug: string,
		id: string,
		params: JsonObject,
		principal: Principal,
		since?: number,
		_stream?: string,
	): Promise<DataResult | undefined> {
		const located = this.locate(slug, id);
		if (located === undefined) return undefined;
		const key = this.keyFor(located.def, params);
		const state = this.stateFor(slug, id, key);
		const access = await this.accessFor(slug, id, key, params, principal);
		if (access === "none") return undefined;

		// The since window (spec §7.3): contiguous iff every rev increment
		// corresponds to one logged op (the full-fetch path below never
		// bumps a sharedData rev, preserving this). `since == rev` answers
		// an empty op list — the client is current.
		if (
			located.def.sharedData === true &&
			since !== undefined &&
			since >= state.rev - state.ops.length &&
			since <= state.rev
		) {
			const ops = state.ops
				.filter((entry) => entry.rev > since)
				.flatMap((entry) => entry.ops);
			// Ops answers are data responses too (spec §7.3): the client folds
			// them into its local copy, so they must carry the SAME rewritten
			// sources the full data answer would — else fold(data, ops) drifts
			// from the server's data.
			return {
				rev: state.rev,
				treeRev: state.treeRev,
				// SAFETY: ops are wire JSON (DataOp values); the rewriter returns
				// the same shape, and `unknown[]`'s lack of an index signature is
				// the only reason for the bridge cast.
				ops: this.rewriteForWire(ops as unknown as JsonValue) as unknown as readonly unknown[],
			};
		}

		let data: JsonObject;
		let access2: SurfaceAccessLevel;
		if (located.def.data !== undefined) {
			let result;
			try {
				result = await located.def.data({
					principal,
					params,
					key,
					signal: new AbortController().signal,
				});
			} catch (cause) {
				throw new SurfaceFailedError(
					`surface ${slug}/${id} data() threw: ${
						cause instanceof Error ? cause.message : String(cause)
					}`,
				);
			}
			data = result.data;
			access2 = result.access;
		} else {
			// No data(): the refetch re-runs render (the fallback ruling).
			const rendered = await this.callRender(located, key, params, principal);
			data = rendered.data;
			access2 = rendered.access;
		}
		this.cache.set(slug, id, key, principal.user, access2);
		if (_stream !== undefined) {
			this.watchers.touch(_stream, principal.user ?? "", slug, id, key, access2);
		}
		if (access2 === "none") return undefined;
		// Rev advances only via bumpRev for sharedData surfaces (spec §7.3):
		// the server-assigned rev reflects STORED changes, and a full data()
		// refetch returns data consistent with the stored rev — bumping here
		// would break the since-window invariant (every rev must correspond
		// to one logged op) and strand clients at an unobservable revision.
		// Principal-specific surfaces keep no ops contract; their bump is a
		// per-fetch freshness marker only (gap detection, never consumed for
		// ops).
		if (located.def.sharedData !== true) {
			state.rev += 1;
		}
		return { rev: state.rev, treeRev: state.treeRev, data: this.rewriteForWire(data) };
	}

	/**
	 * The wire-side image rewrite (U7 Task 1, spec §11.1/§11.2): every
	 * tree and data (and ops) response passes through `rewriteImages`
	 * before leaving the server, replacing https image sources with
	 * signed proxy URLs. Absent signer → verbatim pass-through. This is
	 * the hook point U5's chat surfaces reuse when they land: they call
	 * the same `rewriteImages` over their trees/data.
	 */
	private rewriteForWire<T extends JsonValue>(value: T): T {
		return this.imageSign === undefined
			? value
			: rewriteImages(value, this.imageSign);
	}

	/**
	 * One principal's access to one instance (spec §6.5): the cached
	 * verdict when fresh, else a re-render whose answer is cached.
	 */
	async accessFor(
		slug: string,
		id: string,
		key: string,
		params: JsonObject,
		principal: Principal,
	): Promise<SurfaceAccess> {
		const cached = this.cache.get(slug, id, key, principal.user);
		if (cached !== undefined) return cached;
		const located = this.locate(slug, id);
		if (located === undefined) return "none";
		const result = await this.callRender(located, key, params, principal);
		this.cache.set(slug, id, key, principal.user, result.access);
		return result.access;
	}

	/** The composite instance key (`slugidkey`) for one def + params. */
	compositeFor(
		slug: string,
		def: SurfaceDef<"view" | "panel">,
		params: JsonObject,
	): string {
		return `${slug}${def.id}${this.keyFor(def, params)}`;
	}

	/**
	 * The effective upload cap for one field (spec §7.1): the field's
	 * own `maxBytes` clamped by the server-wide `server.maxUploadBytes`.
	 * A field absent from the last rendered tree answers `undefined`.
	 */
	uploadCapBytes(
		slug: string,
		id: string,
		key: string,
		field: string,
	): number | undefined {
		const state = this.instances.get(`${slug}${id}${key}`);
		if (state === undefined) return undefined;
		if (!state.fileFields.has(field)) return undefined;
		const fieldMax = state.fileFields.get(field);
		return Math.min(fieldMax ?? Number.MAX_SAFE_INTEGER, this.maxUploadBytes);
	}

	/** Test seam: enable or disable the action rate limiter. */
	setRateLimitDisabled(disabled: boolean): void {
		this.rateLimit.setDisabled(disabled);
	}

	/**
	 * Invoke one action handler (spec §6.1/§6.3/§15): rate-limited per
	 * principal per surface, deduped per actionId per instance for 10
	 * minutes (a duplicate returns the FIRST stored result), timed out
	 * at 10 s (the handler is abandoned; its late settlement is dropped
	 * — the dedup entry still records the timeout body), and wrapped per
	 * §6.3: an accept WITH `update.ops` answers `{ok, rev, ops}` (ops
	 * logged for sharedData), an accept WITHOUT ops answers `{ok, rev}`
	 * with nothing recorded (extension surfaces own their data), and
	 * `navigate`/`toast` pass through.
	 *
	 * Ordering note (a decision, not an accident): the rate limiter
	 * takes its token BEFORE the dedup check, so a legitimate retry of
	 * an already-processed actionId still costs a token — replayed
	 * actionIds can never probe the service rate-free; the trade-off is
	 * that a client hammering one actionId can 429 itself.
	 *
	 * The caller (the route) has ALREADY enforced access; a miss/throw
	 * inside the handler maps to {@link SurfaceFailedError}.
	 */
	async act(
		slug: string,
		id: string,
		key: string,
		params: JsonObject,
		principal: Principal,
		action: string,
		payload: unknown,
		actionId: string | undefined,
		signal: AbortSignal,
	): Promise<ActionResponse> {
		const located = this.locate(slug, id);
		if (located === undefined) return { ok: false, error: { message: "unknown surface" } };
		const handler = located.def.actions?.[action];
		if (handler === undefined) throw new UnknownActionError(action);
		if (!this.rateLimit.take(slug, id, principal.user ?? "")) {
			throw new ActionRateLimitedError();
		}
		const composite = `${slug}${id}${key}`;
		if (actionId !== undefined) {
			const hit = this.dedup.check(actionId, composite);
			if (hit !== undefined && hit !== null) return hit.result;
		}
		const result = await this.invokeWithTimeout(() =>
			handler({ principal, params, key, signal }, payload as never),
		);
		const wrapped = this.wrapResult(slug, id, key, result);
		if (actionId !== undefined) {
			this.dedup.record(actionId, composite, wrapped);
		}
		return wrapped;
	}

	/**
	 * Deliver one upload (spec §7.1/§7.2): the bytes were capped at the
	 * route (field `maxBytes` clamped by `server.maxUploadBytes`); the
	 * MIME is sniffed from the bytes, never the client name. The
	 * handler's result is wrapped like an action's.
	 */
	async upload(
		slug: string,
		id: string,
		key: string,
		params: JsonObject,
		principal: Principal,
		field: string,
		name: string,
		bytes: Uint8Array,
		signal: AbortSignal,
	): Promise<ActionResponse> {
		const located = this.locate(slug, id);
		if (located === undefined) return { ok: false, error: { message: "unknown surface" } };
		const handler = located.def.actions?.[field];
		if (handler === undefined) throw new UnknownActionError(field);
		const file: UploadedFile = {
			field,
			name,
			mime: sniffMime(bytes),
			bytes,
		};
		let result: ActionResult;
		try {
			result = await handler(
				{ principal, params, key, signal },
				file as never,
			);
		} catch (cause) {
			throw new SurfaceFailedError(
				`surface ${slug}/${id} upload handler "${field}" threw: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
			);
		}
		return this.wrapResult(slug, id, key, result);
	}

	/**
	 * The §6.3 accept rules: WITH `update.ops` the ops log (sharedData)
	 * and the answer carries `{ok, rev, ops}`; WITHOUT ops nothing is
	 * recorded and the answer is `{ok, rev}` (extension surfaces own
	 * their data — the rev bump announces the change). A reject and the
	 * `navigate`/`toast` fields pass through unchanged.
	 */
	private wrapResult(
		slug: string,
		id: string,
		key: string,
		result: ActionResult,
	): ActionResponse {
		if (!result.ok) return result;
		if (result.update !== undefined) {
			const rev = this.bumpRev(slug, id, key, result.update);
			return {
				ok: true,
				rev,
				ops: result.update.ops,
				...(result.navigate === undefined ? {} : { navigate: result.navigate }),
				...(result.toast === undefined ? {} : { toast: result.toast }),
			};
		}
		const rev = this.bumpRev(slug, id, key);
		return {
			ok: true,
			rev,
			...(result.navigate === undefined ? {} : { navigate: result.navigate }),
			...(result.toast === undefined ? {} : { toast: result.toast }),
		};
	}

	/**
	 * Race the handler against the 10 s timeout (spec §6.3 step 4): on a
	 * timeout the handler is abandoned (its late settlement is dropped)
	 * and the action answers the `timed out` reject body.
	 */
	private async invokeWithTimeout(
		invoke: () => Promise<ActionResult>,
	): Promise<ActionResult> {
		let timer: NodeJS.Timeout | undefined;
		try {
			const outcome = await Promise.race([
				invoke().then(
					(result): { kind: "done"; result: ActionResult } => ({
						kind: "done",
						result,
					}),
					(cause: unknown): { kind: "threw"; cause: unknown } => ({
						kind: "threw",
						cause,
					}),
				),
				new Promise<{ kind: "timedout" }>((resolvePromise) => {
					timer = setTimeout(
						() => resolvePromise({ kind: "timedout" }),
						ACTION_TIMEOUT_MS,
					);
				}),
			]);
			if (outcome.kind === "timedout") return TIMED_OUT_RESULT;
			if (outcome.kind === "threw") {
				throw outcome.cause instanceof Error
					? outcome.cause
					: new Error(String(outcome.cause));
			}
			return outcome.result;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	/**
	 * Record a change for one instance (spec §7.3): advances `rev`;
	 * `ops` are kept only for `sharedData` surfaces (the window above).
	 * Returns the new `rev`.
	 */
	bumpRev(
		slug: string,
		id: string,
		key: string,
		ops?: { ops: unknown[] },
	): number {
		const state = this.stateFor(slug, id, key);
		state.rev += 1;
		const located = this.locate(slug, id);
		if (located?.def.sharedData === true && ops !== undefined) {
			state.ops.push({ rev: state.rev, ops: ops.ops });
			while (state.ops.length > SHARED_OPS_WINDOW) state.ops.shift();
		}
		// The surface.changed nudge (Task 4, spec §7.3): the hashed
		// instance key, the new rev, NO params and NO data; the events
		// route's visibility case delivers it to watching streams only.
		// The watching-stream list resolves HERE — the registry keys on
		// the plain `key`; the wire's hashed `k` can never be reversed.
		this.publishChanged?.({
			type: "surface.changed",
			slug,
			id,
			k: eventKey(slug, id, key),
			rev: state.rev,
			treeRev: state.treeRev,
			streams: this.watchers.streamsFor(slug, id, key),
		});
		return state.rev;
	}

	/** Call the surface's `render`, mapping throws to SurfaceFailedError. */
	private async callRender(
		located: Located,
		key: string,
		params: JsonObject,
		principal: Principal,
	): Promise<{ tree: Tree; data: JsonObject; access: SurfaceAccessLevel }> {
		try {
			return await located.def.render({
				principal,
				params,
				key,
				signal: new AbortController().signal,
			});
		} catch (cause) {
			throw new SurfaceFailedError(
				`surface ${located.slug}/${located.def.id} render() threw: ${
					cause instanceof Error ? cause.message : String(cause)
				}`,
			);
		}
	}
}
