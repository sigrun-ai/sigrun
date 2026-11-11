import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import type { ExtensionsResponse } from "../src/server/views.js";
import { seededIdentity } from "./helpers/identity.js";

const UNDECLARED_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-stores", "index.js"),
).href;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function bootServer(options?: {
	readonly builtins?: boolean;
	readonly storedSettings?: {
		readonly slug: string;
		readonly value: Record<string, unknown>;
	};
	readonly malformedSettingsSlug?: string;
}) {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-extension-settings-page-"));
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
	const identity = await seededIdentity(join(dir, "seed"), "tester");
	await identity.users.add({ user: "pleb", admin: false, source: "cli" });
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		builtins: options?.builtins === true,
		extensionSpecifiers: options?.builtins === true ? [] : [UNDECLARED_SPECIFIER],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	if (options?.storedSettings !== undefined) {
		await opened.extensionStores
			.settingsFor(options.storedSettings.slug)
			.set(options.storedSettings.value);
	}
	if (options?.malformedSettingsSlug !== undefined) {
		await writeFile(
			join(configDir, "settings", `${options.malformedSettingsSlug}.json`),
			"{not json}",
			"utf8",
		);
	}
	const adminToken = (await opened.identity.tokens.create("tester-cli", "tester")).token;
	const plebToken = (await opened.identity.tokens.create("pleb-cli", "pleb")).token;
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return async function get<T>(path: string, user: "tester" | "pleb" = "tester"): Promise<T> {
		const response = await app.inject({
			method: "GET",
			url: path,
			headers: { authorization: `Bearer ${user === "tester" ? adminToken : plebToken}` },
		});
		expect(response.statusCode).toBe(200);
		return response.json() as T;
	};
}

test("extensions without settings get no settingsPage", async () => {
	const get = await bootServer({ builtins: true });
	const inventory = await get<ExtensionsResponse>("/v1/extensions");
	for (const name of ["codemode", "tool-search"]) {
		expect(inventory.extensions.find((extension) => extension.name === name), name)
			.toBeDefined();
		expect(inventory.extensions.find((extension) => extension.name === name))
			.not.toHaveProperty("settingsPage");
	}
	for (const name of ["curator", "sigrun-mcp"]) {
		expect(inventory.extensions).toContainEqual(expect.objectContaining({
			name,
			settingsPage: true,
		}));
	}
});

test("a stored settings file earns a page for admins only", async () => {
	const get = await bootServer({
		storedSettings: { slug: "acme-tool", value: { enabled: true } },
	});
	const admin = await get<ExtensionsResponse>("/v1/extensions");
	expect(admin.extensions).toContainEqual(expect.objectContaining({
		name: "acme-tool",
		settingsPage: true,
	}));
	const nonAdmin = await get<ExtensionsResponse>("/v1/extensions", "pleb");
	expect(nonAdmin.extensions).toContainEqual(expect.objectContaining({ name: "acme-tool" }));
	expect(nonAdmin.extensions.find((extension) => extension.name === "acme-tool"))
		.not.toHaveProperty("settingsPage");
});

test("a corrupt stored settings file earns no page without breaking the admin inventory", async () => {
	const get = await bootServer({ malformedSettingsSlug: "acme-tool" });
	const inventory = await get<ExtensionsResponse>("/v1/extensions");
	const row = inventory.extensions.find((extension) => extension.name === "acme-tool");
	expect(row).toMatchObject({ name: "acme-tool", status: "ok" });
	expect(row).not.toHaveProperty("settingsPage");
});
