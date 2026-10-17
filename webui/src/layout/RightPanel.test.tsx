/**
 * RightPanel (B2, UI refresh): the 280px docked panel right of the chat
 * pane. Pure switching: renders the outline node or the workspace node
 * for the active PanelMode, nothing when the panel is closed. The CONTENT
 * (the outline list, the workspace browser) is App-provided — this
 * component owns only the panel chrome.
 */

import { describe, expect, test } from "vitest";
import { render, textContent } from "../test-utils";
import { RightPanel } from "./RightPanel";

describe("RightPanel", () => {
	test("renders nothing when the panel is closed (mode null)", () => {
		const renderer = render(
			<RightPanel
				mode={null}
				outline={<p>outline-body</p>}
				workspace={<p>workspace-body</p>}
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
			/>,
		);
		const panel = renderer.root.findByProps({ className: "right-panel" });
		expect(panel.props["data-panel"]).toBe("outline");
		const text = textContent(renderer.toJSON());
		expect(text).toContain("outline-body");
		expect(text).not.toContain("workspace-body");
	});

	test("renders the workspace node under data-panel=workspace", () => {
		const renderer = render(
			<RightPanel
				mode="workspace"
				outline={<p>outline-body</p>}
				workspace={<p>workspace-body</p>}
			/>,
		);
		const panel = renderer.root.findByProps({ className: "right-panel" });
		expect(panel.props["data-panel"]).toBe("workspace");
		const text = textContent(renderer.toJSON());
		expect(text).toContain("workspace-body");
		expect(text).not.toContain("outline-body");
	});
});
