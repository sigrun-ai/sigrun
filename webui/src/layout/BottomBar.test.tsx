/**
 * BottomBar (tabs+skills Task 2): the ≤900px tab bar — Chats, then the
 * core Skills/Jobs slots (only while the served meta lists them), then
 * More, whose sheet lists the extension views and Settings. More carries
 * `aria-current` while the active tab is an ext tab or settings.
 */

import { describe, expect, test, vi } from "vitest";
import { act } from "react";
import { render } from "../test-utils";
import type { ExtViewEntry } from "./extViews";
import { BottomBar } from "./BottomBar";

const SKILLS: ExtViewEntry = {
	slug: "core",
	id: "skills",
	title: "Skills",
	icon: "list",
};
const JOBS: ExtViewEntry = {
	slug: "core",
	id: "jobs",
	title: "Jobs",
	icon: "clock",
};
const WIDGET: ExtViewEntry = {
	slug: "acme-widgets",
	id: "board",
	title: "Board",
	icon: "board",
};

function renderBar(init?: {
	readonly active?: Parameters<typeof BottomBar>[0]["active"];
	readonly extViews?: readonly ExtViewEntry[];
}) {
	const onTab = vi.fn();
	const renderer = render(
		<BottomBar
			active={init?.active ?? "chats"}
			extViews={init?.extViews ?? []}
			onTab={onTab}
		/>,
	);
	return { renderer, onTab };
}

/** Click a button node through its prop handler (react-test-renderer). */
function click(node: { props: { onClick?: (event: object) => void } }): void {
	// State updates (the sheet open/close) must flush inside act.
	act(() => {
	node.props.onClick?.({
		preventDefault() {},
		stopPropagation() {},
		target: null,
		currentTarget: null,
	});
	});
}

/** The bar's button node for one label (its aria-label is the lowercase title). */
function barButton(
	renderer: ReturnType<typeof render>,
	label: string,
): { props: Record<string, unknown>; type: unknown } {
	const matches = renderer.root.findAll(
		(node) =>
			node.type === "button" &&
			node.props["aria-label"] === label.toLowerCase(),
	);
	expect(matches).toHaveLength(1);
	return matches[0]!;
}

describe("BottomBar", () => {
	test("renders Chats and More always; Skills/Jobs only when meta lists them", () => {
		const bare = renderBar();
		expect(() => barButton(bare.renderer, "chats")).not.toThrow();
		expect(() => barButton(bare.renderer, "more")).not.toThrow();
		expect(
			bare.renderer.root.findAll(
				(node) =>
					node.type === "button" && node.props["aria-label"] === "skills",
			),
		).toHaveLength(0);
		expect(
			bare.renderer.root.findAll(
				(node) => node.type === "button" && node.props["aria-label"] === "jobs",
			),
		).toHaveLength(0);

		const full = renderBar({ extViews: [SKILLS, JOBS, WIDGET] });
		expect(() => barButton(full.renderer, "skills")).not.toThrow();
		expect(() => barButton(full.renderer, "jobs")).not.toThrow();
		// Non-core ext views live in the More sheet, never on the bar.
		expect(
			full.renderer.root.findAll(
				(node) => node.type === "button" && node.props["aria-label"] === "board",
			),
		).toHaveLength(0);
	});

	test("the fixed slots dispatch their tab ids", () => {
		const { renderer, onTab } = renderBar({ extViews: [SKILLS, JOBS] });
		click(barButton(renderer, "skills"));
		expect(onTab).toHaveBeenCalledWith("skills");
		click(barButton(renderer, "jobs"));
		expect(onTab).toHaveBeenCalledWith("jobs");
		click(barButton(renderer, "chats"));
		expect(onTab).toHaveBeenCalledWith("chats");
	});

	test("More is current on an ext tab; the fixed tabs are current on their own", () => {
		const { renderer } = renderBar({ active: "ext:acme-widgets/board" });
		expect(barButton(renderer, "more").props["aria-current"]).toBe("page");
		expect(barButton(renderer, "chats").props["aria-current"]).toBeUndefined();

		const chats = renderBar({ active: "chats" });
		expect(barButton(chats.renderer, "chats").props["aria-current"]).toBe(
			"page",
		);
		expect(barButton(chats.renderer, "more").props["aria-current"]).toBeUndefined();
	});

	test("More is current on the settings tab", () => {
		const { renderer } = renderBar({ active: "settings" });
		expect(barButton(renderer, "more").props["aria-current"]).toBe("page");
	});

	test("the sheet lists ext views then Settings", () => {
		const { renderer } = renderBar({ extViews: [SKILLS, WIDGET] });
		click(barButton(renderer, "more"));
		const dialogs = renderer.root.findAll(
			(node) => node.props.role === "dialog",
		);
		expect(dialogs).toHaveLength(1);
		const dialog = dialogs[0]!;
		expect(dialog.props["aria-label"]).toBe("More views");
		const labels = dialog
			.findAll((node) => node.type === "button")
			.map((node) => node.props["aria-label"]);
		// Core views are bar slots, not sheet rows: only the non-core ext
		// view lists, ahead of Settings.
		expect(labels).toEqual(["board", "settings"]);
	});

	test("picking from the sheet calls onTab and closes", () => {
		const { renderer, onTab } = renderBar({ extViews: [WIDGET] });
		click(barButton(renderer, "more"));
		const sheetButton = renderer.root
			.findAll((node) => node.props.role === "dialog")[0]!
			.findAll((node) => node.type === "button")
			.find((node) => node.props["aria-label"] === "settings")!;
		click(sheetButton);
		expect(onTab).toHaveBeenCalledWith("settings");
		expect(
			renderer.root.findAll((node) => node.props.role === "dialog"),
		).toHaveLength(0);
	});

	test("picking an ext view from the sheet calls onTab with its tab id", () => {
		const { renderer, onTab } = renderBar({ extViews: [WIDGET] });
		click(barButton(renderer, "more"));
		const sheetButton = renderer.root
			.findAll((node) => node.props.role === "dialog")[0]!
			.findAll((node) => node.type === "button")
			.find((node) => node.props["aria-label"] === "board")!;
		click(sheetButton);
		expect(onTab).toHaveBeenCalledWith("ext:acme-widgets/board");
		expect(
			renderer.root.findAll((node) => node.props.role === "dialog"),
		).toHaveLength(0);
	});
});
