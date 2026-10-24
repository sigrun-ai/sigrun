/**
 * The ambient seam's TUI renderer (UI-blocks U6 Task 3 — the parity
 * rule): ambient surfaces placed in the TUI's chrome per the seam's
 * `place` field, rendered FROM BLOCK TREES (spec §9.2):
 *
 * - `place: "status"` → the statusline (the row directly above the
 *   composer; multiple status records join with " · ").
 * - `place: "footer"` → the footer zone (the body's `columns` block
 *   renders the left/middle/right zones, one line per record).
 * - `place: "panel"` → the panel zone (the full tree rendering; literal
 *   rows through the collection renderer, quiet rows folded behind the
 *   collection's own "N more"; `maxRows`/`overflow` budget per Review
 *   Focus 3).
 *
 * Records are generic — the chrome never knows what a "todo" or a "goal"
 * is. Refetches arrive on conversation connect and on `ambient.changed`
 * host events via `kick(conversationId)` (W3 Task 4 — the refreshMs
 * timer cadence is retired). `expires: "idle"` entries are visible only
 * while a run is live and disappear when the conversation goes idle.
 *
 * Tests own their literals.
 */

import { describe, expect, test, vi } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";
import { TuiApp } from "../src/ui/app.js";
import { AmbientChrome } from "../src/ui/ambient.js";
import type {
	AmbientList,
	AmbientWire,
	ConversationList,
	ConversationSummary,
	ConversationViewWire,
	SigrunClient,
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

/** A one-line markdown tree (the §9.2 status shape). */
function lineTree(text: string): unknown {
	return { v: TREE_V, root: { type: "markdown", text } };
}

/** A three-zone footer tree (§9.2: one columns of one-line blocks). */
function footerTree(left: string, middle: string, right: string): unknown {
	return {
		v: TREE_V,
		root: {
			type: "columns",
			children: [
				{ block: { type: "markdown", text: left } },
				{ block: { type: "markdown", text: middle } },
				{ block: { type: "markdown", text: right } },
			],
		},
	};
}

/** A panel rows tree: a literal-rows list collection (the §9.2 rows
 *  mapping; ambient collections never bind — the 2026-10-24 ruling). */
function rowsTree(
	rows: readonly Record<string, unknown>[],
): unknown {
	return {
		v: TREE_V,
		root: {
			type: "collection",
			id: "rows",
			items: rows,
			display: "list",
			item: {
				title: { $: "./label" },
				status: { label: { $: "./status" } },
				quiet: { $: "./quiet" },
				body: { $: "./detail" },
			},
		},
	};
}

/** One ambient record (envelope + block-tree body). */
function ambient(
	key: string,
	init?: {
		owner?: string;
		place?: "status" | "footer" | "panel";
		refreshMs?: number;
		expires?: "never" | "idle";
		maxRows?: number;
		overflow?: "drop" | "wrap" | "summarize";
		body?: unknown;
		details?: Record<string, unknown>;
	},
): AmbientWire {
	return {
		key,
		owner: init?.owner ?? "acme-ext",
		place: init?.place ?? "status",
		expires: init?.expires ?? "never",
		...(init?.refreshMs === undefined ? {} : { refreshMs: init.refreshMs }),
		...(init?.maxRows === undefined ? {} : { maxRows: init.maxRows }),
		...(init?.overflow === undefined ? {} : { overflow: init.overflow }),
		updatedAt: 1,
		body: init?.body,
		...(init?.details === undefined ? {} : { details: init.details }),
	} as unknown as AmbientWire;
}

function stubClient() {
	let ambientCalls = 0;
	const watchCalls: number[] = [];
	const watchRegistry = new Map<number, WatchHandlers>();
	const listed: ConversationSummary[] = [summary(1), summary(2)];
	let surfaces: AmbientWire[] = [];
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
		listInteractions(_id: number) {
			return Promise.resolve({ interactions: [] });
		},
		answerInteraction() {
			return Promise.resolve({ callId: "", status: "answered", answer: {} });
		},
		getAmbient(_id: number): Promise<AmbientList> {
			ambientCalls += 1;
			return Promise.resolve({ ambient: [...surfaces] });
		},
		submit(id: number) {
			return Promise.resolve({ id: 1, conversationId: id, type: "user", status: "answered" });
		},
	};
	return {
		client: client as unknown as SigrunClient,
		watchCalls,
		watchRegistry,
		ambientCalls: () => ambientCalls,
		setSurfaces(records: AmbientWire[]) {
			surfaces = records;
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

/** Strip ANSI styling for structural assertions. */
const strip = (line: string): string => line.replace(/\[[0-9;]*m/g, "");

// ─── AmbientChrome (unit) ───────────────────────────────────────────────

describe("AmbientChrome", () => {
	test("a status record renders one line in the statusline", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("goal", { place: "status", body: lineTree("building the thing") }),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		expect(chrome.statusline()).toContain("building the thing");
		expect(chrome.footerLines()).toEqual([]);
		expect(chrome.panelLines()).toEqual([]);
		chrome.dispose();
	});

	test("a footer record renders its three zone columns, not the statusline", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("usage", { place: "footer", body: footerTree("tok 2.5k", "mid", "$0.01") }),
			ambient("goal", { place: "status", body: lineTree("on track") }),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const footer = chrome.footerLines().map(strip).join("\n");
		expect(footer).toContain("tok 2.5k");
		expect(footer).toContain("mid");
		expect(footer).toContain("$0.01");
		expect(chrome.statusline()).toContain("on track");
		expect(chrome.statusline()).not.toContain("tok 2.5k");
		chrome.dispose();
	});

	test("multiple status records join onto one statusline", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("a", { place: "status", body: lineTree("left") }),
			ambient("b", { place: "status", body: lineTree("right") }),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const line = chrome.statusline();
		expect(line).toContain("left");
		expect(line).toContain("right");
		chrome.dispose();
	});

	test("maxRows: 3 with 5 rows — a quiet-less template still truncates with '2 more'", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("queue", {
				place: "panel",
				maxRows: 3,
				overflow: "drop",
				// NO quiet binding in the item template: the drop overflow
				// must fall back to truncate + a count line (Review fix).
				body: {
					v: TREE_V,
					root: {
						type: "collection",
						id: "rows",
						items: [1, 2, 3, 4, 5].map((n) => ({
							id: `r${n}`,
							label: `row ${n}`,
							status: "open",
						})),
						display: "list",
						item: {
							title: { $: "./label" },
							status: { label: { $: "./status" } },
						},
					},
				},
			}),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const lines = chrome.panelLines().map(strip).join("\n");
		expect(lines).toContain("row 1");
		expect(lines).toContain("row 3");
		expect(lines).not.toContain("row 4");
		expect(lines).not.toContain("row 5");
		expect(lines).toContain("2 more");
		chrome.dispose();
	});

	test("render(width) clamps ANSI-bearing lines without cutting escape sequences", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("long", {
				place: "status",
				body: lineTree(
					"a rather long status line that will not fit in a narrow pane at all",
				),
			}),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const width = 24;
		const lines = chrome.render(width);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			// ANSI-aware clamp: the DISPLAY width never exceeds the pane
			// and no dangling escape introducer survives (a raw UTF-16
			// slice could cut mid-sequence).
			expect(strip(line).length).toBeLessThanOrEqual(width);
		}
		// The clamp used the given width, not the hardcoded 120.
		expect(strip(lines.join("\n"))).toContain("…");
		chrome.dispose();
	});

	test("a panel renders literal rows; a quiet row folds behind the count", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("todos", {
				place: "panel",
				body: rowsTree([
					{ id: "t1", label: "calm item", status: "open" },
					{ id: "t2", label: "urgent item", status: "open", detail: "on fire" },
					{ id: "t3", label: "quiet done", status: "done", quiet: true },
				]),
			}),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const lines = chrome.panelLines().map(strip).join("\n");
		expect(lines).toContain("urgent item");
		expect(lines).toContain("calm item");
		// Quiet rows fold behind the collection's quiet bucket.
		expect(lines).not.toContain("quiet done");
		expect(lines).toContain("1 more");
		chrome.dispose();
	});

	test("maxRows: 3 with 5 rows — drop folds the tail behind 'N more'", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("queue", {
				place: "panel",
				maxRows: 3,
				overflow: "drop",
				body: rowsTree(
					[1, 2, 3, 4, 5].map((n) => ({
						id: `r${n}`,
						label: `row ${n}`,
						status: "open",
					})),
				),
			}),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const lines = chrome.panelLines().map(strip).join("\n");
		expect(lines).toContain("row 1");
		expect(lines).toContain("row 3");
		expect(lines).not.toContain("row 4");
		expect(lines).not.toContain("row 5");
		expect(lines).toContain("2 more");
		chrome.dispose();
	});

	test("maxRows: 3 with 5 rows — summarize shows a count line", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("queue", {
				place: "panel",
				maxRows: 3,
				overflow: "summarize",
				body: rowsTree(
					[1, 2, 3, 4, 5].map((n) => ({
						id: `r${n}`,
						label: `row ${n}`,
						status: "open",
					})),
				),
			}),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const lines = chrome.panelLines().map(strip).join("\n");
		expect(lines).toContain("row 1");
		expect(lines).toContain("row 3");
		expect(lines).not.toContain("row 4");
		expect(lines).toContain("2 rows");
		chrome.dispose();
	});

	test("a meter-shaped panel renders its percent", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("run", {
				place: "panel",
				body: {
					v: TREE_V,
					root: { type: "meter", value: 0.4, format: "percent", label: "auditing" },
				},
			}),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const lines = chrome.panelLines().map(strip).join("\n");
		expect(lines).toContain("auditing");
		expect(lines).toContain("40%");
		chrome.dispose();
	});

	test("details render as one collapsed JSON line", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("feed", {
				place: "panel",
				body: lineTree("headline"),
				details: { custom: true },
			}),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const lines = chrome.panelLines().join("\n");
		expect(lines).toContain("[details]");
		expect(lines).toContain("custom");
		chrome.dispose();
	});

	test("W3: no timer cadence — ambient.changed host events refetch via kick()", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
		try {
			const stub = stubClient();
			stub.setSurfaces([
				ambient("clock", { place: "status", refreshMs: 500, body: lineTree("tick") }),
			]);
			const chrome = new AmbientChrome(stub.client);
			chrome.setConversation(1);
			await vi.advanceTimersByTimeAsync(0);
			expect(stub.ambientCalls()).toBe(1);
			// The retired cadence: advancing time fires NO fetches (not even
			// the declared refreshMs — the extension's writes carry the event).
			await vi.advanceTimersByTimeAsync(120_000);
			expect(stub.ambientCalls()).toBe(1);
			// The host-event path: an ambient.changed for the LIVE conversation
			// refetches; another conversation's event is ignored.
			chrome.kick(2);
			await vi.advanceTimersByTimeAsync(0);
			expect(stub.ambientCalls()).toBe(1);
			chrome.kick(1);
			await vi.advanceTimersByTimeAsync(0);
			expect(stub.ambientCalls()).toBe(2);
			chrome.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("a failed fetch keeps the last surfaces and the next kick recovers", async () => {
		const stub = stubClient();
		stub.setSurfaces([ambient("clock", { place: "status", body: lineTree("tick") })]);
		let failNext = false;
		let attempts = 0;
		const flaky = {
			...stub.client,
			getAmbient(id: number): Promise<AmbientList> {
				attempts += 1;
				if (failNext) {
					failNext = false;
					return Promise.reject(new Error("boom"));
				}
				return stub.client.getAmbient(id);
			},
		} as unknown as SigrunClient;
		const chrome = new AmbientChrome(flaky);
		chrome.setConversation(1);
		await flush();
		expect(attempts).toBe(1);
		// A kicked fetch fails quiet: the last surfaces stay.
		failNext = true;
		chrome.kick(1);
		await flush();
		expect(attempts).toBe(2);
		expect(chrome.statusline()).toContain("tick");
		// The next kick recovers (no cadence to kill — each event refetches).
		stub.setSurfaces([ambient("clock", { place: "status", body: lineTree("tock") })]);
		chrome.kick(1);
		await flush();
		expect(attempts).toBe(3);
		expect(chrome.statusline()).toContain("tock");
		chrome.dispose();
	});

	test("zero records: a surface that appears later lands via the ambient.changed kick", async () => {
		const stub = stubClient();
		// Zero records at connect…
		stub.setSurfaces([]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		expect(stub.ambientCalls()).toBe(1);
		expect(chrome.statusline()).toBe("");
		// …the extension writes a surface, which emits ambient.changed —
		// the kick picks it up (the retired fallback cadence's role).
		stub.setSurfaces([ambient("clock", { place: "status", body: lineTree("tick") })]);
		chrome.kick(1);
		await flush();
		expect(stub.ambientCalls()).toBe(2);
		expect(chrome.statusline()).toContain("tick");
		chrome.dispose();
	});

	test("expires: idle entries disappear when the conversation is idle", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("spinner", { place: "status", expires: "idle", body: lineTree("working…") }),
			ambient("goal", { place: "status", expires: "never", body: lineTree("the goal") }),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		// Fetched while idle: the idle-expiring record is hidden.
		expect(chrome.statusline()).not.toContain("working…");
		expect(chrome.statusline()).toContain("the goal");
		// A run starts: the idle-expiring record appears.
		chrome.setBusy(true);
		expect(chrome.statusline()).toContain("working…");
		// The run settles: it disappears again.
		chrome.setBusy(false);
		expect(chrome.statusline()).not.toContain("working…");
		expect(chrome.statusline()).toContain("the goal");
		chrome.dispose();
	});

	test("switching conversations swaps surfaces (no cross-conversation bleed)", async () => {
		const stub = stubClient();
		const byConversation = new Map<number, AmbientWire[]>([
			[1, [ambient("one", { place: "status", body: lineTree("conv one status") })]],
			[2, [ambient("two", { place: "status", body: lineTree("conv two status") })]],
		]);
		const client = {
			...stub.client,
			getAmbient(id: number): Promise<AmbientList> {
				return Promise.resolve({ ambient: [...(byConversation.get(id) ?? [])] });
			},
		} as unknown as SigrunClient;
		const chrome = new AmbientChrome(client);
		chrome.setConversation(1);
		await flush();
		expect(chrome.statusline()).toContain("conv one status");
		chrome.setConversation(2);
		await flush();
		expect(chrome.statusline()).toContain("conv two status");
		expect(chrome.statusline()).not.toContain("conv one status");
		chrome.dispose();
	});

	test("a stale fetch response never lands after a conversation switch", async () => {
		const stub = stubClient();
		let resolveFirst: ((list: AmbientList) => void) | undefined;
		let calls = 0;
		const slow = {
			...stub.client,
			getAmbient(_id: number): Promise<AmbientList> {
				calls += 1;
				if (calls === 1) {
					return new Promise((resolve) => {
						resolveFirst = resolve;
					});
				}
				return Promise.resolve({
					ambient: [ambient("two", { place: "status", body: lineTree("fresh status") })],
				});
			},
		} as unknown as SigrunClient;
		const chrome = new AmbientChrome(slow);
		chrome.setConversation(1);
		chrome.setConversation(2);
		await flush();
		expect(chrome.statusline()).toContain("fresh status");
		resolveFirst?.({
			ambient: [ambient("one", { place: "status", body: lineTree("stale status") })],
		});
		await flush();
		expect(chrome.statusline()).toContain("fresh status");
		expect(chrome.statusline()).not.toContain("stale status");
		chrome.dispose();
	});
});

// ─── App integration ────────────────────────────────────────────────────

describe("TuiApp ambient chrome", () => {
	test("boot fetches ambient surfaces and renders them in the app's chrome", async () => {
		const stub = stubClient();
		stub.setSurfaces([ambient("goal", { place: "status", body: lineTree("ship the tui") })]);
		const app = new TuiApp(stub.client, {
			tui: fakeTui,
			watch: stubWatch(stub.watchRegistry, stub.watchCalls),
		});
		await app.refresh();
		await flush();
		expect(stub.ambientCalls()).toBe(1);
		expect(app.render(80).join("\n")).toContain("ship the tui");
		app.dispose();
	});

	test("a busy→idle frame transition drops idle-expiring surfaces from the render", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("spinner", { place: "status", expires: "idle", body: lineTree("crunching") }),
		]);
		const app = new TuiApp(stub.client, {
			tui: fakeTui,
			watch: stubWatch(stub.watchRegistry, stub.watchCalls),
		});
		await app.refresh();
		await flush();
		expect(app.render(80).join("\n")).not.toContain("crunching");
		// A busy frame makes the idle-expiring surface visible.
		stub.watchRegistry.get(1)?.onSnapshot?.(view(1, [], true));
		expect(app.render(80).join("\n")).toContain("crunching");
		// The settled frame hides it again.
		stub.watchRegistry.get(1)?.onView?.(view(1, [], false));
		expect(app.render(80).join("\n")).not.toContain("crunching");
		app.dispose();
	});

	test("switching conversations re-fetches ambient for the new conversation", async () => {
		const stub = stubClient();
		const app = new TuiApp(stub.client, {
			tui: fakeTui,
			watch: stubWatch(stub.watchRegistry, stub.watchCalls),
		});
		await app.refresh();
		await flush();
		const before = stub.ambientCalls();
		await app.selectConversation(2);
		await flush();
		expect(stub.ambientCalls()).toBeGreaterThan(before);
		app.dispose();
	});
});
