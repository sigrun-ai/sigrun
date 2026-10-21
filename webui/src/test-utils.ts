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
import { vi, type Mock } from "vitest";
import type {
	ContentBlockWire,
	ConversationEntryWire,
	ConversationViewWire,
	MessageWire,
	UsageWire,
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

/**
 * Create a react-test-renderer instance inside an ASYNC `act` — flushes
 * effect-triggered promises (client fetches) before returning. Use for
 * components whose effects await the §5 client (SessionList, App).
 */
export async function renderAsync(
	element: ReactElement,
): Promise<TestRenderer.ReactTestRenderer> {
	let renderer: TestRenderer.ReactTestRenderer | undefined;
	await act(async () => {
		renderer = TestRenderer.create(element);
	});
	if (renderer === undefined) throw new Error("test renderer not created");
	return renderer;
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
	init?: {
		readonly id?: number;
		readonly conversationId?: number;
		readonly data?: unknown;
	},
): ConversationEntryWire {
	return {
		id: init?.id ?? 1,
		conversationId: init?.conversationId ?? 1,
		kind,
		model,
		...(init?.data === undefined ? {} : { data: init.data }),
	};
}

/* ── turn fixtures (B4): the entry shapes groupTurns folds into turns ──── */

/** A one-block text message; `extra` overrides/adds message fields. */
export function textMessage(
	role: string,
	text: string,
	extra?: Partial<MessageWire>,
): MessageWire {
	return { role, content: [{ type: "text", text }], ...extra };
}

/** A text content block. */
export function textBlock(text: string): ContentBlockWire {
	return { type: "text", text };
}

/** A thinking content block (pi-ai ThinkingContent). */
export function thinkingBlock(text: string): ContentBlockWire {
	return { type: "thinking", thinking: text };
}

/** A toolCall content block (the wire type keeps block fields narrow —
 *  id/name/arguments ride the loose shape groupTurns reads). */
export function toolCallBlock(
	id: string,
	name: string,
	args: unknown,
): ContentBlockWire {
	return { type: "toolCall", id, name, arguments: args } as unknown as ContentBlockWire;
}

/** A `pi.user` entry carrying one text message. */
export function userTurnEntry(
	id: number,
	text: string,
	init?: { readonly conversationId?: number },
): ConversationEntryWire {
	return makeEntry("pi.user", [textMessage("user", text)], {
		id,
		conversationId: init?.conversationId,
	});
}

/** A `pi.assistant` entry carrying one blocks message (thinking/text/toolCall). */
export function assistantTurnEntry(
	id: number,
	blocks: readonly ContentBlockWire[],
	init?: {
		readonly model?: string;
		readonly totalTokens?: number;
		readonly conversationId?: number;
	},
): ConversationEntryWire {
	return makeEntry(
		"pi.assistant",
		[
			{
				role: "assistant",
				content: blocks,
				...(init?.model === undefined ? {} : { model: init.model }),
				...(init?.totalTokens === undefined
					? {}
					: { usage: usageOf(init.totalTokens) }),
			},
		],
		{ id, conversationId: init?.conversationId },
	);
}

/** A full UsageWire with one meaningful number (token-count fixtures). */
export function usageOf(totalTokens: number): UsageWire {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A `pi.tool-result` entry for one call (toolResult-role message). */
export function toolResultTurnEntry(
	id: number,
	callId: string,
	init?: {
		readonly text?: string;
		readonly toolName?: string;
		readonly isError?: boolean;
		readonly details?: unknown;
		readonly conversationId?: number;
	},
): ConversationEntryWire {
	return makeEntry(
		"pi.tool-result",
		[
			{
				role: "toolResult",
				content: [{ type: "text", text: init?.text ?? "ok" }],
				toolName: init?.toolName ?? "bash",
				toolCallId: callId,
				...(init?.isError === undefined ? {} : { isError: init.isError }),
				...(init?.details === undefined ? {} : { details: init.details }),
			},
		],
		{ id, conversationId: init?.conversationId },
	);
}

/** The button whose visible label is exactly `label` (action-button finder);
 *  throws unless EXACTLY one matches (scoping is the caller's job). */
export function findButton(
	rrenderer: TestRenderer.ReactTestRenderer | TestRenderer.ReactTestInstance,
	label: string,
): TestRenderer.ReactTestInstance {
	const root = ("root" in rrenderer ? rrenderer.root : rrenderer) as {
		findAllByType(type: "button"): TestRenderer.ReactTestInstance[];
	};
	const matches = root.findAllByType("button").filter((button) =>
		(button.children ?? []).some(
			(child) => typeof child === "string" && child.trim() === label,
		),
	);
	if (matches.length !== 1) {
		throw new Error(
			`expected one "${label}" button, found ${matches.length}`,
		);
	}
	return matches[0]!;
}

/** Stub `navigator.clipboard` (Node has none); returns the writeText spy. */
export function stubClipboard(): Mock {
	const writeText = vi.fn(() => Promise.resolve());
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	return writeText;
}

/** Stub `sessionStorage` (Node has none) with a real Map-backed Storage. */
export function stubSessionStorage(): Storage {
	const map = new Map<string, string>();
	const storage: Storage = {
		get length(): number {
			return map.size;
		},
		key: (index) => Array.from(map.keys())[index] ?? null,
		getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
		setItem: (key, value) => void map.set(key, String(value)),
		removeItem: (key) => void map.delete(key),
		clear: () => map.clear(),
	};
	vi.stubGlobal("sessionStorage", storage);
	return storage;
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
