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

function renderPanel(client: ReturnType<typeof createClient>) {
	return renderAsync(<SettingsPanel client={client} onClose={() => {}} />);
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
			},
		});
		const renderer = await renderPanel(client);
		expect(calls.some((call) => call.method === "GET" || (call.method === undefined && call.input === "/v1/settings"))).toBe(true);
		// The selects carry the served modes.
		expect(find(renderer, "settings-steering").props.value).toBe("all");
		expect(find(renderer, "settings-followup").props.value).toBe(
			"one-at-a-time",
		);
		// retry.enabled false renders unchecked.
		expect(find(renderer, "settings-retry-enabled").props.checked).toBe(false);
		// defaultTools ["read", "bash"]: those two checked, bash's siblings not.
		const tools = renderer.root.findAllByType("input");
		const byLabel = (name: string) =>
			tools.find((node) => node.parent?.children.some(
				(child) => typeof child === "string" && child === name,
			));
		expect(byLabel("read")?.props.checked).toBe(true);
		expect(byLabel("bash")?.props.checked).toBe(true);
		expect(byLabel("edit")?.props.checked).toBe(false);
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
		expect(find(renderer, "settings-retry-enabled").props.checked).toBe(true);
		const tools = renderer.root.findAllByType("input");
		expect(
			tools.filter((node) => node.props.type === "checkbox").length,
		).toBe(8); // retry + 7 tools
		for (const node of tools) {
			expect(node.props.checked).toBe(true);
		}
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
			settings: { steeringMode: "all" },
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

	test("all tools checked clears the filter (PATCH null) when one was set", async () => {
		const { calls, client } = makeHarness({
			settings: { defaultTools: ["read"] },
		});
		const renderer = await renderPanel(client);
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
			settings: { perModelThinking: { "faux/m": "high" } },
		});
		const renderer = await renderPanel(client);
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
});
