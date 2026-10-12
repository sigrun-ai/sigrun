/**
 * CompactionEntry (Task 4, pi parity): a `pi.compaction` summary entry —
 * the manual-compact result's visible rendering: a label naming the reason
 * (manual / threshold / overflow) plus the summary text upstream wraps.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { createElement as h } from "react";
import { describe, expect, test } from "vitest";
import { makeEntry, render, textContent, textMessage } from "../test-utils";
import { CompactionEntry } from "./CompactionEntry";

/** A `pi.compaction` entry (model = the wrapped summary user message). */
function compactionEntry(init?: {
	reason?: string;
	id?: number;
}): ReturnType<typeof makeEntry> {
	const entry = makeEntry(
		"pi.compaction",
		[
			textMessage(
				"user",
				"The conversation so far was compacted into the following summary… secrets remain.",
			),
		],
		{ id: init?.id ?? 3 },
	);
	return { ...entry, data: { reason: init?.reason ?? "manual" } };
}

describe("CompactionEntry", () => {
	test("renders the summary text with a manual-compaction label", () => {
		const renderer = render(h(CompactionEntry, { entry: compactionEntry() }));
		const tree = renderer.toJSON();
		expect(textContent(tree)).toContain("Compacted (manual)");
		expect(textContent(tree)).toContain("compacted into the following summary");
		expect(tree).toMatchObject({
			props: {
				className: expect.stringContaining("entry-compaction"),
				"data-reason": "manual",
			},
		});
		renderer.unmount();
	});

	test("names the reason for threshold/overflow compactions too", () => {
		const renderer = render(
			h(CompactionEntry, { entry: compactionEntry({ reason: "threshold" }) }),
		);
		expect(textContent(renderer.toJSON())).toContain("Compacted (threshold)");
		renderer.unmount();
	});

	test("a missing reason renders the bare label, never a crash", () => {
		const renderer = render(
			h(CompactionEntry, { entry: compactionEntry({ reason: undefined }) }),
		);
		expect(textContent(renderer.toJSON())).toContain("Compacted");
		renderer.unmount();
	});
});