/**
 * ChatHeader (B2, UI refresh): the 48px header over the chat pane — the
 * conversation title (click → inline rename; Enter saves, Esc cancels),
 * the Outline / Workspace panel toggles (aria-pressed), the ⋯ menu
 * (Export, Compact, Rename, Archive), and the narrow-viewport drawer
 * toggle (CSS shows it ≤900px only).
 */

import { act } from "react";
import { describe, expect, test, vi } from "vitest";
import { render, textContent } from "../test-utils";
import { ChatHeader, type PanelMode } from "./ChatHeader";

function renderHeader(init?: {
	readonly title?: string;
	readonly panel?: PanelMode | null;
	readonly onPanel?: (mode: PanelMode) => void;
	readonly onRename?: (name: string) => Promise<void>;
	readonly onExport?: () => void;
	readonly onCompact?: () => void;
	readonly onArchive?: () => void;
}) {
	const renderer = render(
		<ChatHeader
			title={init?.title ?? "Fjord walking routes"}
			panel={init?.panel ?? null}
			onPanel={init?.onPanel ?? (() => {})}
			onRename={init?.onRename ?? (async () => {})}
			onExport={init?.onExport ?? (() => {})}
			onCompact={init?.onCompact ?? (() => {})}
			onArchive={init?.onArchive ?? (() => {})}
			drawerOpen={false}
			onToggleDrawer={() => {}}
		/>,
	);
	return renderer;
}

describe("ChatHeader", () => {
	test("renders the title in the single-line ellipsis element (a 200-char title survives)", () => {
		const long = "r".repeat(200);
		const renderer = renderHeader({ title: long });
		const title = renderer.root.findByProps({ className: "chat-title" });
		expect(title.children.join("")).toBe(long);
		expect(textContent(renderer.toJSON())).toContain(long);
	});

	test("clicking the title opens an inline rename input; Enter saves via onRename and closes it", async () => {
		const onRename = vi.fn(async () => {});
		const renderer = renderHeader({ onRename });
		const title = renderer.root.findByProps({ className: "chat-title" });
		await act(async () => {
			(title.props as { onClick: () => void }).onClick();
		});
		const input = renderer.root.findByProps({ className: "chat-title-input" });
		act(() => {
			(input.props as {
				onChange: (event: { target: { value: string } }) => void;
			}).onChange({ target: { value: "New" } });
		});
		await act(async () => {
			(input.props as {
				onKeyDown: (event: { key: string }) => void;
			}).onKeyDown({ key: "Enter" });
		});
		expect(onRename).toHaveBeenCalledWith("New");
		// The input closed after the rename resolved.
		expect(
			renderer.root.findAllByProps({ className: "chat-title-input" }),
		).toHaveLength(0);
		expect(
			renderer.root.findAllByProps({ className: "chat-title" }),
		).toHaveLength(1);
	});

	test("Esc cancels the rename without calling onRename", async () => {
		const onRename = vi.fn(async () => {});
		const renderer = renderHeader({ onRename });
		const title = renderer.root.findByProps({ className: "chat-title" });
		await act(async () => {
			(title.props as { onClick: () => void }).onClick();
		});
		const input = renderer.root.findByProps({ className: "chat-title-input" });
		act(() => {
			(input.props as {
				onChange: (event: { target: { value: string } }) => void;
			}).onChange({ target: { value: "discarded" } });
		});
		act(() => {
			(input.props as {
				onKeyDown: (event: { key: string }) => void;
			}).onKeyDown({ key: "Escape" });
		});
		expect(onRename).not.toHaveBeenCalled();
		expect(
			renderer.root.findAllByProps({ className: "chat-title-input" }),
		).toHaveLength(0);
	});

	test("the Outline and Workspace buttons carry aria-pressed and forward onPanel", () => {
		const onPanel = vi.fn();
		const renderer = renderHeader({ panel: "outline", onPanel });
		const outline = renderer.root.findByProps({ "data-panel": "outline" });
		expect(outline.props["aria-pressed"]).toBe(true);
		const workspace = renderer.root.findByProps({ "data-panel": "workspace" });
		expect(workspace.props["aria-pressed"]).toBe(false);
		(outline.props as { onClick: () => void }).onClick();
		expect(onPanel).toHaveBeenCalledWith("outline");
		(workspace.props as { onClick: () => void }).onClick();
		expect(onPanel).toHaveBeenCalledWith("workspace");
	});

	test("the ⋯ menu lists Export, Compact, Rename, Archive; each item forwards its action", async () => {
		const onExport = vi.fn();
		const onCompact = vi.fn();
		const onArchive = vi.fn();
		const renderer = renderHeader({ onExport, onCompact, onArchive });
		const more = renderer.root.findByProps({ "aria-label": "more actions" });
		await act(async () => {
			(more.props as { onClick: () => void }).onClick();
		});
		const menu = renderer.root.findByProps({ className: "chat-menu" });
		const actions = menu
			.findAllByProps({ type: "button" })
			.map((button) => button.props["data-menu-action"]);
		expect(actions).toEqual(["export", "compact", "rename", "archive"]);
		await act(async () => {
			(menu.findByProps({ "data-menu-action": "export" }).props as {
				onClick: () => void;
			}).onClick();
		});
		expect(onExport).toHaveBeenCalledTimes(1);
		await act(async () => {
			(renderer.root.findByProps({ "aria-label": "more actions" }).props as {
				onClick: () => void;
			}).onClick();
		});
		const menu2 = renderer.root.findByProps({ className: "chat-menu" });
		await act(async () => {
			(menu2.findByProps({ "data-menu-action": "compact" }).props as {
				onClick: () => void;
			}).onClick();
		});
		expect(onCompact).toHaveBeenCalledTimes(1);
		await act(async () => {
			(renderer.root.findByProps({ "aria-label": "more actions" }).props as {
				onClick: () => void;
			}).onClick();
		});
		const menu3 = renderer.root.findByProps({ className: "chat-menu" });
		await act(async () => {
			(menu3.findByProps({ "data-menu-action": "archive" }).props as {
				onClick: () => void;
			}).onClick();
		});
		expect(onArchive).toHaveBeenCalledTimes(1);
	});

	test("the menu's Rename item opens the inline rename input", async () => {
		const onRename = vi.fn(async () => {});
		const renderer = renderHeader({ onRename });
		await act(async () => {
			(renderer.root.findByProps({ "aria-label": "more actions" }).props as {
				onClick: () => void;
			}).onClick();
		});
		await act(async () => {
			(renderer.root.findByProps({ "data-menu-action": "rename" }).props as {
				onClick: () => void;
			}).onClick();
		});
		const input = renderer.root.findByProps({ className: "chat-title-input" });
		act(() => {
			(input.props as {
				onChange: (event: { target: { value: string } }) => void;
			}).onChange({ target: { value: "Menu rename" } });
		});
		await act(async () => {
			(input.props as {
				onKeyDown: (event: { key: string }) => void;
			}).onKeyDown({ key: "Enter" });
		});
		expect(onRename).toHaveBeenCalledWith("Menu rename");
	});

	test("the drawer toggle forwards onToggleDrawer with aria-expanded", () => {
		const onToggleDrawer = vi.fn();
		const renderer = render(
			<ChatHeader
				title="t"
				panel={null}
				onPanel={() => {}}
				onRename={async () => {}}
				onExport={() => {}}
				onCompact={() => {}}
				onArchive={() => {}}
				drawerOpen={false}
				onToggleDrawer={onToggleDrawer}
			/>,
		);
		const toggle = renderer.root.findByProps({
			"aria-label": "open conversations",
		});
		expect((toggle.props.className as string).includes("chat-menu-toggle")).toBe(
			true,
		);
		expect(toggle.props["aria-expanded"]).toBe(false);
		(toggle.props as { onClick: () => void }).onClick();
		expect(onToggleDrawer).toHaveBeenCalledTimes(1);
	});
});
