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
 *   sees is listable state; a `job.changed` event (W4 Task 5) calls the
 *   optional `onJobChanged` callback on the SAME source — the jobs
 *   panel never opens its own EventSource;
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
import type { JsonObject } from "@sigrun/shared/blocks";
import { canonicalJson } from "@sigrun/shared/blocks";
import type { ConversationSummary, SigrunClient } from "../api";
import type { EventSourceLike } from "../stream";

export interface UseConversationListResult {
	/** The latest list load (raw summaries — archived rows included). */
	readonly rows: readonly ConversationSummary[];
	/** Re-run the list GET now (resolves once the load settled). */
	reload(): Promise<void>;
	/** The latest load failure's description, or null. */
	readonly error: string | null;
	/**
	 * UI-blocks U3 Task 4 (spec §7.3, the W3 amendment): the current
	 * `/v1/events` stream id from the hello frame — `undefined` before
	 * the first hello. Surface/data fetches send it as
	 * `X-Sigrun-Stream` (the watcher registry's entry).
	 */
	readonly streamId: string | undefined;
	/**
	 * Fetch one extension surface as the current stream (sends
	 * `X-Sigrun-Stream` once the hello landed). Task 5's transport rides
	 * this seam; the registry entry lives for the fetch's instance.
	 */
	fetchSurface(slug: string, id: string, params?: JsonObject): Promise<unknown>;
	/**
	 * Mark one surface INSTANCE as visible (Task 5's rail/panel calls
	 * this): the reconnect rule (a NEW hello re-fetches every visible
	 * instance, re-registering the new stream's watcher entries)
	 * consults this set. `params` distinguish two open instances of the
	 * same surface — each re-registers with its OWN params (its own
	 * watcher entry, keyed on the server side by the instance key).
	 */
	noteSurfaceVisible(slug: string, id: string, params?: JsonObject): void;
}

const BUSY_SETTLE_MS = 5_000;

/** The EventSource factory the hook consumes (the test seam). */
export type ListEventSourceFactory = (url: string) => EventSourceLike;

/**
 * Open the ONE shared `/v1/events` source for the app (W3 Task 4):
 * conversation.* events call `onConversationEvent`; `job.changed` calls
 * `onJobChanged` (W4 Task 5 — the jobs panel rides the SAME source);
 * `hello` frames (U3 Task 4, the W3 amendment) call `onHello` with the
 * connection's streamId. Event types are an open set: unknown types are
 * IGNORED (never an error — spec §7.3). Returns the close. The
 * browser's native EventSource auto-reconnects; a malformed frame is
 * dropped (the stream only nudges — a dropped nudge is healed by the
 * next event or a busy-settle reload).
 */
function subscribeHostEvents(
	onConversationEvent: () => void,
	onJobChanged: () => void,
	onHello: (streamId: string) => void,
	onSurfaceChanged?: (event: {
		slug: string;
		id: string;
		k: string;
		rev: number;
		treeRev: number;
	}) => void,
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
	source.addEventListener("job.changed", onJobChanged);
	// surface.changed (U3 Task 5): fan into the app's ext hub. Loose-parse
	// (the frame is server-produced; a malformed one is a dropped nudge).
	source.addEventListener("surface.changed", (event: { data: string }) => {
		if (onSurfaceChanged === undefined) return;
		try {
			const parsed: unknown = JSON.parse(event.data);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				typeof (parsed as { slug?: unknown }).slug === "string" &&
				typeof (parsed as { id?: unknown }).id === "string" &&
				typeof (parsed as { k?: unknown }).k === "string" &&
				typeof (parsed as { rev?: unknown }).rev === "number" &&
				typeof (parsed as { treeRev?: unknown }).treeRev === "number"
			) {
				onSurfaceChanged(
					parsed as {
						slug: string;
						id: string;
						k: string;
						rev: number;
						treeRev: number;
					},
				);
			}
		} catch {
			// a malformed frame is a dropped nudge
		}
	});
	// The hello frame (U3 Task 4): each (re)connect carries a NEW
	// streamId; the handler owns the visible-surface re-fetch.
	source.addEventListener("hello", (event: { data: string }) => {
		try {
			const parsed: unknown = JSON.parse(event.data);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				typeof (parsed as { streamId?: unknown }).streamId === "string"
			) {
				onHello((parsed as { streamId: string }).streamId);
			}
		} catch {
			// A malformed hello is a dropped nudge — the next reconnect
			// (EventSource auto-reconnect) sends a fresh one.
		}
	});
	// Unknown event types never register a listener at all — the open-set
	// rule (spec §7.3) is satisfied by construction.
	return () => source.close();
}

export function useConversationList(
	client: SigrunClient,
	options: {
		busy: boolean;
		/** Test seam: inject a stub EventSource factory. */
		createEventSource?: ListEventSourceFactory;
		/** `job.changed` nudge (W4 Task 5): the jobs panel's refetch token,
		 *  delivered on the SAME shared source — never a second EventSource. */
		onJobChanged?: () => void;
	/**
	 * `surface.changed` dispatch (U3 Task 5): the shared events source
	 * routes a surface event into the app-level ext hub (the transports'
	 * subscription registry). App passes the hub's dispatch bound.
	 */
	onSurfaceChanged?: (event: {
		slug: string;
		id: string;
		k: string;
		rev: number;
		treeRev: number;
	}) => void;
	/** Test seam: the surface fetch's transport (defaults to the ambient fetch). */
	fetchImpl?: typeof fetch;
	},
): UseConversationListResult {
	const busy = options.busy;
	const [rows, setRows] = useState<readonly ConversationSummary[]>([]);
	const [error, setError] = useState<string | null>(null);
	// U3 Task 4: the current /v1/events stream id (the hello frame's
	// payload) and the visible-surface set the reconnect rule re-fetches.
	const [streamId, setStreamId] = useState<string | undefined>(undefined);
	const streamRef = useRef<string | undefined>(undefined);
	const visibleSurfaces = useRef<Set<string>>(new Set());

	const reload = useCallback(async (): Promise<void> => {
		try {
			const list = await client.listConversations();
			setRows(list.conversations);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, [client]);

	// The surface fetch seam (U3 Task 4): the registry entry the server
	// records lives for this stream; fetches before the first hello carry
	// no header (the stream simply is not a watcher yet).
	const fetchSurface = useCallback(
		async (slug: string, id: string, params?: JsonObject): Promise<unknown> => {
			const current = streamRef.current;
			const transport = options.fetchImpl ?? fetch;
			// The instance key distinguishes two open instances of one
			// surface — the watcher entry (and the data route's params) is
			// per-instance, so the re-register fetch carries them.
			const path =
				params === undefined || Object.keys(params).length === 0
					? `/v1/ext/${slug}/surfaces/${id}`
					: `/v1/ext/${slug}/surfaces/${id}?params=${encodeURIComponent(JSON.stringify(params))}`;
			const response = await transport(
				path,
				{
					headers:
						current === undefined
							? { accept: "application/json" }
							: {
									accept: "application/json",
									"x-sigrun-stream": current,
								},
				},
			);
			return response.json();
		},
		[options.fetchImpl],
	);

	const noteSurfaceVisible = useCallback(
		(slug: string, id: string, params?: JsonObject): void => {
			// Instance-keyed (slug + id + the CANONICAL params): two open
			// instances of one surface each re-register on a re-hello.
			const key = params === undefined ? "{}" : canonicalJson(params);
			visibleSurfaces.current.add(`${slug}\u0001${id}\u0001${key}`);
		},
		[],
	);

	// The hello handler (U3 Task 4): store the streamId; a NEW id (a
	// reconnect) re-fetches every visible surface, re-registering the
	// new stream's watcher entries (spec §7.3's re-registration rule).
	const onHello = useCallback(
		(next: string): void => {
			const previous = streamRef.current;
			streamRef.current = next;
			setStreamId(next);
			if (previous !== undefined && previous !== next) {
				for (const composite of visibleSurfaces.current) {
					const [slug, id, key] = composite.split("\u0001");
					let params: JsonObject | undefined;
					if (key !== undefined && key !== "{}") {
						try {
							const parsed: unknown = JSON.parse(key);
							if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
								params = parsed as JsonObject;
							}
						} catch {
							// malformed key → the default instance
						}
					}
					void fetchSurface(slug ?? "", id ?? "", params);
				}
			}
		},
		[fetchSurface],
	);

	useEffect(() => {
		void reload();
	}, [reload]);

	// The host-events subscription (W3 Task 4): ONE EventSource per app —
	// the hook is mounted once (App), so the hook's effect IS the shared
	// subscription. A conversation.* event refetches the list; bursts
	// coalesce by fetch latency (reloads overlap harmlessly — last write
	// wins, and the server's list is cheap). `job.changed` (W4 Task 5)
	// rides the same source into the jobs panel's nudge callback.
	useEffect(() => {
		return subscribeHostEvents(
			() => {
				void reload();
			},
			options.onJobChanged ?? (() => {}),
			onHello,
			options.onSurfaceChanged,
			options.createEventSource,
		);
	}, [reload, onHello, options.createEventSource, options.onJobChanged, options.onSurfaceChanged]);

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

	return { rows, reload, error, streamId, fetchSurface, noteSurfaceVisible };
}
