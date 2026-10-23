/**
 * The TUI's extension-surface transport (UI-blocks U3 Task 5): implements
 * the shared `SurfaceTransport` contract over the U3 routes (spec §7.2)
 * as the TUI's remote client. One transport = one surface instance
 * (slug + id + params); the wire `k` (hashed instance key) keys the
 * change-event routing in {@link ExtSurfaceHub}.
 *
 * Like the webui twin, every fetch carries `X-Sigrun-Stream` once the
 * launcher hands the stream id in (the watcher entry's stream);
 * `image()` rejects until U7 ships the route. The channel owns
 * refreshMs cadence, the keepalive, and visibility gating (U2).
 */

import { createHash } from "node:crypto";
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
import { instanceKey } from "@sigrun/shared/blocks";
import { SigrunApiError } from "../api.js";

export interface ExtSurfaceTransportOptions {
	/** The extension slug (the `/v1/ext/<slug>/` prefix segment). */
	readonly slug: string;
	/** The surface id within the extension. */
	readonly id: string;
	/** The instance params; absent → `{}` (the route's default). */
	readonly params?: JsonObject;
	/** The current `/v1/events` stream id (the watcher entry's stream). */
	readonly streamId?: string;
	/** The server's origin (the launcher that constructs the client owns it). */
	readonly baseUrl: string;
	readonly user?: string;
	readonly token?: string;
	readonly fetch?: typeof globalThis.fetch;
}

/**
 * The TUI's transport handle (U3 Task 5 fix round): the `SurfaceTransport`
 * plus `setStreamId` — a `/v1/events` reconnect hands the OPEN view the
 * new stream id without re-creating the transport (the next fetch
 * carries it, re-registering the watcher entry, spec §7.3).
 */
export interface ExtSurfaceTransportHandle {
	readonly transport: SurfaceTransport;
	/** Update the watcher stream id (a reconnect's hello); subsequent
	 *  fetches carry the new id. */
	setStreamId(streamId: string | undefined): void;
}

/**
 * The wire `k` for one surface instance (spec §7.3), Node flavor:
 * `sha256(slug + "\0" + id + "\0" + key)` hex. The TUI's transport
 * computes it synchronously (the WebCrypto twin in `@sigrun/shared/
 * blocks` is async — DOM-only).
 */
export function surfaceKeyHash(slug: string, id: string, key: string): string {
	return createHash("sha256")
		.update([slug, id, key].join("\u0000"))
		.digest("hex");
}

/** The instance key for one transport's params (the default rule). */
export function transportKey(options: ExtSurfaceTransportOptions): string {
	return instanceKey(options.params ?? {});
}

/** The base path for one surface instance (`?params=` omitted when `{}`). */
function surfacePath(options: ExtSurfaceTransportOptions): string {
	const base = `/v1/ext/${encodeURIComponent(options.slug)}/surfaces/${encodeURIComponent(options.id)}`;
	if (options.params === undefined || Object.keys(options.params).length === 0) {
		return base;
	}
	return `${base}?params=${encodeURIComponent(JSON.stringify(options.params))}`;
}

function withQuery(path: string, key: string, value: string): string {
	return `${path}${path.includes("?") ? "&" : "?"}${key}=${value}`;
}

/** Create the TUI's extension-surface transport. */
export function createExtSurfaceTransport(
	options: ExtSurfaceTransportOptions,
): ExtSurfaceTransportHandle {
	const doFetch =
		options.fetch ??
		(((input, init) =>
			globalThis.fetch(
				input,
				init as Parameters<typeof globalThis.fetch>[1],
			)) as typeof globalThis.fetch);
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const listeners = new Set<(event: SurfaceChangedEvent) => void>();
	// Mutable: a reconnect's new stream id lands via setStreamId — every
	// fetch resolves the header at CALL time.
	let streamId = options.streamId;
	const headers = (): Record<string, string> => ({
		accept: "application/json",
		...(options.user === undefined || options.user.trim() === ""
			? {}
			: { "x-sigrun-user": options.user.trim() }),
		...(options.token === undefined || options.token.trim() === ""
			? {}
			: { authorization: `Bearer ${options.token.trim()}` }),
		...(streamId === undefined
			? {}
			: { "x-sigrun-stream": streamId }),
	});

	const get = async <T>(path: string): Promise<T> => {
		const response = await doFetch(`${baseUrl}${path}`, {
			method: "GET",
			headers: headers(),
		});
		if (!response.ok) {
			throw new SigrunApiError(
				"GET",
				path,
				response.status,
				await response.json().catch(() => undefined),
			);
		}
		return (await response.json()) as T;
	};

	const transport: SurfaceTransport = {
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
			const response = await doFetch(
				`${baseUrl}${surfacePath(options)}/actions`,
				{
					method: "POST",
					headers: { ...headers(), "content-type": "application/json" },
					body: JSON.stringify({ ...body, params: options.params ?? {} }),
				},
			);
			return (await response.json()) as SurfaceActResult;
		},
		async upload(body: SurfaceUploadBody): Promise<SurfaceActResult> {
			const base = surfacePath(options);
			const path = withQuery(
				`${baseUrl}${base}/uploads/${encodeURIComponent(body.field)}/${encodeURIComponent(body.name)}`,
				"params",
				encodeURIComponent(JSON.stringify(options.params ?? {})),
			);
			const response = await doFetch(path, {
				method: "PUT",
				headers: { ...headers(), "content-type": "application/octet-stream" },
				// SAFETY: Node's fetch types Uint8Array<ArrayBuffer> narrower
				// than the Uint8Array<ArrayBufferLike> the wire body carries;
				// the runtime accepts any ArrayBuffer view.
				body: body.bytes as unknown as BodyInit,
			});
			return (await response.json()) as SurfaceActResult;
		},
		image(): Promise<Uint8Array> {
			return Promise.reject(new Error("ext surface image route ships with U7"));
		},
		onChanged(listener: (event: SurfaceChangedEvent) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return {
		transport,
		setStreamId(next: string | undefined): void {
			streamId = next;
		},
	};
}

/**
 * The change-event router (the launcher's dispatch seam): `attach`
 * creates a transport whose `onChanged` subscribes into the hub under
 * the instance's (slug, id, k); `dispatch` fans a `surface.changed`
 * event out to the matching subscriptions only.
 */
export class ExtSurfaceHub {
	readonly #subscriptions = new Set<{
		readonly slug: string;
		readonly id: string;
		readonly keyHash: string;
		readonly listener: (event: SurfaceChangedEvent) => void;
	}>();

	/** Create a transport whose `onChanged` subscribes into this hub. */
	attach(options: ExtSurfaceTransportOptions, keyHash: string): ExtSurfaceTransportHandle {
		const base = createExtSurfaceTransport(options);
		const hub = this;
		const transport: SurfaceTransport = {
			load: () => base.transport.load(),
			fetchData: (since) => base.transport.fetchData(since),
			act: (body) => base.transport.act(body),
			upload: (body) => base.transport.upload(body),
			image: (src, opts) => base.transport.image(src, opts),
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
		return {
			transport,
			setStreamId: (next) => base.setStreamId(next),
		};
	}

	/** Fire every subscription matching the event's (slug, id, k). */
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
