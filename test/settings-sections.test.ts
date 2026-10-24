/**
 * UI-blocks U4 Task 3 (spec §13.3/§13.4): extension-declared settings
 * sections as settings-placement surfaces.
 *
 * - The loader reads a factory result's `surfaces.settings` list
 *   (`SettingsSectionDef`), validating each form against the `settings`
 *   placement; a malformed declaration quarantines the extension.
 * - The settings-surfaces adapter
 *   (`src/server/surfaces/settings-surfaces.ts`) turns one section into
 *   a surface at `/v1/ext/<slug>/surfaces/<id>`: `render` returns the
 *   form plus the stored `settings/<slug>.json` values and the
 *   declared-secret statuses; the `save` action validates the fields,
 *   merges into the stored object (unknown stored keys survive —
 *   Review Focus 5), and fires the §13.2 change path.
 * - Access: `admin` sections (the default) are `write` for superusers
 *   and admins, `none` (404) for everyone else; `admin: false`
 *   sections are `write` for any authenticated principal.
 * - Optimistic concurrency (Review Focus 3): `save` carries the `rev`
 *   its data read was based on; a stale `rev` rejects with
 *   `{ok: false, error: {message: "changed by someone else"}}`.
 * - An extension naming itself `core` quarantines — core's own
 *   sections use that slug (§13.4).
 *
 * Hermetic shape: full `openHarness` + `createServer` boots over tmp
 * dirs (the surfaces-routes test pattern), token auth with one admin
 * (alice) and one non-admin (bob).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	afterAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import type { JsonObject } from "@sigrun/shared/blocks";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import { received, reset } from "./fixtures/fixture-settings-section/index.js";

const SECTION_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-settings-section", "index.js"),
).href;
const CORE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-settings-core", "index.js"),
).href;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly aliceToken: string;
	readonly bobToken: string;
}

let booted: Promise<TestServer> | undefined;
function server(): Promise<TestServer> {
	booted ??= bootServer();
	return booted;
}

/** Boot one hermetic token-method server with the settings-section fixture. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-sett-sections-"));
	const configDir = join(dir, "config");
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_WEBUI: "false",
		SIGRUN_AUTH: "token",
		SIGRUN_CONFIG_DIR: configDir,
	});
	const identity = await seededIdentity(join(dir, "seed"), "alice");
	await identity.users.add({
		user: "bob",
		name: "Bob Acme",
		admin: false,
		source: "cli",
	});
	const opened = await openHarness(config, {
		identity,
		extensionSpecifiers: [SECTION_SPECIFIER],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	const { token: bobToken } = await opened.identity.tokens.create(
		"bob-cli",
		"bob",
	);
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, aliceToken, bobToken };
}

interface CallResult {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

async function call(
	app: FastifyInstance,
	options: {
		readonly method: "GET" | "POST" | "PUT";
		readonly url: string;
		readonly token: string;
		readonly payload?: unknown;
	},
): Promise<CallResult> {
	const response = await app.inject({
		method: options.method,
		url: options.url,
		headers: { authorization: `Bearer ${options.token}` },
		...(options.payload === undefined
			? {}
			: { payload: options.payload as Record<string, unknown> }),
	});
	return {
		status: response.statusCode,
		body: response.json() as Record<string, unknown>,
	};
}

const SECTION_URL =
	"/v1/ext/acme-settings-section/surfaces/connection";
const DISPLAY_URL = "/v1/ext/acme-settings-section/surfaces/display";

beforeEach(() => {
	reset();
});

describe("settings sections render (U4 Task 3)", () => {
	test("the section renders its form with the stored values", async () => {
		const { app, opened, aliceToken } = await server();
		await opened.extensionStores
			.settingsFor("acme-settings-section")
			.set({ apiUrl: "https://api.example.invalid", limit: 42 });
		const result = await call(app, {
			method: "GET",
			url: SECTION_URL,
			token: aliceToken,
		});
		expect(result.status).toBe(200);
		const body = result.body as {
			tree: { root: { type: string; children: { name: string }[] } };
			data: { settings: JsonObject };
			access: string;
		};
		expect(body.tree.root.type).toBe("form");
		expect(
			body.tree.root.children.map((child) => child.name),
		).toEqual(["apiUrl", "limit"]);
		expect(body.data.settings).toEqual({
			apiUrl: "https://api.example.invalid",
			limit: 42,
		});
		expect(body.access).toBe("write");
	});

	test("a secret field shows its status and never its value", async () => {
		const { app, aliceToken } = await server();
		const secret = await call(app, {
			method: "PUT",
			url: "/v1/extensions/acme-settings-section/secrets/api-token",
			token: aliceToken,
			payload: { value: "s3cr3t-token-value" },
		});
		expect(secret.status).toBe(200);
		const result = await call(app, {
			method: "GET",
			url: SECTION_URL,
			token: aliceToken,
		});
		expect(result.status).toBe(200);
		const body = result.body as {
			data: { secrets: Record<string, string>; settings: JsonObject };
		};
		expect(body.data.secrets).toEqual({ "api-token": "set (stored)" });
		// The secret VALUE appears nowhere in the response.
		expect(JSON.stringify(result.body)).not.toContain("s3cr3t-token-value");
	});
});

describe("settings section save (U4 Task 3)", () => {
	test("a value violating the field's min rejects and writes nothing", async () => {
		const { app, opened, aliceToken } = await server();
		// The booted server is shared across tests — reset the store to a
		// known state before the reject-does-not-write assertion.
		await opened.extensionStores.settingsFor("acme-settings-section").set({});
		const render = await call(app, {
			method: "GET",
			url: SECTION_URL,
			token: aliceToken,
		});
		const rev = (render.body as { rev: number }).rev;
		const save = await call(app, {
			method: "POST",
			url: `${SECTION_URL}/actions`,
			token: aliceToken,
			payload: {
				action: "save",
				payload: { rev, values: { limit: 0 } },
			},
		});
		expect(save.status).toBe(200);
		expect(save.body).toEqual({
			ok: false,
			error: { message: expect.any(String), field: "limit" },
		});
		// Nothing was written.
		expect(
			await opened.extensionStores.settingsFor("acme-settings-section").get(),
		).toEqual({});
	});

	test("a valid save writes the store, returns a rev, and fires onSettingsChanged", async () => {
		const { app, opened, aliceToken } = await server();
		// The booted server is shared across tests — reset the store (and
		// the fixture's `received` list is per-test via beforeEach).
		await opened.extensionStores.settingsFor("acme-settings-section").set({});
		const render = await call(app, {
			method: "GET",
			url: SECTION_URL,
			token: aliceToken,
		});
		const rev = (render.body as { rev: number }).rev;
		const save = await call(app, {
			method: "POST",
			url: `${SECTION_URL}/actions`,
			token: aliceToken,
			payload: {
				action: "save",
				payload: {
					rev,
					values: { apiUrl: "https://api.example.invalid/v2", limit: 7 },
				},
			},
		});
		expect(save.status).toBe(200);
		expect(save.body).toMatchObject({ ok: true });
		expect(typeof (save.body as { rev: unknown }).rev).toBe("number");
		// The store holds the saved values.
		expect(
			await opened.extensionStores.settingsFor("acme-settings-section").get(),
		).toEqual({ apiUrl: "https://api.example.invalid/v2", limit: 7 });
		// The §13.2 change path fired (the fixture's recorder saw the keys).
		expect(received).toEqual([["apiUrl", "limit"]]);
		// A re-render sees the saved values.
		const after = await call(app, {
			method: "GET",
			url: SECTION_URL,
			token: aliceToken,
		});
		expect(
			(after.body as { data: { settings: JsonObject } }).data.settings,
		).toEqual({ apiUrl: "https://api.example.invalid/v2", limit: 7 });
	});

	test("a save based on a stale rev rejects (Review Focus 3)", async () => {
		const { app, opened, aliceToken } = await server();
		// The booted server is shared across tests — reset the store to a
		// known state before the concurrency dance.
		await opened.extensionStores.settingsFor("acme-settings-section").set({});
		const first = await call(app, {
			method: "GET",
			url: SECTION_URL,
			token: aliceToken,
		});
		const rev = (first.body as { rev: number }).rev;
		const saveOne = await call(app, {
			method: "POST",
			url: `${SECTION_URL}/actions`,
			token: aliceToken,
			payload: { action: "save", payload: { rev, values: { limit: 10 } } },
		});
		expect(saveOne.body).toMatchObject({ ok: true });
		// The SECOND save is based on the SAME (now stale) rev.
		const saveTwo = await call(app, {
			method: "POST",
			url: `${SECTION_URL}/actions`,
			token: aliceToken,
			payload: { action: "save", payload: { rev, values: { limit: 20 } } },
		});
		expect(saveTwo.status).toBe(200);
		expect(saveTwo.body).toEqual({
			ok: false,
			error: { message: "changed by someone else" },
		});
		// The stale write never landed.
		expect(
			await opened.extensionStores.settingsFor("acme-settings-section").get(),
		).toEqual({ limit: 10 });
		// The next fetch shows the current values.
		const after = await call(app, {
			method: "GET",
			url: SECTION_URL,
			token: aliceToken,
		});
		expect(
			(after.body as { data: { settings: JsonObject } }).data.settings,
		).toEqual({ limit: 10 });
	});

	test("an unknown stored key survives a save (Review Focus 5)", async () => {
		const { app, opened, aliceToken } = await server();
		await opened.extensionStores
			.settingsFor("acme-settings-section")
			.set({ apiUrl: "https://api.example.invalid", legacyFlag: true });
		const render = await call(app, {
			method: "GET",
			url: SECTION_URL,
			token: aliceToken,
		});
		// The unknown key is visible verbatim (the Advanced raw JSON reads
		// the same data payload).
		expect(
			(render.body as { data: { settings: JsonObject } }).data.settings,
		).toEqual({ apiUrl: "https://api.example.invalid", legacyFlag: true });
		const rev = (render.body as { rev: number }).rev;
		const save = await call(app, {
			method: "POST",
			url: `${SECTION_URL}/actions`,
			token: aliceToken,
			payload: { action: "save", payload: { rev, values: { apiUrl: "https://api.example.invalid/v3" } } },
		});
		expect(save.body).toMatchObject({ ok: true });
		// The unknown key SURVIVED the save (never dropped, §13.3).
		expect(
			await opened.extensionStores.settingsFor("acme-settings-section").get(),
		).toEqual({ apiUrl: "https://api.example.invalid/v3", legacyFlag: true });
	});
});

describe("settings section access (U4 Task 3)", () => {
	test("a non-admin gets 404 on an admin section (the default)", async () => {
		const { app, bobToken } = await server();
		const result = await call(app, {
			method: "GET",
			url: SECTION_URL,
			token: bobToken,
		});
		expect(result.status).toBe(404);
		expect(result.body).toEqual({ error: "surface_not_found" });
		// …and on its actions.
		const action = await call(app, {
			method: "POST",
			url: `${SECTION_URL}/actions`,
			token: bobToken,
			payload: { action: "save", payload: { rev: 0, values: {} } },
		});
		expect(action.status).toBe(404);
	});

	test("a non-admin section renders for a non-admin", async () => {
		const { app, bobToken } = await server();
		const result = await call(app, {
			method: "GET",
			url: DISPLAY_URL,
			token: bobToken,
		});
		expect(result.status).toBe(200);
		expect((result.body as { access: string }).access).toBe("write");
	});
});

describe("settings section load contract (U4 Task 3)", () => {
	test("an extension naming itself core quarantines (core sections use that slug)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-sett-core-"));
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_AUTH: "none",
		});
		const opened = await openHarness(config, {
			identity: await seededIdentity(join(dir, "seed")),
			extensionSpecifiers: [CORE_SPECIFIER],
			env: {},
			settingsDir: dir,
		});
		cleanups.push(async () => {
			await opened.harness.close(BACKGROUND_CONTEXT);
			await rm(dir, { recursive: true, force: true });
		});
		const outcome = opened.extensionOutcomes.find(
			(entry) => entry.status === "quarantined",
		);
		expect(outcome?.status).toBe("quarantined");
		expect(outcome?.error).toContain('"core"');
	});
});
