/**
 * SettingsPanel (Task 8c + B7): the settings editor over GET/PATCH
 * /v1/settings — renders the current settings from GET, edits + save
 * PATCHes the changed fields, invalid raw JSON refuses to save locally.
 * The Interface section (B7) also carries the client-only theme controls,
 * asserted through a live useTheme wired to fake storage + a fake root
 * (the dataset the browser's documentElement receives). Fetch-stub style
 * per Composer.test.tsx.
 */

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test } from "vitest";
import {
	createClient,
	type ExtensionInfoWire,
	type FetchLike,
	type SettingsWire,
} from "../api";
import { renderAsync, textContent } from "../test-utils";
import { useTheme, type ThemeRoot, type ThemeState, type ThemeStorage } from "../theme/useTheme";
import { SettingsPanel } from "./SettingsPanel";
import { usePrefs } from "./usePrefs";

interface Call {
	readonly input: string;
	readonly method?: string;
	readonly body?: string | Uint8Array;
}

/** The extension fixtures the Extensions-section tests serve. */
interface ExtensionsHarness {
	readonly list: readonly ExtensionInfoWire[];
	/** GET bodies per slug (absent → {}). */
	readonly settings?: Readonly<Record<string, Record<string, unknown>>>;
	/** GET bodies per slug (absent → no keys). */
	readonly secrets?: Readonly<
		Record<string, readonly { key: string; source: string }[]>
	>;
}

function makeHarness(init?: {
	readonly settings?: SettingsWire;
	/** The GET body served AFTER a successful PATCH (defaults to the patch). */
	readonly settingsAfterSave?: SettingsWire;
	/** The Extensions-section fixtures (serves the /v1/extensions surface). */
	readonly extensions?: ExtensionsHarness;
}) {
	const calls: Call[] = [];
	const settings = init?.settings ?? {};
	const ext = init?.extensions;
	// The mutable secret-key state the PUT/DELETE paths read back through
	// the GET responses (the UI refreshes from the write responses).
	const secretState = new Map<string, readonly { key: string; source: string }[]>(
		Object.entries(ext?.secrets ?? {}).map(([slug, keys]) => [slug, [...keys]]),
	);
	const fetchImpl: FetchLike = (input, init2) => {
		calls.push({ input, method: init2?.method, body: init2?.body });
		let m: RegExpMatchArray | null;
		let body: unknown = {};
		if (input === "/v1/settings" && init2?.method === "PATCH") {
			// The server returns the new effective settings; echo a sensible
			// merge (enough for the component's post-save state).
			body = init?.settingsAfterSave ?? {
				...settings,
				...(JSON.parse(init2.body as string) as Record<string, unknown>),
			};
		} else if (input === "/v1/settings") {
			body = settings;
		} else if (input === "/v1/extensions") {
			body = { extensions: ext?.list ?? [] };
		} else if ((m = input.match(/^\/v1\/extensions\/([^/]+)\/settings$/)) !== null) {
			const slug = decodeURIComponent(m[1]);
			if (init2?.method === "PUT") {
				// Echo the stored object (the server's response shape).
				body = JSON.parse(init2.body as string);
			} else {
				body = ext?.settings?.[slug] ?? {};
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
	return { calls, client: createClient({ fetch: fetchImpl }) };
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

/**
 * Render the panel wired to live usePrefs + useTheme instances (the App
 * shape: the hooks live in a wrapper so their state survives the panel).
 * The probe exposes the held prefs and the theme root's dataset (what the
 * browser's documentElement would receive).
 */
function renderPanelWithPrefs(
	client: ReturnType<typeof createClient>,
) {
	const themeRoot = makeThemeRoot();
	let captured: ReturnType<typeof usePrefs> | undefined;
	let theme: ThemeState | undefined;
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
	}));
}

function renderPanel(client: ReturnType<typeof createClient>) {
	return renderPanelWithPrefs(client).then(({ renderer }) => renderer);
}

/** Click one section-nav button (fields are section-scoped now). */
async function openSection(
	renderer: TestRenderer.ReactTestRenderer,
	name: string,
) {
	const button = renderer.root
		.findAllByType("button")
		.find((node) => node.props.className === "settings-nav-item" && node.props.children === name);
	if (button === undefined) throw new Error(`section ${name} not rendered`);
	await act(async () => {
		button.props.onClick();
	});
}

function find<T extends TestRenderer.ReactTestInstance>(
	renderer: TestRenderer.ReactTestRenderer,
	className: string,
): T {
	return renderer.root.findByProps({ className }) as T;
}

describe("SettingsPanel", () => {
	test("renders the current settings from GET /v1/settings", async () => {
		const { calls, client } = makeHarness({
			settings: {
				steeringMode: "all",
				followUpMode: "one-at-a-time",
				retry: { enabled: false },
				defaultTools: ["read", "bash"],
				perModelThinking: { "faux/m": "high" },
				toolRoster: ["read", "bash", "edit"],
				effective: {},
			},
		});
		const renderer = await renderPanel(client);
		expect(calls.some((call) => call.method === "GET" || (call.method === undefined && call.input === "/v1/settings"))).toBe(true);
		// The General section is the default view; its selects carry the modes.
		expect(find(renderer, "settings-steering").props.value).toBe("all");
		expect(find(renderer, "settings-followup").props.value).toBe(
			"one-at-a-time",
		);
		await openSection(renderer, "Advanced");
		// retry.enabled false renders unchecked.
		expect(find(renderer, "settings-retry-enabled").props.checked).toBe(false);
		await openSection(renderer, "Tools");
		// defaultTools ["read", "bash"]: those two checked, bash's siblings not.
		const tools = renderer.root.findAllByType("input");
		const byLabel = (name: string) =>
			tools.find((node) => node.parent?.children.some(
				(child) => typeof child === "string" && child === name,
			));
		expect(byLabel("read")?.props.checked).toBe(true);
		expect(byLabel("bash")?.props.checked).toBe(true);
		expect(byLabel("edit")?.props.checked).toBe(false);
		await openSection(renderer, "Advanced");
		// perModelThinking renders as JSON in the textarea.
		expect(find(renderer, "settings-thinking").props.value).toContain(
			'"faux/m": "high"',
		);
});

	test("absent settings render defaults: (server default) selects, retry on, every tool on", async () => {
		const { client } = makeHarness();
		const renderer = await renderPanel(client);
		expect(find(renderer, "settings-steering").props.value).toBe("");
		expect(find(renderer, "settings-followup").props.value).toBe("");
		await openSection(renderer, "Advanced");
		expect(find(renderer, "settings-retry-enabled").props.checked).toBe(true);
		await openSection(renderer, "Tools");
		const tools = renderer.root.findAllByType("input");
		expect(
			tools.filter((node) => node.props.type === "checkbox").length,
		).toBe(7); // the 7 roster tools
		for (const node of tools) {
			expect(node.props.checked).toBe(true);
		}
		await openSection(renderer, "Advanced");
		expect(find(renderer, "settings-thinking").props.value).toBe("");
});

	test("edit steeringMode + save PATCHes only the changed field", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderPanel(client);
		await act(async () => {
			find(renderer, "settings-steering").props.onChange({
				target: { value: "all" },
			});
		});
		await act(async () => {
			await find(renderer, "settings-save").props.onClick();
		});
		const patchCall = calls.find(
			(call) => call.input === "/v1/settings" && call.method === "PATCH",
		);
		expect(patchCall).toBeDefined();
		expect(JSON.parse(patchCall!.body as string)).toEqual({
			steeringMode: "all",
		});
		// The save rendered a success note.
		expect(renderer.root.findByProps({ role: "status" })).toBeDefined();
	});

	test("re-selecting (server default) PATCHes null to clear the key", async () => {
		const { calls, client } = makeHarness({
			settings: { steeringMode: "all", toolRoster: [], effective: {} },
		});
		const renderer = await renderPanel(client);
		await act(async () => {
			find(renderer, "settings-steering").props.onChange({
				target: { value: "" },
			});
		});
		await act(async () => {
			await find(renderer, "settings-save").props.onClick();
		});
		const patchCall = calls.find(
			(call) => call.input === "/v1/settings" && call.method === "PATCH",
		);
		expect(JSON.parse(patchCall!.body as string)).toEqual({
			steeringMode: null,
		});
	});

	test("unchecking a tool PATCHes the reduced defaultTools list", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderPanel(client);
		await openSection(renderer, "Tools");
		const grep = renderer.root
			.findAllByType("input")
			.find((node) =>
				node.parent?.children.some(
					(child) => typeof child === "string" && child === "grep",
				),
			);
		await act(async () => {
			grep!.props.onChange({ target: { checked: false } });
		});
		await act(async () => {
			await find(renderer, "settings-save").props.onClick();
		});
		const patchCall = calls.find(
			(call) => call.input === "/v1/settings" && call.method === "PATCH",
		);
		expect(JSON.parse(patchCall!.body as string)).toEqual({
			defaultTools: ["read", "bash", "edit", "write", "find", "ls"],
		});
	});

	test("the served toolRoster drives the checkboxes (extension tools render and PATCH)", async () => {
		// A roster with an extension tool beyond the bundled core list —
		// the registry-driven surface Tasks 5-7 rely on (codemode's tools
		// appear in the panel without a panel change).
		const roster = [
			"read",
			"bash",
			"edit",
			"write",
			"find",
			"grep",
			"ls",
			"load_skill",
			"codemode_eval",
		];
		const { calls, client } = makeHarness({
			settings: { toolRoster: roster, effective: {} },
		});
		const renderer = await renderPanel(client);
		await openSection(renderer, "Tools");
		const boxes = renderer.root.findAllByType("input").filter(
			(node) => node.props.type === "checkbox",
		);
		// The 9 roster names (both non-core entries render).
		expect(boxes.length).toBe(9);
		const byLabel = (name: string) =>
			renderer.root
				.findAllByType("input")
				.find((node) =>
					node.parent?.children.some(
						(child) => typeof child === "string" && child === name,
					),
				);
		expect(byLabel("load_skill")?.props.checked).toBe(true);
		expect(byLabel("codemode_eval")?.props.checked).toBe(true);
		// Unchecking a roster-only name PATCHes the reduced ROSTER list
		// (not the core list) — every other roster name stays selected.
		await act(async () => {
			byLabel("codemode_eval")!.props.onChange({ target: { checked: false } });
		});
		await act(async () => {
			await find(renderer, "settings-save").props.onClick();
		});
		const patchCall = calls.find(
			(call) => call.input === "/v1/settings" && call.method === "PATCH",
		);
		expect(JSON.parse(patchCall!.body as string)).toEqual({
			defaultTools: [
				"read",
			"bash",
			"edit",
			"write",
			"find",
			"grep",
			"ls",
			"load_skill",
			],
		});
	});

	test("all tools checked clears the filter (PATCH null) when one was set", async () => {
		const { calls, client } = makeHarness({
			settings: { defaultTools: ["read"], toolRoster: ["read", "bash"], effective: {} },
		});
		const renderer = await renderPanel(client);
		await openSection(renderer, "Tools");
		// Check every unchecked box.
		const boxes = renderer.root
			.findAllByType("input")
			.filter((node) => node.props.checked === false);
		for (const box of boxes) {
			await act(async () => {
				box.props.onChange({ target: { checked: true } });
			});
		}
		await act(async () => {
			await find(renderer, "settings-save").props.onClick();
		});
		const patchCall = calls.find(
			(call) => call.input === "/v1/settings" && call.method === "PATCH",
		);
		expect(JSON.parse(patchCall!.body as string)).toEqual({
			defaultTools: null,
		});
	});

	test("invalid per-model thinking JSON refuses to save (no PATCH fired)", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderPanel(client);
		await openSection(renderer, "Advanced");
		await act(async () => {
			find(renderer, "settings-thinking").props.onChange({
				target: { value: "{not json" },
			});
		});
		// Save is disabled while the JSON is invalid.
		expect(find(renderer, "settings-save").props.disabled).toBe(true);
		await act(async () => {
			await find(renderer, "settings-save").props.onClick();
		});
		expect(
			calls.some(
				(call) => call.input === "/v1/settings" && call.method === "PATCH",
			),
		).toBe(false);
	});

	test("an empty textarea clears perModelThinking when one was set", async () => {
		const { calls, client } = makeHarness({
			settings: { perModelThinking: { "faux/m": "high" }, toolRoster: [], effective: {} },
		});
		const renderer = await renderPanel(client);
		await openSection(renderer, "Advanced");
		expect(find(renderer, "settings-thinking").props.value).toContain(
			'"faux/m": "high"',
		);
		await act(async () => {
			find(renderer, "settings-thinking").props.onChange({
				target: { value: "" },
			});
		});
		await act(async () => {
			await find(renderer, "settings-save").props.onClick();
		});
		const patchCall = calls.find(
			(call) => call.input === "/v1/settings" && call.method === "PATCH",
		);
		expect(JSON.parse(patchCall!.body as string)).toEqual({
			perModelThinking: null,
		});
	});

	test("sections render: the nav shows all four and switches views", async () => {
		const { client } = makeHarness();
		const renderer = await renderPanel(client);
		const navItems = renderer.root
			.findAllByType("button")
			.filter((node) => node.props.className === "settings-nav-item");
		expect(navItems.map((node) => node.props.children)).toEqual([
			"General",
			"Tools",
			"Interface",
			"Advanced",
			"Extensions",
		]);
		// General renders steering; Interface does NOT.
		expect(
			renderer.root.findAllByProps({ className: "settings-steering" }),
		).toHaveLength(1);
		await openSection(renderer, "Interface");
		expect(
			renderer.root.findAllByProps({ className: "settings-steering" }),
		).toHaveLength(0);
		expect(
			renderer.root.findAllByProps({ className: "settings-pref-enterToSend" }),
		).toHaveLength(1);
		expect(
			renderer.root.findAllByProps({ className: "settings-pref-showThinking" }),
		).toHaveLength(1);
	});

	test("interface prefs apply live through the shared prefs state", async () => {
		const { client } = makeHarness();
		const { renderer, prefs } = await renderPanelWithPrefs(client);
		await openSection(renderer, "Interface");
		expect(prefs().enterToSend).toBe(false);
		expect(prefs().showThinking).toBe(true);
		await act(async () => {
			find(renderer, "settings-pref-enterToSend").props.onChange({
				target: { checked: true },
			});
		});
		expect(prefs().enterToSend).toBe(true);
		await act(async () => {
			find(renderer, "settings-pref-showThinking").props.onChange({
				target: { checked: false },
			});
		});
		expect(prefs().showThinking).toBe(false);
	});

	test("Interface theme controls: Fjord / Lichen / Light apply immediately to the theme root", async () => {
		const { client } = makeHarness();
		const { renderer, themeRoot } = await renderPanelWithPrefs(client);
		await openSection(renderer, "Interface");
		// The three controls render over the shared theme data: four palette
		// swatches, seven accent swatches, three mode segments.
		const optionsOf = (attr: string): (string | undefined)[] =>
			renderer.root
				.findAllByType("button")
				.map((button) => button.props[attr] as string | undefined)
				.filter((value) => value !== undefined);
		expect(optionsOf("data-palette-option")).toEqual([
			"fjord",
			"iron-ember",
			"polar-night",
			"birch-moss",
		]);
		expect(optionsOf("data-accent-option")).toEqual([
			"baltic-amber",
			"ember",
			"lingonberry",
			"glacier",
			"aurora",
			"lichen",
			"heather",
		]);
		expect(optionsOf("data-mode-option")).toEqual(["system", "dark", "light"]);
		// A pick applies IMMEDIATELY (no save): the theme root's dataset —
		// what documentElement carries in the browser — flips on click.
		await act(async () => {
			renderer.root.findByProps({ "data-palette-option": "fjord" }).props.onClick();
		});
		expect(themeRoot.palette).toBe("fjord");
		await act(async () => {
			renderer.root.findByProps({ "data-accent-option": "lichen" }).props.onClick();
		});
		expect(themeRoot.accent).toBe("lichen");
		await act(async () => {
			renderer.root.findByProps({ "data-mode-option": "light" }).props.onClick();
		});
		expect(themeRoot.mode).toBe("light");
	});

	test("the palette swatch carries its own preview colours + label; the accent swatch its label in title", async () => {
		const { client } = makeHarness();
		const { renderer } = await renderPanelWithPrefs(client);
		await openSection(renderer, "Interface");
		// Fjord's swatch: its own dark bg + text + default accent (Baltic Amber).
		const fjord = renderer.root.findByProps({ "data-palette-option": "fjord" });
		expect(fjord.props.title).toBe("Fjord");
		expect(fjord.props.style.background).toBe("#0b0f13");
		const dots = fjord.children.filter(
			(node): node is TestRenderer.ReactTestInstance =>
				typeof node === "object",
		);
		expect(
			dots.map((node) => node.props.className === "settings-swatch-dot"),
		).toEqual([true, true]);
		expect(dots.map((node) => node.props.style.background)).toEqual([
			"#dde6ee",
			"#d6a24a",
		]);
		// An accent swatch is round with its label in title.
		const lichen = renderer.root.findByProps({ "data-accent-option": "lichen" });
		expect(lichen.props.title).toBe("Lichen");
		expect(lichen.props.style.background).toBe("#b9c46a");
	});

	test("showThinking's description names the activity-details surface", async () => {
		const { client } = makeHarness();
		const { renderer } = await renderPanelWithPrefs(client);
		await openSection(renderer, "Interface");
		expect(textContent(renderer.toJSON())).toContain(
			"Show thinking text inside activity details",
		);
	});
});

// ─── Extensions section (W3 Task 7, spec §7.7) ─────────────────────────────

describe("SettingsPanel Extensions section", () => {
	const EXTENSIONS: readonly ExtensionInfoWire[] = [
		{
			name: "acme-tool",
			status: "ok",
			interactionKinds: [],
			ambientKeys: [],
			workers: [],
		},
		{
			name: "acme-settings-tool",
			status: "ok",
			version: "0.0.0",
			interactionKinds: [],
			ambientKeys: [],
			workers: [],
		},
	];

	async function renderExtensions(harness: ReturnType<typeof makeHarness>) {
		const renderer = await renderPanel(harness.client);
		await openSection(renderer, "Extensions");
		return renderer;
	}

	test("renders a row per extension (name, status, version) with the settings + secrets blocks", async () => {
		const harness = makeHarness({
			extensions: {
				list: EXTENSIONS,
				settings: { "acme-tool": { theme: "dark" } },
				secrets: { "acme-tool": [{ key: "api-key", source: "stored" }] },
			},
		});
		const renderer = await renderExtensions(harness);
		// One fieldset per extension, keyed by slug.
		const rows = renderer.root.findAllByType("fieldset").filter(
			(node) => node.props.className === "settings-ext",
		);
		expect(rows.map((node) => node.props["data-ext"] as string)).toEqual([
			"acme-tool",
			"acme-settings-tool",
		]);
		// The inventory rode the GET; the version renders on its row only.
		expect(
			harness.calls.some((call) => call.input === "/v1/extensions"),
		).toBe(true);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("acme-tool");
		expect(text).toContain("v0.0.0");
		// The settings textarea carries the fetched object; the secrets row
		// carries the key + source.
		expect(
			renderer.root.findAllByType("textarea")[0].props.value,
		).toContain('"theme": "dark"');
		expect(text).toContain("api-key");
		expect(text).toContain("(stored)");
	});

	test("editing the settings textarea PUTs the parsed object", async () => {
		const harness = makeHarness({
			extensions: { list: EXTENSIONS.slice(0, 1) },
		});
		const renderer = await renderExtensions(harness);
		await act(async () => {
			find(renderer, "settings-ext-settings").props.onChange({
				target: { value: '{ "retries": 2 }' },
			});
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
		expect(renderer.root.findByProps({ role: "status" })).toBeDefined();
	});

	test("invalid settings JSON refuses to save (no PUT fired)", async () => {
		const harness = makeHarness({
			extensions: { list: EXTENSIONS.slice(0, 1) },
		});
		const renderer = await renderExtensions(harness);
		await act(async () => {
			find(renderer, "settings-ext-settings").props.onChange({
					target: { value: "{not json" },
			});
		});
		await act(async () => {
			await find(renderer, "settings-ext-save").props.onClick();
		});
		expect(
			harness.calls.some(
				(call) =>
					call.input === "/v1/extensions/acme-tool/settings" &&
					call.method === "PUT",
			),
		).toBe(false);
		expect(renderer.root.findByProps({ role: "alert" })).toBeDefined();
	});

	test("the secret input sends PUT with the value and never displays stored values", async () => {
		const harness = makeHarness({
			extensions: {
				list: EXTENSIONS.slice(0, 1),
				secrets: { "acme-tool": [{ key: "api-key", source: "stored" }] },
			},
		});
		const renderer = await renderExtensions(harness);
		// The write-only input renders EMPTY (the API returns keys only;
		// there is no stored value to display) and is masked.
		const input = find(renderer, "settings-ext-secret-value");
		expect(input.props.type).toBe("password");
		expect(input.props.value).toBe("");
		expect(
			renderer.root
				.findAllByType("input")
				.every((node) => (node.props.value ?? "") === ""),
		).toBe(true);
		await act(async () => {
			input.props.onChange({ target: { value: "hunter2" } });
		});
		await act(async () => {
			await find(renderer, "settings-ext-secret-set").props.onClick();
		});
		const put = harness.calls.find(
				(call) =>
					call.input === "/v1/extensions/acme-tool/secrets/api-key" &&
				call.method === "PUT",
		);
		expect(put).toBeDefined();
		expect(JSON.parse(put!.body as string)).toEqual({ value: "hunter2" });
		// The write cleared the input — the value does not linger on screen.
		expect(find(renderer, "settings-ext-secret-value").props.value).toBe("");
	});

	test("the add-new row sets a fresh key; Delete removes one", async () => {
		const harness = makeHarness({
			extensions: {
				list: EXTENSIONS.slice(0, 1),
				secrets: { "acme-tool": [{ key: "api-key", source: "stored" }] },
			},
		});
		const renderer = await renderExtensions(harness);
		await act(async () => {
			find(renderer, "settings-ext-new-key").props.onChange({
				target: { value: "token" },
			});
		});
		await act(async () => {
			find(renderer, "settings-ext-new-value").props.onChange({
				target: { value: "tok-value" },
			});
		});
		await act(async () => {
			await find(renderer, "settings-ext-secret-add").props.onClick();
		});
		expect(
				harness.calls.some(
					(call) =>
						call.input === "/v1/extensions/acme-tool/secrets/token" &&
					call.method === "PUT" &&
					(call.body as string).includes("tok-value"),
			),
		).toBe(true);
		// Delete the stored key: DELETE fires and the row disappears.
		await act(async () => {
			await renderer.root
				.findByProps({
					className: "settings-ext-secret-delete",
					"data-secret-key": "api-key",
				})
				.props.onClick();
		});
		expect(
			harness.calls.some(
				(call) =>
					call.input === "/v1/extensions/acme-tool/secrets/api-key" &&
				call.method === "DELETE",
			),
		).toBe(true);
		// Exactly one secret row remains: the added key (stored now), never
		// the deleted one (the response's refreshed list drove the render).
		expect(
			renderer.root.findAllByProps({ className: "settings-ext-key" }).length,
		).toBe(1);
	});
});
