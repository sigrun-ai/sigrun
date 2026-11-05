/**
 * Rail (tabs Task 1): the 52px rail is the desktop TAB BAR — one tab per
 * view (Chats, the core views /v1/meta lists, the extension views, then
 * spacer, health, user, logout, Settings). Tab clicks dispatch
 * `onOpenTab(tab)`; clicking the ACTIVE tab dispatches nothing.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { MetaResponse } from "../api";
import { render } from "../test-utils";
import { Rail } from "./Rail";

function makeMeta(init?: {
	readonly extensions?: MetaResponse["extensions"];
	readonly health?: MetaResponse["health"];
	readonly coreViews?: MetaResponse["coreViews"];
}): MetaResponse {
	return {
		version: "0.0.0-test",
		harnessVersion: "1.0.2",
		schemaVersion: "abc123",
		listener: { host: "::", port: 3000, families: ["ipv4", "ipv6"] },
		extensions: init?.extensions ?? [
			{ name: "memory", status: "ok" },
			{ name: "gatekeeper", status: "ok" },
		],
		health: init?.health ?? {
			backup: "unconfigured",
			memory: "ok",
			providers: "ok",
		},
		auth: { methods: [], claimed: true },
		backup: {},
		capabilities: { backup: false, channels: ["webui"] },
		dev: false,
		supervised: false,
		isolation: { mode: "auto", active: false, available: false, abi: 0, osUsers: "off" },
		seam: { interactions: [], ambient: [] },
		collisions: { webui: [], providers: [], commands: [] },
		publishedHooks: [],
		...(init?.coreViews === undefined ? {} : { coreViews: init.coreViews }),
	};
}

describe("Rail", () => {
	test("renders the brand, the active Chats tab, and the Settings tab", () => {
		const renderer = render(<Rail meta={makeMeta()} />);
		// The brand is the gull-wing mark; its accessible name is the product name.
		const brand = renderer.root.findByProps({ className: "rail-brand" });
		expect(brand.props.title).toBe("sigrun");
		const chats = renderer.root.findByProps({
			className: "rail-btn rail-btn-active",
		});
		expect(chats.props["aria-current"]).toBe("page");
		expect(chats.props.title).toBe("Chats");
		expect(
			renderer.root.findAllByProps({ "data-rail-section": "settings" }),
		).toHaveLength(1);
	});

	test("the brand mark is the gull wing — two stroke paths at weight 1.9 (0.4.0 Task 8)", () => {
		const renderer = render(<Rail meta={makeMeta()} />);
		const brand = renderer.root.findByProps({ className: "rail-brand" });
		const svg = brand.findByType("svg");
		expect(svg.type).toBe("svg");
		// The icon set's conventions hold: 24×24 viewBox, currentColor ink,
		// no fill, round caps/joins, the brand's single heavier weight.
		expect(svg.props.viewBox).toBe("0 0 24 24");
		expect(svg.props.fill).toBe("none");
		expect(svg.props.stroke).toBe("currentColor");
		expect(svg.props.strokeWidth).toBe(1.9);
		expect(svg.props.strokeLinecap).toBe("round");
		expect(svg.props.strokeLinejoin).toBe("round");
		// The picked mark (candidate A, "Gull Wing"): a long primaries sweep
		// rising into a short leading edge — drawn twice. The exact path
		// literals are the pick's geometry; changing them is a brand decision.
		const paths = svg.findAll((node) => node.type === "path");
		expect(paths.map((path) => path.props.d)).toEqual([
			"M4 16c3.2-1.4 6.9-4.6 8.4-8.4l.6 2.2 2.2.6",
			"M8.5 18.5c2.7-1.5 5.4-4.4 6.6-7.4l1.5 1.2 1.9-.3",
		]);
	});

	test("no rune or Norse-script text anywhere in the rail tree or the icon set source", () => {
		const renderer = render(<Rail meta={makeMeta()} />);
		const tree = JSON.stringify(renderer.toJSON());
		// The Unicode Runic block (U+16A0–U+16FF) covers every Norse-script
		// glyph the outgoing sowilo mark used.
		expect(tree).not.toMatch(/[\u16A0-\u16FF]/);
		expect(tree).not.toContain("sowilo");
		// The source file too — the outgoing mark also lived in comments.
		const source = readFileSync(new URL("./icons.tsx", import.meta.url), "utf8");
		// The Runic block again, plus the words the old comments used.
		expect(source).not.toMatch(/[\u16A0-\u16FF]/);
		expect(source).not.toContain("sowilo");
		expect(source).not.toContain("rune");
	});

	test("health dot is ok when every extension and health field is ok (unconfigured backup is not degraded)", () => {
		const renderer = render(<Rail meta={makeMeta()} />);
		const dot = renderer.root.findByProps({ className: "rail-health" });
		expect(dot.props["data-health"]).toBe("ok");
	});

	test("a quarantined extension degrades the health dot", () => {
		const renderer = render(
			<Rail
				meta={makeMeta({
					extensions: [
						{ name: "memory", status: "ok" },
						{ name: "gatekeeper", status: "quarantined" },
					],
				})}
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
				<Rail meta={makeMeta({ health })} />,
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
						{ name: "gatekeeper", status: "quarantined" },
					],
				})}
			/>,
		);
		const title = renderer.root.findByProps({ className: "rail-health" })
			.props.title as string;
		expect(title).toContain("memory: ok");
		expect(title).toContain("gatekeeper: quarantined");
		expect(title).toContain("backup: unconfigured");
	});

	test("with no extensions the title says 'extensions: none'", () => {
		const renderer = render(
			<Rail
				meta={makeMeta({ extensions: [], health: { backup: "configured", memory: "ok", providers: "ok" } })}
			/>,
		);
		const title = renderer.root.findByProps({ className: "rail-health" })
			.props.title as string;
		expect(title).toContain("extensions: none");
		expect(title).toContain("backup: configured");
	});

	test("an IdP session shows the identity and sign-out controls", () => {
		const onLogout = vi.fn();
		const renderer = render(
			<Rail
				meta={makeMeta()}
				identity={{ user: "idp-user", admin: false, service: false, method: "session", provider: "login:oauth:corp" }}
				onLogout={onLogout}
			/>,
		);
		expect(renderer.root.findByProps({ className: "rail-user" }).props.children).toBe("idp-user");
		const logout = renderer.root.findByProps({ "data-rail-section": "logout" });
		logout.props.onClick();
		expect(onLogout).toHaveBeenCalledOnce();
	});

	test("activeTab=null is the NO-TAB signal (the dev Blocks gallery): no tab is active", () => {
		const renderer = render(<Rail meta={makeMeta()} activeTab={null} />);
		// No active class, no aria-current anywhere — the gallery rides a
		// hash section outside the tab router (matches the pre-task
		// chatsActive gate: Chats is NOT active on #/blocks).
		expect(
			renderer.root.findAllByProps({ className: "rail-btn rail-btn-active" }),
		).toHaveLength(0);
		expect(
			renderer.root.findAll(
				(node) => node.props["aria-current"] !== undefined,
			),
		).toHaveLength(0);
	});
	test("tab clicks dispatch onOpenTab with the tab id; the ACTIVE tab dispatches nothing", () => {
		const onOpenTab = vi.fn();
		const renderer = render(
			<Rail meta={makeMeta()} activeTab="chats" onOpenTab={onOpenTab} />,
		);
		// Clicking the active tab (chats) dispatches NOTHING — no duplicate
		// history entry for a view already showing.
		const chats = renderer.root.findByProps({ "data-rail-section": "chats" });
		(chats.props as { onClick: () => void }).onClick();
		expect(onOpenTab).not.toHaveBeenCalled();
		// A different tab dispatches its id.
		const settings = renderer.root.findByProps({
			"data-rail-section": "settings",
		});
		(settings.props as { onClick: () => void }).onClick();
		expect(onOpenTab).toHaveBeenCalledWith("settings");
		expect(onOpenTab).toHaveBeenCalledTimes(1);
	});

	test("the active tab carries the active class + aria-current", () => {
		const active = render(<Rail meta={makeMeta()} activeTab="settings" />);
		const activeButton = active.root.findByProps({
			"data-rail-section": "settings",
		});
		expect(activeButton.props.className).toBe("rail-btn rail-btn-active");
		expect(activeButton.props["aria-current"]).toBe("page");
		// Off its tab: a plain button.
		const inactive = render(<Rail meta={makeMeta()} activeTab="chats" />);
		const inactiveButton = inactive.root.findByProps({
			"data-rail-section": "settings",
		});
		expect(inactiveButton.props.className).toBe("rail-btn");
		expect(inactiveButton.props["aria-current"]).toBeUndefined();
	});

	test("the Blocks gallery entry is absent without dev meta and present with dev: true (U1 Task 6)", () => {
		const hasBlocksEntry = (root: unknown): boolean => {
			const entries = (root as { findAllByProps(p: object): unknown[] })
				.findAllByProps({ "data-rail-section": "blocks" });
			return entries.length > 0;
		};
		// Default meta (dev: false): the entry must NOT render even when the
		// handler is supplied — a gate regression otherwise ships to prod.
		const withoutDev = render(
			<Rail
				meta={makeMeta()}
				onOpenGallery={() => {}}
			/>,
		);
		expect(hasBlocksEntry(withoutDev.root)).toBe(false);
		const withDev = render(
			<Rail
				meta={{ ...makeMeta(), dev: true }}
				onOpenGallery={() => {}}
			/>,
		);
		expect(hasBlocksEntry(withDev.root)).toBe(true);
	});
});

describe("Rail core views (tabs Task 1, fed by Task 4's coreViewEntries)", () => {
	function coreMeta(): MetaResponse {
		return makeMeta({
			coreViews: [
				{ id: "skills", title: "Skills", icon: "book" },
				{ id: "jobs", title: "Jobs", icon: "list" },
			],
		});
	}

	test("the Skills and Jobs tabs render ONLY when meta.coreViews lists them", () => {
		const without = render(<Rail meta={makeMeta()} />);
		expect(
			without.root.findAllByProps({ "data-rail-section": "skills" }),
		).toHaveLength(0);
		expect(
			without.root.findAllByProps({ "data-rail-section": "jobs" }),
		).toHaveLength(0);
		const withCore = render(<Rail meta={coreMeta()} />);
		expect(
			withCore.root.findAllByProps({ "data-rail-section": "skills" }),
		).toHaveLength(1);
		expect(
			withCore.root.findAllByProps({ "data-rail-section": "jobs" }),
		).toHaveLength(1);
	});

	test("a core view tab click dispatches its tab id (skills/jobs)", () => {
		const onOpenTab = vi.fn();
		const renderer = render(
			<Rail meta={coreMeta()} activeTab="chats" onOpenTab={onOpenTab} />,
		);
		const skills = renderer.root.findByProps({ "data-rail-section": "skills" });
		(skills.props as { onClick: () => void }).onClick();
		expect(onOpenTab).toHaveBeenCalledWith("skills");
	});

	test("a core view icon renders through the blocks icon set, not the title's first letter", () => {
		const renderer = render(<Rail meta={coreMeta()} />);
		const skills = renderer.root.findByProps({ "data-rail-section": "skills" });
		// The "book" icon renders the blocks Icon component (an svg); the old
		// letter fallback would render the text "S".
		expect(skills.findAllByType("svg")).toHaveLength(1);
		expect(skills.findAllByType("svg")[0]?.props.className).toContain(
			"blk-icon",
		);
		// No letter fallback: the button's children are the icon, not text.
		expect(skills.findAll((node) => typeof node.children === "string")).toHaveLength(0);
	});
});

describe("Rail extension views (UI-blocks U3 Task 5)", () => {
	function extMeta(surfaces?: readonly { id: string; title: string; icon: string; placement: "view" | "panel" }[]): MetaResponse {
		return makeMeta({
			extensions: [
				{
					name: "fixture-surfaces",
					status: "ok",
					...(surfaces === undefined ? {} : { surfaces }),
				},
			],
		});
	}

	test("an extension view renders one rail tab after the core entries", () => {
		const renderer = render(
			<Rail
				meta={extMeta([
					{ id: "board", title: "Acme board", icon: "board", placement: "view" },
				])}
			/>,
		);
		const entry = renderer.root.findByProps({
			"data-rail-section": "ext:fixture-surfaces/board",
		});
		expect(entry.props.title).toBe("Acme board");
	});

	test("an ext view entry with icon 'book' renders the blocks icon component, not the letter", () => {
		const renderer = render(
			<Rail
				meta={extMeta([
					{ id: "board", title: "Acme board", icon: "book", placement: "view" },
				])}
			/>,
		);
		const entry = renderer.root.findByProps({
			"data-rail-section": "ext:fixture-surfaces/board",
		});
		// The blocks Icon renders an svg with the blk-icon class; the old
		// fallback rendered the title's first letter as text.
		const svgs = entry.findAllByType("svg");
		expect(svgs).toHaveLength(1);
		expect(svgs[0]?.props.className).toContain("blk-icon");
		expect(entry.findAll((node) => typeof node.children === "string")).toHaveLength(0);
	});

	test("a panel surface does NOT render a rail entry", () => {
		const renderer = render(
			<Rail
				meta={extMeta([
					{ id: "stats", title: "Acme stats", icon: "chart", placement: "panel" },
				])}
			/>,
		);
		const found = renderer.root.findAllByProps({
			"data-rail-section": "ext:fixture-surfaces/stats",
		});
		expect(found).toHaveLength(0);
	});

	test("a surface the principal cannot see (access none) has NO rail entry", () => {
		const renderer = render(
			<Rail
				meta={extMeta([
					{ id: "board", title: "Acme board", icon: "board", placement: "view" },
				])}
				hiddenExtSurfaces={["fixture-surfaces/board"]}
			/>,
		);
		expect(
			renderer.root.findAllByProps({
				"data-rail-section": "ext:fixture-surfaces/board",
			}),
		).toHaveLength(0);
	});

	test("an ext view tab click dispatches its ext:<slug>/<id> tab id", () => {
		const onOpenTab = vi.fn();
		const renderer = render(
			<Rail
				meta={extMeta([
					{ id: "board", title: "Acme board", icon: "board", placement: "view" },
				])}
				activeTab="chats"
				onOpenTab={onOpenTab}
			/>,
		);
		const entry = renderer.root.findByProps({
			"data-rail-section": "ext:fixture-surfaces/board",
		});
		(entry.props as { onClick: () => void }).onClick();
		expect(onOpenTab).toHaveBeenCalledWith("ext:fixture-surfaces/board");
	});

	test("the active ext tab is marked current and its click dispatches nothing", () => {
		const onOpenTab = vi.fn();
		const renderer = render(
			<Rail
				meta={extMeta([
					{ id: "board", title: "Acme board", icon: "board", placement: "view" },
				])}
				activeTab="ext:fixture-surfaces/board"
				onOpenTab={onOpenTab}
			/>,
		);
		const entry = renderer.root.findByProps({
			"data-rail-section": "ext:fixture-surfaces/board",
		});
		expect(entry.props.className).toBe("rail-btn rail-btn-active");
		expect(entry.props["aria-current"]).toBe("page");
		(entry.props as { onClick: () => void }).onClick();
		expect(onOpenTab).not.toHaveBeenCalled();
	});
});
