/**
 * SettingsPanel (Task 8c): the settings editor over GET/PATCH /v1/settings —
 * renders the current settings from GET, edits + save PATCHes the changed
 * fields, invalid raw JSON refuses to save locally. Fetch-stub style per
 * Composer.test.tsx.
 */

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test } from "vitest";
import {
	createClient,
	type FetchLike,
	type SettingsWire,
} from "../api";
import { renderAsync } from "../test-utils";
import { SettingsPanel } from "./SettingsPanel";
import { usePrefs } from "./usePrefs";

interface Call {
	readonly input: string;
	readonly method?: string;
	readonly body?: string;
}

function makeHarness(init?: {
	readonly settings?: SettingsWire;
	/** The GET body served AFTER a successful PATCH (defaults to the patch). */
	readonly settingsAfterSave?: SettingsWire;
}) {
	const calls: Call[] = [];
	const settings = init?.settings ?? {};
	const fetchImpl: FetchLike = (input, init2) => {
		calls.push({ input, method: init2?.method, body: init2?.body });
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

/**
 * Render the panel wired to a live usePrefs instance (the App shape: the
 * hook lives in a wrapper so its state survives the panel). The probe
 * exposes the held prefs for assertions.
 */
function renderPanelWithPrefs(
	client: ReturnType<typeof createClient>,
) {
	let captured: ReturnType<typeof usePrefs> | undefined;
	function Probe() {
		captured = usePrefs();
		return (
			<SettingsPanel
				client={client}
				prefsState={captured}
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
			settings: { steeringMode: "all", toolRoster: [] },
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
			settings: { toolRoster: roster },
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
			settings: { defaultTools: ["read"], toolRoster: ["read", "bash"] },
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
			settings: { perModelThinking: { "faux/m": "high" }, toolRoster: [] },
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
});
