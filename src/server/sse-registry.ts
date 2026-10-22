/**
 * The live-SSE registry (the ctrl+c fix): hijacked event-stream routes
 * never end on their own — the browser holds them open — and Fastify's
 * `app.close()` drains in-flight requests before finishing, so a shutdown
 * with any webui tab open HUNG forever on its `/v1/events` connection.
 *
 * Every SSE route registers its `end()` here on connect and deregisters on
 * disconnect; the shutdown path (serve.ts) terminates the whole registry
 * BEFORE `app.close()`, so the drain never waits on a stream that exists
 * only to be closed. Ending the stream is also what the CLIENT wants: the
 * browser's EventSource sees a clean close and reconnects if the server
 * were still alive.
 */

/** One live server-sent-events stream's termination handle. */
export interface LiveStream {
	/** End the response stream (idempotent per registration). */
	end(): void;
}

/** The per-app registry; `createServer` owns one and shutdown drains it. */
export class SseRegistry {
	readonly #streams = new Set<LiveStream>();

	/** Register a live stream; returns its deregister handle. */
	register(stream: LiveStream): () => void {
		this.#streams.add(stream);
		return () => {
			this.#streams.delete(stream);
		};
	}

	/** Terminate every live stream (idempotent; safe when empty). */
	endAll(): void {
		for (const stream of [...this.#streams]) {
			try {
				stream.end();
			} catch (error) {
				// A stream that died between registration and endAll is
				// already gone (the client saw its disconnect) — but report
				// it so a systematic teardown bug is visible, not silent.
				console.warn(
					"sse-registry: ending a live stream failed:",
					error instanceof Error ? error.message : String(error),
				);
			}
		}
	}

	/** How many streams are live (observability/tests). */
	get size(): number {
		return this.#streams.size;
	}
}
