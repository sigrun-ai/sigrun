/**
 * Shared test stub for the §5 EventSource stream (Task 21 review P2: the two
 * test files each carried an identical copy). A minimal EventSource-like:
 * `addEventListener` + `close` + a test-side `emit(type, data)` that fires
 * the registered listeners. Both the stream wrapper and the hook tests drive
 * the stub via an injected `EventSourceFactory`.
 */

import type { EventSourceLike, StreamMessageEvent } from "./stream.js";

export class StubEventSource implements EventSourceLike {
	closed = false;
	private readonly listeners = new Map<
		string,
		((event: StreamMessageEvent) => void)[]
	>();

	addEventListener(
		type: string,
		listener: (event: StreamMessageEvent) => void,
	): void {
		const list = this.listeners.get(type) ?? [];
		list.push(listener);
		this.listeners.set(type, list);
	}

	close(): void {
		this.closed = true;
	}

	emit(type: string, data = ""): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener({ data });
		}
	}
}
