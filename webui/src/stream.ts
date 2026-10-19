/**
 * The §5 conversation view stream (Task 21; delta frames in core hardening
 * W3 Task 3, spec §7.3 ruling 11): one EventSource over
 * `GET /v1/conversations/:id/stream` carrying `snapshot` and `delta` frames.
 *
 * This wrapper is the webui's delta folder: `snapshot` REPLACES the held
 * `ConversationViewWire` wholesale, `delta` folds into it via
 * `applyDelta` (the shared reducer), and every accepted frame surfaces to
 * the consumer as a FULL immutable revision — replace, never accumulate
 * (spec §5; App C's contract makes a reconnect a re-attach: the server
 * sends a fresh snapshot, no replay needed). The `view` event name is
 * retired server-side; only `snapshot`/`delta` are handled here.
 *
 * Frame discipline (ported from the proven spike,
 * `spikes/webui-transport/index.html`):
 * - frames are single-line JSON `data:` payloads on `snapshot` / `delta` events;
 * - heartbeat `: ping` comment lines are consumed by the EventSource parser
 *   itself and never reach this wrapper — tolerance is inherent;
 * - a malformed frame (JSON.parse failure, or JSON that is not a view/delta
 *   object) reports `onError` and the stream STAYS OPEN — one bad frame
 *   must never kill the transport; a delta that arrives before any snapshot
 *   is malformed (there is nothing to fold into).
 *
 * Transport failures (`error` event) close the current source and re-open
 * with exponential backoff (250ms doubling, capped at 4s, reset on a
 * successful `open`). Reconnects are owned by this wrapper — the source is
 * closed first so the browser's native auto-reconnect never double-connects.
 *
 * Tests inject the `EventSourceFactory` seam; production uses the browser's
 * native `EventSource`.
 */

import type { ConversationViewWire } from "./api";
import {
	applyDelta,
	type ViewDelta,
} from "@sigrun/shared/view-delta";

/** The minimal message-event surface the wrapper consumes. */
export interface StreamMessageEvent {
	readonly data: string;
}

/**
 * The minimal EventSource surface the wrapper needs — the browser's native
 * `EventSource` satisfies this structurally; tests inject a stub.
 */
export interface EventSourceLike {
	close(): void;
	addEventListener(
		type: string,
		listener: (event: StreamMessageEvent) => void,
	): void;
}

/** Builds an EventSource for a URL. The test seam — inject a stub factory. */
export type EventSourceFactory = (url: string) => EventSourceLike;

export interface ConversationStreamHandlers {
	/** A `snapshot` frame arrived (the full view on connect/re-attach). */
	readonly onSnapshot?: (view: ConversationViewWire) => void;
	/**
	 * A full revision arrived — either the connect snapshot or the fold of
	 * every `delta` since it. The view is ALWAYS a full immutable
	 * `ConversationViewWire`: replace, never accumulate.
	 */
	readonly onView?: (view: ConversationViewWire) => void;
	/**
	 * A failure: either a malformed frame (stream stays open) or a transport
	 * error (reconnect in progress). Carries a human-readable description —
	 * fail loud, never silent.
	 */
	readonly onError?: (message: string) => void;
	/** The underlying connection (re)opened. */
	readonly onOpen?: () => void;
}

export interface ConversationStreamHandle {
	/** Close the stream and cancel any pending reconnect. Idempotent. */
	close(): void;
}

export interface ConversationStreamOptions {
	/** Injected for tests; defaults to the browser's native `EventSource`. */
	readonly createEventSource?: EventSourceFactory;
}

/** Backoff ladder: 250ms doubling to a 4s cap, reset on a successful open. */
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 4_000;

const defaultFactory: EventSourceFactory = (url) =>
	new EventSource(url) as unknown as EventSourceLike;

/** Parse a frame; `undefined` when the payload is not a view object. */
function parseFrame(data: string): ConversationViewWire | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	return parsed as ConversationViewWire;
}

/** Parse a delta frame; `undefined` when the payload is not an object. */
function parseDeltaFrame(data: string): ViewDelta | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	return parsed as ViewDelta;
}

/**
 * Open the §5 conversation stream for `conversationId`. `baseUrl` defaults to
 * "" (same-origin — the bundle is served by the sigrun server itself).
 */
export function openConversationStream(
	conversationId: number,
	handlers: ConversationStreamHandlers,
	baseUrl = "",
	options: ConversationStreamOptions = {},
): ConversationStreamHandle {
	const factory = options.createEventSource ?? defaultFactory;
	const url = `${baseUrl}/v1/conversations/${conversationId}/stream`;

	let closed = false;
	let attempts = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let source: EventSourceLike | undefined;
	/**
	 * The held view: the last snapshot, folded with every accepted delta
	 * since. `undefined` before the first snapshot — a delta arriving then
	 * is malformed (there is nothing to fold into).
	 */
	let currentView: ConversationViewWire | undefined;

	function connect(): void {
		if (closed) return;
		const current = factory(url);
		source = current;
		// One transport failure per source: repeated `error` events on the same
		// (already closing) source must not schedule duplicate reconnects.
		let failed = false;

		current.addEventListener("open", () => {
			if (closed) return;
			attempts = 0;
			handlers.onOpen?.();
		});
		current.addEventListener("snapshot", (event) => {
			if (closed) return;
			const view = parseFrame(event.data);
			if (view === undefined) {
				handlers.onError?.("malformed snapshot frame (not a view object)");
				return;
			}
			// A snapshot REPLACES: the delta fold re-bases on it wholesale —
			// any frame missed while disconnected is subsumed.
			currentView = view;
			handlers.onSnapshot?.(view);
		});
		current.addEventListener("delta", (event) => {
			if (closed) return;
			if (currentView === undefined) {
				handlers.onError?.(
					"malformed delta frame (arrived before any snapshot)",
				);
				return;
			}
			const delta = parseDeltaFrame(event.data);
			if (delta === undefined) {
				handlers.onError?.("malformed delta frame (not a delta object)");
				return;
			}
			// Fold, then surface the FULL revision: the consumer's contract
			// stays "replace, never accumulate". The webui's narrowed wire type
			// (api.ts) shadows the shared one — the shapes are assignment-
			// compatible at runtime; the cross-module generic check is the
			// type system's, so the fold is cast at the seam.
			currentView = applyDelta(
				currentView as never,
				delta,
			) as ConversationViewWire;
			handlers.onView?.(currentView);
		});
		current.addEventListener("error", () => {
			if (closed || failed) return;
			failed = true;
			handlers.onError?.("conversation stream connection error");
			current.close();
			if (source === current) source = undefined;
			attempts += 1;
			const delay = Math.min(
				RECONNECT_BASE_MS * 2 ** (attempts - 1),
				RECONNECT_MAX_MS,
			);
			timer = setTimeout(() => {
				timer = undefined;
				connect();
			}, delay);
		});
	}

	connect();

	return {
		close() {
			if (closed) return;
			closed = true;
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			source?.close();
			source = undefined;
		},
	};
}
