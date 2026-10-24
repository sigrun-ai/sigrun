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

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test } from "vitest";
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
import { SettingsPanel } from "./SettingsPanel";
import { usePrefs } from "./usePrefs";

interface Call {
	readonly input: string;
	readonly method?: string;
	readonly body?: string | Uint8Array;
}

/** The extension fixtures the Extensions-cove tests serve. */
interface ExtensionsHarness {
	readonly list: readonly ExtensionInfoWire[];
	readonly settings?: Readonly<Record<string, Record<string, unknown>>>;
	readonly secrets?: Readonly<
		Record<string, readonly { key: string; source: string }[]>
	>;
}

/** The sections the fake server's `/v1/settings/sections` serves. */
const SECTIONS = [
	{ slug: "core", id: "general", title: "General", icon: "key" },
	{ slug: "core", id: "tools", title: "Tools", icon: "edit" },
	{ slug: "core", id: "interface", title: "Interface", icon: "image" },
	{ slug: "core", id: "advanced", title: "Advanced", icon: "more" },
	{ slug: "core", id: "providers", title: "Providers", icon: "cloud" },
	{ slug: "core", id: "extensions", title: "Extensions", icon: "add" },
	{ slug: "core", id: "accounts", title: "Account links", icon: "key" },
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
			body = { providers: [] };
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
}

function renderPanelWithPrefs(
	client: ReturnType<typeof createClient>,
	init?: { readonly admin?: boolean },
): Promise<Rendered> {
	const themeRoot = makeThemeRoot();
	let captured: ReturnType<typeof usePrefs> | undefined;
	let theme: ThemeState | undefined;
	let restarts = 0;
	function Probe() {
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
				onRestart={async () => {
					restarts += 1;
				}}
				onClose={() => {}}
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
	test("renders the sections nav from GET /v1/settings/sections, General first", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderPanel(client);
		expect(
			calls.some((call) => call.input === "/v1/settings/sections"),
		).toBe(true);
		const navItems = renderer.root
			.findAllByType("button")
			.filter((node) => node.props.className === "settings-nav-item");
		expect(navItems.map((node) => node.props.children)).toEqual([
			"General",
			"Tools",
			"Interface",
			"Advanced",
			"Providers",
			"Extensions",
			"Account links",
		]);
		// The General surface mounted (its SurfaceView renders the form).
		expect(
			renderer.root.findAllByProps({ "data-settings-section": "general" }),
		).toHaveLength(1);
	});

	test("an extension's sections follow core in the nav", async () => {
		const { client } = makeHarness({
			sectionsResponse: {
				sections: [
					...SECTIONS,
					{ slug: "acme-ext", id: "display", title: "Display", icon: "key" },
				],
				index: [...INDEX],
			},
		});
		const renderer = await renderPanel(client);
		const navItems = renderer.root
			.findAllByType("button")
			.filter((node) => node.props.className === "settings-nav-item");
		expect(navItems.map((node) => node.props.children)).toContain("Display");
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
		// Supervised + admin: the button renders and calls the action.
		const { client } = makeHarness({
			meta: { pendingRestart: ["server.port"], env: {}, supervised: true },
		});
		const rendered = await renderPanelWithPrefs(client, { admin: true });
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
});

describe("SettingsPanel Extensions cove", () => {
	const EXTENSIONS: readonly ExtensionInfoWire[] = [
		{
			name: "acme-tool",
			status: "ok",
			interactionKinds: [],
			ambientKeys: [],
			workers: [],
		},
	];

	async function renderExtensions(harness: ReturnType<typeof makeHarness>) {
		const renderer = await renderPanel(harness.client);
		await openSection(renderer, "Extensions");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		return renderer;
	}

	test("the extension's raw JSON editor round-trips through PUT", async () => {
		const harness = makeHarness({
			extensions: {
				list: EXTENSIONS,
				settings: { "acme-tool": { theme: "dark" } },
			},
		});
		const renderer = await renderExtensions(harness);
		const textarea = find<TestRenderer.ReactTestInstance>(
			renderer,
			"settings-ext-settings",
		);
		expect(textarea.props.value).toContain('"theme": "dark"');
		await act(async () => {
			textarea.props.onChange({ target: { value: '{ "retries": 2 }' } });
		});
		await act(async () => {
			await find(renderer, "settings-ext-save").props.onClick();
		});
		const put = harness.calls.find(
			(call) =>
				call.input === "/v1/extensions/acme-tool/settings" &&
				call.method === "PUT",
		);
		expect(put).toBeDefined();
		expect(JSON.parse(put!.body as string)).toEqual({ retries: 2 });
	});

	test("an extension without a section shows its raw editor under the nav (the carry-over)", async () => {
		const harness = makeHarness({ extensions: { list: EXTENSIONS } });
		const renderer = await renderPanel(harness.client);
		// The nav carries a per-extension row for the uncovered extension.
		const row = renderer.root
			.findAllByType("button")
			.find(
				(node) =>
					node.props.className ===
						"settings-nav-item settings-nav-extension" &&
					node.props["data-ext"] === "acme-tool",
			);
		expect(row).toBeDefined();
		await act(async () => {
			row!.props.onClick();
		});
		expect(
			renderer.root.findAllByProps({ className: "settings-ext-settings" }),
		).toHaveLength(1);
	});
});
