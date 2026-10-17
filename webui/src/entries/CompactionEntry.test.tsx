/**
 * CompactionEntry (B4, UI refresh): the compaction divider — centred
 * "Context compacted" between two rules, no button. The reason (when the
 * entry carries one) rides `data-reason` and the native title tooltip.
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
				"The conversation so far was compacted into the following summary…",
			),
		],
		{ id: init?.id ?? 3 },
	);
	return init?.reason === undefined
		? entry
		: { ...entry, data: { reason: init.reason } };
}

describe("CompactionEntry", () => {
	test("renders the centred divider text with no button", () => {
		const renderer = render(h(CompactionEntry, { entry: compactionEntry() }));
		const tree = renderer.toJSON();
		expect(textContent(tree)).toContain("Context compacted");
		expect(renderer.root.findAllByType("button")).toHaveLength(0);
		expect(tree).toMatchObject({
			props: {
				className: expect.stringContaining("turn-compaction"),
			},
		});
		renderer.unmount();
	});

	test("a reason rides data-reason and the title tooltip", () => {
		const renderer = render(
			h(CompactionEntry, { entry: compactionEntry({ reason: "threshold" }) }),
		);
		expect(renderer.toJSON()).toMatchObject({
			props: {
				"data-reason": "threshold",
				title: "context compacted (threshold)",
			},
		});
		renderer.unmount();
	});

	test("a missing reason renders the bare divider, never a crash", () => {
		const renderer = render(
			h(CompactionEntry, { entry: compactionEntry({ reason: undefined }) }),
		);
		const tree = renderer.toJSON();
		expect(textContent(tree)).toContain("Context compacted");
		expect(
			(tree === null || Array.isArray(tree) ? null : tree)?.props[
				"data-reason"
			],
		).toBeUndefined();
		renderer.unmount();
	});
});
