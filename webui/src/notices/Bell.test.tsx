/**
 * Bell (notices Task 6): the rail's notices toggle — the badge count
 * equals the notices present.
 */

import { createElement as h } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test } from "vitest";
import { instanceText, render } from "../test-utils";
import { Bell } from "./Bell";

function findBell(root: TestRenderer.ReactTestRenderer) {
	return root.root.findByProps({ "data-rail-section": "notices" });
}

describe("Bell", () => {
	test("count equals notices present", () => {
		const root = render(h(Bell, { count: 3 }));
		expect(instanceText(findBell(root))).toContain("3");
	});

	test("an empty pile renders no badge", () => {
		const root = render(h(Bell, { count: 0 }));
		expect(instanceText(findBell(root))).not.toContain("0");
		expect(root.root.findAllByProps({ "data-bell-count": 0 })).toEqual([]);
	});

	test("a click toggles the pane", () => {
		let toggled = 0;
		const root = render(h(Bell, { count: 2, onToggle: () => (toggled += 1) }));
		findBell(root).props.onClick();
		expect(toggled).toBe(1);
	});
});
