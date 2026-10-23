/**
 * SurfaceState (UI-blocks U2 Task 4, spec §6.3): the confirmed-data plus
 * optimistic-overlay model, ported from U1's useSurface.ts with EXACTLY
 * the same overlay rules:
 *
 * - accept with ops → apply the ops to confirmed, drop the entry;
 * - accept without ops → hold the entry (untilRev) until a fetch lands
 *   at ≥ that rev (no snap-back flicker);
 * - reject or the 10 s timeout → drop the entry and a notice line
 *   (U1 toasts; the TUI's notice is the status-bar flash, wired at the
 *   app seam — SurfaceState exposes `notices` and `consumeNotices`);
 * - a rev gap or a DataOpError → a full refetch;
 * - `access: "none"` → the not-found state;
 * - a treeRev change → a full reload.
 */

import { describe, expect, test, vi } from "vitest";
import type {
	Action,
	DataOp,
	JsonObject,
	JsonValue,
	SurfaceActResult,
	SurfaceChangedEvent,
	SurfaceFetch,
	SurfaceLoad,
	SurfaceTransport,
} from "@sigrun/shared/blocks";
import { ACT_TIMEOUT_MS, SurfaceState } from "../src/blocks/surface.js";

/** The tree: one collection `lanes` block whose onMove is "move-task". */
const TREE: SurfaceLoad["tree"] = {
	v: 1,
	root: {
		type: "collection",
		id: "board",
		items: { $: "/items" },
		display: "lanes",
		groupBy: "status",
		groups: [
			{ id: "todo", title: "To do" },
			{ id: "doing", title: "Doing" },
			{ id: "done", title: "Done" },
		],
		item: { title: { $: "./title" } },
		onMove: "move-task",
	},
};

const ITEMS: JsonValue = [
	{ id: "t-1", title: "Write spec", status: "todo" },
	{ id: "t-2", title: "Build board", status: "doing" },
	{ id: "t-3", title: "Ship it", status: "todo" },
];

interface FakeSurface {
	transport: SurfaceTransport;
	acts: { action: string; payload: JsonValue; actionId: string }[];
	/** Queue or resolve act results explicitly. */
	answer(result: SurfaceActResult): void;
	answerLater(): void;
	emitChanged(rev: number, treeRev?: number): void;
	fetchQueue: (SurfaceFetch | Error)[];
	loadResult: SurfaceLoad;
	changedCount(): number;
}

function fakeSurface(init?: {
	access?: "none" | "read" | "write";
	data?: JsonObject;
	rev?: number;
	treeRev?: number;
}): FakeSurface {
	const loadResult: SurfaceLoad = {
		tree: TREE,
		data: init?.data ?? { items: ITEMS },
		rev: init?.rev ?? 1,
		treeRev: init?.treeRev ?? 1,
		access: init?.access ?? "write",
	};
	const acts: FakeSurface["acts"] = [];
	const pending: { resolve: (result: SurfaceActResult) => void }[] = [];
	const queued: SurfaceActResult[] = [];
	const fetchQueue: (SurfaceFetch | Error)[] = [];
	const changedListeners: ((e: SurfaceChangedEvent) => void)[] = [];
	const current: { loadResult: SurfaceLoad } = { loadResult };
	const transport: SurfaceTransport = {
		load: () => Promise.resolve(current.loadResult),
		fetchData: () => {
			const next = fetchQueue.shift();
			if (next === undefined) {
				return Promise.reject(new Error("no fetch queued"));
			}
			if (next instanceof Error) return Promise.reject(next);
			return Promise.resolve(next);
		},
		act: (body) => {
			acts.push(body);
			const result = queued.shift();
			if (result !== undefined) return Promise.resolve(result);
			return new Promise((resolve) => pending.push({ resolve }));
		},
		upload: () => Promise.resolve({ ok: true, rev: 0 }),
		image: () => Promise.resolve(new Uint8Array()),
		onChanged: (listener) => {
			changedListeners.push(listener);
			return () => {
				const at = changedListeners.indexOf(listener);
				if (at >= 0) changedListeners.splice(at, 1);
			};
		},
	};
	return {
		transport,
		acts,
		fetchQueue,
		get loadResult() {
			return current.loadResult;
		},
		set loadResult(next: SurfaceLoad) {
			current.loadResult = next;
		},
		answer(result) {
			const first = pending.shift();
			if (first !== undefined) {
				first.resolve(result);
			} else {
				queued.push(result);
			}
		},
		answerLater() {
			queued.push({ ok: true, rev: 2 });
		},
		emitChanged(rev, treeRev = 1) {
			for (const listener of [...changedListeners]) {
				listener({ rev, treeRev });
			}
		},
		changedCount: () => changedListeners.length,
	};
}

/** Flush the microtask queue (transport promises resolve on it). */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

const MOVE: Action = { type: "move", name: "move-task" };
const MOVE_PAYLOAD: JsonValue = {
	itemId: "t-1",
	from: { group: "todo", index: 0 },
	to: { group: "doing", index: 1 },
};

describe("SurfaceState — load and access (§6.5)", () => {
	test("load leaves the surface ready with confirmed data", async () => {
		const surface = fakeSurface();
		const state = new SurfaceState(surface.transport);
		expect(state.view.status).toBe("loading");
		await state.load();
		expect(state.view.status).toBe("ready");
		expect(state.view.rev).toBe(1);
		const items = (state.view.data as JsonObject).items as JsonValue[];
		expect(items).toHaveLength(3);
	});

	test("access none → the not-found state", async () => {
		const surface = fakeSurface({ access: "none" });
		const state = new SurfaceState(surface.transport);
		await state.load();
		expect(state.view.status).toBe("notFound");
		expect(state.view.access).toBe("none");
	});

	test("a load failure leaves the error state", async () => {
		const surface = fakeSurface();
		surface.transport.load = () => Promise.reject(new Error("boom"));
		const state = new SurfaceState(surface.transport);
		await state.load();
		expect(state.view.status).toBe("error");
	});
});

describe("SurfaceState — the optimistic overlay (§6.3)", () => {
	test("a move renders in the overlay at once (before the answer)", async () => {
		const surface = fakeSurface();
		const state = new SurfaceState(surface.transport);
		await state.load();
		state.dispatch(MOVE, MOVE_PAYLOAD);
		// Overlay applied: t-1 now in doing, at index 1 (after t-2).
		const items = (state.view.data as JsonObject).items as JsonObject[];
		const doing = items.filter((item) => item.status === "doing");
		expect(doing.map((item) => item.id)).toEqual(["t-2", "t-1"]);
		expect(surface.acts).toHaveLength(1);
		expect(surface.acts[0]?.action).toBe("move-task");
		expect(surface.acts[0]?.payload).toEqual(MOVE_PAYLOAD);
	});

	test("accept WITH ops applies them to confirmed and drops the entry", async () => {
		const surface = fakeSurface();
		const state = new SurfaceState(surface.transport);
		await state.load();
		state.dispatch(MOVE, MOVE_PAYLOAD);
		const ops: DataOp[] = [{ op: "set", path: "/items/0/status", value: "doing" }];
		surface.answer({ ok: true, rev: 2, ops });
		await flush();
		expect(state.view.rev).toBe(2);
		// The overlay is dropped; confirmed carries the ops (item stays in
		// array position — ops are the server's word).
		const items = (state.view.data as JsonObject).items as JsonObject[];
		expect(items.find((item) => item.id === "t-1")?.status).toBe("doing");
		expect(items.map((item) => item.id)).toEqual(["t-1", "t-2", "t-3"]);
	});

	test("accept WITHOUT ops holds the entry until a fetch reaches the rev", async () => {
		const surface = fakeSurface();
		const state = new SurfaceState(surface.transport);
		await state.load();
		state.dispatch(MOVE, MOVE_PAYLOAD);
		surface.answer({ ok: true, rev: 2 });
		await flush();
		// The entry is held: the item stays where the user dropped it
		// even though confirmed data is untouched.
		let items = (state.view.data as JsonObject).items as JsonObject[];
		expect(items.filter((i) => i.status === "doing").map((i) => i.id)).toEqual([
			"t-2",
			"t-1",
		]);
		// A fetch below the accepted rev does NOT drop the entry.
		surface.fetchQueue.push({ rev: 1, treeRev: 1, data: { items: ITEMS } });
		surface.emitChanged(1);
		await flush();
		items = (state.view.data as JsonObject).items as JsonObject[];
		expect(items.filter((i) => i.status === "doing").map((i) => i.id)).toEqual([
			"t-2",
			"t-1",
		]);
		// A fetch at the accepted rev drops it (data now server-true).
		const moved: JsonValue = [
			{ id: "t-3", title: "Ship it", status: "todo" },
			{ id: "t-2", title: "Build board", status: "doing" },
			{ id: "t-1", title: "Write spec", status: "doing" },
		];
		surface.fetchQueue.push({ rev: 2, treeRev: 1, data: { items: moved } });
		surface.emitChanged(2);
		await flush();
		items = (state.view.data as JsonObject).items as JsonObject[];
		expect(items.map((i) => i.id)).toEqual(["t-3", "t-2", "t-1"]);
	});

	test("reject drops the entry (snap back) and surfaces a notice", async () => {
		const surface = fakeSurface();
		const state = new SurfaceState(surface.transport);
		await state.load();
		state.dispatch(MOVE, MOVE_PAYLOAD);
		surface.answer({ ok: false, error: { message: "cannot move a locked card" } });
		await flush();
		const items = (state.view.data as JsonObject).items as JsonObject[];
		expect(items.find((i) => i.id === "t-1")?.status).toBe("todo");
		expect(state.view.notices.join("\n")).toContain("cannot move a locked card");
	});

	test("the 10 s timeout drops the entry and surfaces a notice", async () => {
		vi.useFakeTimers();
		try {
			const surface = fakeSurface();
			const state = new SurfaceState(surface.transport);
			await state.load();
			state.dispatch(MOVE, MOVE_PAYLOAD);
			await vi.advanceTimersByTimeAsync(ACT_TIMEOUT_MS);
			const items = (state.view.data as JsonObject).items as JsonObject[];
			expect(items.find((i) => i.id === "t-1")?.status).toBe("todo");
			expect(state.view.notices.join("\n")).toContain("timed out");
			// A LATE accept is stale: no ops, no extra notice.
			surface.answer({ ok: true, rev: 2 });
			await vi.advanceTimersByTimeAsync(0);
			expect(state.view.rev).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a rev gap (fetch lands behind the announced rev) triggers a full refetch", async () => {
		const surface = fakeSurface();
		const state = new SurfaceState(surface.transport);
		await state.load();
		// The event announces rev 5; the fetch returns ops at rev 4 — a gap.
		surface.fetchQueue.push({ rev: 4, treeRev: 1, ops: [] });
		// The full refetch follows.
		surface.fetchQueue.push({ rev: 5, treeRev: 1, data: { items: ITEMS } });
		surface.emitChanged(5);
		await flush();
		expect(state.view.rev).toBe(5);
	});

	test("a DataOpError applying ops triggers a full refetch", async () => {
		const surface = fakeSurface();
		const state = new SurfaceState(surface.transport);
		await state.load();
		// The ops path does not exist → DataOpError inside applyOps.
		surface.fetchQueue.push({
			rev: 2,
			treeRev: 1,
			ops: [{ op: "set", path: "/nope/deep", value: 1 }],
		});
		// The refetch succeeds and replaces confirmed data.
		surface.fetchQueue.push({ rev: 2, treeRev: 1, data: { items: ITEMS } });
		surface.emitChanged(2);
		await flush();
		expect(state.view.rev).toBe(2);
		expect(state.view.status).toBe("ready");
	});

	test("a treeRev change on a change event reloads the whole surface", async () => {
		const surface = fakeSurface();
		const state = new SurfaceState(surface.transport);
		await state.load();
		expect(state.view.treeRev).toBe(1);
		// The reload's load() carries treeRev 2.
		surface.loadResult = { ...surface.loadResult, treeRev: 2, rev: 7 };
		surface.emitChanged(2, 2);
		await flush();
		expect(state.view.treeRev).toBe(2);
		expect(state.view.rev).toBe(7);
	});

	test("onChange fires on load, dispatch and settle", async () => {
		const surface = fakeSurface();
		const state = new SurfaceState(surface.transport);
		let changes = 0;
		state.onChange(() => {
			changes += 1;
		});
		await state.load();
		expect(changes).toBeGreaterThan(0);
		const before = changes;
		state.dispatch(MOVE, MOVE_PAYLOAD);
		expect(changes).toBeGreaterThan(before);
		surface.answer({ ok: true, rev: 2, ops: [] });
		await flush();
		expect(changes).toBeGreaterThan(before + 1);
	});

	test("a non-move action dispatches without an overlay entry", async () => {
		const surface = fakeSurface();
		const state = new SurfaceState(surface.transport);
		await state.load();
		state.dispatch({ type: "submit", name: "archive-all" }, { ids: ["t-1"] });
		expect(surface.acts[0]?.action).toBe("archive-all");
		surface.answer({ ok: true, rev: 2, toast: "Archived 1 card" });
		await flush();
		expect(state.view.notices.join("\n")).toContain("Archived 1 card");
	});

	test("consumeNotices drains the notice list", async () => {
		const surface = fakeSurface();
		const state = new SurfaceState(surface.transport);
		await state.load();
		state.dispatch(MOVE, MOVE_PAYLOAD);
		surface.answer({ ok: false, error: { message: "nope" } });
		await flush();
		const drained = state.consumeNotices();
		expect(drained.length).toBeGreaterThan(0);
		expect(state.view.notices).toHaveLength(0);
	});

	test("the notice list caps at 50, dropping oldest first", async () => {
		const surface = fakeSurface();
		const state = new SurfaceState(surface.transport);
		await state.load();
		for (let i = 0; i < 55; i++) {
			state.dispatch(MOVE, { itemId: `t-x${i}`, from: { group: "todo", index: 0 }, to: { group: "doing", index: 0 } });
			surface.answer({ ok: false, error: { message: `reject-${i}` } });
		}
		await flush();
		expect(state.view.notices).toHaveLength(50);
		expect(state.view.notices[0]).toBe("reject-5");
		expect(state.view.notices[49]).toBe("reject-54");
	});
});
