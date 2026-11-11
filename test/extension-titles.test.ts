import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import type { ExtensionsResponse, SettingsSectionsResponse } from "../src/server/views.js";
import { seededIdentity } from "./helpers/identity.js";

const TITLED_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-titled-extension", "index.js"),
).href;

declare global {
	var __sigrunTitledFixtureTitle: unknown;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	delete globalThis.__sigrunTitledFixtureTitle;
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function bootServer(options?: {
	readonly builtins?: boolean;
	readonly extensionEntries?: readonly import("../src/harness/loader.js").ResolvedExtensionInput[];
}) {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-extension-titles-"));
	const configDir = join(dir, "config");
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_CONFIG_DIR: configDir,
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_AUTH: "token",
		SIGRUN_WEBUI: "false",
	});
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 128_000 }] });
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const opened = await openHarness(config, {
		identity: await seededIdentity(join(dir, "seed"), "alice"),
		extensions: [contributor],
		...(options?.builtins === true
			? {}
			: {
					...(options?.extensionEntries === undefined
						? { extensionSpecifiers: [TITLED_SPECIFIER] }
						: { extensionEntries: options.extensionEntries }),
					builtins: false,
				}),
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	const { token } = await opened.identity.tokens.create("alice-cli", "alice");
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return async function get<T>(path: string): Promise<T> {
		const response = await app.inject({
			method: "GET",
			url: path,
			headers: { authorization: `Bearer ${token}` },
		});
		expect(response.statusCode).toBe(200);
		return response.json() as T;
	};
}

test("a factory title reaches /v1/extensions and the section list", async () => {
	const get = await bootServer();
	const inventory = await get<ExtensionsResponse>("/v1/extensions");
	const sections = await get<SettingsSectionsResponse>("/v1/settings/sections");
	expect(inventory.extensions).toContainEqual(expect.objectContaining({
		name: "acme-titled",
		title: "Acme Titled",
	}));
	const entries = sections.sections.filter((section) => section.slug === "acme-titled");
	expect(entries.length).toBeGreaterThan(0);
	for (const section of entries) {
		expect(section).toMatchObject({
			slug: "acme-titled",
			page: "acme-titled",
			pageTitle: "Acme Titled",
		});
	}
});

test("built-ins carry their table titles", async () => {
	const get = await bootServer({ builtins: true });
	const inventory = await get<ExtensionsResponse>("/v1/extensions");
	expect(inventory.extensions).toContainEqual(expect.objectContaining({
		name: "sigrun-mcp",
		title: "MCP",
	}));
	expect(inventory.extensions.map((extension) => ({
		name: extension.name,
		title: extension.title,
	}))).toEqual([
		{ name: "codemode", title: "Codemode" },
		{ name: "sigrun-mcp", title: "MCP" },
		{ name: "tool-search", title: "Tool search" },
		{ name: "gateway", title: "Gateway" },
		{ name: "oauth", title: "OAuth login" },
		{ name: "curator", title: "Curator" },
	]);
});

test("a factory title overrides the built-in table title", async () => {
	const get = await bootServer({
		extensionEntries: [{ entry: TITLED_SPECIFIER, title: "Table fallback" }],
	});
	const inventory = await get<ExtensionsResponse>("/v1/extensions");
	expect(inventory.extensions).toContainEqual(expect.objectContaining({
		name: "acme-titled",
		title: "Acme Titled",
	}));
});

test("a blank title is ignored", async () => {
	globalThis.__sigrunTitledFixtureTitle = "  ";
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const get = await bootServer();
	const inventory = await get<ExtensionsResponse>("/v1/extensions");
	const sections = await get<SettingsSectionsResponse>("/v1/settings/sections");
	const row = inventory.extensions.find((extension) => extension.name === "acme-titled");
	expect(row).toBeDefined();
	expect(row).not.toHaveProperty("title");
	for (const section of sections.sections.filter((entry) => entry.slug === "acme-titled")) {
		expect(section.pageTitle).toBe("acme-titled");
	}
	const warnings = warn.mock.calls
		.map((call) => String(call[0]))
		.filter((message) => message.includes("title") && message.includes("acme-titled"));
	expect(warnings).toHaveLength(1);
});

test("a title is trimmed and limited to 60 characters", async () => {
	globalThis.__sigrunTitledFixtureTitle = "  Acme Titled  ";
	const getTrimmed = await bootServer();
	const trimmed = await getTrimmed<ExtensionsResponse>("/v1/extensions");
	expect(trimmed.extensions.find((extension) => extension.name === "acme-titled")?.title)
		.toBe("Acme Titled");

	globalThis.__sigrunTitledFixtureTitle = "x".repeat(61);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const getTooLong = await bootServer();
	const tooLong = await getTooLong<ExtensionsResponse>("/v1/extensions");
	expect(tooLong.extensions.find((extension) => extension.name === "acme-titled")?.title)
		.toBeUndefined();
	expect(warn.mock.calls.filter((call) =>
		String(call[0]).includes("title") && String(call[0]).includes("acme-titled"),
	)).toHaveLength(1);

	globalThis.__sigrunTitledFixtureTitle = "x".repeat(60);
	const getMaximum = await bootServer();
	const maximum = await getMaximum<ExtensionsResponse>("/v1/extensions");
	expect(maximum.extensions.find((extension) => extension.name === "acme-titled")?.title)
		.toBe("x".repeat(60));
});
