/**
 * Rail (B2, UI refresh): the 52px section rail — brand mark, the single
 * active Chats entry, a spacer, the health dot (data-health ok/degraded
 * derived from /v1/meta), and the Settings button. The dot's title is the
 * rail's hover surface for extension + backup status (the old TopBar's
 * badges collapsed into one quiet indicator).
 */

import { describe, expect, test, vi } from "vitest";
import type { MetaResponse } from "../api";
import { render } from "../test-utils";
import { Rail } from "./Rail";

function makeMeta(init?: {
	readonly extensions?: MetaResponse["extensions"];
	readonly health?: MetaResponse["health"];
}): MetaResponse {
	return {
		harnessVersion: "1.0.2",
		schemaVersion: "abc123",
		extensions: init?.extensions ?? [
			{ name: "memory", status: "ok" },
			{ name: "approvals", status: "ok" },
		],
		health: init?.health ?? {
			backup: "unconfigured",
			memory: "ok",
			providers: "ok",
		},
		auth: { methods: [], claimed: true },
		capabilities: { backup: false, channels: ["webui"] },
		seam: { interactions: [], ambient: [] },
		collisions: { webui: [], providers: [] },
		};
}

describe("Rail", () => {
	test("renders the brand, the active Chats entry, and Settings", () => {
		const renderer = render(<Rail meta={makeMeta()} onOpenSettings={() => {}} />);
		// The brand is the rune mark; its accessible name is the product name.
		const brand = renderer.root.findByProps({ className: "rail-brand" });
		expect(brand.props.title).toBe("sigrun");
		const chats = renderer.root.findByProps({
			className: "rail-btn rail-btn-active",
		});
		expect(chats.props["aria-current"]).toBe("page");
		expect(chats.props.title).toBe("Chats");
	});

	test("health dot is ok when every extension and health field is ok (unconfigured backup is not degraded)", () => {
		const renderer = render(<Rail meta={makeMeta()} onOpenSettings={() => {}} />);
		const dot = renderer.root.findByProps({ className: "rail-health" });
		expect(dot.props["data-health"]).toBe("ok");
	});

	test("a quarantined extension degrades the health dot", () => {
		const renderer = render(
			<Rail
				meta={makeMeta({
					extensions: [
						{ name: "memory", status: "ok" },
						{ name: "approvals", status: "quarantined" },
					],
				})}
				onOpenSettings={() => {}}
			/>,
		);
		const dot = renderer.root.findByProps({ className: "rail-health" });
		expect(dot.props["data-health"]).toBe("degraded");
	});

	test("degraded memory, providers, or backup degrades the dot", () => {
		const cases: readonly MetaResponse["health"][] = [
			{ backup: "unconfigured", memory: "degraded", providers: "ok" },
			{ backup: "unconfigured", memory: "ok", providers: "degraded" },
			{ backup: "degraded", memory: "ok", providers: "ok" },
		];
		for (const health of cases) {
			const renderer = render(
				<Rail meta={makeMeta({ health })} onOpenSettings={() => {}} />,
			);
			expect(
				renderer.root.findByProps({ className: "rail-health" }).props[
					"data-health"
				],
			).toBe("degraded");
		}
	});

	test("the dot's title lists the extensions and the backup status", () => {
		const renderer = render(
			<Rail
				meta={makeMeta({
					extensions: [
						{ name: "memory", status: "ok" },
						{ name: "approvals", status: "quarantined" },
					],
				})}
				onOpenSettings={() => {}}
			/>,
		);
		const title = renderer.root.findByProps({ className: "rail-health" })
			.props.title as string;
		expect(title).toContain("memory: ok");
		expect(title).toContain("approvals: quarantined");
		expect(title).toContain("backup: unconfigured");
	});

	test("with no extensions the title says 'extensions: none'", () => {
		const renderer = render(
			<Rail
				meta={makeMeta({ extensions: [], health: { backup: "configured", memory: "ok", providers: "ok" } })}
				onOpenSettings={() => {}}
			/>,
		);
		const title = renderer.root.findByProps({ className: "rail-health" })
			.props.title as string;
		expect(title).toContain("extensions: none");
		expect(title).toContain("backup: configured");
	});

	test("the Settings button forwards onOpenSettings", () => {
		const onOpenSettings = vi.fn();
		const renderer = render(
			<Rail meta={makeMeta()} onOpenSettings={onOpenSettings} />,
		);
		const settings = renderer.root.findByProps({ "aria-label": "settings" });
		expect(settings.props.title).toBe("Settings");
		(settings.props as { onClick: () => void }).onClick();
		expect(onOpenSettings).toHaveBeenCalledTimes(1);
	});
});
