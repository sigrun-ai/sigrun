/**
 * The interaction seam's TUI renderer (UI-blocks U6 Task 3 — the parity
 * rule): the pending-interaction stack rendered FROM BLOCK TREES (spec
 * §9.1: a record's body is a root `form` whose submit is the answer,
 * `{values}` — ruling 20). Covered here:
 *
 * - a pending interaction renders its tree (the form's markdown +
 *   choice rows); multiple pending items stack (the top one is the
 *   prompt).
 * - answering goes through `answerInteraction` (the ONE generic route)
 *   with `{values}` (the chosen option id under the choice's name); the
 *   item clears on the next list.
 * - a multi-question form (several choice sections) presents the
 *   stepper: Tab advances, the review step lists every answer, Enter
 *   submits ONCE.
 * - expiry mid-stepper (Review Focus 2): the answer 404s, the card
 *   refetches through `getInteraction` and shows the settled status;
 *   the typed values stay visible, read-only.
 * - records without a tree body render nothing answerable (no ctrl+o).
 * - refetch triggers: stream frames (via the app) and `interaction.*`
 *   host events (W3 Task 4 — the 2s poll interval is retired);
 *   a stale list response never lands after a conversation switch.
 * - answer failures render an `[error]` line in the pane (user-initiated
 *   actions fail loud; background polls fail quiet).
 *
 * Tests own their literals (synthetic hosts/kinds only).
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
	// C2's sidebar tree orders by recency; a distinct stamp per id keeps
	// the boot listing deterministic with the LOWEST id newest (row 0,
	// the app's boot selection) — the pre-C2 insertion-order behavior.
	return {
		id,
		root: false,
		archived: false,
		pinned: false,
		access: "write",
		lastActivityAt: new Date(2026, 0, 1, 0, 0, -id).toISOString(),
	};
}

function view(id: number, entries: unknown[], busy = false): ConversationViewWire {
	return {
		conversation: { id },
		entries,
		docs: {},
		steer: { busy, queued: 0 },
	} as unknown as ConversationViewWire;
}

const TREE_V = 1;

/** A root form with the given children (the §9.1 interaction shape). */
function formTree(children: readonly unknown[]): unknown {
	return {
		v: TREE_V,
		root: {
			type: "form",
			id: "ask",
			bind: "/values",
			mode: "submit",
			children,
		},
	};
}

/** One choice section (the stepper's per-question shape, §9.1). */
function questionSection(
	name: string,
	label: string,
	options: readonly { id: string; label: string; recommended?: boolean }[],
): unknown {
	return {
		type: "section",
		title: label,
		children: [{ type: "choice", name, label, options }],
	};
}

/** One pending interaction record (envelope + block-tree body). */
function interaction(
	callId: string,
	init?: {
		kind?: string;
		/** The tree's children (fields/sections). */
		children?: readonly unknown[];
		/** Raw tree override (children ignored when set). */
		tree?: unknown;
		details?: Record<string, unknown>;
	},
): InteractionWire {
	return {
		kind: init?.kind ?? "acme.confirm",
		callId,
		status: "pending",
		createdAt: 1,
		body: init?.tree ?? (init?.children === undefined ? undefined : formTree(init.children)),
		...(init?.details === undefined ? {} : { details: init.details }),
	} as unknown as InteractionWire;
}

/** A one-question gate tree (markdown + a decision choice). */
function gateChildren(
	text: string,
	options: readonly { id: string; label: string; recommended?: boolean }[],
): readonly unknown[] {
	return [
		{
			type: "section",
			children: [{ type: "markdown", text }],
		},
		{ type: "choice", name: "decision", label: text, options },
	];
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
	/** getInteraction stub behavior (the settle-refetch path). */
	getResult?: (callId: string) => Promise<InteractionWire>;
}) {
	const answerCalls: AnswerCall[] = [];
	const getCalls: { id: number; callId: string }[] = [];
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
				access: "write",
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
		getInteraction(id: number, callId: string): Promise<InteractionWire> {
			getCalls.push({ id, callId });
			if (init?.getResult !== undefined) return init.getResult(callId);
			return Promise.reject(new Error("unexpected getInteraction"));
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
		getCalls,
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
	test("a pending interaction renders its tree (markdown + choice rows)", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", {
				children: gateChildren("Proceed with the deploy?", [
					{ id: "yes", label: "Yes", recommended: true },
					{ id: "no", label: "No" },
				]),
			}),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		const lines = prompter.render(60).join("\n");
		expect(lines).toContain("[interaction] acme.confirm");
		expect(lines).toContain("Proceed with the deploy?");
		expect(lines).toContain("Yes");
		expect(lines).toContain("No");
		expect(lines).toContain("ctrl+o to answer");
		prompter.dispose();
	});

	test("multiple pending items stack: the top renders, the rest are counted", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", { children: gateChildren("first prompt", [{ id: "a", label: "A" }]) }),
			interaction("c2", { children: gateChildren("second prompt", [{ id: "b", label: "B" }]) }),
			interaction("c3", { children: gateChildren("third prompt", [{ id: "c", label: "C" }]) }),
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

	test("answering POSTs {values} and the item clears on the next list", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", {
				children: gateChildren("pick one", [
					{ id: "yes", label: "Yes" },
					{ id: "no", label: "No" },
				]),
			}),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		expect(prompter.beginAnswer()).toBe(true);
		expect(prompter.handleKey("2")).toBe(true);
		await flush();
		expect(stub.answerCalls).toEqual([
			{ id: 1, callId: "c1", answer: { values: { decision: "no" } } },
		]);
		// The next list (fetched after the answer settled) drops the item.
		expect(prompter.render(60).join("\n")).not.toContain("pick one");
		expect(prompter.answerMode).toBe(false);
		prompter.dispose();
	});

	test("a custom-onSubmit flat gate answers via the digit accelerator", async () => {
		// The digit's direct pick dispatches the form's onSubmit action,
		// not a hardcoded "submit" — the transport's submit gate keys on
		// the action name, so a custom action must POST too.
		const stub = stubClient();
		stub.setPending([
			interaction("c1", {
				tree: {
					v: TREE_V,
					root: {
						type: "form",
						id: "ask",
						bind: "/values",
						mode: "submit",
						onSubmit: "decide",
						children: gateChildren("pick one", [
							{ id: "yes", label: "Yes" },
							{ id: "no", label: "No" },
						]),
					},
				},
			}),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		expect(prompter.beginAnswer()).toBe(true);
		expect(prompter.handleKey("2")).toBe(true);
		await flush();
		expect(stub.answerCalls).toEqual([
			{ id: 1, callId: "c1", answer: { values: { decision: "no" } } },
		]);
		prompter.dispose();
	});

	test("a digit beyond the option range is consumed but answers nothing", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", { children: gateChildren("pick", [{ id: "a", label: "A" }]) }),
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

	test("multi-select toggles with digits and submits the set on enter", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", {
				children: [
					{
						type: "choice",
						name: "picks",
						label: "pick several",
						multi: true,
						options: [
							{ id: "a", label: "A", recommended: true },
							{ id: "b", label: "B" },
							{ id: "c", label: "C" },
						],
					},
				],
			}),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		prompter.beginAnswer();
		// Digits toggle the working set (the prompter's accelerator).
		prompter.handleKey("1");
		prompter.handleKey("2");
		await flush();
		// Tab to the submit row; Enter submits the accumulated set ONCE
		// (the form's one-submit rule).
		prompter.handleKey("\t");
		prompter.handleKey("\r");
		await flush();
		expect(stub.answerCalls).toHaveLength(1);
		expect(stub.answerCalls[0]?.callId).toBe("c1");
		const answer = stub.answerCalls[0]?.answer as { values: Record<string, unknown> };
		expect(answer.values.picks).toEqual(["a", "b"]);
		// A second Enter dispatches nothing (the form submitted once).
		prompter.handleKey("\r");
		await flush();
		expect(stub.answerCalls).toHaveLength(1);
		prompter.dispose();
	});

	test("esc exits answer mode without answering", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", { children: gateChildren("pick", [{ id: "a", label: "A" }]) }),
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

	test("a record without a tree body renders but offers no answer affordance", async () => {
		const stub = stubClient();
		stub.setPending([interaction("c1")]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		const lines = prompter.render(60).join("\n");
		expect(lines).toContain("[interaction] acme.confirm");
		expect(lines).not.toContain("ctrl+o");
		expect(prompter.beginAnswer()).toBe(false);
		prompter.dispose();
	});

	test("a multi-question form steps with Tab, reviews, and submits once", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", {
				children: [
					questionSection("q1", "First", [
						{ id: "a", label: "A" },
						{ id: "b", label: "B" },
					]),
					questionSection("q2", "Second", [
						{ id: "x", label: "X" },
						{ id: "y", label: "Y" },
					]),
				],
			}),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		// Stepper: one question at a time.
		expect(prompter.render(60).join("\n")).toContain("Step 1 of 2");
		prompter.beginAnswer();
		// Enter selects the current option (q1 → "a").
		prompter.handleKey("\r");
		// Tab advances to step 2.
		prompter.handleKey("\t");
		expect(prompter.render(60).join("\n")).toContain("Step 2 of 2");
		prompter.handleKey("\r");
		// Tab to the review: both answers listed.
		prompter.handleKey("\t");
		const review = prompter.render(60).join("\n");
		expect(review).toContain("a");
		expect(review).toContain("x");
		// Enter submits ONCE with every value.
		prompter.handleKey("\r");
		await flush();
		expect(stub.answerCalls).toHaveLength(1);
		expect(stub.answerCalls[0]?.answer).toEqual({
			values: { q1: "a", q2: "x" },
		});
		prompter.dispose();
	});

	test("expiry mid-form: the 404 refetches, shows the status, keeps typed values read-only", async () => {
		// A FLAT form (no sections): a digit on the review STEP would be
		// inert for an unrelated reason, so the read-only assertion below
		// is only load-bearing on a flat form (fix round 2).
		const flatChildren: readonly unknown[] = [
			{ type: "markdown", text: "Approve the deploy?" },
			{ type: "text", name: "note", label: "Note" },
		];
		const settledRecord = {
			kind: "acme.confirm",
			callId: "c1",
			status: "expired",
			createdAt: 1,
			settledAt: 2,
			body: interaction("c1", { children: flatChildren }).body,
		} as unknown as InteractionWire;
		const stub = stubClient({
			answerResult: () =>
				Promise.reject(
					new SigrunApiError("POST", "/v1/conversations/1/interactions/c1/answer", 404, {
						error: "not_pending",
					}),
				),
			getResult: () => Promise.resolve(settledRecord),
		});
		stub.setPending([interaction("c1", { children: flatChildren })]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		prompter.beginAnswer();
		// Type a note, Tab to the submit row, Enter submits (404s).
		// (Letters, not digits: the prompter consumes digits as the
		// one-question gate's direct-pick shortcut.)
		prompter.handleKey("x");
		prompter.handleKey("y");
		prompter.handleKey("\t");
		prompter.handleKey("\r");
		await flush();
		// The letters landed ("xy") — the field IS live pre-settle.
		expect(prompter.render(60).join("\n")).toContain("xy");
		// The refetch happened (the settle-refetch path).
		expect(stub.getCalls).toEqual([{ id: 1, callId: "c1" }]);
		// The settled status renders in the header (Review fix: the
		// header carries the record's status); the typed value stays
		// visible, read-only.
		const lines = prompter.render(60).join("\n");
		expect(lines).toContain("expired");
		expect(lines).toContain("xy");
		expect(prompter.answerMode).toBe(false);
		// A further poll still lists the record pending (the server's
		// pending index lags the settle) — the settled envelope must NOT
		// revert to write access (the read-only swap sticks).
		await prompter.kickAndWait();
		const after = prompter.render(60).join("\n");
		expect(after).toContain("expired");
		// Read-only: a keystroke dispatches nothing (no re-submit). On
		// the flat form this is LOAD-BEARING — pre-fix the letter lands
		// in the field and the Tab+Enter re-dispatches the submit.
		prompter.beginAnswer();
		prompter.handleKey("z");
		await flush();
		// The letter never landed in the (now read-only) field…
		expect(prompter.render(60).join("\n")).not.toContain("xyz");
		// …and no second submit is possible.
		prompter.handleKey("\t");
		prompter.handleKey("\r");
		await flush();
		expect(stub.answerCalls).toHaveLength(1);
		prompter.dispose();
	});

	test("a 400 answer failure keeps the card writable — a retry can answer", async () => {
		let fail = true;
		const stub = stubClient({
			answerResult: () =>
				fail
					? Promise.reject(
							new SigrunApiError("POST", "/v1/conversations/1/interactions/c1/answer", 400, {
								error: "invalid_body",
							}),
						)
					: Promise.resolve({ callId: "c1", status: "answered", answer: {} }),
			// The settle-refetch returns the STILL-PENDING record (the 400
			// was no settle) — the card must not wedge read-only.
			getResult: (callId) =>
				Promise.resolve(
					interaction(callId, { children: gateChildren("pick", [{ id: "a", label: "A" }]) }),
				),
		});
		stub.setPending([
			interaction("c1", { children: gateChildren("pick", [{ id: "a", label: "A" }]) }),
		]);
		const prompter = new InteractionPrompter(stub.client);
		const errors: string[] = [];
		prompter.onError = (message) => errors.push(message);
		prompter.setConversation(1);
		await flush();
		prompter.beginAnswer();
		prompter.handleKey("1");
		await flush();
		// The error surfaces loud; the card stays pending + writable.
		expect(errors.length).toBe(1);
		const mid = prompter.render(60).join("\n");
		expect(mid).toContain("pick");
		expect(mid).not.toContain(" — answered");
		// The retry answers.
		fail = false;
		prompter.beginAnswer();
		prompter.handleKey("1");
		await flush();
		expect(stub.answerCalls).toHaveLength(2);
		prompter.dispose();
	});

	test("a callout action is NOT the answer — only the root form's submit answers", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", {
				children: [
					{ type: "markdown", text: "heads up" },
					// A callout action button inside the form: its dispatch
					// must never POST an answer.
					{
						type: "callout",
						tone: "info",
						title: "Note",
						body: "context",
						actions: [
							{
								id: "more",
								label: "More info",
								action: { type: "submit", name: "details" },
							},
						],
					},
				],
			}),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		prompter.beginAnswer();
		// Dispatch the callout action directly (the form's button click).
		const state = prompter.surface;
		expect(state).toBeDefined();
		state?.dispatch({ type: "submit", name: "details" }, {});
		await flush();
		expect(stub.answerCalls).toEqual([]);
		// The form's own submit DOES answer.
		state?.dispatch({ type: "submit", name: "submit" }, { values: { ok: true } });
		await flush();
		expect(stub.answerCalls).toHaveLength(1);
		expect(stub.answerCalls[0]?.answer).toEqual({ values: { ok: true } });
		prompter.dispose();
	});

	test("a callout action NAMED \"submit\" (type \"edit\") is NOT the answer — the gate checks the kind", async () => {
		// Fix round 2: name alone must never settle — a callout
		// itemAction named "submit" (the default onSubmit name) is an
		// `edit`, and an edit never answers.
		const stub = stubClient();
		stub.setPending([
			interaction("c1", {
				children: [{ type: "markdown", text: "heads up" }],
			}),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		prompter.beginAnswer();
		const state = prompter.surface;
		expect(state).toBeDefined();
		state?.dispatch({ type: "edit", name: "submit" }, {});
		await flush();
		expect(stub.answerCalls).toEqual([]);
		// The real submit still answers.
		state?.dispatch({ type: "submit", name: "submit" }, { values: { ok: true } });
		await flush();
		expect(stub.answerCalls).toHaveLength(1);
		prompter.dispose();
	});

	test("a live-mode edit NAMED the onSubmit action is NOT the answer (the gate checks the kind)", async () => {
		// Fix round 2: mode "live" + onSubmit dispatches
		// `{type: "edit", name: onSubmit}` on the debounce — settling on
		// the first keystroke would be the bug.
		const stub = stubClient();
		stub.setPending([
			interaction("c1", {
				tree: {
					v: TREE_V,
					root: {
						type: "form",
						id: "ask",
						bind: "/values",
						mode: "live",
						onSubmit: "save",
						children: [{ type: "text", name: "note", label: "Note" }],
					},
				},
			}),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		prompter.beginAnswer();
		const state = prompter.surface;
		expect(state).toBeDefined();
		// The debounce's dispatch (driven directly: the debounce timing
		// is the form's own suite's concern).
		state?.dispatch({ type: "edit", name: "save" }, { values: { note: "typed" } });
		await flush();
		expect(stub.answerCalls).toEqual([]);
		// The real submit with the onSubmit name answers.
		state?.dispatch({ type: "submit", name: "save" }, { values: { note: "typed" } });
		await flush();
		expect(stub.answerCalls).toHaveLength(1);
		expect(stub.answerCalls[0]?.answer).toEqual({ values: { note: "typed" } });
		prompter.dispose();
	});

	test("W3: no poll interval — timers alone never refetch; kick() does", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
		try {
			const stub = stubClient();
			const prompter = new InteractionPrompter(stub.client);
			prompter.setConversation(1);
			await vi.advanceTimersByTimeAsync(0);
			const atBoot = stub.listCalls();
			// The retired poll interval: advancing time fires NO fetches.
			await vi.advanceTimersByTimeAsync(60_000);
			expect(stub.listCalls()).toBe(atBoot);
			// The host-event path (the app wires interaction.* to kick).
			prompter.kick();
			await vi.advanceTimersByTimeAsync(0);
			expect(stub.listCalls()).toBe(atBoot + 1);
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
					interactions: [
						interaction("c2", { children: gateChildren("conversation two prompt", [{ id: "b", label: "B" }]) }),
					],
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
			interactions: [interaction("c1", { children: gateChildren("stale conversation one prompt", [{ id: "a", label: "A" }]) })],
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
			getResult: () => Promise.reject(new Error("not found either")),
		});
		stub.setPending([
			interaction("c1", { children: gateChildren("pick", [{ id: "a", label: "A" }]) }),
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
			interaction("c1", { children: gateChildren("prompt A", [{ id: "a", label: "A" }]) }),
			interaction("c2", { children: gateChildren("prompt B", [{ id: "b", label: "B" }]) }),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		// The user reads prompt A and arms the answer keys.
		expect(prompter.beginAnswer()).toBe(true);
		expect(prompter.render(60).join("\n")).toContain("prompt A");
		// A poll lands where A has settled elsewhere and B is now the top.
		stub.setPending([
			interaction("c2", { children: gateChildren("prompt B", [{ id: "b", label: "B" }]) }),
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

	test("setConversation(undefined) clears the prompt; stale kicks no-op", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", { children: gateChildren("pick", [{ id: "a", label: "A" }]) }),
		]);
		const prompter = new InteractionPrompter(stub.client);
		prompter.setConversation(1);
		await flush();
		expect(prompter.render(60).join("\n")).toContain("pick");
		prompter.setConversation(undefined);
		expect(prompter.render(60).join("\n")).not.toContain("pick");
		const calls = stub.listCalls();
		prompter.kick();
		await flush();
		expect(stub.listCalls()).toBe(calls);
		prompter.dispose();
	});
});

// ─── App integration ────────────────────────────────────────────────────

describe("TuiApp interactions", () => {
	test("boot fetches the active conversation's pending interactions into the app render", async () => {
		const stub = stubClient();
		stub.setPending([
			interaction("c1", { children: gateChildren("boot-time prompt", [{ id: "a", label: "A" }]) }),
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
				children: gateChildren("gate", [
					{ id: "allow", label: "Allow" },
					{ id: "deny", label: "Deny" },
				]),
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
			{ id: 1, callId: "c1", answer: { values: { decision: "deny" } } },
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
			interaction("c1", { children: gateChildren("gate", [{ id: "a", label: "A" }]) }),
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
			getResult: () => Promise.reject(new Error("gone")),
		});
		stub.setPending([
			interaction("c1", { children: gateChildren("gate", [{ id: "a", label: "A" }]) }),
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
			[1, [interaction("c1", { children: gateChildren("conv one prompt", [{ id: "a", label: "A" }]) })]],
			[2, [interaction("c2", { children: gateChildren("conv two prompt", [{ id: "b", label: "B" }]) })]],
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
