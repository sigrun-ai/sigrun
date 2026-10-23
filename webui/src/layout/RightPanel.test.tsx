/**
 * RightPanel (B2, UI refresh): the 280px docked panel right of the chat
 * pane. Pure switching: renders the outline, workspace, or jobs node
 * for the active PanelMode, nothing when the panel is closed. The
 * CONTENT (the outline list, the workspace browser, the jobs panel) is
 * App-provided — this component owns only the panel chrome.
 */

import { describe, expect, test, vi } from "vitest";
import { render, textContent } from "../test-utils";
import { RightPanel } from "./RightPanel";

describe("RightPanel", () => {
	test("renders nothing when the panel is closed (mode null)", () => {
		const renderer = render(
			<RightPanel
				mode={null}
				outline={<p>outline-body</p>}
				workspace={<p>workspace-body</p>}
				jobs={<p>jobs-body</p>}
			/>,
		);
		expect(renderer.toJSON()).toBeNull();
	});

	test("renders the outline node under data-panel=outline", () => {
		const renderer = render(
			<RightPanel
				mode="outline"
				outline={<p>outline-body</p>}
				workspace={<p>workspace-body</p>}
				jobs={<p>jobs-body</p>}
			/>,
		);
		const panel = renderer.root.findByProps({ className: "right-panel" });
		expect(panel.props["data-panel"]).toBe("outline");
		const text = textContent(renderer.toJSON());
		expect(text).toContain("outline-body");
		expect(text).not.toContain("workspace-body");
		expect(text).not.toContain("jobs-body");
	});

	test("renders the workspace node under data-panel=workspace", () => {
		const renderer = render(
			<RightPanel
				mode="workspace"
				outline={<p>outline-body</p>}
				workspace={<p>workspace-body</p>}
				jobs={<p>jobs-body</p>}
			/>,
		);
		const panel = renderer.root.findByProps({ className: "right-panel" });
		expect(panel.props["data-panel"]).toBe("workspace");
		const text = textContent(renderer.toJSON());
		expect(text).toContain("workspace-body");
		expect(text).not.toContain("outline-body");
	});

	test("renders the jobs node under data-panel=jobs (W4 Task 5)", () => {
		const renderer = render(
			<RightPanel
				mode="jobs"
				outline={<p>outline-body</p>}
				workspace={<p>workspace-body</p>}
				jobs={<p>jobs-body</p>}
			/>,
		);
		const panel = renderer.root.findByProps({ className: "right-panel" });
		expect(panel.props["data-panel"]).toBe("jobs");
		const text = textContent(renderer.toJSON());
		expect(text).toContain("jobs-body");
		expect(text).not.toContain("workspace-body");
	});

describe("RightPanel extension tabs (UI-blocks U3 Task 5)", () => {
	const panels = [
		{ slug: "fixture-surfaces", id: "stats", title: "Acme stats", icon: "chart" },
	];

	test("extension panel surfaces render one tab each, after the core tabs", () => {
		const renderer = render(
			<RightPanel
				mode="outline"
				outline={<p>outline-body</p>}
				workspace={<p>workspace-body</p>}
				jobs={<p>jobs-body</p>}
				extPanels={panels}
			/>,
		);
		const tab = renderer.root.findByProps({
			"data-panel-tab": "ext:fixture-surfaces/stats",
		});
		expect(tab.props.title).toBe("Acme stats");
	});

	test("an extension tab click forwards (slug, id) to onOpenExtPanel", () => {
		const onOpenExtPanel = vi.fn();
		const renderer = render(
			<RightPanel
				mode="outline"
				outline={<p>outline-body</p>}
				workspace={<p>workspace-body</p>}
				jobs={<p>jobs-body</p>}
				extPanels={panels}
				onOpenExtPanel={onOpenExtPanel}
			/>,
		);
		const tab = renderer.root.findByProps({
			"data-panel-tab": "ext:fixture-surfaces/stats",
		});
		(tab.props as { onClick: () => void }).onClick();
		expect(onOpenExtPanel).toHaveBeenCalledWith("fixture-surfaces", "stats");
	});
});
});
