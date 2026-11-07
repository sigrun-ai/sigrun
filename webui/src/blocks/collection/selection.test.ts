/**
 * Select-all helpers: the bar's tri-state checkbox and the per-group
 * heading checkboxes both read `selectionState` and write `toggleAll`.
 */
import { describe, expect, test } from "vitest";
import { selectionState, toggleAll } from "./selection";

describe("selectionState", () => {
	test("none / some / all over the given ids", () => {
		expect(selectionState([], ["a", "b"])).toBe("none");
		expect(selectionState(["a"], ["a", "b"])).toBe("some");
		expect(selectionState(["b", "a"], ["a", "b"])).toBe("all");
	});

	test("ids outside the scope do not count (a group's state ignores other groups)", () => {
		expect(selectionState(["x"], ["a", "b"])).toBe("none");
		expect(selectionState(["x", "a", "b"], ["a", "b"])).toBe("all");
	});

	test("an empty scope is none", () => {
		expect(selectionState(["a"], [])).toBe("none");
	});
});

describe("toggleAll", () => {
	test("selects the missing ids when not all are selected, keeping order", () => {
		expect(toggleAll(["x", "b"], ["a", "b", "c"])).toEqual(["x", "b", "a", "c"]);
	});

	test("clears the scope's ids when all are selected, keeping others", () => {
		expect(toggleAll(["x", "a", "b"], ["a", "b"])).toEqual(["x"]);
	});
});
