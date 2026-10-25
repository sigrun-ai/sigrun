/**
 * The TUI's chat-block transport (UI-blocks U5 Task 4, spec §8.2): the
 * shared `SurfaceTransport` contract over the chat-block routes
 * (`/v1/conversations/:id/blocks/:entryId`, `…/data?since=`, `POST
 * …/actions`) — the port of the webui's `chatTransport.ts`, addressed
 * by (conversationId, entryId) instead of (slug, id, params).
 *
 * Unlike the TUI's ext transport there is no `X-Sigrun-Stream` watcher
 * registration: chat change events are conversation-scoped (the events
 * route delivers them to every stream whose principal sees the
 * conversation), so `setStreamId` does not exist here. The launcher's
 * events loop hands the conversation-scoped frames to
 * {@link ChatSurfaceHub.dispatch}.
 */

import type {
	JsonValue,
	SurfaceActResult,
	SurfaceChangedEvent,
	SurfaceFetch,
	SurfaceLoad,
	SurfaceTransport,
} from "@sigrun/shared/blocks";
import { SigrunApiError } from "../api.js";

export interface ChatTransportOptions {
	readonly conversationId: number;
	readonly entryId: string;
	/** The server's origin (the launcher owns it). */
	readonly baseUrl: string;
	readonly user?: string;
	readonly token?: string;
	readonly fetch?: typeof globalThis.fetch;
}

/** The base path of one chat block (`/data` and `/actions` hang off it). */
function blockPath(options: ChatTransportOptions): string {
	return `/v1/conversations/${options.conversationId}/blocks/${encodeURIComponent(options.entryId)}`;
}

/** Create the TUI's chat-block transport. */
export function createChatTransport(
	options: ChatTransportOptions,
): SurfaceTransport {
	const doFetch =
		options.fetch ??
		(((input, init) =>
			globalThis.fetch(
				input,
				init as Parameters<typeof globalThis.fetch>[1],
			)) as typeof globalThis.fetch);
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const listeners = new Set<(event: SurfaceChangedEvent) => void>();
	const headers = (): Record<string, string> => ({
		accept: "application/json",
		...(options.user === undefined || options.user.trim() === ""
			? {}
			: { "x-sigrun-user": options.user.trim() }),
		...(options.token === undefined || options.token.trim() === ""
			? {}
			: { authorization: `Bearer ${options.token.trim()}` }),
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
			const response = await doFetch(`${baseUrl}${blockPath(options)}/actions`, {
				method: "POST",
				headers: { ...headers(), "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			return (await response.json()) as SurfaceActResult;
		},
		upload(): Promise<SurfaceActResult> {
			// Chat trees forbid upload fields (spec §8.2); reject loudly.
			return Promise.reject(new Error("chat blocks carry no upload fields"));
		},
		image(): Promise<Uint8Array> {
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
 * The TUI's chat-block change router: `attach` creates a transport whose
 * `onChanged` subscribes into this hub under (conversationId, entryId);
 * `dispatch` fans a conversation-scoped `surface.changed` frame out to
 * the matching subscriptions only.
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
