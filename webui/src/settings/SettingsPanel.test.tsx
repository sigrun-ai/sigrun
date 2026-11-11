/**
 * SettingsPanel (UI-blocks U4 Task 4): the settings editor over
 * `GET /v1/settings/sections` — the nav + search from the sections
 * payload, every non-cove section a `SurfaceView` over its
 * `/v1/ext/<slug>/surfaces/<id>` mount, the Interface/Providers/
 * Extensions coves their channels-native components, and the
 * pending-restart callout reading the General section's `meta` block.
 *
 * The fetch-stub harness serves the sections list, the surface
 * render/action routes (a minimal in-memory settings surface), the
 * extension cove's routes, and /v1/meta — the panel never touches
 * /v1/settings itself anymore.
 */

import { act, useState } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";
import {
	createClient,
	type ExtensionInfoWire,
	type FetchLike,
	type SettingsSectionIndexEntryWire,
} from "../api";
import type { JsonObject, SurfaceActResult } from "@sigrun/shared/blocks";
import { renderAsync, textContent } from "../test-utils";
import {
	useTheme,
	type ThemeRoot,
	type ThemeState,
	type ThemeStorage,
} from "../theme/useTheme";
import { SettingsPanel, visibleSettingsSections } from "./SettingsPanel";
import type { SettingsSectionEntryWire } from "../api";
import { usePrefs } from "./usePrefs";

interface Call {
	readonly input: string;
	readonly method?: string;
	readonly body?: string | Uint8Array;
}

/** The extension fixtures the Extensions-cove tests serve. */
const EXTENSIONS_FIXTURE: ExtensionInfoWire = {
	name: "acme-tool",
	settingsPage: true,
	status: "ok",
	interactionKinds: [],
	ambientKeys: [],
	workers: [],
	services: [],
};

interface ExtensionsHarness {
	readonly list: readonly ExtensionInfoWire[];
	readonly settings?: Readonly<Record<string, Record<string, unknown>>>;
	readonly secrets?: Readonly<
		Record<string, readonly { key: string; source: string }[]>
	>;
}

/** The sections the fake server's `/v1/settings/sections` serves. */
const SECTIONS = [
	{ slug: "core", id: "general", title: "General", icon: "key", group: "system" },
	{ slug: "core", id: "interface", title: "Interface", icon: "image", group: "mine" },
	{ slug: "core", id: "advanced", title: "Advanced", icon: "more", group: "system" },
	{ slug: "core", id: "providers", title: "Providers", icon: "cloud", group: "system" },
	{ slug: "core", id: "accounts", title: "Account links", icon: "key", group: "mine" },
	{ slug: "core", id: "tokens", title: "API tokens", icon: "lock", group: "mine" },
] as const;

const INDEX: readonly SettingsSectionIndexEntryWire[] = [
	{ slug: "core", sectionId: "general", kind: "section", label: "General" },
	{
		slug: "core",
		sectionId: "general",
		kind: "core-key",
		label: "Naming model",
		help: "The model the conversation auto-namer completes through",
		key: "namingModel",
	},
	{
		slug: "core",
		sectionId: "advanced",
		kind: "core-key",
		label: "Listen port",
		key: "server.port",
	},
];

/** The General form the fake surface serves (the naming-model field the
 *  search test focuses). */
const GENERAL_FORM = {
	v: 1,
	root: {
		type: "form",
		id: "core-general-form",
		bind: "/settings",
		mode: "submit",
		onSubmit: "save",
		submitLabel: "Save",
		children: [
			{
				type: "text",
				name: "namingModel",
				label: "Naming model",
				help: "The model the conversation auto-namer completes through",
				apply: "live",
			},
		],
	},
} as const;

function makeHarness(init?: {
	/** The General surface's stored values (absent → {}). */
	readonly general?: JsonObject;
	/** The General surface's meta block (the callout's source). */
	readonly meta?: JsonObject;
	/** The sections payload override (the ordering test's fixture). */
	readonly sectionsResponse?: {
		readonly sections: readonly {
			readonly slug: string;
			readonly id: string;
			readonly title: string;
			readonly icon: string;
			readonly page?: string;
			readonly scope?: "user";
			readonly admin?: boolean;
			readonly group?: "mine" | "system";
		}[];
		readonly index: readonly SettingsSectionIndexEntryWire[];
	};
	/** The Extensions-cove fixtures. */
	readonly extensions?: ExtensionsHarness;
	/** The meta response (the version line). */
	readonly metaResponse?: JsonObject;
}) {
	const calls: Call[] = [];
	// The surface instance state: a rev + the stored values (the save
	// action bumps the rev — the stale-rev test's lever).
	let rev = 0;
	let values: JsonObject = { ...(init?.general ?? {}) };
	const ext = init?.extensions;
	const secretState = new Map<string, readonly { key: string; source: string }[]>(
		Object.entries(ext?.secrets ?? {}).map(([slug, keys]) => [slug, [...keys]]),
	);
	const meta = init?.meta ?? { pendingRestart: [], env: {}, supervised: false };
	const fetchImpl: FetchLike = (input, init2) => {
		calls.push({ input, method: init2?.method, body: init2?.body });
		let m: RegExpMatchArray | null;
		let body: unknown = {};
		if (input === "/v1/meta") {
			body = init?.metaResponse ?? { version: "0.1.0", harnessVersion: "1.0.0" };
		} else if (input === "/v1/settings/sections") {
			body = init?.sectionsResponse ?? { sections: [...SECTIONS], index: [...INDEX] };
		} else if (input === "/v1/ext/core/surfaces/general" && init2?.method !== "POST") {
			body = {
				tree: GENERAL_FORM,
				data: { settings: values, meta },
				rev,
				treeRev: 0,
				access: "write",
			};
		} else if (input.startsWith("/v1/ext/core/surfaces/general/data")) {
			// The panel's meta probe polls the data channel (the
			// pending-restart callout reads it).
			body = { rev, treeRev: 0, data: { settings: values, meta } };
		} else if (input === "/v1/ext/core/surfaces/general/actions") {
			const parsed = JSON.parse(init2?.body as string) as {
				payload: { rev: number; values: Record<string, unknown> };
			};
			let result: SurfaceActResult;
			if (parsed.payload.rev !== rev) {
				result = { ok: false, error: { message: "changed by someone else" } };
			} else {
				rev += 1;
				// The test's stored values are the submitted ones (the
				// payload's Record<string, unknown> narrows field-wise — the
				// fake surface keeps the values verbatim).
				values = { ...values, ...parsed.payload.values } as JsonObject;
				result = { ok: true, rev };
			}
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () => Promise.resolve(result),
				text: () => Promise.resolve(JSON.stringify(result)),
			});
		} else if (input === "/v1/extensions") {
			body = { extensions: ext?.list ?? [] };
		} else if ((m = input.match(/^\/v1\/extensions\/([^/]+)\/settings$/)) !== null) {
			const slug = decodeURIComponent(m[1]);
			if (init2?.method === "PUT") {
				body = {
					settings: JSON.parse(init2.body as string),
					pendingRestart: [],
				};
			} else {
				body = { settings: ext?.settings?.[slug] ?? {}, pendingRestart: [] };
			}
		} else if ((m = input.match(/^\/v1\/extensions\/([^/]+)\/secrets$/)) !== null) {
			const slug = decodeURIComponent(m[1]);
			body = { secrets: secretState.get(slug) ?? [] };
		} else if (
			(m = input.match(/^\/v1\/extensions\/([^/]+)\/secrets\/([^/]+)$/)) !== null
		) {
			const slug = decodeURIComponent(m[1]);
			const key = decodeURIComponent(m[2]);
			const keys = [...(secretState.get(slug) ?? [])].filter(
				(row) => row.key !== key,
			);
			if (init2?.method === "PUT") {
				keys.push({ key, source: "stored" });
				keys.sort((a, b) => a.key.localeCompare(b.key));
			}
			secretState.set(slug, keys);
			body = { secrets: keys };
		} else if (input === "/v1/providers") {
			body = { providers: [{ provider: "acme-provider", owner: "acme-tool", status: "ready", models: 2 }] };
		} else if (input === "/v1/auth/accounts") {
			body = { accounts: [] };
		} else if (input === "/v1/auth/providers") {
			body = { providers: [] };
		} else {
			throw new Error(`unexpected fetch ${init2?.method ?? "GET"} ${input}`);
		}
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve(body),
			text: () => Promise.resolve(JSON.stringify(body)),
		});
	};
	return {
		calls,
		client: createClient({
			fetch: fetchImpl,
			// The surface transports ride the same stub (the raw,
			// non-throwing shape — a 4xx must REACH the transport).
			rawFetch: fetchImpl as unknown as (
				input: string,
				init?: {
					readonly method?: string;
					readonly headers?: Record<string, string>;
					readonly body?: string | Uint8Array;
				},
			) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
		}),
	};
}

/** A minimal in-memory storage (useTheme's localStorage surface). */
function makeThemeStorage(): ThemeStorage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => {
			map.set(key, value);
		},
	};
}

/** A minimal fake root element (useTheme's dataset + setProperty surface). */
function makeThemeRoot(): { root: ThemeRoot; dataset: Record<string, string | undefined> } {
	const dataset: Record<string, string | undefined> = {};
	return {
		dataset,
		root: {
			dataset,
			setProperty: () => undefined,
		},
	};
}

/** A matchMedia stub that always reports a dark system preference. */
const darkMatchMedia = () => () => ({
	matches: true,
	addEventListener: () => undefined,
	removeEventListener: () => undefined,
});

/** The captured restart action (the callout's button). */
interface Rendered {
	readonly renderer: TestRenderer.ReactTestRenderer;
	readonly prefs: () => ReturnType<typeof usePrefs>["prefs"];
	readonly themeRoot: Record<string, string | undefined>;
	readonly restarts: () => number;
	/** Every id the nav handed to onSection, in order. */
	readonly onSectionCalls: () => readonly string[];
}

function renderPanelWithPrefs(
	client: ReturnType<typeof createClient>,
	init?: {
		readonly admin?: boolean;
		/** The route's section id (the controlled prop's initial value). */
		readonly section?: string;
		/** The route writer spy (the host defaults to a state round-trip so
		 * nav clicks genuinely switch the section like the App would). */
		readonly onSection?: (id: string) => void;
	},
): Promise<Rendered> {
	const themeRoot = makeThemeRoot();
	let captured: ReturnType<typeof usePrefs> | undefined;
	let theme: ThemeState | undefined;
	let restarts = 0;
	const onSectionCalls: string[] = [];
	function Probe() {
		// The controlled-section host: in the real shell the route owns the
		// section and the panel's nav calls onSection back into it — the
		// host mirrors that round trip so nav clicks land like the App.
		const [section, setSection] = useState<string | undefined>(init?.section);
		captured = usePrefs();
		theme = useTheme({
			storage: makeThemeStorage(),
			root: themeRoot.root,
			matchMedia: darkMatchMedia(),
		});
		return (
			<SettingsPanel
				client={client}
				prefsState={captured}
				theme={theme}
				{...(init?.admin === undefined ? {} : { admin: init.admin })}
				section={section}
				onSection={(id) => {
					onSectionCalls.push(id);
					init?.onSection?.(id);
					setSection(id);
				}}
				onRestart={async () => {
					restarts += 1;
				}}
			/>
		);
	}
	return renderAsync(<Probe />).then((renderer) => ({
		renderer,
		prefs: () => {
			if (captured === undefined) throw new Error("prefs not captured");
			return captured.prefs;
		},
		themeRoot: themeRoot.dataset,
		restarts: () => restarts,
		onSectionCalls: () => [...onSectionCalls],
	}));
}

function renderPanel(client: ReturnType<typeof createClient>) {
	return renderPanelWithPrefs(client).then(({ renderer }) => renderer);
}

function find<T extends TestRenderer.ReactTestInstance>(
	renderer: TestRenderer.ReactTestRenderer,
	className: string,
): T {
	return renderer.root.findByProps({ className }) as T;
}

/** Click one section-nav button. */
async function openSection(
	renderer: TestRenderer.ReactTestRenderer,
	name: string,
) {
	const button = renderer.root
		.findAllByType("button")
		.find(
			(node) =>
				typeof node.props.className === "string" &&
				node.props.className.startsWith("settings-nav-item") &&
				node.props.children === name,
		);
	if (button === undefined) throw new Error(`section ${name} not rendered`);
	await act(async () => {
		button.props.onClick();
	});
	// The SurfaceView's load is async — let it settle.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("SettingsPanel", () => {
	test("initial selection and navigation share the same non-admin visible section set", () => {
		// A known non-admin sees only the My-settings sections.
		expect(visibleSettingsSections(SECTIONS, false)).toEqual(
			SECTIONS.filter((section) => section.group === "mine"),
		);
	});

	test("two nav groups for admins", async () => {
		const groupedSections = [
			{ slug: "core", id: "general", title: "General", icon: "key", group: "system" as const },
			{ slug: "core", id: "interface", title: "Interface", icon: "image", group: "mine" as const },
			{ slug: "core", id: "advanced", title: "Advanced", icon: "more", group: "system" as const },
			{ slug: "core", id: "providers", title: "Providers", icon: "cloud", group: "system" as const },
			{ slug: "core", id: "accounts", title: "Account links", icon: "key", group: "mine" as const },
			{ slug: "core", id: "tokens", title: "API tokens", icon: "lock", group: "mine" as const },
		];
		const { client } = makeHarness({
			sectionsResponse: { sections: groupedSections, index: [...INDEX] },
		});
		const { renderer } = await renderPanelWithPrefs(client, { admin: true });
		const text = textContent(renderer.toJSON());
		expect(text).toContain("My settings");
		expect(text).toContain("System settings");
	});

	test("non-admins see only My settings", async () => {
		const groupedSections = [
			{ slug: "core", id: "general", title: "General", icon: "key", group: "system" as const },
			{ slug: "core", id: "interface", title: "Interface", icon: "image", group: "mine" as const },
			{ slug: "core", id: "advanced", title: "Advanced", icon: "more", group: "system" as const },
			{ slug: "core", id: "providers", title: "Providers", icon: "cloud", group: "system" as const },
			{ slug: "core", id: "accounts", title: "Account links", icon: "key", group: "mine" as const },
			{ slug: "core", id: "tokens", title: "API tokens", icon: "lock", group: "mine" as const },
		];
		const { client } = makeHarness({
			sectionsResponse: { sections: groupedSections, index: [...INDEX] },
		});
		const { renderer } = await renderPanelWithPrefs(client, { admin: false });
		const text = textContent(renderer.toJSON());
		expect(text).toContain("My settings");
		expect(text).not.toContain("System settings");
	});

	test("non-admin deep link to a system page lands in My settings", async () => {
		const groupedSections = [
			{ slug: "core", id: "general", title: "General", icon: "key", group: "system" as const },
			{ slug: "core", id: "interface", title: "Interface", icon: "image", group: "mine" as const },
			{ slug: "core", id: "advanced", title: "Advanced", icon: "more", group: "system" as const },
			{ slug: "core", id: "providers", title: "Providers", icon: "cloud", group: "system" as const },
			{ slug: "core", id: "accounts", title: "Account links", icon: "key", group: "mine" as const },
			{ slug: "core", id: "tokens", title: "API tokens", icon: "lock", group: "mine" as const },
		];
		const nonAdmin = makeHarness({
			sectionsResponse: { sections: groupedSections, index: [...INDEX] },
		});
		const { renderer } = await renderPanelWithPrefs(nonAdmin.client, { admin: false, section: "advanced" });
		// Non-admin deep-linking to a system section lands on the first
		// My settings (mine) section, not the advanced body.
		const text = textContent(renderer.toJSON());
		expect(text).toContain("My settings");
		expect(text).not.toContain("System settings");
		expect(renderer.root.findAllByProps({ "data-settings-section": "advanced" })).toHaveLength(0);
		expect(renderer.root.findAllByProps({ "data-settings-section": "general" })).toHaveLength(0);
		// The first My-settings (mine) section — the Interface cove — opens.
		expect(renderer.root.findAllByProps({ "data-mode-option": "dark" })).toHaveLength(1);
		// The Advanced body was never fetched (no System-section mount).
		expect(nonAdmin.calls.some((call) => call.input.includes("surfaces/advanced"))).toBe(false);
	});

	test("#/settings/tools opens Advanced", async () => {
		const groupedSections = [
			{ slug: "core", id: "general", title: "General", icon: "key", group: "system" as const },
			{ slug: "core", id: "interface", title: "Interface", icon: "image", group: "mine" as const },
			{ slug: "core", id: "advanced", title: "Advanced", icon: "more", group: "system" as const },
			{ slug: "core", id: "providers", title: "Providers", icon: "cloud", group: "system" as const },
			{ slug: "core", id: "accounts", title: "Account links", icon: "key", group: "mine" as const },
			{ slug: "core", id: "tokens", title: "API tokens", icon: "lock", group: "mine" as const },
		];
		const { client } = makeHarness({
			sectionsResponse: { sections: groupedSections, index: [...INDEX] },
		});
		const { renderer } = await renderPanelWithPrefs(client, { admin: true, section: "tools" });
		// Flush the resolve effect (the tools alias maps to advanced).
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
		// The tools route alias resolves to Advanced: the Advanced nav item is active.
		const activeItem = renderer.root.findAllByType("button").find(
			(node) => node.props.className === "settings-nav-item" &&
				node.props["data-active"] !== undefined && node.props.children === "Advanced",
		);
		expect(activeItem).toBeDefined();
		// No Tools entry exists.
		const toolsItem = renderer.root.findAllByType("button").find(
			(node) => typeof node.props.className === "string" && node.props.className.startsWith("settings-nav-item") && node.props.children === "Tools",
		);
		expect(toolsItem).toBeUndefined();
	});

	test("an extension with both schemas has a page in each group", async () => {
		const extSections = [
			{ slug: "curator", id: "settings", title: "Settings", icon: "key", group: "system" as const, page: "curator", admin: true },
			{ slug: "curator", id: "user-settings", title: "Your settings", icon: "key", group: "mine" as const, page: "curator", scope: "user" as const, admin: false },
		];
		const { client } = makeHarness({
			sectionsResponse: { sections: extSections, index: [...INDEX] },
			extensions: { list: [{ ...EXTENSIONS_FIXTURE, name: "curator" }] },
		});
		const { renderer } = await renderPanelWithPrefs(client, { admin: true });
		const text = textContent(renderer.toJSON());
		expect(text).toContain("My settings");
		expect(text).toContain("System settings");
		// #/settings/my:curator draws only Your settings — no header, no
		// credentials, no shared Settings section.
		const mine = makeHarness({
			sectionsResponse: { sections: extSections, index: [...INDEX] },
			extensions: { list: [{ ...EXTENSIONS_FIXTURE, name: "curator" }] },
		});
		const { renderer: mineRenderer } = await renderPanelWithPrefs(mine.client, { admin: true, section: "my:curator" });
		const minePage = mineRenderer.root.findByProps({ "data-extension-page": "curator" });
		expect(minePage.findAllByProps({ "data-extension-part": "user-settings" })).toHaveLength(1);
		expect(minePage.findAllByType("header")).toHaveLength(0);
		expect(minePage.findAllByProps({ "data-extension-part": "settings" })).toHaveLength(0);
		expect(minePage.findAllByProps({ "data-extension-part": "credentials" })).toHaveLength(0);
		// #/settings/curator (the system page) has NO Your settings part.
		const system = makeHarness({
			sectionsResponse: { sections: extSections, index: [...INDEX] },
			extensions: { list: [{ ...EXTENSIONS_FIXTURE, name: "curator" }] },
		});
		const { renderer: systemRenderer } = await renderPanelWithPrefs(system.client, { admin: true, section: "curator" });
		const systemPage = systemRenderer.root.findByProps({ "data-extension-page": "curator" });
		expect(systemPage.findAllByProps({ "data-extension-part": "user-settings" })).toHaveLength(0);
		expect(systemPage.findAllByType("header")).toHaveLength(1);
		expect(systemPage.findAllByProps({ "data-extension-part": "settings" })).toHaveLength(1);
	});

	test("non-admin deep link to an extension's bare slug shows only Your settings", async () => {
		const extSections = [
			{ slug: "curator", id: "settings", title: "Settings", icon: "key", group: "system" as const, page: "curator", admin: true },
			{ slug: "curator", id: "user-settings", title: "Your settings", icon: "key", group: "mine" as const, page: "curator", scope: "user" as const, admin: false },
		];
		const harness = makeHarness({
			sectionsResponse: { sections: extSections, index: [...INDEX] },
			extensions: { list: [{ ...EXTENSIONS_FIXTURE, name: "curator" }] },
		});
		const { renderer } = await renderPanelWithPrefs(harness.client, { admin: false, section: "curator" });
		const page = renderer.root.findByProps({ "data-extension-page": "curator" });
		expect(page.findAllByProps({ "data-extension-part": "user-settings" })).toHaveLength(1);
		expect(page.findAllByType("header")).toHaveLength(0);
		expect(page.findAllByProps({ "data-extension-part": "settings" })).toHaveLength(0);
		expect(page.findAllByType("h2")).toHaveLength(0);
	});

	test("non-admins see an extension's user page without its shared section", async () => {
		const userSections = [
			{ slug: "acme-ext", id: "user-settings", page: "acme-ext", title: "Your settings", icon: "key", scope: "user" as const, admin: false },
			{ slug: "acme-ext", id: "settings", page: "acme-ext", title: "Settings", icon: "key", admin: true },
		];
		const inventory = [{ ...EXTENSIONS_FIXTURE, name: "acme-ext" }];
		const nonAdmin = makeHarness({
			sectionsResponse: { sections: [...SECTIONS, ...userSections], index: [...INDEX] },
			extensions: { list: inventory },
		});
		const { renderer } = await renderPanelWithPrefs(nonAdmin.client, { admin: false });
		expect(visibleSettingsSections(userSections, false)).toEqual([userSections[0]]);
		expect(visibleSettingsSections(userSections, true)).toEqual(userSections);
		const personalGroup = renderer.root.findByProps({ role: "group", "aria-label": "Extensions" });
		expect(personalGroup.findAllByType("button").map((node) => node.props.children)).toEqual(["acme-ext"]);
		const admin = makeHarness({
			sectionsResponse: { sections: [...SECTIONS, ...userSections], index: [...INDEX] },
			extensions: { list: inventory },
		});
		const { renderer: adminRenderer } = await renderPanelWithPrefs(admin.client, { admin: true });
		expect(textContent(adminRenderer.toJSON())).toContain("Settings");
	});

	test("renders the sections nav in My settings / System settings groups, Interface first", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderPanel(client);
		expect(
			calls.some((call) => call.input === "/v1/settings/sections"),
		).toBe(true);
		const navItems = renderer.root
			.findAllByType("button")
			.filter((node) => node.props.className === "settings-nav-item");
		expect(navItems.map((node) => node.props.children)).toEqual([
			"Interface",
			"Account links",
			"API tokens",
			"General",
			"Advanced",
			"Providers",
		]);
		// The Interface cove mounted (the first My-settings section).
		expect(
			renderer.root.findAllByProps({ "data-mode-option": "dark" }),
		).toHaveLength(1);
	});

	test("an extension page follows core in the nav", async () => {
		const { client } = makeHarness({
			sectionsResponse: {
				sections: [
					...SECTIONS,
					{ slug: "acme-ext", id: "settings", page: "acme-ext", title: "Settings", icon: "key", admin: true },
				],
				index: [...INDEX],
			},
			extensions: { list: [{ ...EXTENSIONS_FIXTURE, name: "acme-ext" }] },
		});
		const renderer = await renderPanel(client);
		const group = renderer.root.findByProps({ role: "group", "aria-label": "Extensions" });
		expect(group.findAllByType("button").map((node) => node.props.children)).toContain("acme-ext");
	});

	test("the search filters the index; a hit jumps to its section and focuses the field", async () => {
		const { client } = makeHarness();
		const renderer = await renderPanel(client);
		await act(async () => {
			renderer.root
				.findByProps({ className: "settings-search" })
				.props.onChange({ target: { value: "naming" } });
		});
		const hits = renderer.root.findAllByProps({
			className: "settings-search-hit",
		});
		expect(hits.length).toBeGreaterThan(0);
		expect(textContent(renderer.toJSON())).toContain("Naming model");
		// Click the hit: the General section opens and the field mounts.
		await act(async () => {
			hits[0].props.onClick();
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(
			renderer.root
				.findAllByProps({ "data-settings-section": "general" })
				.length,
		).toBe(1);
		expect(
			renderer.root
				.findAllByType("div")
				.some((node) => node.props["data-name"] === "namingModel"),
		).toBe(true);
	});

	test("the pending-restart callout lists keys; the Restart button shows only for a supervised admin", async () => {
		// Supervised + admin: the button renders and calls the action (General
		// carries the meta block).
		const { client } = makeHarness({
			meta: { pendingRestart: ["server.port"], env: {}, supervised: true },
		});
		const rendered = await renderPanelWithPrefs(client, { admin: true, section: "general" });
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(textContent(rendered.renderer.toJSON())).toContain(
			"Restart sigrun to apply: server.port",
		);
		const button = find(rendered.renderer, "settings-restart");
		await act(async () => {
			button.props.onClick();
		});
		expect(rendered.restarts()).toBe(1);

		// Unsupervised: the text only, no button.
		const second = makeHarness({
			meta: { pendingRestart: ["server.port"], env: {}, supervised: false },
		});
		const secondRenderer = await renderPanelWithPrefs(second.client, {
			admin: true,
			section: "general",
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(textContent(secondRenderer.renderer.toJSON())).toContain(
			"Restart sigrun to apply",
		);
		expect(
			secondRenderer.renderer.root.findAllByProps({
				className: "settings-restart",
			}),
		).toHaveLength(0);
	});

	test("a non-admin deep link to Providers falls back to the first My-settings section; an admin opens Providers", async () => {
		const nonAdmin = makeHarness();
		const nonAdminRenderer = await renderPanelWithPrefs(nonAdmin.client, {
			admin: false,
			section: "providers",
		});
		expect(nonAdminRenderer.renderer.root.findAllByProps({ "data-settings-section": "general" })).toHaveLength(0);
		expect(nonAdminRenderer.renderer.root.findAllByProps({ "data-mode-option": "dark" })).toHaveLength(1);
		expect(nonAdmin.calls.some((call) => call.input === "/v1/providers")).toBe(false);

			const admin = makeHarness();
			const adminRenderer = await renderPanelWithPrefs(admin.client, {
				admin: true,
				section: "providers",
			});
			expect(adminRenderer.renderer.root.findAllByProps({ "data-settings-section": "general" })).toHaveLength(0);
			expect(textContent(adminRenderer.renderer.toJSON())).toContain("acme-provider");
			expect(admin.calls.some((call) => call.input === "/v1/providers")).toBe(true);
		});

	test("Account links is a core cove available to a signed-in non-admin", async () => {
		const { client } = makeHarness();
		const { renderer } = await renderPanelWithPrefs(client, { admin: false });
		const navItems = renderer.root
			.findAllByType("button")
			.filter((node) => node.props.className === "settings-nav-item");
		expect(navItems.map((node) => node.props.children)).toContain("Account links");
		await openSection(renderer, "Account links");
		expect(renderer.root.findAllByProps({ "data-settings-section": "accounts" })).toHaveLength(1);
	});

	test("the Interface cove applies prefs and theme picks live", async () => {
		const { client } = makeHarness();
		const { renderer, prefs, themeRoot } = await renderPanelWithPrefs(client);
		await openSection(renderer, "Interface");
		expect(prefs().enterToSend).toBe(false);
		await act(async () => {
			find(renderer, "settings-pref-enterToSend").props.onChange({
				target: { checked: true },
			});
		});
		expect(prefs().enterToSend).toBe(true);
		await act(async () => {
			renderer.root
				.findByProps({ "data-palette-option": "fjord" })
				.props.onClick();
		});
		expect(themeRoot.palette).toBe("fjord");
	});

	test("clicking a core nav entry calls onSection(id) and the section follows the prop (0.4.0 Task 4)", async () => {
		const onSection = vi.fn();
		const { client } = makeHarness();
		const { renderer } = await renderPanelWithPrefs(client, { onSection });
		const interfaceNav = renderer.root
			.findAllByType("button")
			.find(
				(node) =>
					node.props.className === "settings-nav-item" &&
					node.props.children === "Interface",
			);
		if (interfaceNav === undefined) throw new Error("Interface nav not rendered");
		await act(async () => {
			interfaceNav.props.onClick();
		});
		expect(onSection).toHaveBeenCalledWith("interface");
		// The controlled section switched: the Interface cove's mode
		// buttons mount (a cove — no surface fetch needed).
		expect(
				renderer.root.findAllByProps({ "data-mode-option": "dark" }),
		).toHaveLength(1);
	});

	test("the panel renders as a page — no overlay/backdrop/dialog chrome (0.4.0 Task 4)", async () => {
		const { client } = makeHarness();
		const renderer = await renderPanel(client);
		expect(
			renderer.root.findAllByProps({ className: "settings-overlay" }),
		).toHaveLength(0);
		expect(
			renderer.root.findAllByProps({ className: "panel-backdrop" }),
		).toHaveLength(0);
		expect(renderer.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
		expect(
			renderer.root.findAllByProps({ className: "settings-page" }),
		).toHaveLength(1);
	});
});

describe("SettingsPanel extension pages", () => {
	const EXTENSIONS: readonly ExtensionInfoWire[] = [
		{
			name: "acme-tool",
			settingsPage: true,
			status: "ok",
			interactionKinds: [],
			ambientKeys: [],
			workers: [],
			services: [],
		},
	];

	test("nav labels extensions by title", async () => {
		const harness = makeHarness({
			extensions: { list: [{ ...EXTENSIONS_FIXTURE, name: "sigrun-mcp", title: "MCP" }] },
		});
		const { renderer } = await renderPanelWithPrefs(harness.client);
		const nav = renderer.root.findByProps({
			className: "settings-nav-item settings-nav-extension",
			"data-ext": "sigrun-mcp",
		});
		expect(nav.props.children).toBe("MCP");
		await act(async () => {
			nav.props.onClick();
		});
		const page = renderer.root.findByProps({ "data-extension-page": "sigrun-mcp" });
		expect(page.findByType("h2").props.children).toBe("MCP");
	});

	test("a provider's owner link uses the extension title", async () => {
		const harness = makeHarness({
			extensions: { list: [{ ...EXTENSIONS_FIXTURE, name: "acme-tool", title: "Acme Titled" }] },
		});
		const { renderer, onSectionCalls } = await renderPanelWithPrefs(harness.client, { section: "providers" });
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const link = renderer.root.findByProps({
			className: "settings-provider-page-link",
			"data-owner": "acme-tool",
		});
		expect(link.props.children).toBe("Acme Titled");
		await act(async () => {
			link.props.onClick();
		});
		expect(onSectionCalls()).toContain("acme-tool");
	});

	test("nav lists only settingsPage extensions, sorted by title", async () => {
		const list: readonly ExtensionInfoWire[] = [
			{ ...EXTENSIONS[0], name: "zeta", title: "Zeta", settingsPage: true },
			{ ...EXTENSIONS[0], name: "alpha", title: "alpha", settingsPage: true },
			{ ...EXTENSIONS[0], name: "codemode", settingsPage: undefined },
		];
		const { client } = makeHarness({ extensions: { list } });
		const renderer = await renderPanel(client);
		const group = renderer.root.findByProps({ role: "group", "aria-label": "Extensions" });
		const buttons = group.findAllByProps({ className: "settings-nav-item settings-nav-extension" });
		expect(buttons.map((button) => button.props["data-ext"])).toEqual(["alpha", "zeta"]);
		expect(buttons.map((button) => button.props.children)).toEqual(["alpha", "Zeta"]);
	});

	test("deep link to an extension without settings opens the first My-settings section", async () => {
		const { client } = makeHarness({
			extensions: { list: [{ ...EXTENSIONS_FIXTURE, name: "codemode", settingsPage: undefined }] },
		});
		const { renderer } = await renderPanelWithPrefs(client, { section: "codemode" });
		expect(renderer.root.findAllByProps({ "data-settings-section": "general" })).toHaveLength(0);
		expect(renderer.root.findAllByProps({ "data-extension-page": "codemode" })).toHaveLength(0);
		expect(renderer.root.findAllByProps({ "data-mode-option": "dark" })).toHaveLength(1);
	});

	test("nav lists one Extensions entry per page; no (advanced) rows", async () => {
		const pageSections: readonly SettingsSectionEntryWire[] = [
			{ slug: "acme-one", id: "settings", page: "acme-one", title: "Settings", icon: "key", admin: true },
			{ slug: "acme-one", id: "user-settings", page: "acme-one", title: "Your settings", icon: "key", scope: "user", admin: false },
			{ slug: "acme-two", id: "settings", page: "acme-two", title: "Settings", icon: "key", admin: true },
		];
		const harness = makeHarness({
			sectionsResponse: { sections: [...SECTIONS, ...pageSections], index: [...INDEX] },
			extensions: { list: [{ ...EXTENSIONS[0], name: "acme-one" }, { ...EXTENSIONS[0], name: "acme-two" }] },
		});
		const { renderer, onSectionCalls } = await renderPanelWithPrefs(harness.client);
		const groups = renderer.root.findAllByProps({ role: "group", "aria-label": "Extensions" });
		// Two sub-lists: My settings (extensions with a personal page, here
		// acme-one) and System settings (every extension page).
		expect(groups).toHaveLength(2);
		const labels = groups[0].findAllByType("button").map((node) => node.props.children);
		expect(labels).toEqual(["acme-one"]);
		expect(groups[1].findAllByType("button").map((node) => node.props.children)).toEqual(["acme-one", "acme-two"]);
		const nav = renderer.root.findByProps({ className: "settings-nav" });
		const flatLabels = nav.findAllByType("button")
			.filter((node) => node.props.className === "settings-nav-item")
			.map((node) => node.props.children);
		// My settings first (Interface, Account links, API tokens), then System.
		expect(flatLabels).toEqual(
			["Interface", "Account links", "API tokens"].concat(
				SECTIONS.filter((s) => s.group === "system").map((s) => s.title),
			),
		);
		expect(textContent(renderer.toJSON())).not.toContain("(advanced)");
		await act(async () => {
			groups[1].findAllByType("button")[1].props.onClick();
		});
		expect(onSectionCalls()).toContain("acme-two");
		expect(renderer.root.findAllByProps({ "data-extension-page": "acme-two" })).toHaveLength(1);
	});

	test("Providers rows link to the extension page even when it declares no sections", async () => {
		const harness = makeHarness({
			sectionsResponse: { sections: [...SECTIONS], index: [...INDEX] },
			extensions: { list: EXTENSIONS },
		});
		const { renderer, onSectionCalls } = await renderPanelWithPrefs(harness.client, { section: "providers" });
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const link = renderer.root.findByProps({ className: "settings-provider-page-link", "data-owner": "acme-tool" });
		await act(async () => {
			link.props.onClick();
		});
		expect(onSectionCalls()).toContain("acme-tool");
	});

	test("a non-admin sees only extensions with a visible personal page", async () => {
		const harness = makeHarness({
			sectionsResponse: { sections: [...SECTIONS], index: [...INDEX] },
			extensions: { list: EXTENSIONS },
		});
		const { renderer } = await renderPanelWithPrefs(harness.client, { admin: false });
		expect(renderer.root.findAllByProps({ role: "group", "aria-label": "Extensions" })).toHaveLength(0);
	});

	test("a stale extension route falls back to the first My-settings section", async () => {
		const harness = makeHarness({
			sectionsResponse: { sections: [...SECTIONS], index: [...INDEX] },
			extensions: { list: [] },
		});
		const { renderer } = await renderPanelWithPrefs(harness.client, { section: "missing-extension" });
		expect(renderer.root.findAllByProps({ "data-settings-section": "general" })).toHaveLength(0);
		expect(renderer.root.findAllByProps({ "data-mode-option": "dark" })).toHaveLength(1);
	});

	test("a deep link to an extension page opens its Advanced pane", async () => {
		const harness = makeHarness({
			extensions: { list: EXTENSIONS, settings: { "acme-tool": { legacy: true } } },
		});
		const { renderer } = await renderPanelWithPrefs(harness.client, { section: "acme-tool" });
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(renderer.root.findAllByProps({ "data-extension-page": "acme-tool" })).toHaveLength(1);
		expect(textContent(renderer.toJSON())).toContain("This extension doesn't describe its settings.");
	});
});
