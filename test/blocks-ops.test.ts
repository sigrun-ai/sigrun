/**
 * U0 Task 1 — the shared block-set foundation: `applyOps`,
 * `resolvePointer`, `lttb`, and the icon-name contract
 * (`@sigrun/shared/blocks`).
 *
 * `applyOps` is the single applier every surface's data updates go
 * through (spec §4.3): pure copy-on-write over the touched path only,
 * RFC 6901 pointers with `~0`/`~1` escaping, and `DataOpError` naming
 * the offending op's index (the caller's full-refetch signal — spec
 * §16 "a rev gap forces a full refetch", plan Review Focus 4).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	BLOCK_SET_VERSION,
	DataOpError,
	ICON_NAMES,
	applyOps,
	lttb,
	resolvePointer,
} from "@sigrun/shared/blocks";
import type { DataOp, JsonObject } from "@sigrun/shared/blocks";

/** Recursively freeze a JSON value — any mutation attempt throws. */
function deepFreeze(value: unknown): void {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
		return;
	}
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) {
		deepFreeze(child);
	}
}

/** Runs `fn`, returns the thrown error (fails the test if none throws). */
function catchError(fn: () => unknown): Error {
	try {
		fn();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected the call to throw");
}

describe("applyOps", () => {
	it("set /a/b creates b and never mutates the (frozen) input", () => {
		const input: JsonObject = { a: { z: 1 } };
		deepFreeze(input);
		const snapshot = structuredClone(input);
		const out = applyOps(input, [
			{ op: "set", path: "/a/b", value: 2 },
		]);
		expect(out).toEqual({ a: { z: 1, b: 2 } });
		expect(input).toEqual(snapshot);
		expect(Object.isFrozen(input)).toBe(true);
	});

	it("remove /items/1 drops index 1", () => {
		const out = applyOps({ items: ["a", "b", "c"] }, [
			{ op: "remove", path: "/items/1" },
		]);
		expect(out).toEqual({ items: ["a", "c"] });
	});

	it("insert /items/- appends", () => {
		const out = applyOps({ items: [1, 2] }, [
			{ op: "insert", path: "/items/-", value: 3 },
		]);
		expect(out).toEqual({ items: [1, 2, 3] });
	});

	it("insert /items/0 prepends", () => {
		const out = applyOps({ items: [1, 2] }, [
			{ op: "insert", path: "/items/0", value: 9 },
		]);
		expect(out).toEqual({ items: [9, 1, 2] });
	});

	it("move carries an item across arrays", () => {
		const input: JsonObject = {
			lanes: { todo: [{ id: "t0" }, { id: "t1" }], done: [{ id: "d0" }, { id: "d1" }] },
		};
		deepFreeze(input);
		const snapshot = structuredClone(input);
		const out = applyOps(input, [
			{ op: "move", from: "/lanes/todo/0", path: "/lanes/done/2" },
		]);
		expect(out).toEqual({
			lanes: { todo: [{ id: "t1" }], done: [{ id: "d0" }, { id: "d1" }, { id: "t0" }] },
		});
		expect(input).toEqual(snapshot);
	});

	it("move within one array reorders it", () => {
		const out = applyOps({ x: ["a", "b", "c", "d"] }, [
			{ op: "move", from: "/x/3", path: "/x/0" },
		]);
		expect(out).toEqual({ x: ["d", "a", "b", "c"] });
	});

	it("ops apply sequentially: an insert is visible to the next move", () => {
		const out = applyOps({ lanes: { todo: [], done: [{ id: "d0" }] } }, [
			{ op: "insert", path: "/lanes/todo/-", value: { id: "c1" } },
			{ op: "move", from: "/lanes/todo/0", path: "/lanes/done/-" },
		]);
		expect(out).toEqual({ lanes: { todo: [], done: [{ id: "d0" }, { id: "c1" }] } });
	});

	it("remove /items/99 throws DataOpError with opIndex 0", () => {
		const error = catchError(() =>
			applyOps({ items: [1] }, [{ op: "remove", path: "/items/99" }]),
		);
		expect(error).toBeInstanceOf(DataOpError);
		expect((error as DataOpError).opIndex).toBe(0);
		expect(error.message).toContain("/items/99");
	});

	it("the failing op's index is reported (second op)", () => {
		const error = catchError(() =>
			applyOps({ items: [1] }, [
				{ op: "set", path: "/n", value: 5 },
				{ op: "remove", path: "/items/7" },
			]),
		);
		expect(error).toBeInstanceOf(DataOpError);
		expect((error as DataOpError).opIndex).toBe(1);
	});

	it("set through a missing intermediate path throws DataOpError", () => {
		const error = catchError(() =>
			applyOps({}, [{ op: "set", path: "/nope/b", value: 1 }]),
		);
		expect(error).toBeInstanceOf(DataOpError);
		expect((error as DataOpError).opIndex).toBe(0);
	});

	it("escapes RFC 6901 tokens: ~1 is / and ~0 is ~", () => {
		const viaSet = applyOps({ "a/b": { "m~n": 1 } }, [
			{ op: "set", path: "/a~1b/m~0n", value: 2 },
		]);
		expect(viaSet).toEqual({ "a/b": { "m~n": 2 } });
		expect(resolvePointer({ "a/b": 7 }, "/a~1b")).toBe(7);
		expect(resolvePointer({ "m~n": 8 }, "/m~0n")).toBe(8);
	});

	it("untouched branches are shared by reference (clone of the touched path only)", () => {
		const keep = { deep: [1, 2, 3] };
		const input: JsonObject = { keep, heading: "old" };
		deepFreeze(input);
		const out = applyOps(input, [{ op: "set", path: "/heading", value: "new" }]);
		expect(out.heading).toBe("new");
		// The untouched subtree is the SAME object — applyOps clones along the
		// op path only, never the whole document.
		expect(out.keep).toBe(keep);
	});

	it("a batch of ops leaves the frozen input byte-identical", () => {
		const input: JsonObject = {
			keep: { deep: [1, 2, 3] },
			items: [{ id: 1 }, { id: 2 }, { id: 3 }],
			heading: "old",
		};
		deepFreeze(input);
		const snapshot = structuredClone(input);
		const out = applyOps(input, [
			{ op: "set", path: "/heading", value: "new" },
			{ op: "remove", path: "/items/1" },
			{ op: "insert", path: "/items/-", value: { id: 4 } },
			{ op: "move", from: "/items/0", path: "/items/2" },
			{ op: "set", path: "/keep/deep/1", value: 99 },
		]);
		expect(out).toEqual({
			keep: { deep: [1, 99, 3] },
			items: [{ id: 3 }, { id: 4 }, { id: 1 }],
			heading: "new",
		});
		expect(input).toEqual(snapshot);
	});
});

describe("applyOps property: moves preserve the multiset", () => {
	type Item = { id: number; tag: string };

	it("random arrays under random valid move ops stay permutations", () => {
		fc.assert(
			fc.property(
				fc
					.array(
						fc.record({
							id: fc.integer({ min: 0, max: 999 }),
							tag: fc.string({ minLength: 0, maxLength: 6 }),
						}),
						{ minLength: 1, maxLength: 24 },
					)
					.chain((items) =>
						fc.tuple(
							fc.constant(items),
							fc.array(
								fc.tuple(fc.nat(items.length - 1), fc.nat(items.length - 1)),
								{ maxLength: 8 },
							),
						),
					),
				([items, moves]) => {
					const data: JsonObject = { arr: items };
					deepFreeze(data);
					const snapshot = structuredClone(data);
					const ops: DataOp[] = moves.map(([from, to]) => ({
						op: "move" as const,
						from: `/arr/${from}`,
						path: `/arr/${to}`,
					}));
					const out = applyOps(data, ops);
					expect(data).toEqual(snapshot);
					const result = out.arr as Item[];
					expect(result).toHaveLength(items.length);
					const idsOf = (rows: Item[]): number[] =>
						rows.map((row) => row.id).sort((a, b) => a - b);
					expect(idsOf(result)).toEqual(idsOf(items));
				},
			),
			{ numRuns: 200 },
		);
	});
});

describe("resolvePointer", () => {
	it("resolves nested objects and array indices", () => {
		expect(resolvePointer({ a: [{ t: 1 }] }, "/a/0/t")).toBe(1);
	});

	it('resolves "./x" pointers against the item', () => {
		expect(resolvePointer({ t: 9 }, "./t", { t: 2 })).toBe(2);
	});

	it("a missing path is undefined", () => {
		expect(resolvePointer({ a: 1 }, "/b")).toBeUndefined();
		expect(resolvePointer({ a: [1] }, "/a/3")).toBeUndefined();
		expect(resolvePointer({ a: [1] }, "/a/x")).toBeUndefined();
	});

	it("a path through a JSON null is a missing path, not an error", () => {
		expect(resolvePointer({ a: null }, "/a/b")).toBeUndefined();
		expect(resolvePointer({ a: [null] }, "/a/0/b")).toBeUndefined();
		expect(resolvePointer({ a: null }, "/a")).toBe(null);
	});

	it("a malformed pointer is a missing path, not a thrown error", () => {
		expect(resolvePointer({ a: 1 }, "foo")).toBeUndefined();
		expect(resolvePointer({ a: 1 }, "./foo", { a: 1 })).toBeUndefined();
	});

	it("the empty pointer is the root", () => {
		const root: JsonObject = { a: 1 };
		expect(resolvePointer(root, "")).toBe(root);
	});
});

describe("lttb (largest-triangle-three-buckets)", () => {
	it("downsamples 10,000 points to 500 keeping the ends and the global max", () => {
		const points: [number, number][] = Array.from({ length: 10_000 }, (_, i) => [
			i,
			i === 4321 ? 1_000_000 : 0,
		]);
		deepFreeze(points);
		const snapshot = structuredClone(points);
		const out = lttb(points, 500);
		expect(out).toHaveLength(500);
		expect(out[0]).toEqual([0, 0]);
		expect(out[out.length - 1]).toEqual([9999, 0]);
		expect(out).toContainEqual([4321, 1_000_000]);
		expect(points).toEqual(snapshot);
	});

	it("returns a fresh array when the input is already within the threshold", () => {
		const input: [number, number][] = [[1, 2], [3, 4]];
		deepFreeze(input);
		const out = lttb(input, 5);
		expect(out).toEqual(input);
		expect(out).not.toBe(input);
	});
});

describe("the block-set contract constants", () => {
	it("BLOCK_SET_VERSION is 1", () => {
		expect(BLOCK_SET_VERSION).toBe(1);
	});

	it("ICON_NAMES is the spec §10.2 list: 49 names, no duplicates", () => {
		expect(ICON_NAMES.length).toBe(49);
		expect(new Set(ICON_NAMES).size).toBe(49);
		expect(ICON_NAMES[0]).toBe("add");
		expect(ICON_NAMES[48]).toBe("umbrella");
		for (const name of [
			"cloud-lightning",
			"thermometer",
			"droplets",
			"external",
			"board",
			"running",
		]) {
			expect(ICON_NAMES, name).toContain(name);
		}
	});
});
