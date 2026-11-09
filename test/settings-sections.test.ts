/**
 * Settings rework Task 7: declarations become one extension page with fixed
 * shared/personal section ids, and the generated forms feed search.
 */

import { mkdtemp, rm } from "node:fs/promises";
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
import type { SettingsSectionsResponse } from "../src/server/views.js";
import { seededIdentity } from "./helpers/identity.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

test("sections list one page per declaring extension", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-schema-sections-"));
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
	});
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 128_000 }] });
	const contributor: ProviderContributor = { name: "ext-faux", providers: [{ provider: faux.provider }] };
	const fixture = (name: string) => pathToFileURL(join(import.meta.dirname, "fixtures", name, "index.js")).href;
	const opened = await openHarness(config, {
		identity: await seededIdentity(join(dir, "seed"), "alice"),
		extensions: [contributor],
		extensionSpecifiers: [fixture("fixture-settings-schema-user-only"), fixture("fixture-settings-schema-save")],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
		builtins: false,
		expectHostBridge: true,
	});
	const { token } = await opened.identity.tokens.create("alice-cli", "alice");
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	const response = await app.inject({
		method: "GET",
		url: "/v1/settings/sections",
		headers: { authorization: `Bearer ${token}` },
	});
	expect(response.statusCode).toBe(200);
	const body = response.json() as SettingsSectionsResponse;
	const extensionSections = body.sections.filter((section) => section.slug !== "core");
	expect(extensionSections).toEqual([
		expect.objectContaining({
			slug: "acme-schema-save", id: "settings", page: "acme-schema-save", title: "Settings", admin: true,
		}),
		expect.objectContaining({
			slug: "acme-schema-save", id: "user-settings", page: "acme-schema-save", title: "Your settings", scope: "user", admin: false,
		}),
		expect.objectContaining({
			slug: "acme-schema-user-only", id: "settings", page: "acme-schema-user-only", title: "Settings", admin: true,
		}),
		expect.objectContaining({
			slug: "acme-schema-user-only", id: "user-settings", page: "acme-schema-user-only", title: "Your settings", scope: "user", admin: false,
		}),
	]);
	expect(extensionSections.filter((section) => section.page === "acme-schema-save")).toHaveLength(2);
	expect(body.index.some((entry) => entry.slug === "acme-schema-save" && entry.sectionId === "settings" && entry.kind === "section")).toBe(true);
	expect(body.index.some((entry) => entry.slug === "acme-schema-save" && entry.sectionId === "user-settings" && entry.key === "nickname")).toBe(true);
});

test("a non-admin direct shared-section save is 404", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-schema-non-admin-"));
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
	});
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 128_000 }] });
	const contributor: ProviderContributor = { name: "ext-faux", providers: [{ provider: faux.provider }] };
	const identity = await seededIdentity(join(dir, "seed"), "alice");
	await identity.users.add({ user: "bob", admin: false, source: "cli" });
	const specifier = pathToFileURL(join(import.meta.dirname, "fixtures", "fixture-settings-schema-save", "index.js")).href;
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor], extensionSpecifiers: [specifier],
		env: { SIGRUN_CONFIG_DIR: configDir }, settingsDir: dir, builtins: false, expectHostBridge: true,
	});
	const { token } = await opened.identity.tokens.create("bob-cli", "bob");
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	const response = await app.inject({
		method: "POST",
		url: "/v1/ext/acme-schema-save/surfaces/settings/actions",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		payload: { action: "save", actionId: "bob-direct-shared-save", params: {}, payload: { rev: 0, values: {} } },
	});
	expect(response.statusCode).toBe(404);
});

test("search index includes entry item fields", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-schema-index-"));
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
	});
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 128_000 }] });
	const contributor: ProviderContributor = { name: "ext-faux", providers: [{ provider: faux.provider }] };
	const specifier = pathToFileURL(join(import.meta.dirname, "fixtures", "fixture-settings-schema-save", "index.js")).href;
	const opened = await openHarness(config, {
		identity: await seededIdentity(join(dir, "seed"), "alice"),
		extensions: [contributor], extensionSpecifiers: [specifier],
		env: { SIGRUN_CONFIG_DIR: configDir }, settingsDir: dir, builtins: false, expectHostBridge: true,
	});
	const { token } = await opened.identity.tokens.create("alice-cli", "alice");
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	const response = await app.inject({
		method: "GET", url: "/v1/settings/sections", headers: { authorization: `Bearer ${token}` },
	});
	expect(response.statusCode).toBe(200);
	const body = response.json() as SettingsSectionsResponse;
	expect(body.index).toContainEqual(expect.objectContaining({
		slug: "acme-schema-save",
		sectionId: "settings",
		kind: "field",
		label: "Gateway address",
		help: "The entry endpoint",
		key: "url",
	}));
});
