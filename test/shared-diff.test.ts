/** Shared line diffs: both clients render the same operations and skips. */

import { describe, expect, it } from "vitest";
import { lineDiff, type DiffLine } from "@sigrun/shared/diff";

const lines = (prefix: string, count: number): string[] =>
	Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);

describe("lineDiff", () => {
	it("identical texts are all same", () => {
		expect(lineDiff("alpha\nbeta", "alpha\nbeta")).toEqual([
			{ op: "same", text: "alpha" },
			{ op: "same", text: "beta" },
		]);
	});

	it("one changed line is del + add in place", () => {
		expect(lineDiff("alpha\nold\nomega", "alpha\nnew\nomega")).toEqual([
			{ op: "same", text: "alpha" },
			{ op: "del", text: "old" },
			{ op: "add", text: "new" },
			{ op: "same", text: "omega" },
		]);
	});

	it("long unchanged runs collapse", () => {
		const before = [...lines("before", 100), "old", ...lines("after", 100)].join("\n");
		const after = [...lines("before", 100), "new", ...lines("after", 100)].join("\n");
		expect(lineDiff(before, after)).toEqual([
			{ op: "same", text: "before-1" },
			{ op: "same", text: "before-2" },
			{ op: "same", text: "before-3" },
			{ op: "skip", count: 94 },
			{ op: "same", text: "before-98" },
			{ op: "same", text: "before-99" },
			{ op: "same", text: "before-100" },
			{ op: "del", text: "old" },
			{ op: "add", text: "new" },
			{ op: "same", text: "after-1" },
			{ op: "same", text: "after-2" },
			{ op: "same", text: "after-3" },
			{ op: "skip", count: 94 },
			{ op: "same", text: "after-98" },
			{ op: "same", text: "after-99" },
			{ op: "same", text: "after-100" },
		] satisfies DiffLine[]);
	});

	it("an added file is all add", () => {
		expect(lineDiff("", "alpha\nbeta")).toEqual([
			{ op: "add", text: "alpha" },
			{ op: "add", text: "beta" },
		]);
	});

	it("the size guard falls back", () => {
		const before = lines("old", 5001).join("\n");
		const after = lines("new", 5001).join("\n");
		const diff = lineDiff(before, after);
		expect(diff).toHaveLength(10002);
		expect(diff[0]).toEqual({ op: "del", text: "old-1" });
		expect(diff[5000]).toEqual({ op: "del", text: "old-5001" });
		expect(diff[5001]).toEqual({ op: "add", text: "new-1" });
		expect(diff[10001]).toEqual({ op: "add", text: "new-5001" });
	});
});
