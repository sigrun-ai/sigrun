/**
 * The TUI's §5 conversation stream watcher (Task 4): a Node-side SSE
 * client over `GET /v1/conversations/:id/stream` carrying `snapshot` and
 * `view` frames.
 *
 * Frame contract (verified against src/server/index.ts): every frame is a
 * FULL immutable `ConversationViewWire` revision — the consumer replaces,
 * never accumulates. The server sends a fresh `snapshot` on EVERY connect,
 * so a reconnect's snapshot SUBSUMES any frame missed while disconnected —
 * no replay, no stale merge (Review Focus 1).
 *
 * Node 22 global fetch + manual frame parsing: `:` lines are comments,
 * `data:` lines accumulate until a blank line dispatches the frame;
 * multi-line `data:` joins with `\n`.
 *
 * Transport failures close the reader and reconnect with exponential
 * backoff (base 250ms doubling, capped at 4s, ±30% jitter). Reconnects
 * give up after 10 consecutive failures with ONE final `onError`; the
 * counter resets on every successful open and at watch start. One failed
 * connection emits at most one transport `onError` (a read failure and
 * the ensuing close are the same failure). A malformed frame reports
 * `onError` and the stream STAYS OPEN — one bad frame must never kill the
 * transport.
 */

import type { ConversationViewWire } from "./api.js";

export interface WatchHandlers {
	/** A `snapshot` frame arrived (the full view on connect/re-attach). */
	readonly onSnapshot?: (view: ConversationViewWire) => void;
	/** A `view` frame arrived (a full revision — replace, never accumulate). */
	readonly onView?: (view: ConversationViewWire) => void;
	/**
	 * A failure: a malformed frame (stream stays open) or a transport
	 * error (a reconnect follows unless `unwatch` ran). Carries a
	 * human-readable description — fail loud, never silent.
	 */
	readonly onError?: (message: string) => void;
	/** The underlying connection (re)opened with an OK response. */
	readonly onOpen?: () => void;
}

export interface WatchOptions {
	/**
	 * The server's origin (e.g. `http://127.0.0.1:PORT`) — required; the
	 * TUI is a remote client.
	 */
	readonly baseUrl: string;
	/** `X-Sigrun-User` identity header (Task 2); omitted when absent/empty. */
	readonly user?: string;
	/** Backoff ladder base in ms (default 250; tests shrink it). */
	readonly reconnectBaseMs?: number;
	/** Backoff cap in ms (default 4000). */
	readonly reconnectMaxMs?: number;
	/** Injected for tests; defaults to the ambient `fetch`. */
	readonly fetch?: typeof globalThis.fetch;
}

/** The watcher handle: `unwatch()` closes the stream, idempotent. */
export type Unwatch = () => void;

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

/**
 * An incremental SSE frame parser: feed it chunks; it emits complete
 * frames (`{event, data}`). `:` lines are comments; `data:` accumulates
 * until a blank line; the field-name space after `:` is stripped once.
 */
function createFrameParser(
	emit: (frame: { event: string; data: string }) => void,
): (chunk: string) => void {
	let buffer = "";
	let event = "";
	let data: string[] = [];

	function dispatchLine(line: string): void {
		if (line === "") {
			if (data.length > 0) {
				emit({ event, data: data.join("\n") });
			}
			event = "";
			data = [];
			return;
		}
		if (line.startsWith(":")) {
			return; // a comment (the heartbeat `: ping`)
		}
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) {
			value = value.slice(1);
		}
		if (field === "event") {
			event = value;
		} else if (field === "data") {
			data.push(value);
		}
		// `id:` (and unknown fields) are accepted and ignored — every frame
		// is a full revision, so the revision cursor is never needed.
	}

	return (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			let line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.endsWith("\r")) {
				line = line.slice(0, -1);
			}
			dispatchLine(line);
		}
	};
}

/**
 * Watch one conversation's stream. Returns `unwatch()`. Reconnects on
 * stream drop; a reconnect's fresh snapshot replaces state wholesale.
 */
export function watchConversation(
	conversationId: number,
	handlers: WatchHandlers,
	options: WatchOptions,
): Unwatch {
	const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
	const baseMs = options.reconnectBaseMs ?? 250;
	const maxMs = options.reconnectMaxMs ?? 4_000;
	/** Give up after this many consecutive failed reconnects. */
	const maxAttempts = 10;
	const user = options.user?.trim();
	const headers: Record<string, string> =
		user === undefined || user === ""
			? { accept: "text/event-stream" }
			: { accept: "text/event-stream", "x-sigrun-user": user };
	const url = `${options.baseUrl}/v1/conversations/${conversationId}/stream`;

	let closed = false;
	let attempts = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: AbortController | undefined;
	/** Per-attempt onError dedupe (fix wave A10); cleared on open. */
	let reportedTransportError = false;

	function scheduleReconnect(): void {
		attempts += 1;
		const base = Math.min(baseMs * 2 ** (attempts - 1), maxMs);
		// ±30% jitter: correlated drops must not reconnect in lockstep.
		const delay = base * (1 + (Math.random() * 0.6 - 0.3));
		timer = setTimeout(() => {
			timer = undefined;
			void connect();
		}, delay);
	}

	async function connect(): Promise<void> {
		if (closed) return;
		if (attempts >= maxAttempts) {
			// Give up (fix wave A3): the 10th consecutive failure was just
			// reported by its caller; emit ONE final notice and stop — no
			// 11th fetch fires.
			handlers.onError?.(
				`giving up after ${maxAttempts} failed reconnects`,
			);
			return;
		}
		const controller = new AbortController();
		abort = controller;
		let response;
		try {
			response = await fetchImpl(url, {
				method: "GET",
				headers,
				signal: controller.signal,
			});
		} catch (error) {
			if (closed) return;
			handlers.onError?.(
				`conversation stream connect failed: ${(error as Error).message}`,
			);
			scheduleReconnect();
			return;
		}
		if (!response.ok || response.body === null) {
			if (closed) return;
			handlers.onError?.(
				`conversation stream responded with status ${response.status}`,
			);
			scheduleReconnect();
			return;
		}
		attempts = 0;
		// The open clears the per-attempt dedupe (fix wave A10): the next
		// failed connection gets its own single onError.
		reportedTransportError = false;
		handlers.onOpen?.();

		const parser = createFrameParser((frame) => {
			if (closed) return;
			const view = parseFrame(frame.data);
			if (view === undefined) {
				handlers.onError?.(
					`malformed ${frame.event === "" ? "message" : frame.event} frame (not a view object)`,
				);
				return;
			}
			if (frame.event === "snapshot") {
				// A fresh snapshot SUBSUMES anything missed — the consumer
				// replaces state wholesale; nothing here merges.
				handlers.onSnapshot?.(view);
			} else if (frame.event === "view") {
				handlers.onView?.(view);
			} else {
				handlers.onError?.(`unknown stream event "${frame.event}"`);
			}
		});

		const decoder = new TextDecoder();
		try {
			const reader = response.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				parser(decoder.decode(value, { stream: true }));
			}
		} catch (error) {
			if (closed) return;
			// Dedupe (fix wave A10): a read failure and the close that
			// follows it are ONE connection failure — one onError.
			if (!reportedTransportError) {
				reportedTransportError = true;
				handlers.onError?.(
					`conversation stream read failed: ${(error as Error).message}`,
				);
			}
		}
		if (!closed) {
			if (!reportedTransportError) {
				reportedTransportError = true;
				handlers.onError?.("conversation stream closed by the server");
			}
			scheduleReconnect();
		}
	}

	void connect();

	return () => {
		if (closed) return;
		closed = true;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		abort?.abort();
		abort = undefined;
	};
}
