/**
 * The interaction seam's TUI renderer (Task 8 — the parity rule): the
 * pending-interaction stack rendered as an answerable prompt above the
 * composer, generic over record kinds (the TUI never knows what an
 * "approval" is). Covered here:
 *
 * - a pending interaction renders its kind, prompt text, and numbered
 *   options; multiple pending items stack (the top one is the prompt).
 * - answering goes through `answerInteraction` (the ONE generic route)
 *   with the chosen option ids; the item clears on the next list.
 * - multi-select records (`details.multi`, the webui's reading) toggle
 *   with digits and submit the accumulated set on enter.
 * - records without options render without an answer affordance (the
 *   webui's no-affordance rule; form fields render read-only).
 * - polling: on stream frames (via the app) and on a short interval;
 *   a stale list response never lands after a conversation switch.
 * - answer failures render an `[error]` line in the pane (user-initiated
 *   actions fail loud; background polls fail quiet).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";
import { TuiApp } from "../src/ui/app.js";
import { InteractionPrompter } from "../src/ui/interactions.js";
import {
	SigrunApiError,
	type ConversationList,
	type ConversationSummary,
	type ConversationViewWire,
	type InteractionList,
	type InteractionWire,
	type SigrunClient,
} from "../src/api.js";
import type { Unwatch, WatchHandlers, WatchOptions } from "../src/sse.js";

// ─── Stubs (the app.test.ts idiom, extended with the seam surface) ──────

function summary(id: number): ConversationSummary {
	return { id, root: false, entryCount: 0, archived: false, pinned: false };
}

function view(id: number, entries: unknown[], busy = false): ConversationViewWire {
	return {
		conversation: { id },
		entries,
		docs: {},
		steer: { busy, queued: 0 },
	} as unknown as ConversationViewWire;
}

/** One pending interaction record (envelope + closed-primitive body). */
function interaction(
	callId: string,
	init?: {
		kind?: string;
		text?: string;
		options?: readonly { id: string; label: string; description?: string; recommended?: boolean }[];
		fields?: readonly { name: string; type: "string" | "number" | "boolean" | "secret"; label?: string; required?: boolean }[];
		diff?: { before: string; after: string; path?: string };
		details?: Record<string, unknown>;
	},
): InteractionWire {
	return {
		kind: init?.kind ?? "acme.confirm",
		callId,
		status: "pending",
		createdAt: 1,
		body: {
			...(init?.text === undefined ? {} : { text: init.text }),
			...(init?.options === undefined ? {} : { options: [...init.options] }),
			...(init?.fields === undefined ? {} : { fields: [...init.fields] }),
			...(init?.diff === undefined ? {} : { diff: init.diff }),
		},
		...(init?.details === undefined ? {} : { details: init.details }),
	} as unknown as InteractionWire;
}

interface AnswerCall {
	id: number;
	callId: string;
	answer: unknown;
}

function stubClient(init?: {
	/** The answer stub's behavior (default: resolves answered). */
	answerResult?: () => Promise<unknown>;
	/** listInteractions stub behavior; default serves the mutable list. */
	listResult?: () => Promise<InteractionList>;
}) {
	const answerCalls: AnswerCall[] = [];
	let listCalls = 0;
	let ambientCalls = 0;
	const watchCalls: number[] = [];
	const watchRegistry = new Map<number, WatchHandlers>();
	const listed: ConversationSummary[] = [summary(1), summary(2)];
	// The stub's pending list is stateful: answering removes the record,
	// exactly like the server's first-answer-wins settle + index update.
	let pending: InteractionWire[] = [];
	const client = {
		listConversations(): Promise<ConversationList> {
			return Promise.resolve({ conversations: [...listed] });
		},
		getMeta(_id: number) {
			return Promise.resolve({
				pinned: false,
				tagged: [],
				archived: false,
				draft: { text: "", attachments: [] },
				source: "user",
			});
		},
		getConversation(id: number) {
			return Promise.resolve(view(id, []));
		},
		listInteractions(_id: number): Promise<InteractionList> {
			listCalls += 1;
			return init?.listResult !== undefined
				? init.listResult()
				: Promise.resolve({ interactions: [...pending] });
		},
		answerInteraction(id: number, callId: string, answer: unknown) {
			answerCalls.push({ id, callId, answer });
			const result =
				init?.answerResult !== undefined
					? init.answerResult()
					: Promise.resolve({ callId, status: "answered", answer: {} });
			// The settle lands only on success: a rejected answer leaves the
			// record pending, exactly like the server's first-answer-wins.
			return Promise.resolve(result).then((value) => {
				pending = pending.filter((record) => record.callId !== callId);
				return value;
			});
		},
		getAmbient(_id: number) {
			ambientCalls += 1;
			return Promise.resolve({ ambient: [] });
		},
		submit(id: number) {
			return Promise.resolve({ id: 1, conversationId: id, type: "user", status: "answered" });
		},
	};
	return {
		client: client as unknown as SigrunClient,
		answerCalls,
		watchCalls,
		watchRegistry,
		listCalls: () => listCalls,
		ambientCalls: () => ambientCalls,
		setPending(records: InteractionWire[]) {
			pending = records;
		},
	};
}

function stubWatch(
	registry: Map<number, WatchHandlers>,
	calls: number[],
): (conversationId: number, handlers: WatchHandlers, options: WatchOptions) => Unwatch {
	return (conversationId, handlers) => {
		calls.push(conversationId);
		registry.set(conversationId, handlers);
		return () => {
			registry.delete(conversationId);
		};
	};
}

/** A render target stand-in: the app requests renders on seam changes. */
const fakeTui = { requestRender: () => {} } as unknown as TUI;

/** Flush the microtask queue (one macrotask drains every chained promise). */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function boot(init?: Parameters<typeof stubClient>[0]) {
	const stub = stubClient(init);
	const app = new TuiApp(stub.client, {
		tui: fakeTui,
		watch: stubWatch(stub.watchRegistry, stub.watchCalls),
	});
	await app.refresh();
	return { app, ...stub };
}

// ─── InteractionPrompter (unit) ─────────────────────────────────────────

describe("InteractionPrompter", () => {
	test("a pending interaction renders its kind, prompt, and numbered options", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", {
				text: "Proceed with the deploy?",
				options: [
					{ id: "yes", label: "Yes", recommended: true },
					{ id: "no", label: "No", description: "stop here" },
				],
			}),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		const lines = prompter.render(60).join("\n");
		expect(lines).toContain("[interaction] acme.confirm");
		expect(lines).toContain("Proceed with the deploy?");
		expect(lines).toContain("1. Yes");
		expect(lines).toContain("(recommended)");
		expect(lines).toContain("2. No");
		expect(lines).toContain("stop here");
		expect(lines).toContain("ctrl+o to answer");
		prompter.dispose();
	});

	test("multiple pending items stack: the top renders, the rest are counted", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", { text: "first prompt", options: [{ id: "a", label: "A" }] }),
			interaction("c2", { text: "second prompt", options: [{ id: "b", label: "B" }] }),
			interaction("c3", { text: "third prompt", options: [{ id: "c", label: "C" }] }),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		const lines = prompter.render(60).join("\n");
		expect(lines).toContain("first prompt");
		expect(lines).not.toContain("second prompt");
		expect(lines).not.toContain("third prompt");
		expect(lines).toContain("+2 more pending");
		prompter.dispose();
	});

	test("answering POSTs the decision and the item clears on the next list", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", {
				text: "pick one",
				options: [
					{ id: "yes", label: "Yes" },
					{ id: "no", label: "No" },
				],
			}),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		expect(prompter.beginAnswer()).toBe(true);
		expect(prompter.handleKey("2")).toBe(true);
		await flush();
		expect(stub.answerCalls).toEqual([
			{ id: 1, callId: "c1", answer: { ids: ["no"] } },
		]);
		// The next list (fetched after the answer settled) drops the item.
		expect(prompter.render(60).join("\n")).not.toContain("pick one");
		expect(prompter.answerMode).toBe(false);
		prompter.dispose();
	});

	test("a digit beyond the option range is consumed but answers nothing", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", { text: "pick", options: [{ id: "a", label: "A" }] }),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		prompter.beginAnswer();
		expect(prompter.handleKey("9")).toBe(true);
		await flush();
		expect(stub.answerCalls).toEqual([]);
		prompter.dispose();
	});

	test("multi-select (details.multi) toggles with digits and submits on enter", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", {
				text: "pick several",
				options: [
					{ id: "a", label: "A", recommended: true },
					{ id: "b", label: "B" },
					{ id: "c", label: "C" },
				],
				details: { multi: true },
			}),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		prompter.beginAnswer();
		// The recommended option starts selected; toggle 1 off, 2 and 3 on.
		prompter.handleKey("1");
		prompter.handleKey("2");
		prompter.handleKey("3");
		const marked = prompter.render(60).join("\n");
		expect(marked).toContain("[ ] 1. A");
		expect(marked).toContain("[x] 2. B");
		expect(marked).toContain("[x] 3. C");
		expect(prompter.handleKey("\r")).toBe(true);
		await flush();
		expect(stub.answerCalls).toEqual([
			{ id: 1, callId: "c1", answer: { ids: ["b", "c"] } },
		]);
		prompter.dispose();
	});

	test("esc exits answer mode without answering", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", { text: "pick", options: [{ id: "a", label: "A" }] }),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		prompter.beginAnswer();
		expect(prompter.handleKey("\x1b")).toBe(true);
		expect(prompter.answerMode).toBe(false);
		await flush();
		expect(stub.answerCalls).toEqual([]);
		prompter.dispose();
	});

	test("a record without options renders but offers no answer affordance", async () => {
		const stub = stubClient();
		stub.setPending([interaction("c1", { text: "just so you know" })]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		const lines = prompter.render(60).join("\n");
		expect(lines).toContain("just so you know");
		expect(lines).not.toContain("ctrl+o");
		expect(prompter.beginAnswer()).toBe(false);
		prompter.dispose();
	});

	test("form fields render read-only with the medium-limitation hint", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", {
				text: "configure",
				fields: [
					{ name: "host", type: "string", label: "Host", required: true },
					{ name: "token", type: "secret" },
				],
			}),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		const lines = prompter.render(60).join("\n");
		expect(lines).toContain("Host");
		expect(lines).toContain("string");
		expect(lines).toContain("required");
		expect(lines).toContain("token");
		expect(lines).toContain("answer in the webui");
		expect(prompter.beginAnswer()).toBe(false);
		prompter.dispose();
	});

	test("a diff renders as before/after lines", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", {
				text: "apply this change?",
				options: [{ id: "ok", label: "OK" }],
				diff: { before: "old line", after: "new line", path: "src/a.ts" },
			}),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		const lines = prompter.render(60).join("\n");
		expect(lines).toContain("[diff] src/a.ts");
		expect(lines).toContain("- old line");
		expect(lines).toContain("+ new line");
		prompter.dispose();
	});

	test("the poll interval re-fetches the pending list", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
		try {
			const stub = stubClient();
			const prompter = new InteractionPrompter(stub.client, { pollMs: 1000 });
			prompter.setConversation(1);
			await vi.advanceTimersByTimeAsync(0);
			const atBoot = stub.listCalls();
			await vi.advanceTimersByTimeAsync(2000);
			expect(stub.listCalls()).toBeGreaterThanOrEqual(atBoot + 2);
			prompter.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("a stale list response never lands after a conversation switch", async () => {
		const stub = stubClient();
		let resolveFirst: ((list: InteractionList) => void) | undefined;
		let calls = 0;
		const slow = {
			...stub.client,
			listInteractions(_id: number): Promise<InteractionList> {
				calls += 1;
				if (calls === 1) {
					return new Promise((resolve) => {
						resolveFirst = resolve;
					});
				}
				return Promise.resolve({
					interactions: [interaction("c2", { text: "conversation two prompt" })],
				});
			},
		} as unknown as SigrunClient;
		const prompter = new InteractionPrompter(slow);
		prompter.setConversation(1);
		prompter.setConversation(2);
		await flush();
		expect(prompter.render(60).join("\n")).toContain("conversation two prompt");
		// The conversation-1 response resolves LATE — it must be dropped.
		resolveFirst?.({
			interactions: [interaction("c1", { text: "stale conversation one prompt" })],
		});
		await flush();
		const lines = prompter.render(60).join("\n");
		expect(lines).toContain("conversation two prompt");
		expect(lines).not.toContain("stale conversation one prompt");
		prompter.dispose();
	});

	test("an answer failure surfaces via onError and the prompt stays", async () => {
		const stub = stubClient({
			answerResult: () =>
				Promise.reject(
					new SigrunApiError("POST", "/v1/conversations/1/interactions/c1/answer", 400, {
						error: "invalid_body",
					}),
				),
		});
		stub.setPending([
			interaction("c1", { text: "pick", options: [{ id: "a", label: "A" }] }),
		]);
		const prompter = new InteractionPrompter(stub.client);
		const errors: string[] = [];
		prompter.onError = (message) => errors.push(message);
		prompter.setConversation(1);
		await flush();
		prompter.beginAnswer();
		prompter.handleKey("1");
		await flush();
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("answer failed (400)");
		expect(errors[0]).toContain("invalid_body");
		// The record is still pending server-side; the prompt stays.
		expect(prompter.render(60).join("\n")).toContain("pick");
		prompter.dispose();
	});

	test("a poll that changes the top record exits answer mode and keys answer nothing", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", { text: "prompt A", options: [{ id: "a", label: "A" }] }),
			interaction("c2", { text: "prompt B", options: [{ id: "b", label: "B" }] }),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		// The user reads prompt A and arms the answer keys.
		expect(prompter.beginAnswer()).toBe(true);
		expect(prompter.render(60).join("\n")).toContain("prompt A");
		// A poll lands where A has settled elsewhere and B is now the top.
		stub.setPending([
			interaction("c2", { text: "prompt B", options: [{ id: "b", label: "B" }] }),
		]);
		await prompter.kickAndWait();
		expect(prompter.render(60).join("\n")).toContain("prompt B");
		expect(prompter.answerMode).toBe(false);
		// The stale digit must NOT answer B (the user never saw it).
		expect(prompter.handleKey("1")).toBe(false);
		await flush();
		expect(stub.answerCalls).toEqual([]);
		prompter.dispose();
	});

	test("setConversation(undefined) clears the prompt and stops polling", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
		try {
			const stub = stubClient();
			stub.setPending([
				interaction("c1", { text: "pick", options: [{ id: "a", label: "A" }] }),
			]);
			const prompter = new InteractionPrompter(stub.client, { pollMs: 1000 });
			prompter.setConversation(1);
			await vi.advanceTimersByTimeAsync(0);
			expect(prompter.render(60).join("\n")).toContain("pick");
			prompter.setConversation(undefined);
			expect(prompter.render(60).join("\n")).not.toContain("pick");
			const calls = stub.listCalls();
			await vi.advanceTimersByTimeAsync(5000);
			expect(stub.listCalls()).toBe(calls);
			prompter.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});

// ─── App integration ────────────────────────────────────────────────────

describe("TuiApp interactions", () => {
	test("boot fetches the active conversation's pending interactions into the app render", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", { text: "boot-time prompt", options: [{ id: "a", label: "A" }] }),
		]);
		const app = new TuiApp(stub.client, {
			tui: fakeTui,
			watch: stubWatch(stub.watchRegistry, stub.watchCalls),
		});
		await app.refresh();
		await flush();
		expect(app.render(80).join("\n")).toContain("boot-time prompt");
		app.dispose();
	});

	test("a stream frame kicks an interaction refresh (each revision may change the pending set)", async () => {
		const { app, watchRegistry, listCalls } = await boot();
		await flush();
		const before = listCalls();
		watchRegistry.get(1)?.onSnapshot?.(view(1, []));
		await flush();
		expect(listCalls()).toBeGreaterThan(before);
		app.dispose();
	});

	test("ctrl+o enters answer mode and a digit answers through the generic route", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", {
				text: "gate",
				options: [
					{ id: "allow", label: "Allow" },
					{ id: "deny", label: "Deny" },
				],
			}),
		]);
		const app = new TuiApp(stub.client, {
			tui: fakeTui,
			watch: stubWatch(stub.watchRegistry, stub.watchCalls),
		});
		await app.refresh();
		await flush();
		expect(app.handleKeybinding("\x0f")).toBe(true); // ctrl+o
		expect(app.handleKeybinding("2")).toBe(true);
		await flush();
		expect(stub.answerCalls).toEqual([
			{ id: 1, callId: "c1", answer: { ids: ["deny"] } },
		]);
		expect(app.render(80).join("\n")).not.toContain("gate");
		app.dispose();
	});

	test("ctrl+o with nothing pending is NOT consumed (the editor may want it)", async () => {
		const { app } = await boot();
		await flush();
		expect(app.handleKeybinding("\x0f")).toBe(false);
		app.dispose();
	});

	test("in answer mode esc is the interaction's (it does not abort the run)", async () => {
		const stub = stubClient();
		let aborts = 0;
		const client = {
			...stub.client,
			abort() {
				aborts += 1;
				return Promise.resolve({ result: "aborted", submissionId: 1 });
			},
		} as unknown as SigrunClient;
		stub.setPending([
			interaction("c1", { text: "gate", options: [{ id: "a", label: "A" }] }),
		]);
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(stub.watchRegistry, stub.watchCalls),
		});
		await app.refresh();
		await flush();
		// A frame marks the run busy — esc would abort OUTSIDE answer mode.
		stub.watchRegistry.get(1)?.onSnapshot?.(view(1, [], true));
		app.handleKeybinding("\x0f");
		expect(app.handleKeybinding("\x1b")).toBe(true);
		await flush();
		expect(aborts).toBe(0);
		app.dispose();
	});

	test("an answer failure renders an [error] line in the pane", async () => {
		const stub = stubClient({
			answerResult: () =>
				Promise.reject(
					new SigrunApiError("POST", "/v1/conversations/1/interactions/c1/answer", 400, {
						error: "invalid_body",
					}),
				),
		});
		stub.setPending([
			interaction("c1", { text: "gate", options: [{ id: "a", label: "A" }] }),
		]);
		const app = new TuiApp(stub.client, {
			tui: fakeTui,
			watch: stubWatch(stub.watchRegistry, stub.watchCalls),
		});
		await app.refresh();
		await flush();
		app.handleKeybinding("\x0f");
		app.handleKeybinding("1");
		await flush();
		const lines = app.pane.render(60).join("\n");
		expect(lines).toContain("[error]");
		expect(lines).toContain("answer failed (400)");
		app.dispose();
	});

	test("switching conversations swaps the pending stack (no cross-conversation bleed)", async () => {
		const stub = stubClient();
		const byConversation = new Map<number, InteractionWire[]>([
			[1, [interaction("c1", { text: "conv one prompt", options: [{ id: "a", label: "A" }] })]],
			[2, [interaction("c2", { text: "conv two prompt", options: [{ id: "b", label: "B" }] })]],
		]);
		const client = {
			...stub.client,
			listInteractions(id: number): Promise<InteractionList> {
				return Promise.resolve({ interactions: [...(byConversation.get(id) ?? [])] });
			},
		} as unknown as SigrunClient;
		const app = new TuiApp(client, {
			tui: fakeTui,
			watch: stubWatch(stub.watchRegistry, stub.watchCalls),
		});
		await app.refresh();
		await flush();
		expect(app.render(80).join("\n")).toContain("conv one prompt");
		await app.selectConversation(2);
		await flush();
		const lines = app.render(80).join("\n");
		expect(lines).toContain("conv two prompt");
		expect(lines).not.toContain("conv one prompt");
		app.dispose();
	});
});
