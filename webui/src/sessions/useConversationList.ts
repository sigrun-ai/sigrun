/**
 * useConversationList (B3, UI refresh; events stream in core hardening W3
 * Task 4): App's lifted conversation list.
 *
 * The sidebar, the ChatHeader's title, and (later) the transcript's
 * parent links all read these SAME rows — one request, no per-row meta
 * GETs (the A1 contract). The hook owns freshness:
 * - load on mount;
 * - ONE shared EventSource over `GET /v1/events` (per app — see
 *   `eventsSource` below): `conversation.*` events trigger a refetch
 *   (coalesced — one reload in flight); the server-side stream is
 *   already access-filtered per principal, so every event the client
 *   sees is listable state;
 * - on a busy → idle transition reload IMMEDIATELY, then again after
 *   5 s, so a name the server auto-generated at run settlement appears
 *   without a manual reload (belt for the run.settled event's list
 *   refetch — the auto-name lands in a FOLLOWING commit).
 *
 * `reload` is exposed (App calls it after its own writes — create, fork,
 * meta PATCHes — so the sidebar reflects them at once instead of waiting
 * for the next event). Errors never throw to the caller: `error` carries
 * the description and `rows` keeps the last good load.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationSummary, SigrunClient } from "../api";
import type { EventSourceLike } from "../stream";

export interface UseConversationListResult {
	/** The latest list load (raw summaries — archived rows included). */
	readonly rows: readonly ConversationSummary[];
	/** Re-run the list GET now (resolves once the load settled). */
	reload(): Promise<void>;
	/** The latest load failure's description, or null. */
	readonly error: string | null;
}

const BUSY_SETTLE_MS = 5_000;

/** The EventSource factory the hook consumes (the test seam). */
export type ListEventSourceFactory = (url: string) => EventSourceLike;

/**
 * Open the ONE shared `/v1/events` source for the app (W3 Task 4):
 * conversation.* events call `onConversationEvent`. Returns the close.
 * The browser's native EventSource auto-reconnects; a malformed frame is
 * dropped (the stream only nudges — a dropped nudge is healed by the
 * next event or a busy-settle reload).
 */
function subscribeHostEvents(
	onConversationEvent: () => void,
	createEventSource?: ListEventSourceFactory,
): () => void {
	// The native EventSource exists only in the browser; the hook's unit
	// tests (and any non-DOM host) inject the factory seam. Absent BOTH,
	// the subscription is a no-op — the mount load + busy-settle reloads
	// still keep the list fresh enough to boot.
	if (
		createEventSource === undefined &&
		typeof (globalThis as { EventSource?: unknown }).EventSource ===
			"undefined"
	) {
		return () => {};
	}
	const source: EventSourceLike =
		createEventSource !== undefined
			? createEventSource("/v1/events")
			// SAFETY: the native EventSource satisfies the structural
			// EventSourceLike surface (close + addEventListener with a
			// data-carrying message event) — the same cast stream.ts's
			// defaultFactory makes.
			: (new EventSource("/v1/events") as unknown as EventSourceLike);
	const onAny = (): void => onConversationEvent();
	source.addEventListener("conversation.created", onAny);
	source.addEventListener("conversation.changed", onAny);
	return () => source.close();
}

export function useConversationList(
	client: SigrunClient,
	options: {
		busy: boolean;
		/** Test seam: inject a stub EventSource factory. */
		createEventSource?: ListEventSourceFactory;
	},
): UseConversationListResult {
	const busy = options.busy;
	const [rows, setRows] = useState<readonly ConversationSummary[]>([]);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async (): Promise<void> => {
		try {
			const list = await client.listConversations();
			setRows(list.conversations);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, [client]);

	useEffect(() => {
		void reload();
	}, [reload]);

	// The host-events subscription (W3 Task 4): ONE EventSource per app —
	// the hook is mounted once (App), so the hook's effect IS the shared
	// subscription. A conversation.* event refetches the list; bursts
	// coalesce by fetch latency (reloads overlap harmlessly — last write
	// wins, and the server's list is cheap).
	useEffect(() => {
		return subscribeHostEvents(() => {
			void reload();
		}, options.createEventSource);
	}, [reload, options.createEventSource]);

	// The busy → idle transition: an immediate reload plus a settle reload
	// 5 s later (auto names land at run settlement, shortly after idle).
	const previousBusy = useRef(busy);
	useEffect(() => {
		const wasBusy = previousBusy.current;
		previousBusy.current = busy;
		if (!wasBusy || busy) return;
		void reload();
		const settle = setTimeout(() => void reload(), BUSY_SETTLE_MS);
		return () => clearTimeout(settle);
	}, [busy, reload]);

	return { rows, reload, error };
}
