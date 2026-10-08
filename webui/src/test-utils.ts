/**
 * Shared test stub for the §5 EventSource stream (Task 21 review P2: the two
 * test files each carried an identical copy). A minimal EventSource-like:
 * `addEventListener` + `close` + a test-side `emit(type, data)` that fires
 * the registered listeners. Both the stream wrapper and the hook tests drive
 * the stub via an injected `EventSourceFactory`.
 *
 * Task 22 added the react-test-renderer harness helpers (`render`,
 * `textContent`) and the fixture-shaped view builders (`makeEntry`,
 * `textMessage`, `makeView`) the entry-renderer tests drive — shapes per
 * `test/fixtures/view-schema.json`.
 */

import { act, type ReactElement } from "react";
import TestRenderer from "react-test-renderer";
import type {
	ConversationEntryWire,
	ConversationViewWire,
	MessageWire,
} from "./api.js";
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

/** Create a react-test-renderer instance inside `act` (the T21/T22 harness). */
export function render(element: ReactElement): TestRenderer.ReactTestRenderer {
	let renderer: TestRenderer.ReactTestRenderer | undefined;
	act(() => {
		renderer = TestRenderer.create(element);
	});
	if (renderer === undefined) throw new Error("test renderer not created");
	return renderer;
}

/** All text under a rendered JSON tree, concatenated (assertion helper). */
export function textContent(
	node:
		| TestRenderer.ReactTestRendererJSON
		| TestRenderer.ReactTestRendererJSON[]
		| null,
): string {
	if (node === null) return "";
	if (Array.isArray(node)) {
		return node.map((child) => textContent(child)).join("");
	}
	return (node.children ?? [])
		.map((child) =>
			typeof child === "string" ? child : textContent(child),
		)
		.join("");
}

/** Build a §5 entry (fixture-shaped — see test/fixtures/view-schema.json). */
export function makeEntry(
	kind: string,
	model: readonly MessageWire[],
	init?: { readonly id?: number; readonly conversationId?: number },
): ConversationEntryWire {
	return {
		id: init?.id ?? 1,
		conversationId: init?.conversationId ?? 1,
		kind,
		model,
	};
}

/** A one-block text message; `extra` overrides/adds message fields. */
export function textMessage(
	role: string,
	text: string,
	extra?: Partial<MessageWire>,
): MessageWire {
	return { role, content: [{ type: "text", text }], ...extra };
}

/** A full §5 view frame (defaults: conversation 1, no entries, empty docs). */
export function makeView(init?: {
	readonly id?: number;
	readonly entries?: readonly ConversationEntryWire[];
	readonly docs?: Readonly<Record<string, unknown>>;
	readonly steer?: { readonly busy: boolean; readonly queued: number };
}): ConversationViewWire {
	return {
		conversation: { id: init?.id ?? 1 },
		entries: init?.entries ?? [],
		docs: init?.docs ?? {},
		steer: init?.steer ?? { busy: false, queued: 0 },
	};
}
