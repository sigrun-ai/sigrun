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
import { validateTree, type ValidationError } from "../../blocks/validate.js";
import type {
	Principal,
	SurfaceAccessLevel,
	SurfaceDef,
} from "../../extension.js";
import type { ExtensionSurfaceBinding } from "../../harness/loader.js";
import { AccessCache } from "./access-cache.js";
import { instanceKey as defaultInstanceKey } from "./instance.js";

/** The shared-data op-log window (spec §7.3): the last 100 updates. */
export const SHARED_OPS_WINDOW = 100;

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

	constructor(bindings: readonly ExtensionSurfaceBinding[]) {
		this.bindings = bindings;
		this.cache = new AccessCache();
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
			state = { rev: 0, treeRev: 0, ops: [] };
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
		const state = this.stateFor(slug, id, key);
		return {
			tree: validation.tree,
			data: result.data,
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
			return { rev: state.rev, treeRev: state.treeRev, ops };
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
		return { rev: state.rev, treeRev: state.treeRev, data };
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
