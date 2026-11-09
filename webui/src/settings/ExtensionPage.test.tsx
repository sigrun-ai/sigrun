import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test } from "vitest";
import type { Tree } from "@sigrun/shared/blocks";
import {
	createClient,
	type AuthCheckProviderWire,
	type ExtensionInfoWire,
	type FetchLike,
	type SettingsSectionEntryWire,
} from "../api";
import { renderAsync, textContent } from "../test-utils";
import { ExtensionPage } from "./ExtensionPage";

const extension: ExtensionInfoWire = {
	name: "acme-ext",
	status: "ok",
	version: "1.2.3",
	interactionKinds: [],
	ambientKeys: [],
	workers: [],
	services: [],
};

const sections: readonly SettingsSectionEntryWire[] = [
	{ slug: "acme-ext", id: "settings", page: "acme-ext", title: "Settings", icon: "key", admin: true },
	{ slug: "acme-ext", id: "user-settings", page: "acme-ext", title: "Your settings", icon: "key", scope: "user", admin: false },
];

function form(id: string, title: string, field: string): Tree {
	return {
		v: 1,
		root: {
			type: "form",
			id,
			bind: "/settings",
			mode: "submit",
			onSubmit: "save",
			children: id === "acme-settings"
				? [{ type: "section", id: "acme-credentials", title: "Credentials", children: [{ type: "secret", name: "token", label: "Token" }] }, { type: "text", name: field, label: field }]
				: [{ type: "text", name: field, label: field }],
		},
	};
}

function makeHarness(init?: {
	readonly admin?: boolean;
	readonly providers?: readonly AuthCheckProviderWire[];
	readonly sections?: readonly SettingsSectionEntryWire[];
	readonly stored?: Record<string, unknown>;
}) {
	const admin = init?.admin ?? true;
	const fetchImpl: FetchLike = (input, request) => {
		let status = 200;
		let body: unknown = {};
		if (input === "/v1/providers") {
			body = { providers: init?.providers ?? [] };
		} else if (input === "/v1/extensions/acme-ext/settings") {
			body = { settings: init?.stored ?? { endpoint: "https://acme.example.invalid", legacy: true }, pendingRestart: [] };
		} else if (input.startsWith("/v1/ext/acme-ext/surfaces/settings")) {
			if (!admin) status = 404;
			else if (input.includes("/data")) body = { rev: 0, treeRev: 0, data: { settings: {}, unknownKeys: ["legacy"] } };
			else body = { tree: form("acme-settings", "Settings", "endpoint"), data: { settings: {}, unknownKeys: ["legacy"] }, rev: 0, treeRev: 0, access: "write" };
		} else if (input.startsWith("/v1/ext/acme-ext/surfaces/user-settings")) {
			if (input.includes("/data")) body = { rev: 0, treeRev: 0, data: { settings: {} } };
			else body = { tree: form("acme-user", "Your settings", "nickname"), data: { settings: {} }, rev: 0, treeRev: 0, access: "write" };
		} else {
			throw new Error(`unexpected fetch ${request?.method ?? "GET"} ${input}`);
		}
		return Promise.resolve({
			ok: status < 400,
			status,
			json: () => Promise.resolve(body),
			text: () => Promise.resolve(JSON.stringify(body)),
		});
	};
	return createClient({ fetch: fetchImpl, rawFetch: fetchImpl as never });
}

async function renderPage(init?: Parameters<typeof makeHarness>[0]) {
	const client = makeHarness(init);
	const renderer = await renderAsync(
		<ExtensionPage client={client} extension={extension} sections={init?.sections ?? sections} admin={init?.admin ?? true} />,
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return renderer;
}

function parts(renderer: TestRenderer.ReactTestRenderer): string[] {
	return renderer.root
		.findAll((node) => typeof node.props["data-extension-part"] === "string")
		.map((node) => node.props["data-extension-part"] as string);
}

describe("ExtensionPage", () => {
	test("page stacks Credentials, Settings, Your settings, Advanced in that order", async () => {
		const renderer = await renderPage({ providers: [{ provider: "acme", owner: "acme-ext", status: "ready", models: 2 }] });
		expect(parts(renderer)).toEqual(["credentials", "settings", "user-settings", "advanced"]);
	});

	test("non-admin sees only the user part", async () => {
		const renderer = await renderPage({ admin: false });
		expect(parts(renderer)).toEqual(["user-settings"]);
		expect(textContent(renderer.toJSON())).not.toContain("not in this version's settings");
	});

	test("provider page shows one auth.json key row per provider across chat and decision kinds", async () => {
		const renderer = await renderPage({
			providers: [
				{ provider: "acme", owner: "acme-ext", kind: "chat", status: "ready", models: 2 },
				{ provider: "acme", owner: "acme-ext", kind: "chat", status: "ready", models: 1 },
				{ provider: "acme-decision", owner: "acme-ext", kind: "decision", status: "degraded", models: 1 },
			],
		});
		expect(renderer.root.findAllByProps({ className: "settings-provider-key" })).toHaveLength(2);
		const credential = renderer.root.findByProps({ className: "settings-provider", "data-provider": "acme" });
		expect(credential.findByProps({ className: "settings-provider-key" }).props.type).toBe("password");
		expect(textContent(renderer.toJSON())).toContain("ready");
		expect(textContent(renderer.toJSON())).toContain("degraded");
	});

	test("undeclared extension shows the note and Advanced only", async () => {
		const renderer = await renderPage({ sections: [] });
		expect(parts(renderer)).toEqual(["advanced"]);
		expect(textContent(renderer.toJSON())).toContain("This extension doesn't describe its settings.");
		expect(textContent(renderer.toJSON())).toContain("endpoint, legacy");
		expect(textContent(renderer.toJSON())).toContain("not in this version's settings");
	});

	test("Advanced lists unknown stored keys", async () => {
		const renderer = await renderPage();
		const advanced = renderer.root.findByProps({ "data-extension-part": "advanced" });
		expect(advanced.props.open).toBeUndefined();
		expect(advanced.findByType("summary").children).toContain("Advanced");
		const text = textContent(renderer.toJSON());
		expect(text).toContain("legacy");
		expect(text).toContain("not in this version's settings");
		expect(text).toContain("https://acme.example.invalid");
	});
});
