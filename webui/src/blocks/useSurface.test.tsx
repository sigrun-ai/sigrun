/**
 * useSurface tests (UI-blocks U1 Task 4, spec §6.3): the confirmed-data
 * plus optimistic-overlay model — every review-focus case and every
 * accept/reject/timeout shape, driven through a fake transport with
 * controllable promises and fake timers for the 10 s deadline.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h } from "react";
import TestRenderer from "react-test-renderer";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
	DataOp,
	JsonObject,
	JsonValue,
	SurfaceActResult,
	SurfaceFetch,
	SurfaceLoad,
	SurfaceTransport,
	Tree,
} from "@sigrun/shared/blocks";
import { applyOps } from "@sigrun/shared/blocks";
import { useSurface, type SurfaceState } from "./useSurface";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** A one-collection surface tree: the lanes board the overlay scans. */
const TREE: Tree = {
	v: 1,
	root: {
		type: "collection",
		id: "board",
		items: { $: "/tasks" },
		item: { title: { $: "./title" } },
		display: "lanes",
		groupBy: "state",
		groups: [
			{ id: "todo", title: "To do" },
			{ id: "doing", title: "Doing" },
			{ id: "done", title: "Done" },
		],
		onMove: "onMove",
	},
};

/** A board-shaped data document: tasks grouped by `state`. */
function board(tasks: readonly JsonObject[]): JsonObject {
	return { tasks: [...tasks] };
}

function task(id: string, state: string, extra?: JsonObject): JsonObject {
	return { id, state, title: `Task ${id}`, ...extra };
}

/** A fake transport with controllable promises. */
class FakeTransport implements SurfaceTransport {
	loadResult: SurfaceLoad = {
		tree: TREE,
		data: board([]),
		rev: 1,
		treeRev: 1,
		access: "write",
	};
	loadCalls = 0;
	fetchCalls: (number | undefined)[] = [];
	actCalls: { action: string; payload: JsonValue; actionId: string }[] = [];
	changedListeners: ((e: { rev: number; treeRev: number }) => void)[] = [];

	private actWaiters: {
		resolve(result: SurfaceActResult): void;
	}[] = [];
	private fetchWaiters: {
		since: number | undefined;
		resolve(result: SurfaceFetch): void;
	}[] = [];

	load(): Promise<SurfaceLoad> {
		this.loadCalls += 1;
		return Promise.resolve(this.loadResult);
	}

	fetchData(since?: number): Promise<SurfaceFetch> {
		this.fetchCalls.push(since);
		return new Promise<SurfaceFetch>((resolve) => {
			this.fetchWaiters.push({ since, resolve });
		});
	}

	act(body: {
		action: string;
		payload: JsonValue;
		actionId: string;
	}): Promise<SurfaceActResult> {
		this.actCalls.push(body);
		return new Promise<SurfaceActResult>((resolve) => {
			this.actWaiters.push({ resolve });
		});
	}

	upload(): Promise<SurfaceActResult> {
		throw new Error("not used");
	}

	image(): Promise<Uint8Array> {
		throw new Error("not used");
	}

	onChanged(
		listener: (e: { rev: number; treeRev: number }) => void,
	): () => void {
		this.changedListeners.push(listener);
		return () => {
			this.changedListeners = this.changedListeners.filter(
				(existing) => existing !== listener,
			);
		};
	}

	/** Resolve the oldest pending act. */
	resolveAct(result: SurfaceActResult): void {
		const waiter = this.actWaiters.shift();
		if (waiter === undefined) throw new Error("no pending act");
		waiter.resolve(result);
	}

	/** Resolve the oldest pending fetch. */
	resolveFetch(result: SurfaceFetch): void {
		const waiter = this.fetchWaiters.shift();
		if (waiter === undefined) throw new Error("no pending fetch");
		waiter.resolve(result);
	}

	pendingActs(): number {
		return this.actWaiters.length;
	}

	emitChanged(rev: number, treeRev: number): void {
		for (const listener of this.changedListeners) {
			listener({ rev, treeRev });
		}
	}
}

/** A position in a move payload (group/index or time start/end). */
type MoveSpot = {
	readonly group?: string;
	readonly index?: number;
	readonly start?: string;
	readonly end?: string;
} & JsonObject;

/** A move payload (spec §6.3 step 2). */
type MovePayload = {
	readonly itemId: string;
	readonly from?: MoveSpot;
	readonly to: MoveSpot;
} & JsonObject;

/** Mount the hook in a probe component exposing the latest state. */
function mount(transport: SurfaceTransport): {
	latest(): SurfaceState;
	renderer: TestRenderer.ReactTestRenderer;
} {
	let latest: SurfaceState | undefined;
	function Probe(): null {
		latest = useSurface(transport);
		return null;
	}
	let renderer: TestRenderer.ReactTestRenderer | undefined;
	act(() => {
		renderer = TestRenderer.create(h(Probe));
	});
	if (renderer === undefined) throw new Error("no renderer");
	return {
		latest: () => {
			if (latest === undefined) throw new Error("no state");
			return latest;
		},
		renderer,
	};
}

/** Wait for the initial load to land. */
async function settleLoad(): Promise<void> {
	await act(async () => {});
}

const MOVE = { type: "move", name: "onMove" } as const;

function movePayload(itemId: string, from: MoveSpot, to: MoveSpot): MovePayload {
	return { itemId, from, to };
}

/** Render the task ids in lane order for the current (possibly
 *  overlay-applied) data. */
function laneStates(data: JsonObject, state: string): string[] {
	const tasks = data.tasks as JsonObject[];
	return tasks
		.filter((t) => t.state === state)
		.map((t) => t.id as string);
}

/** Apply one move the way the overlay must (the test derives the
 *  expected document itself so assertions stay independent of the
 *  implementation's op construction). */
function applyMove(data: JsonObject, payload: MovePayload): JsonObject {
	const to = payload.to;
	if (to.group === undefined || to.index === undefined) return data;
	const tasks = [...(data.tasks as JsonObject[])];
	const fromIndex = tasks.findIndex((t) => t.id === payload.itemId);
	const [item] = tasks.splice(fromIndex, 1);
	const moved: JsonObject = { ...item, state: to.group };
	const lanePositions = tasks
		.map((t, index) => ({ t, index }))
		.filter((entry) => entry.t.state === to.group);
	const at =
		to.index < lanePositions.length
			? lanePositions[to.index]?.index ?? tasks.length
			: tasks.length;
	tasks.splice(at, 0, moved);
	return { tasks };
}

describe("useSurface (spec §6.3)", () => {
	test("loads: status ready with tree, view, access", async () => {
		const transport = new FakeTransport();
		transport.loadResult.data = board([task("a", "todo")]);
		const { latest } = mount(transport);
		expect(latest().status).toBe("loading");
		await settleLoad();
		expect(latest().status).toBe("ready");
		expect(latest().tree).toBe(TREE);
		expect(latest().view).toEqual({ tasks: [task("a", "todo")] });
		expect(latest().access).toBe("write");
	});

	test("setView writes the /view/ branch; the returned view carries it (spec §6.2)", async () => {
		const transport = new FakeTransport();
		transport.loadResult.data = board([task("a", "todo")]);
		const { latest } = mount(transport);
		await settleLoad();
		// No view state yet: the view is exactly the confirmed data.
		expect(latest().view).toEqual({ tasks: [task("a", "todo")] });
		act(() => {
			latest().setView("filters", { q: "acme" });
		});
		expect(latest().view).toEqual({
			tasks: [task("a", "todo")],
			view: { filters: { q: "acme" } },
		});
		// A nested write merges (sibling keys survive).
		act(() => {
			latest().setView("filters", { q: "acme", sort: "due" });
		});
		expect((latest().view as { view: { filters: JsonObject } }).view.filters).toEqual({
			q: "acme",
			sort: "due",
		});
		// No dispatch to the server — view-only.
		expect(transport.actCalls).toEqual([]);
	});

	test('access "none" -> status notFound', async () => {
		const transport = new FakeTransport();
		transport.loadResult.access = "none";
		const { latest } = mount(transport);
		await settleLoad();
		expect(latest().status).toBe("notFound");
	});

	test("load failure -> status error; retry() loads again", async () => {
		class Failing extends FakeTransport {
			override load(): Promise<SurfaceLoad> {
						return Promise.reject(new Error("boom"));
			}
		}
		const failing = new Failing();
		const { latest } = mount(failing);
		await settleLoad();
		expect(latest().status).toBe("error");
		const working = new FakeTransport();
		working.loadResult.data = board([task("a", "todo")]);
		failing.load = () => working.load();
		await act(async () => {
			latest().retry();
		});
		expect(latest().status).toBe("ready");
		expect(latest().view).toEqual({ tasks: [task("a", "todo")] });
	});

	test("onChanged with the same treeRev fetches data since rev", async () => {
		const transport = new FakeTransport();
		transport.loadResult.data = board([task("a", "todo")]);
		const { latest } = mount(transport);
		await settleLoad();
		act(() => transport.emitChanged(2, 1));
		expect(transport.fetchCalls).toEqual([1]);
		const ops: DataOp[] = [
			{ op: "set", path: "/tasks/0/title", value: "Renamed" },
		];
		await act(async () => {
			transport.resolveFetch({ rev: 2, treeRev: 1, ops });
		});
		expect(latest().view).toEqual(
			board([{ ...task("a", "todo"), title: "Renamed" }]),
		);
	});

	test("accept WITHOUT ops keeps the item placed until a fetch at >= untilRev drops the entry — no intermediate old-spot render", async () => {
		const transport = new FakeTransport();
		transport.loadResult.data = board([task("a", "todo"), task("b", "doing")]);
		const { latest } = mount(transport);
		await settleLoad();
		act(() => {
			latest().dispatch(
				MOVE,
				movePayload("a", { group: "todo", index: 0 }, { group: "doing", index: 1 }),
			);
		});
		expect(laneStates(latest().view as JsonObject, "doing")).toEqual(["b", "a"]);
		await act(async () => {
			transport.resolveAct({ ok: true, rev: 2 });
		});
		// Entry retained with untilRev=2: confirmed is still rev 1, so the
		// overlay must still place "a" in doing.
		expect(laneStates(latest().view as JsonObject, "doing")).toEqual(["b", "a"]);
		const moved = applyMove(
			board([task("a", "todo"), task("b", "doing")]),
			movePayload("a", { group: "todo", index: 0 }, { group: "doing", index: 1 }),
		);
		act(() => transport.emitChanged(2, 1));
		await act(async () => {
			transport.resolveFetch({ rev: 2, treeRev: 1, data: moved });
		});
		// Entry dropped; the view is exactly the fetched data (no flicker:
		// confirmed rev 2 carries the move already).
		expect(latest().view).toEqual(moved);
		// A later fetch must not resurrect the dropped entry.
		act(() => transport.emitChanged(3, 1));
		await act(async () => {
			transport.resolveFetch({ rev: 3, treeRev: 1, data: moved });
		});
		expect(latest().view).toEqual(moved);
	});

	test("treeRev change triggers a full load()", async () => {
		const transport = new FakeTransport();
		const { latest } = mount(transport);
		await settleLoad();
		expect(transport.loadCalls).toBe(1);
		act(() => transport.emitChanged(2, 2));
		await act(async () => {});
		expect(transport.loadCalls).toBe(2);
		expect(transport.fetchCalls).toEqual([]);
		expect(latest().status).toBe("ready");
	});

	test("accept WITH ops applies ops to confirmed and drops the overlay entry", async () => {
		const transport = new FakeTransport();
		transport.loadResult.data = board([task("a", "todo"), task("b", "doing")]);
		const { latest } = mount(transport);
		await settleLoad();
		act(() => {
			latest().dispatch(
				MOVE,
				movePayload("a", { group: "todo", index: 0 }, { group: "doing", index: 1 }),
			);
		});
		expect(laneStates(latest().view as JsonObject, "doing")).toEqual(["b", "a"]);
		const ops: DataOp[] = [
			{ op: "set", path: "/tasks/0/state", value: "doing" },
			{ op: "move", from: "/tasks/0", path: "/tasks/-" },
		];
		await act(async () => {
			transport.resolveAct({ ok: true, rev: 2, ops });
		});
		expect(laneStates(latest().view as JsonObject, "todo")).toEqual([]);
		expect(laneStates(latest().view as JsonObject, "doing")).toEqual(["b", "a"]);
	});

	test("reject drops the overlay entry (snap back) and toasts", async () => {
		const transport = new FakeTransport();
		transport.loadResult.data = board([task("a", "todo")]);
		const { latest } = mount(transport);
		await settleLoad();
		act(() => {
			latest().dispatch(
				MOVE,
				movePayload("a", { group: "todo", index: 0 }, { group: "doing", index: 0 }),
			);
		});
		expect(laneStates(latest().view as JsonObject, "doing")).toEqual(["a"]);
		await act(async () => {
			transport.resolveAct({ ok: false, error: { message: "nope from acme" } });
		});
		expect(laneStates(latest().view as JsonObject, "todo")).toEqual(["a"]);
		expect(latest().toasts).toEqual(["nope from acme"]);
	});

	test("a 10 s timeout drops the entry and toasts", async () => {
		vi.useFakeTimers();
		const transport = new FakeTransport();
		transport.loadResult.data = board([task("a", "todo")]);
		const { latest } = mount(transport);
		await settleLoad();
		act(() => {
			latest().dispatch(
				MOVE,
				movePayload("a", { group: "todo", index: 0 }, { group: "doing", index: 0 }),
			);
		});
		expect(laneStates(latest().view as JsonObject, "doing")).toEqual(["a"]);
		expect(transport.pendingActs()).toBe(1);
		await act(async () => {
			vi.advanceTimersByTime(10_000);
		});
		expect(laneStates(latest().view as JsonObject, "todo")).toEqual(["a"]);
		expect(latest().toasts.length).toBe(1);
	});

	test("an act() throw counts as a reject", async () => {
		const throwing = new FakeTransport();
		throwing.loadResult.data = board([task("a", "todo")]);
		const realAct = throwing.act.bind(throwing);
		throwing.act = (body) => {
			realAct(body).catch(() => undefined); // keep the call log
			return Promise.reject(new Error("offline.example.invalid"));
		};
		const { latest } = mount(throwing);
		await settleLoad();
		act(() => {
			latest().dispatch(
				MOVE,
				movePayload("a", { group: "todo", index: 0 }, { group: "doing", index: 0 }),
			);
		});
		await act(async () => {});
		expect(laneStates(latest().view as JsonObject, "todo")).toEqual(["a"]);
		expect(latest().toasts.length).toBe(1);
	});

	test("Review Focus 1: a data update mid-pending-move applies to CONFIRMED only — the overlay keeps the item placed on the new data", async () => {
		const transport = new FakeTransport();
		transport.loadResult.data = board([
			task("a", "todo"),
			task("b", "todo"),
			task("c", "doing"),
		]);
		const { latest } = mount(transport);
		await settleLoad();
		act(() => {
			latest().dispatch(
				MOVE,
				movePayload("a", { group: "todo", index: 0 }, { group: "doing", index: 1 }),
			);
		});
		expect(laneStates(latest().view as JsonObject, "doing")).toEqual(["c", "a"]);
		// Server-side: b moved todo -> doing while our move is pending.
		const serverMoved = applyMove(
			board([task("a", "todo"), task("b", "todo"), task("c", "doing")]),
			movePayload("b", { group: "todo", index: 1 }, { group: "doing", index: 1 }),
		);
		act(() => transport.emitChanged(2, 1));
		await act(async () => {
			transport.resolveFetch({ rev: 2, treeRev: 1, data: serverMoved });
		});
		// Confirmed absorbed b's move; the pending overlay re-places "a"
		// on the NEW confirmed data at its dropped lane index (1): no
		// duplication, no loss, and "a" lands at the index the user chose.
		expect(laneStates(latest().view as JsonObject, "todo")).toEqual([]);
		expect(laneStates(latest().view as JsonObject, "doing")).toEqual([
			"c",
			"a",
			"b",
		]);
	});

	test("Review Focus 2: rapid double drop — both entries apply in order; rejecting the FIRST snaps back only that move", async () => {
		const transport = new FakeTransport();
		transport.loadResult.data = board([
			task("a", "todo"),
			task("x", "doing"),
			task("y", "done"),
		]);
		const { latest } = mount(transport);
		await settleLoad();
		act(() => {
			latest().dispatch(
				MOVE,
				movePayload("a", { group: "todo", index: 0 }, { group: "doing", index: 1 }),
			);
		});
		act(() => {
			latest().dispatch(
				MOVE,
				movePayload("a", { group: "doing", index: 1 }, { group: "done", index: 1 }),
			);
		});
		expect(laneStates(latest().view as JsonObject, "done")).toEqual(["y", "a"]);
		expect(transport.pendingActs()).toBe(2);
		// Reject the FIRST: move 1 snaps back (spec §6.3). Entry 2's
		// recorded `from` (doing) no longer matches "a"'s confirmed
		// position — the overlay re-derives placement from the item's
		// CURRENT position, so entry 2 still delivers "a" to its
		// destination (done index 1): todo empty, doing [x], done [y, a].
		await act(async () => {
			transport.resolveAct({ ok: false, error: { message: "first rejected" } });
		});
		expect(latest().toasts).toEqual(["first rejected"]);
		expect(laneStates(latest().view as JsonObject, "done")).toEqual(["y", "a"]);
		expect(laneStates(latest().view as JsonObject, "todo")).toEqual([]);
		expect(laneStates(latest().view as JsonObject, "doing")).toEqual(["x"]);
		// Accept the second without ops, then the fetch carries it.
		const afterSecond = board([
			task("x", "doing"),
			task("y", "done"),
			task("a", "done"),
		]);
		await act(async () => {
			transport.resolveAct({ ok: true, rev: 2 });
		});
		act(() => transport.emitChanged(2, 1));
		await act(async () => {
			transport.resolveFetch({ rev: 2, treeRev: 1, data: afterSecond });
		});
		expect(latest().view).toEqual(afterSecond);
	});

	test("a late accept AFTER the 10 s timeout does not double-toast", async () => {
		vi.useFakeTimers();
		const transport = new FakeTransport();
		transport.loadResult.data = board([task("a", "todo")]);
		const { latest } = mount(transport);
		await settleLoad();
		act(() => {
			latest().dispatch(
				MOVE,
				movePayload("a", { group: "todo", index: 0 }, { group: "doing", index: 0 }),
			);
		});
		// Timeout fires: entry dropped, one toast.
		await act(async () => {
			vi.advanceTimersByTime(10_000);
		});
		expect(latest().toasts.length).toBe(1);
		// The server answers LATE (after the timeout) with ok + a toast:
		// the stale result must NOT push a second toast.
		await act(async () => {
			transport.resolveAct({ ok: true, rev: 2, toast: "moved" });
		});
		expect(latest().toasts.length).toBe(1);
	});

	test("a rev gap triggers a full refetch", async () => {
		const transport = new FakeTransport();
		transport.loadResult.data = board([task("a", "todo")]);
		const { latest } = mount(transport);
		await settleLoad();
		// Confirmed at rev 1; the fetch's ops advance only to 3 while the
		act(() => transport.emitChanged(5, 1));
		await act(async () => {
			transport.resolveFetch({
				rev: 3,
				treeRev: 1,
				ops: [{ op: "set", path: "/tasks/0/title", value: "gap" }],
			});
		});
		// The ops were dropped (they describe a rev we cannot trust).
		expect((latest().view as JsonObject).tasks).toEqual([task("a", "todo")]);
		expect(transport.fetchCalls).toEqual([1, undefined]);
	});

	test("a DataOpError applying fetched ops triggers a full refetch", async () => {
		const transport = new FakeTransport();
		transport.loadResult.data = board([task("a", "todo")]);
		const { latest: _unused } = mount(transport);
		await settleLoad();
		act(() => transport.emitChanged(2, 1));
		await act(async () => {
			transport.resolveFetch({
				rev: 2,
				treeRev: 1,
				ops: [{ op: "remove", path: "/missing/0" }],
			});
		});
		expect(transport.fetchCalls).toEqual([1, undefined]);
	});

	test("applyOps import sanity (the shared applier the hook delegates to)", () => {
		const result = applyOps(board([task("a", "todo")]), [
			{ op: "set", path: "/tasks/0/state", value: "done" },
		]);
		expect(result).toEqual(board([task("a", "done")]));
	});
});
