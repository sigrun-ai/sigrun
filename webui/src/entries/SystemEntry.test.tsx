/**
 * SystemEntry (Task 22): a `pi.system` entry rendered as a muted single
 * line (the text of its messages, joined).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { createElement as h } from "react";
import { describe, expect, test } from "vitest";
import { makeEntry, render, textContent, textMessage } from "../test-utils";
import { SystemEntry } from "./SystemEntry";

describe("SystemEntry", () => {
	test("renders the message text as a muted system line", () => {
		const entry = makeEntry("pi.system", [
			textMessage("system", "compaction happened"),
		]);
		const renderer = render(h(SystemEntry, { entry }));
		const tree = renderer.toJSON();
		expect(textContent(tree)).toContain("compaction happened");
		expect(tree).toMatchObject({
			props: { className: expect.stringContaining("entry-system") },
		});
		renderer.unmount();
	});

	test("string content renders as-is", () => {
		const entry = makeEntry("pi.system", [
			{ role: "system", content: "plain system note" },
		]);
		const renderer = render(h(SystemEntry, { entry }));
		expect(textContent(renderer.toJSON())).toContain("plain system note");
		renderer.unmount();
	});
});
