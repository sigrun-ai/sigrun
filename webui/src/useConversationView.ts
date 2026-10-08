/**
 * `useConversationView` (Task 21): the typed transport hook every conversation
 * view rides on — one EventSource over `GET /v1/conversations/:id/stream`,
 * the spike's proven shape ported to a hook.
 *
 * The view IS the latest frame: `snapshot` and `view` frames both FULL-REPLACE
 * the held `ConversationViewWire` (never accumulate, never delta-merge), and
 * `frames` counts accepted frames. The hook holds no agent state — it is a
 * thin client over the §5 stream.
 *
 * Status machine:
 * - `idle` — no conversation selected (`conversationId === null`), no stream;
 * - `connecting` — stream open, waiting for the first frame;
 * - `snapshot` — the last accepted frame was a snapshot (connect / re-attach);
 * - `live` — the last accepted frame was a view revision;
 * - `error` — the last failure (malformed frame or transport drop). Fail loud:
 *   `error` carries the description; a later good frame recovers and clears it.
 *
 * Cleanup: the stream closes on unmount and on `conversationId` change; an id
 * change also resets view/frames/error so a stale view is never shown under a
 * new conversation.
 */

import { useEffect, useState } from "react";
import type { ConversationViewWire } from "./api";
import {
	openConversationStream,
	type EventSourceFactory,
} from "./stream";

export type ConversationViewStatus =
	| "idle"
	| "connecting"
	| "snapshot"
	| "live"
	| "error";

export interface ConversationViewState {
	/** The latest accepted frame, or null before the first one. */
	readonly view: ConversationViewWire | null;
	readonly status: ConversationViewStatus;
	/** Count of accepted frames (snapshot + view) since the stream opened. */
	readonly frames: number;
	/** The failure description while status is `"error"`; null otherwise. */
	readonly error: string | null;
}

export interface UseConversationViewOptions {
	/**
	 * URL prefix for the API, default "" (same-origin — the bundle is served
	 * by the sigrun server itself).
	 */
	readonly baseUrl?: string;
	/** Injected for tests; defaults to the browser's native `EventSource`. */
	readonly createEventSource?: EventSourceFactory;
}

const IDLE: ConversationViewState = {
	view: null,
	status: "idle",
	frames: 0,
	error: null,
};

export function useConversationView(
	conversationId: number | null,
	options: UseConversationViewOptions = {},
): ConversationViewState {
	const { baseUrl, createEventSource } = options;
	const [state, setState] = useState<ConversationViewState>(IDLE);

	useEffect(() => {
		if (conversationId === null) {
			setState(IDLE);
			return;
		}
		setState({ view: null, status: "connecting", frames: 0, error: null });
		const handle = openConversationStream(
			conversationId,
			{
				onSnapshot: (view) =>
					setState((previous) => ({
						view,
						status: "snapshot",
						frames: previous.frames + 1,
						error: null,
					})),
				onView: (view) =>
					setState((previous) => ({
						view,
						status: "live",
						frames: previous.frames + 1,
						error: null,
					})),
				onError: (message) =>
					setState((previous) => ({
						...previous,
						status: "error",
						error: message,
					})),
			},
			baseUrl,
			{ createEventSource },
		);
		return () => handle.close();
	}, [conversationId, baseUrl, createEventSource]);

	return state;
}
