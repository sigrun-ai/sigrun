/**
 * The extension-surface transport (UI-blocks U3 Task 5): implements the
 * shared `SurfaceTransport` contract over the U3 routes (spec §7.2), as
 * the webui's fetch. One transport instance = one surface INSTANCE
 * (slug + id + the params object it loads with); the wire `k` (the
 * hashed instance key) keys the change-event routing.
 *
 * Behavior the contract pins here (§7.3):
 * - every fetch carries `X-Sigrun-Stream` when a stream id is supplied,
 *   so the server's watcher registry records this surface as visible;
 * - `onChanged` listeners fire when {@link ExtSurfaceHub} routes a
 *   `surface.changed` event to this instance.
 *
 * The CHANNEL owns refreshMs cadence, the 5-minute watcher keepalive,
 * visibility gating, and optimistic overlays (U1); this module is the
 * wire layer. `image()` rejects until U7's image route ships — the
 * brief's explicit deferred shape.
 */

import type {
	JsonObject,
	JsonValue,
	SurfaceActResult,
	SurfaceChangedEvent,
	SurfaceFetch,
	SurfaceLoad,
	SurfaceTransport,
	SurfaceUploadBody,
} from "@sigrun/shared/blocks";

/** The fetch surface the transport consumes (the real thing or a stub). */
export type ExtFetchLike = (
	input: string,
	init?: {
		readonly method?: string;
		readonly headers?: Record<string, string>;
		readonly body?: string | Uint8Array;
	},
) => Promise<{
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}>;

export interface ExtTransportOptions {
	/** The extension slug (the `/v1/ext/<slug>/` prefix segment). */
	readonly slug: string;
	/** The surface id within the extension. */
	readonly id: string;
	/** The instance params; absent → `{}` (the route's default). */
	readonly params?: JsonObject;
	/** The current `/v1/events` stream id (the watcher entry's stream). */
	readonly streamId?: string;
	/** Same-origin by default; injected for tests. */
	readonly fetch?: ExtFetchLike;
}

/** The base path for one surface instance (`?params=` omitted when `{}`). */
function surfacePath(options: ExtTransportOptions): string {
	const base = `/v1/ext/${encodeURIComponent(options.slug)}/surfaces/${encodeURIComponent(options.id)}`;
	if (options.params === undefined || Object.keys(options.params).length === 0) {
		return base;
	}
	return `${base}?params=${encodeURIComponent(JSON.stringify(options.params))}`;
}

/** Append `&since=` (or `?since=` when the path has no query yet). */
function withQuery(path: string, key: string, value: string): string {
	return `${path}${path.includes("?") ? "&" : "?"}${key}=${value}`;
}

/** The handle `createExtTransport` returns: the transport plus the
 *  instance identity the hub needs for change-event routing. */
export interface ExtTransport {
	readonly transport: SurfaceTransport;
	/** The wire `k` (sha256 hex of slug\0id\0key) — the event's routing key. */
	readonly keyHash: string;
}

/**
 * Create the extension-surface transport. Same-origin `/v1` routes,
 * `X-Sigrun-Stream` on every fetch once the stream id is known.
 *
 * NOTE: the page subscribes `onChanged` via `ExtSurfaceHub.attach`
 * (the hub is the one subscription registry); the base transport's
 * listener set is the no-hub fallback, kept for direct consumers.
 */
export function createExtTransport(options: ExtTransportOptions): SurfaceTransport {
	const doFetch: ExtFetchLike =
		options.fetch ??
		(((input, init) =>
			globalThis.fetch(
				input,
				init as Parameters<typeof globalThis.fetch>[1],
			)) as ExtFetchLike);
	const listeners = new Set<(event: SurfaceChangedEvent) => void>();
	const headers = (): Record<string, string> => ({
		accept: "application/json",
		...(options.streamId === undefined
			? {}
			: { "x-sigrun-stream": options.streamId }),
	});

	const get = async <T>(path: string): Promise<T> => {
		const response = await doFetch(path, { method: "GET", headers: headers() });
		if (!response.ok) {
			throw new Error(`ext surface GET ${path} failed with status ${response.status}`);
		}
		return (await response.json()) as T;
	};

	return {
		load(): Promise<SurfaceLoad> {
			return get<SurfaceLoad>(surfacePath(options));
		},
		fetchData(since?: number): Promise<SurfaceFetch> {
			const path = `${surfacePath(options)}/data`;
			return get<SurfaceFetch>(
				since === undefined ? path : withQuery(path, "since", String(since)),
			);
		},
		async act(body: {
			action: string;
			payload: JsonValue;
			actionId: string;
		}): Promise<SurfaceActResult> {
			const response = await doFetch(`${surfacePath(options)}/actions`, {
				method: "POST",
				headers: { ...headers(), "content-type": "application/json" },
				body: JSON.stringify({ ...body, params: options.params ?? {} }),
			});
			return (await response.json()) as SurfaceActResult;
		},
		async upload(body: SurfaceUploadBody): Promise<SurfaceActResult> {
			const base = surfacePath(options);
			const path = withQuery(
				`${base}/uploads/${encodeURIComponent(body.field)}/${encodeURIComponent(body.name)}`,
				"params",
				encodeURIComponent(JSON.stringify(options.params ?? {})),
			);
			const response = await doFetch(path, {
				method: "PUT",
				headers: { ...headers(), "content-type": "application/octet-stream" },
				body: body.bytes,
			});
			return (await response.json()) as SurfaceActResult;
		},
		image(): Promise<Uint8Array> {
			// U7 owns the image route; until it ships, image blocks render
			// their alt/placeholder and the transport rejects loudly (never
			// a silent blank). The brief's deferred shape.
			return Promise.reject(new Error("ext surface image route ships with U7"));
		},
		onChanged(listener: (event: SurfaceChangedEvent) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/**
 * The change-event router (the app shell's dispatch seam): `attach`
 * creates a transport whose `onChanged` subscribes into the hub, and
 * `dispatch` fans a `surface.changed` event out to exactly the
 * subscriptions whose (slug, id, k) match. The hub is the single
 * subscription registry — params never appear in events (§7.3), so the
 * wire `k` is the only routing key.
 */
export class ExtSurfaceHub {
	readonly #subscriptions = new Set<{
		readonly slug: string;
		readonly id: string;
		readonly keyHash: string;
		readonly listener: (event: SurfaceChangedEvent) => void;
	}>();

	/**
	 * Create a transport for one surface instance whose `onChanged`
	 * subscribes into this hub. The wire `k` (sha256 hex of
	 * slug\0id\0key) is the event's routing key — the caller computes it
	 * once (the instance never changes key for a fixed params).
	 */
	attach(options: ExtTransportOptions, keyHash: string): SurfaceTransport {
		const base = createExtTransport(options);
		const hub = this;
		return {
			load: () => base.load(),
			fetchData: (since) => base.fetchData(since),
			act: (body) => base.act(body),
			upload: (body) => base.upload(body),
			image: (src, opts) => base.image(src, opts),
			onChanged(listener) {
				const subscription = {
					slug: options.slug,
					id: options.id,
					keyHash,
					listener,
				};
				hub.#subscriptions.add(subscription);
				return () => {
					hub.#subscriptions.delete(subscription);
				};
			},
		};
	}

	/**
	 * Fire every subscription matching the event's (slug, id, k). Events
	 * carry no data — the channel fetches `…/data?since=<rev>` as its own
	 * principal (§7.3).
	 */
	dispatch(event: {
		readonly slug: string;
		readonly id: string;
		readonly k: string;
		readonly rev: number;
		readonly treeRev: number;
	}): void {
		for (const subscription of this.#subscriptions) {
			if (
				subscription.slug === event.slug &&
				subscription.id === event.id &&
				subscription.keyHash === event.k
			) {
				subscription.listener({ rev: event.rev, treeRev: event.treeRev });
			}
		}
	}
}
