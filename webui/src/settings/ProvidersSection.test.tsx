/**
 * The Providers settings section (release 0.1 Task 2b, spec §7.6): the
 * per-provider readiness report over `GET /v1/providers` with the
 * write-only credential field — Save PUTs `{apiKey}` (the response's
 * entry drives the badge), Clear DELETEs, Refresh POSTs the one bounded
 * refresh. The API never returns key material, so the field starts
 * empty, never shows a stored value, and clears after a successful
 * save; a known non-admin session never sees the section (the server
 * 403s the writes regardless — the client must not pretend otherwise).
 * Fetch-stub style per SettingsPanel.test.tsx.
 */

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test } from "vitest";
import { createClient, type FetchLike, type SettingsWire } from "../api";
import { renderAsync, textContent } from "../test-utils";
import { useTheme, type ThemeState, type ThemeStorage } from "../theme/useTheme";
import { SettingsPanel } from "./SettingsPanel";
import { usePrefs } from "./usePrefs";

/** One recorded fetch (input + init), for body/path asserts. */
interface Call {
	readonly input: string;
	readonly method?: string;
	readonly body?: string | Uint8Array;
}

/**
 * The served readiness (mutable: the writes' responses decide the new
 * statuses — the stub's stand-in for the server's post-write refresh).
 */
function makeProvidersHarness(init?: {
	readonly providers?: readonly {
		provider: string;
		status: string;
		models: number;
		detail?: string;
	}[];
	/** Serve the credential PUT a 403 (a non-admin session). */
	readonly putFails?: boolean;
}) {
	const calls: Call[] = [];
	const entries = new Map(
		(init?.providers ?? [
			{ provider: "acme", status: "not_configured", models: 0 },
			{
				provider: "acme2",
				status: "degraded",
				models: 2,
				detail: "last refresh failed",
			},
		]).map((entry) => [entry.provider, { ...entry }]),
	);
	const settings: SettingsWire = { toolRoster: [], effective: {}, pendingRestart: [] };
	// The panel's nav comes from /v1/settings/sections (U4 Task 4).
	const sectionsResponse = {
		sections: [
			{ slug: "core", id: "general", title: "General", icon: "key" },
			{ slug: "core", id: "tools", title: "Tools", icon: "edit" },
			{ slug: "core", id: "interface", title: "Interface", icon: "image" },
			{ slug: "core", id: "advanced", title: "Advanced", icon: "more" },
			{ slug: "core", id: "providers", title: "Providers", icon: "cloud" },
			{ slug: "core", id: "extensions", title: "Extensions", icon: "add" },
		],
		index: [],
	};
	const fetchImpl: FetchLike = (input, init2) => {
		calls.push({ input, method: init2?.method, body: init2?.body });
		let m: RegExpMatchArray | null;
		let body: unknown = {};
		if (init2?.method === "PUT" && init?.putFails === true) {
			return Promise.resolve({
				ok: false,
				status: 403,
				json: () => Promise.resolve({ error: "forbidden" }),
				text: () => Promise.resolve(""),
			});
		}
		if (input === "/v1/meta") {
			body = { version: "0.1.0", harnessVersion: "1.0.0" };
		} else if (input === "/v1/settings/sections") {
			body = sectionsResponse;
		} else if (input === "/v1/extensions") {
			body = { extensions: [] };
		} else if (input === "/v1/settings") {
			body = settings;
		} else if (input === "/v1/providers") {
			body = { providers: [...entries.values()] };
		} else if (
			(m = input.match(/^\/v1\/providers\/([^/]+)\/credential$/)) !== null
		) {
			const id = m[1] as string;
			// PUT → ready with a live catalog; DELETE → not_configured (the
			// tracker re-seeds on the refresh).
			entries.set(id, {
				provider: id,
				status: init2?.method === "PUT" ? "ready" : "not_configured",
				models: 3,
			});
			body = entries.get(id);
		} else if (
			(m = input.match(/^\/v1\/providers\/([^/]+)\/refresh$/)) !== null &&
			init2?.method === "POST"
		) {
			const id = m[1] as string;
			body = entries.get(id) ?? { provider: id, status: "ready", models: 0 };
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
 * Render the panel wired to live usePrefs + useTheme instances and the
 * caller's admin posture (the App shape: `admin={identity?.admin}` —
 * undefined = no known identity = the naive posture where every caller
 * is admin).
 */
function renderPanel(
	client: ReturnType<typeof createClient>,
	admin?: boolean,
): Promise<TestRenderer.ReactTestRenderer> {
	const storage = new Map<string, string>();
	const themeStorage: ThemeStorage = {
		getItem: (key) => storage.get(key) ?? null,
		setItem: (key, value) => {
			storage.set(key, value);
		},
	};
	const dataset: Record<string, string | undefined> = {};
	/** The dark system-preference query stub (useTheme listens to it). */
	const darkQuery = {
		matches: true,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	};
	function Probe() {
		const prefs = usePrefs();
		const theme: ThemeState = useTheme({
			storage: themeStorage,
			root: { dataset, setProperty: () => undefined },
			matchMedia: () => darkQuery,
		});
		return (
			<SettingsPanel
				client={client}
				prefsState={prefs}
				theme={theme}
				admin={admin}
				onClose={() => {}}
			/>
		);
	}
	return renderAsync(<Probe />).then((renderer) => renderer);
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
}

/** One provider's row (the fieldset by its data-provider attr). */
function providerRow(
	renderer: TestRenderer.ReactTestRenderer,
	id: string,
): TestRenderer.ReactTestInstance {
	return renderer.root.findByProps({
		className: "settings-provider",
		"data-provider": id,
	}) as TestRenderer.ReactTestInstance;
}

/** The section-nav labels currently rendered. */
function navLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
	return renderer.root
		.findAllByType("button")
		.filter((node) => node.props.className === "settings-nav-item")
		.map((node) => node.props.children as string);
}

describe("SettingsPanel Providers section", () => {
	test("renders one row per provider: name, readiness badge, model count (+ the tracker detail)", async () => {
		const { client } = makeProvidersHarness();
		const renderer = await renderPanel(client);
		await openSection(renderer, "Providers");
		const rows = renderer.root
			.findAllByType("fieldset")
			.filter((node) => node.props.className === "settings-provider");
		expect(rows.map((node) => node.props["data-provider"] as string)).toEqual([
			"acme",
			"acme2",
		]);
		const text = textContent(renderer.toJSON());
		// The readiness badges and model counts render per row…
		expect(text).toContain("not_configured");
		expect(text).toContain("degraded");
		expect(text).toContain("0 models");
		expect(text).toContain("2 models");
		// …including the degraded row's tracker detail.
		expect(text).toContain("last refresh failed");
		// The section mounted over GET /v1/providers.
		const first = renderer.root.findByProps({
			className: "settings-provider",
			"data-provider": "acme",
		});
		expect(first).toBeDefined();
	});

	test("saving a key PUTs {apiKey}, clears the field, and the badge turns ready", async () => {
		const { calls, client } = makeProvidersHarness();
		const renderer = await renderPanel(client);
		await openSection(renderer, "Providers");
		const row = providerRow(renderer, "acme");
		const input = row.findByProps({ className: "settings-provider-key" });
		await act(async () => {
			input.props.onChange({ target: { value: "acme-test-key" } });
		});
		await act(async () => {
			await row.findByProps({ className: "settings-provider-save" }).props.onClick();
		});
		const put = calls.find(
			(call) =>
				call.input === "/v1/providers/acme/credential" && call.method === "PUT",
		);
		expect(put).toBeDefined();
		expect(JSON.parse(put!.body as string)).toEqual({
			apiKey: "acme-test-key",
		});
		// Write-only: the field cleared after the successful save…
		expect(
			row.findByProps({ className: "settings-provider-key" }).props.value,
		).toBe("");
		// …and the PUT response's entry drove the badge (ready, 3 models).
		const badge = row.findByProps({ className: "settings-provider-status" });
		expect(badge.props["data-status"]).toBe("ready");
		expect(textContent(renderer.toJSON())).toContain("3 models");
		// The key never rendered anywhere.
		expect(textContent(renderer.toJSON())).not.toContain("acme-test-key");
	});

	test("the key field is write-only: password type, empty on mount, never populated from any response", async () => {
		const { client } = makeProvidersHarness();
		const renderer = await renderPanel(client);
		await openSection(renderer, "Providers");
		const inputs = renderer.root.findAllByProps({
			className: "settings-provider-key",
		});
		expect(inputs.length).toBe(2);
		for (const input of inputs) {
			expect(input.props.type).toBe("password");
			expect(input.props.value ?? "").toBe("");
			expect(input.props.autoComplete).toBe("off");
		}
	});

	test("a rejected save surfaces the server's error and keeps the typed key (no silent success)", async () => {
		const { client } = makeProvidersHarness({ putFails: true });
		const renderer = await renderPanel(client);
		await openSection(renderer, "Providers");
		const row = providerRow(renderer, "acme");
		const input = row.findByProps({ className: "settings-provider-key" });
		await act(async () => {
			input.props.onChange({ target: { value: "acme-test-key" } });
		});
		await act(async () => {
			await row.findByProps({ className: "settings-provider-save" }).props.onClick();
		});
		expect(row.findByProps({ role: "alert" }).children.join("")).toContain(
			"forbidden",
		);
		// The typed key SURVIVES the failure (the operator retries); the
		// badge never pretended the write landed.
		expect(
			row.findByProps({ className: "settings-provider-key" }).props.value,
		).toBe("acme-test-key");
		expect(
			row.findByProps({ className: "settings-provider-status" }).props[
				"data-status"
			],
		).toBe("not_configured");
	});

	test("Clear DELETEs and Refresh POSTs the refresh route; both apply the response's entry", async () => {
		const { calls, client } = makeProvidersHarness();
		const renderer = await renderPanel(client);
		await openSection(renderer, "Providers");
		const row = providerRow(renderer, "acme2");
		await act(async () => {
			await row.findByProps({ className: "settings-provider-clear" }).props.onClick();
		});
		expect(
			calls.some(
				(call) =>
					call.input === "/v1/providers/acme2/credential" &&
					call.method === "DELETE",
			),
		).toBe(true);
		expect(
			row.findByProps({ className: "settings-provider-status" }).props[
				"data-status"
			],
		).toBe("not_configured");
		await act(async () => {
			await row.findByProps({ className: "settings-provider-refresh" }).props.onClick();
		});
		expect(
			calls.some(
				(call) =>
					call.input === "/v1/providers/acme2/refresh" &&
					call.method === "POST",
			),
		).toBe(true);
	});

	test("a known non-admin session never sees the section (hidden, not read-only)", async () => {
		const { client } = makeProvidersHarness();
		const renderer = await renderPanel(client, false);
		expect(navLabels(renderer)).not.toContain("Providers");
		expect(
			renderer.root.findAllByProps({ className: "settings-provider" }),
		).toHaveLength(0);
		// The default posture (no known identity) keeps the section — the
		// naive server makes every caller admin.
		const naive = await renderPanel(makeProvidersHarness().client);
		expect(navLabels(naive)).toContain("Providers");
	});
});
