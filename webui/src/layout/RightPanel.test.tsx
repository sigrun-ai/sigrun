/**
 * RightPanel (todo Task 2): the 280px docked panel right of the chat
 * pane. Pure switching over ONE selection key: renders the outline,
 * workspace, notices, or extension node for the active selection,
 * nothing when the panel is closed. The CONTENT is App-provided — this
 * component owns only the panel chrome. The tab strip is GONE: ext
 * panels are header toggles now (ChatHeader), and an installed panel
 * extension alone never opens the panel.
 */

import { describe, expect, test } from "vitest";
import { render, textContent } from "../test-utils";
import { RightPanel } from "./RightPanel";

describe("RightPanel", () => {
	test("selection null renders nothing even when ext panels are installed", () => {
		const renderer = render(
			<RightPanel
				selection={null}
				outline={<p>outline-body</p>}
				workspace={<p>workspace-body</p>}
				notices={<p>notices-body</p>}
				extContent={<p>ext-body</p>}
			/>,
		);
		expect(renderer.toJSON()).toBeNull();
	});

	test("renders the outline node under data-panel=outline", () => {
		const renderer = render(
			<RightPanel
				selection="outline"
				outline={<p>outline-body</p>}
				workspace={<p>workspace-body</p>}
				notices={<p>notices-body</p>}
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
				selection="workspace"
				outline={<p>outline-body</p>}
				workspace={<p>workspace-body</p>}
				notices={<p>notices-body</p>}
			/>,
		);
		const panel = renderer.root.findByProps({ className: "right-panel" });
		expect(panel.props["data-panel"]).toBe("workspace");
		const text = textContent(renderer.toJSON());
		expect(text).toContain("workspace-body");
		expect(text).not.toContain("outline-body");
	});

	test("selection ext renders extContent under data-panel=ext", () => {
		const renderer = render(
			<RightPanel
				selection="ext:todo/todos"
				outline={<p>outline-body</p>}
				workspace={<p>workspace-body</p>}
				notices={<p>notices-body</p>}
				extContent={<p>ext-body</p>}
			/>,
		);
		const panel = renderer.root.findByProps({ className: "right-panel" });
		expect(panel.props["data-panel"]).toBe("ext");
		const text = textContent(renderer.toJSON());
		expect(text).toContain("ext-body");
		expect(text).not.toContain("outline-body");
		expect(text).not.toContain("workspace-body");
	});

	test("selection notices renders the notices node under data-panel=notices", () => {
		const renderer = render(
			<RightPanel
				selection="notices"
				outline={<p>outline-body</p>}
				workspace={<p>workspace-body</p>}
				notices={<p>notices-body</p>}
			/>,
		);
		const panel = renderer.root.findByProps({ className: "right-panel" });
		expect(panel.props["data-panel"]).toBe("notices");
		expect(panel.props["aria-label"]).toBe("notices panel");
		const text = textContent(renderer.toJSON());
		expect(text).toContain("notices-body");
	});

	test("no element carries role=tablist (the in-panel tab strip is gone)", () => {
		const renderer = render(
			<RightPanel
				selection="ext:todo/todos"
				outline={<p>outline-body</p>}
				workspace={<p>workspace-body</p>}
				notices={<p>notices-body</p>}
				extContent={<p>ext-body</p>}
			/>,
		);
		expect(renderer.root.findAllByProps({ role: "tablist" })).toHaveLength(0);
	});
});
