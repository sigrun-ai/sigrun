/**
 * The ambient seam's TUI renderer (Task 8 — the parity rule): ambient
 * surfaces placed in the TUI's chrome per the seam's `place` field. The
 * builder's mapping (spec §8 leaves it to the builder):
 *
 * - `place: "status"` → the statusline (the row directly above the
 *   composer; multiple status records join with " · ").
 * - `place: "footer"` → the footer zone (one summary line per record,
 *   above the statusline).
 * - `place: "panel"` → the panel zone (full rendering: line, rows with
 *   severity order + quiet fold, gauge, ledger — the webui's AmbientPanel
 *   mirrored in text).
 *
 * Records are generic — the chrome never knows what a "todo" or a "goal"
 * is. Refetches arrive on conversation connect and on `ambient.changed`
 * host events via `kick(conversationId)` (W3 Task 4 — the refreshMs
 * timer cadence is retired; a record's `refreshMs` no longer drives a
 * client poll). `expires: "idle"` entries are
 * visible only while a run is live and disappear when the conversation
 * goes idle.
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

/** One ambient record (envelope + closed-primitive body). */
function ambient(
	key: string,
	init?: {
		owner?: string;
		place?: "status" | "footer" | "panel";
		refreshMs?: number;
		expires?: "never" | "idle";
		line?: { text?: string; segments?: readonly { id: string; text: string; place?: "left" | "middle" | "right" }[] };
		rows?: readonly { id: string; label: string; status?: string; severity?: 0 | 1 | 2; quiet?: boolean; detail?: string; depth?: number; deps?: readonly string[]; metrics?: { tokens?: number; cost?: number; current?: number; total?: number; completed?: number; format?: "compact" | "usd" | "percent" } }[];
		gauge?: { label: string; percent?: number; phase?: string; elapsedMs?: number; recentOutput?: readonly string[] };
		ledger?: readonly { id: string; at: number; kind: string; summary: string; detail?: readonly string[] }[];
		details?: Record<string, unknown>;
	},
): AmbientWire {
	const body: Record<string, unknown> = {
		...(init?.line === undefined ? {} : { line: init.line }),
		...(init?.rows === undefined ? {} : { rows: [...init.rows] }),
		...(init?.gauge === undefined ? {} : { gauge: init.gauge }),
		...(init?.ledger === undefined ? {} : { ledger: [...init.ledger] }),
	};
	return {
		key,
		owner: init?.owner ?? "acme-ext",
		place: init?.place ?? "status",
		expires: init?.expires ?? "never",
		...(init?.refreshMs === undefined ? {} : { refreshMs: init.refreshMs }),
		updatedAt: 1,
		body,
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

// ─── AmbientChrome (unit) ───────────────────────────────────────────────

describe("AmbientChrome", () => {
	test("a status record renders in the statusline", async () => {
		const stub = stubClient();
		stub.setSurfaces([ambient("goal", { place: "status", line: { text: "building the thing" } })]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		expect(chrome.statusline()).toContain("building the thing");
		expect(chrome.footerLines()).toEqual([]);
		expect(chrome.panelLines()).toEqual([]);
		chrome.dispose();
	});

	test("a footer record renders in the footer zone, not the statusline", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("usage", { place: "footer", line: { text: "tok 2.5k" } }),
			ambient("goal", { place: "status", line: { text: "on track" } }),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		expect(chrome.footerLines().join("\n")).toContain("tok 2.5k");
		expect(chrome.statusline()).toContain("on track");
		expect(chrome.statusline()).not.toContain("tok 2.5k");
		chrome.dispose();
	});

	test("multiple status records join onto one statusline", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("a", { place: "status", line: { text: "left" } }),
			ambient("b", { place: "status", line: { text: "right" } }),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const line = chrome.statusline();
		expect(line).toContain("left");
		expect(line).toContain("right");
		chrome.dispose();
	});

	test("a segmented line renders its segment texts in order", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("power", {
				place: "status",
				line: {
					segments: [
						{ id: "s1", text: "one", place: "left" },
						{ id: "s2", text: "two", place: "right" },
					],
				},
			}),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const line = chrome.statusline();
		expect(line).toContain("one");
		expect(line).toContain("two");
		expect(line.indexOf("one")).toBeLessThan(line.indexOf("two"));
		chrome.dispose();
	});

	test("panel rows render severity-sorted with quiet rows folded", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("todos", {
				place: "panel",
				rows: [
					{ id: "t3", label: "quiet done", status: "done", severity: 2, quiet: true },
					{ id: "t1", label: "calm item", severity: 2 },
					{ id: "t2", label: "urgent item", severity: 0, detail: "on fire" },
				],
			}),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const lines = chrome.panelLines().join("\n");
		expect(lines).toContain("urgent item");
		expect(lines).toContain("on fire");
		expect(lines).toContain("calm item");
		// Severity 0 sorts above severity 2.
		expect(lines.indexOf("urgent item")).toBeLessThan(lines.indexOf("calm item"));
		// Quiet rows fold into a summary.
		expect(lines).not.toContain("quiet done");
		expect(lines).toContain("+1 quiet");
		chrome.dispose();
	});

	test("row metrics format via the record's hint (compact / usd)", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("meter", {
				place: "panel",
				rows: [
					{ id: "r1", label: "usage", metrics: { tokens: 2500, cost: 0.0123, format: "compact" } },
					{ id: "r2", label: "progress", metrics: { completed: 3, total: 7 } },
				],
			}),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const lines = chrome.panelLines().join("\n");
		expect(lines).toContain("tok 2.5k");
		expect(lines).toContain("$0.0123");
		expect(lines).toContain("3/7");
		chrome.dispose();
	});

	test("a gauge renders label, percent bar, and phase", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("run", {
				place: "panel",
				gauge: { label: "auditing", percent: 40, phase: "checks" },
			}),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const lines = chrome.panelLines().join("\n");
		expect(lines).toContain("auditing");
		expect(lines).toContain("checks");
		expect(lines).toContain("40%");
		chrome.dispose();
	});

	test("a ledger renders newest-first", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("feed", {
				place: "panel",
				ledger: [
					{ id: "e1", at: 1, kind: "note", summary: "oldest" },
					{ id: "e2", at: 2, kind: "note", summary: "newest" },
				],
			}),
		]);
		const chrome = new AmbientChrome(stub.client);
		chrome.setConversation(1);
		await flush();
		const lines = chrome.panelLines().join("\n");
		expect(lines.indexOf("newest")).toBeLessThan(lines.indexOf("oldest"));
		chrome.dispose();
	});

	test("W3: no timer cadence — ambient.changed host events refetch via kick()", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
		try {
			const stub = stubClient();
			stub.setSurfaces([ambient("clock", { place: "status", refreshMs: 500, line: { text: "tick" } })]);
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
		stub.setSurfaces([ambient("clock", { place: "status", line: { text: "tick" } })]);
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
		stub.setSurfaces([ambient("clock", { place: "status", line: { text: "tock" } })]);
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
		stub.setSurfaces([ambient("clock", { place: "status", line: { text: "tick" } })]);
		chrome.kick(1);
		await flush();
		expect(stub.ambientCalls()).toBe(2);
		expect(chrome.statusline()).toContain("tick");
		chrome.dispose();
	});

	test("expires: idle entries disappear when the conversation is idle", async () => {
		const stub = stubClient();
		stub.setSurfaces([
			ambient("spinner", { place: "status", expires: "idle", line: { text: "working…" } }),
			ambient("goal", { place: "status", expires: "never", line: { text: "the goal" } }),
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
			[1, [ambient("one", { place: "status", line: { text: "conv one status" } })]],
			[2, [ambient("two", { place: "status", line: { text: "conv two status" } })]],
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
					ambient: [ambient("two", { place: "status", line: { text: "fresh status" } })],
				});
			},
		} as unknown as SigrunClient;
		const chrome = new AmbientChrome(slow);
		chrome.setConversation(1);
		chrome.setConversation(2);
		await flush();
		expect(chrome.statusline()).toContain("fresh status");
		resolveFirst?.({
			ambient: [ambient("one", { place: "status", line: { text: "stale status" } })],
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
		stub.setSurfaces([ambient("goal", { place: "status", line: { text: "ship the tui" } })]);
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
			ambient("spinner", { place: "status", expires: "idle", line: { text: "crunching" } }),
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
