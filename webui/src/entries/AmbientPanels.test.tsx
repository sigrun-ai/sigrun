/**
 * AmbientPanels navigate seam (notices Task 6): an ambient `navigate`
 * button routes through the shell's navigate seam passed as the
 * `onNavigate` prop; `open` stays channel-local in the block renderer
 * (a noopener new tab, never dispatched).
 */

import { act, createElement as h } from "react";
import { describe, expect, test, vi } from "vitest";
import type { AmbientWire } from "../api";
import { render } from "../test-utils";
import { AmbientPanel } from "./AmbientPanels";

const TREE_V = 1;

function navigateSurface(): AmbientWire {
	return {
		key: "go",
		owner: "acme-ext",
		place: "panel",
		expires: "never",
		updatedAt: 1,
		body: {
			v: TREE_V,
			root: {
				type: "callout",
				id: "c1",
				tone: "info",
				title: "Acme digest",
				actions: [
					{
						id: "open-chat",
						label: "Open chat",
						action: { type: "navigate", target: { conversation: 7 } },
					},
				],
			},
		},
	} as AmbientWire;
}

describe("AmbientPanels navigate seam", () => {
	test("an ambient navigate action routes through the navigate prop", () => {
		const navigated: unknown[] = [];
		const renderer = render(
			h(AmbientPanel, {
				surface: navigateSurface(),
				onNavigate: (target) => navigated.push(target),
			}),
		);
		const button = renderer.root.findByProps({ className: "blk-action" });
		act(() => {
			button.props.onClick();
		});
		expect(navigated).toEqual([{ conversation: 7 }]);
	});

	test("without the prop a navigate action no-ops", () => {
		const renderer = render(h(AmbientPanel, { surface: navigateSurface() }));
		const button = renderer.root.findByProps({ className: "blk-action" });
		act(() => {
			button.props.onClick();
		});
		// Nothing threw and nothing navigated — the prop is optional so
		// existing renders (SeamComponents) stay green.
		expect(renderer.toJSON()).toBeTruthy();
	});

	test("open uses noopener", () => {
		const opened: { url: string; target: string; features: string }[] = [];
		vi.stubGlobal("open", (url: string, target: string, features: string) => {
			opened.push({ url, target, features });
		});
		const surface = {
			...navigateSurface(),
			body: {
				v: TREE_V,
				root: {
					type: "callout",
					id: "c2",
					tone: "info",
					title: "Acme link",
					actions: [
						{
							id: "docs",
							label: "Docs",
							action: { type: "open", url: "https://docs.example.invalid/" },
						},
					],
				},
			},
		} as AmbientWire;
		const renderer = render(h(AmbientPanel, { surface, onNavigate: () => {} }));
		const button = renderer.root.findByProps({ className: "blk-action" });
		act(() => {
			button.props.onClick();
		});
		expect(opened).toEqual([
			{ url: "https://docs.example.invalid/", target: "_blank", features: "noopener" },
		]);
		vi.unstubAllGlobals();
	});
});
