/**
 * The chat-block transport (UI-blocks U5 Task 4, spec §8.2): implements
 * the shared `SurfaceTransport` contract over the chat-block routes —
 * `GET /v1/conversations/:id/blocks/:entryId`, `…/data?since=`, and
 * `POST …/actions` — the same machinery U3's extension transport uses,
 * addressed by (conversationId, entryId) instead of (slug, id, params).
 *
 * Differences from `extTransport.ts`:
 * - no `params`/`k` (the address is the entry itself);
 * - no `X-Sigrun-Stream` watcher registration — chat change events are
 *   conversation-scoped (the events route delivers to every stream whose
 *   principal can see the conversation, spec §8.2), so the transport
 *   never registers a watcher;
 * - the chat routes never carry an `uploads` route and `image()` is
 *   unimplemented (chat blocks hold no secret fields or uploads).
 *
 * `onChanged` is the hub-routed listener set the app's `ChatSurfaceHub`
 * subscribes into (the events source dispatches the conversation-scoped
 * `surface.changed` frames into it); the base transport's own set is the
 * no-hub fallback for direct consumers.
 */

import type {
	JsonValue,
	SurfaceActResult,
	SurfaceChangedEvent,
	SurfaceFetch,
	SurfaceLoad,
	SurfaceTransport,
} from "@sigrun/shared/blocks";

/** The fetch surface the transport consumes (the real thing or a stub). */
export type ChatFetchLike = (
	input: string,
	init?: {
		readonly method?: string;
		readonly headers?: Record<string, string>;
		readonly body?: string;
	},
) => Promise<{
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}>;

export interface ChatTransportOptions {
	readonly conversationId: number;
	readonly entryId: string;
	/** Same-origin by default; injected for tests. */
	readonly fetch?: ChatFetchLike;
}

/** The base path of one chat block (`/data` and `/actions` hang off it). */
function blockPath(options: ChatTransportOptions): string {
	return `/v1/conversations/${options.conversationId}/blocks/${encodeURIComponent(options.entryId)}`;
}

/**
 * Create the chat-block transport for one conversation entry. The routes
 * answer `SurfaceLoad`/`SurfaceFetch`/`SurfaceActResult` in the same
 * wire shapes the extension routes use (spec §8.2 mirrors §7.2), so the
 * channel's `useSurface` runs unchanged over it.
 */
export function createChatTransport(
	options: ChatTransportOptions,
): SurfaceTransport {
	const doFetch: ChatFetchLike =
		options.fetch ??
		(((input, init) =>
			globalThis.fetch(
				input,
				init as Parameters<typeof globalThis.fetch>[1],
			)) as ChatFetchLike);
	const listeners = new Set<(event: SurfaceChangedEvent) => void>();
	const headers = (): Record<string, string> => ({ accept: "application/json" });

	const get = async <T>(path: string): Promise<T> => {
		const response = await doFetch(path, { method: "GET", headers: headers() });
		if (!response.ok) {
			throw new Error(`chat block GET ${path} failed with status ${response.status}`);
		}
		return (await response.json()) as T;
	};

	return {
		load(): Promise<SurfaceLoad> {
			return get<SurfaceLoad>(blockPath(options));
		},
		fetchData(since?: number): Promise<SurfaceFetch> {
			const base = `${blockPath(options)}/data`;
			return get<SurfaceFetch>(
				since === undefined ? base : `${base}?since=${String(since)}`,
			);
		},
		async act(body: {
			action: string;
			payload: JsonValue;
			actionId: string;
		}): Promise<SurfaceActResult> {
			const response = await doFetch(`${blockPath(options)}/actions`, {
				method: "POST",
				headers: { ...headers(), "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			return (await response.json()) as SurfaceActResult;
		},
		upload(): Promise<SurfaceActResult> {
			// Chat trees forbid upload fields (spec §8.2's chat subset); the
			// contract still requires the method — reject loudly, never a
			// silent no-op.
			return Promise.reject(new Error("chat blocks carry no upload fields"));
		},
		image(): Promise<Uint8Array> {
			// U7 owns the image route; chat blocks render alt/placeholder
			// until it ships (the ext transport's deferred shape).
			return Promise.reject(new Error("chat block image route ships with U7"));
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
 * The chat-block change-event router (U5 Task 4, spec §8.2): the events
 * source hands every conversation-scoped `surface.changed` frame to
 * `dispatch`, which fans it out to the subscriptions whose
 * (conversationId, entryId) match. The frame carries no data — the
 * channel fetches `…/data?since=<rev>` as its own principal.
 */
export class ChatSurfaceHub {
	readonly #subscriptions = new Set<{
		readonly conversationId: number;
		readonly entryId: string;
		readonly listener: (event: SurfaceChangedEvent) => void;
	}>();

	/** Create a transport whose `onChanged` subscribes into this hub. */
	attach(options: ChatTransportOptions): SurfaceTransport {
		const base = createChatTransport(options);
		const hub = this;
		return {
			load: () => base.load(),
			fetchData: (since) => base.fetchData(since),
			act: (body) => base.act(body),
			upload: (body) => base.upload(body),
			image: (src, opts) => base.image(src, opts),
			onChanged(listener) {
				const subscription = {
					conversationId: options.conversationId,
					entryId: options.entryId,
					listener,
				};
				hub.#subscriptions.add(subscription);
				return () => {
					hub.#subscriptions.delete(subscription);
				};
			},
		};
	}

	/** Fire every subscription matching the event's (conversationId, entryId). */
	dispatch(event: {
		readonly conversationId: number;
		readonly entryId: string;
		readonly rev: number;
		readonly treeRev?: number;
	}): void {
		for (const subscription of this.#subscriptions) {
			if (
				subscription.conversationId === event.conversationId &&
				subscription.entryId === event.entryId
			) {
				subscription.listener({ rev: event.rev, treeRev: event.treeRev ?? 0 });
			}
		}
	}
}
