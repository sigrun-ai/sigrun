/**
 * Settings rework Task 7: schema-declared settings surfaces. Saves validate
 * against the declared JSON Schema, replace declared top-level properties,
 * and route write-only values through the caller's secrets store.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import { changes, reset } from "./fixtures/fixture-settings-schema-save/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	reset();
});

const DECLARING = fixture("fixture-settings-schema-save");
const RESERVED_USER = fixture("fixture-settings-reserved-user-id");
const SURFACE = "/v1/ext/acme-schema-save/surfaces/settings";
const USER_SURFACE = "/v1/ext/acme-schema-save/surfaces/user-settings";

function fixture(name: string): string {
	return pathToFileURL(join(import.meta.dirname, "fixtures", name, "index.js")).href;
}

interface Rig {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly configDir: string;
	readonly token: string;
}

async function boot(options: {
	readonly settings?: Record<string, unknown>;
	readonly secrets?: Record<string, string>;
	readonly userSettings?: Record<string, unknown>;
	readonly userSecrets?: Record<string, string>;
	readonly specifier?: string;
} = {}): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-schema-save-"));
	const configDir = join(dir, "config");
	await mkdir(join(configDir, "settings"), { recursive: true });
	if (options.settings !== undefined) {
		await writeFile(join(configDir, "settings", "acme-schema-save.json"), JSON.stringify(options.settings));
	}
	if (options.secrets !== undefined) {
		await writeFile(
			join(configDir, "secrets.json"),
			JSON.stringify({ "acme-schema-save": options.secrets }),
			{ mode: 0o600 },
		);
	}
	if (options.userSettings !== undefined) {
		await mkdir(join(configDir, "user-settings", "alice"), { recursive: true });
		await writeFile(join(configDir, "user-settings", "alice", "acme-schema-save.json"), JSON.stringify(options.userSettings));
	}
	if (options.userSecrets !== undefined) {
		await writeFile(
			join(configDir, "user-secrets", "alice.json"),
			JSON.stringify({ "acme-schema-save": options.userSecrets }),
			{ mode: 0o600 },
		).catch(async (error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			await mkdir(join(configDir, "user-secrets"), { recursive: true });
			await writeFile(
				join(configDir, "user-secrets", "alice.json"),
				JSON.stringify({ "acme-schema-save": options.userSecrets }),
				{ mode: 0o600 },
			);
		});
	}
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 128_000 }] });
	const contributor: ProviderContributor = { name: "ext-faux", providers: [{ provider: faux.provider }] };
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
	const identity = await seededIdentity(join(dir, "seed"), "alice");
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		extensionSpecifiers: [options.specifier ?? DECLARING],
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
	return { app, opened, configDir, token };
}

async function call(rig: Rig, method: "GET" | "POST", url: string, payload?: unknown) {
	const response = await rig.app.inject({
		method,
		url,
		headers: { authorization: `Bearer ${rig.token}` },
		...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
	});
	return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function save(rig: Rig, values: Record<string, unknown>, id: string, url = SURFACE) {
	const rendered = await call(rig, "GET", url);
	expect(rendered.status, JSON.stringify(rendered.body)).toBe(200);
	return await call(rig, "POST", `${url}/actions`, {
		action: "save",
		actionId: id,
		params: {},
		payload: { rev: rendered.body.rev, values },
	});
}

async function file(rig: Rig, user = false): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readFile(join(
			rig.configDir,
			...(user ? ["user-settings", "alice"] : ["settings"]),
			"acme-schema-save.json",
		), "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

async function secrets(rig: Rig, user = false): Promise<Record<string, string>> {
	const path = user
		? join(rig.configDir, "user-secrets", "alice.json")
		: join(rig.configDir, "secrets.json");
	const document = JSON.parse(await readFile(path, "utf8")) as Record<string, Record<string, string>>;
	return document["acme-schema-save"] ?? {};
}

const renamedEntry = {
	"acme-renamed": {
		$from: "acme",
		url: "https://renamed.example.invalid",
		headers: { Authorization: { value: "", extra: "channel-only" } },
	},
};

test("unknown stored keys survive a schema save", async () => {
	const rig = await boot({ settings: { legacy: { preserve: true }, interval: 30 } });
	const result = await save(rig, { interval: 45 }, "unknown-keys");
	expect(result.body).toMatchObject({ ok: true });
	expect(await file(rig)).toEqual({ legacy: { preserve: true }, interval: 45 });
	expect(changes).toEqual([{ keys: ["interval"], user: undefined }]);
});

test("a scalar table unwraps the channel's single value field", async () => {
	const rig = await boot({ settings: { labels: { acme: "before" } } });
	const result = await save(rig, {
		labels: { acme: { value: "after", $from: "acme" } },
	}, "scalar-table");
	expect(result.body).toMatchObject({ ok: true });
	expect(await file(rig)).toEqual({ labels: { acme: "after" } });
});

test("deleting a table entry removes it from the file", async () => {
	const rig = await boot({
		settings: {
			servers: {
				acme: { url: "https://acme.example.invalid" },
				beta: { url: "https://beta.example.invalid" },
			},
		},
	});
	const result = await save(rig, {
		servers: { acme: { $from: "acme", url: "https://acme.example.invalid" } },
	}, "delete-table-entry");
	expect(result.body).toMatchObject({ ok: true });
	expect(await file(rig)).toEqual({
		servers: { acme: { url: "https://acme.example.invalid" } },
	});
});

test("rename moves secrets", async () => {
	const rig = await boot({
		settings: { servers: { acme: { url: "https://acme.example.invalid", headers: { Authorization: "" } } } },
		secrets: { "servers/acme/headers/Authorization": "Bearer synthetic-acme" },
	});
	const result = await save(rig, { servers: renamedEntry }, "rename-secrets");
	expect(result.body).toMatchObject({ ok: true });
	expect(await secrets(rig)).toEqual({
		"servers/acme-renamed/headers/Authorization": "Bearer synthetic-acme",
	});
	expect(await file(rig)).toEqual({
		servers: {
			"acme-renamed": { url: "https://renamed.example.invalid", headers: { Authorization: "" } },
		},
	});
});

test("delete drops secrets", async () => {
	const rig = await boot({
		settings: {
			servers: {
				acme: { url: "https://acme.example.invalid", headers: { Authorization: "" } },
				beta: { url: "https://beta.example.invalid", headers: { Authorization: "" } },
			},
		},
		secrets: {
			"servers/acme/headers/Authorization": "Bearer synthetic-acme",
			"servers/beta/headers/Authorization": "Bearer synthetic-beta",
		},
	});
	const result = await save(rig, {
		servers: { acme: { $from: "acme", url: "https://acme.example.invalid", headers: { Authorization: { value: "" } } } },
	}, "delete-secrets");
	expect(result.body).toMatchObject({ ok: true });
	expect(await secrets(rig)).toEqual({ "servers/acme/headers/Authorization": "Bearer synthetic-acme" });
});

test("render data never carries secret values", async () => {
	const rig = await boot({
		settings: {
			legacy: true,
			servers: { acme: { url: "https://acme.example.invalid", headers: { Authorization: "leaked-file-value" } } },
		},
		secrets: {
			token: "synthetic-top-level-value",
			"servers/acme/headers/Authorization": "Bearer synthetic-acme",
		},
	});
	const result = await call(rig, "GET", SURFACE);
	expect(result.status).toBe(200);
	const data = result.body.data as Record<string, unknown>;
	expect(data.settings).toMatchObject({ interval: 60, enabled: true });
	expect(data.secrets).toEqual({
		token: "stored",
		"servers/acme/headers/Authorization": "stored",
	});
	expect(data.unknownKeys).toEqual(["legacy"]);
	const serialized = JSON.stringify(result.body);
	for (const value of ["synthetic-top-level-value", "Bearer synthetic-acme", "leaked-file-value"]) {
		expect(serialized).not.toContain(value);
	}
});

test("an explicit clear deletes the secret", async () => {
	const rig = await boot({ secrets: { token: "synthetic-top-level-value" } });
	const result = await save(rig, { token: null }, "clear-secret");
	expect(result.body).toMatchObject({ ok: true });
	expect(await secrets(rig)).toEqual({});
	expect(Object.hasOwn(await file(rig), "token")).toBe(false);
});

test("a minLength-constrained secret clears successfully", async () => {
	const rig = await boot({
		settings: { constrainedToken: "leaked-placeholder" },
		secrets: { constrainedToken: "synthetic-constrained-value" },
	});
	const result = await save(rig, { constrainedToken: null }, "clear-constrained-secret");
	expect(result.body).toMatchObject({ ok: true });
	expect(await secrets(rig)).toEqual({});
	expect(Object.hasOwn(await file(rig), "constrainedToken")).toBe(false);
});

test("a value equal to its default is not pinned when absent before", async () => {
	const rig = await boot();
	const result = await save(rig, { interval: 60, enabled: true }, "defaults-absent");
	expect(result.body).toMatchObject({ ok: true });
	expect(await file(rig)).toEqual({});
});

test("a value equal to its default stays when it was stored", async () => {
	const rig = await boot({ settings: { interval: 30, enabled: false } });
	const result = await save(rig, { interval: 60, enabled: true }, "defaults-stored");
	expect(result.body).toMatchObject({ ok: true });
	expect(await file(rig)).toEqual({ interval: 60, enabled: true });
});

test("stale rev still rejects", async () => {
	const rig = await boot();
	const rendered = await call(rig, "GET", SURFACE);
	const rev = rendered.body.rev;
	const payload = (id: string, value: number) => ({
		action: "save", actionId: id, params: {}, payload: { rev, values: { interval: value } },
	});
	const first = await call(rig, "POST", `${SURFACE}/actions`, payload("stale-first", 45));
	expect(first.body).toMatchObject({ ok: true });
	const stale = await call(rig, "POST", `${SURFACE}/actions`, payload("stale-second", 90));
	expect(stale.body).toEqual({ ok: false, error: { message: "changed by someone else" } });
	expect(await file(rig)).toEqual({ interval: 45 });
});

test("schema error is field-scoped by JSON pointer", async () => {
	const rig = await boot();
	const result = await save(rig, { interval: "often" }, "invalid-schema");
	expect(result.body.ok).toBe(false);
	expect(result.body.error).toMatchObject({ field: "/interval" });
	expect((result.body.error as { message: string }).message).toContain("integer");
	expect(await file(rig)).toEqual({});
});

test("user-settings saves the caller's own file", async () => {
	const rig = await boot({
		settings: { mode: "shared-sentinel" },
		userSettings: { nickname: "Before" },
		userSecrets: { token: "synthetic-personal" },
	});
	const result = await save(rig, { nickname: "Alice", enabled: false }, "personal-save", USER_SURFACE);
	expect(result.body).toMatchObject({ ok: true });
	expect(await file(rig, true)).toEqual({ nickname: "Alice", enabled: false });
	expect(await file(rig)).toEqual({ mode: "shared-sentinel" });
	expect(await secrets(rig, true)).toEqual({ token: "synthetic-personal" });
	expect(changes).toEqual([{ keys: ["nickname", "enabled"], user: "alice" }]);
});

test("raw settings route never returns a nested secret", async () => {
	const rig = await boot({
		settings: {
			token: "leaked-top-level",
			servers: { acme: { url: "https://acme.example.invalid", headers: { Authorization: "leaked-nested-value" } } },
		},
	});
	const result = await call(rig, "GET", "/v1/extensions/acme-schema-save/settings");
	expect(result.status).toBe(200);
	expect(JSON.stringify(result.body)).not.toContain("leaked-top-level");
	expect(JSON.stringify(result.body)).not.toContain("leaked-nested-value");
	expect(result.body.settings).toMatchObject({
		servers: { acme: { url: "https://acme.example.invalid" } },
	});
});

test("renamed entry validates (with $from present in the submission)", async () => {
	const rig = await boot({
		settings: { servers: { acme: { url: "https://acme.example.invalid", headers: { Authorization: "" } } } },
		secrets: { "servers/acme/headers/Authorization": "Bearer synthetic-acme" },
	});
	const result = await save(rig, { servers: renamedEntry }, "renamed-validates");
	expect(result.body).toMatchObject({ ok: true });
	expect(JSON.stringify(await file(rig))).not.toContain("$from");
});

test("a root additionalProperties table renders and saves its rows at the root", async () => {
	const rig = await boot({ specifier: fixture("fixture-settings-root-table") });
	await mkdir(join(rig.configDir, "user-settings", "alice"), { recursive: true });
	await writeFile(
		join(rig.configDir, "user-settings", "alice", "acme-root-table.json"),
		JSON.stringify({ known: "before", acme: true }),
	);
	const surface = "/v1/ext/acme-root-table/surfaces/user-settings";
	const rendered = await call(rig, "GET", surface);
	expect(rendered.status).toBe(200);
	const data = rendered.body.data as Record<string, unknown>;
	const settings = data.settings as Record<string, unknown>;
	expect(settings[""]).toEqual({ acme: true });
	expect(data.unknownKeys).toEqual([]);

	const saved = await save(rig, {
		known: "after",
		"": {
			acme: { value: false, $from: "acme" },
			other: { value: true },
		},
	}, "root-table-save", surface);
	expect(saved.body).toMatchObject({ ok: true });
	const stored = JSON.parse(await readFile(
		join(rig.configDir, "user-settings", "alice", "acme-root-table.json"),
		"utf8",
	)) as Record<string, unknown>;
	expect(stored).toEqual({ known: "after", acme: false, other: true });
});

test("a view named settings fails the load of a declaring extension", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-reserved-view-"));
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 128_000 }] });
	const contributor: ProviderContributor = { name: "ext-faux", providers: [{ provider: faux.provider }] };
	const specifier = fixture("fixture-settings-reserved-id");
	const opened = await openHarness(config, {
		identity: await seededIdentity(join(dir, "seed"), "alice"),
		extensions: [contributor], extensionSpecifiers: [specifier], settingsDir: dir, builtins: false,
	});
	// Boot starts per-user curation migration in the background. Wait for
	// its marker-last write before cleanup; under full-suite load it can
	// otherwise still be creating data/users/alice/curation while rm runs.
	await vi.waitFor(async () => {
		await readFile(join(dir, "data", "users", "alice", "curation", "history", "MIGRATED"));
	}, { timeout: 5_000, interval: 10 });
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	expect(opened.extensionOutcomes[0]).toMatchObject({ status: "quarantined" });
	expect(opened.extensionOutcomes[0]?.error).toContain('"settings"');
});

test("a panel named user-settings fails the load of a declaring extension", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-reserved-user-view-"));
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 128_000 }] });
	const contributor: ProviderContributor = { name: "ext-faux", providers: [{ provider: faux.provider }] };
	const opened = await openHarness(config, {
		identity: await seededIdentity(join(dir, "seed"), "alice"),
		extensions: [contributor], extensionSpecifiers: [RESERVED_USER], settingsDir: dir, builtins: false,
	});
	// Same marker-last migration wait as the reserved-view test above.
	await vi.waitFor(async () => {
		await readFile(join(dir, "data", "users", "alice", "curation", "history", "MIGRATED"));
	}, { timeout: 5_000, interval: 10 });
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	expect(opened.extensionOutcomes[0]).toMatchObject({ status: "quarantined" });
	expect(opened.extensionOutcomes[0]?.error).toContain('"user-settings"');
});



test("a blank optional string clears a stored value", async () => {
	const rig = await boot({ settings: { endpoint: "https://a.example.invalid", interval: 30 } });
	const result = await save(rig, { endpoint: "", interval: 30 }, "blank-clears");
	expect(result.body).toMatchObject({ ok: true });
	expect(await file(rig)).toEqual({ interval: 30 });
});

test("a blank optional string on a fresh file saves", async () => {
	const rig = await boot();
	const result = await save(rig, { endpoint: "" }, "blank-fresh");
	expect(result.body).toMatchObject({ ok: true });
	expect(await file(rig)).toEqual({});
});

test("a blank optional string inside a table entry is dropped", async () => {
	const rig = await boot();
	const result = await save(rig, {
		servers: { first: { url: "https://a.example.invalid", label: "" } },
	}, "blank-table-entry");
	expect(result.body).toMatchObject({ ok: true });
	const stored = await file(rig);
	expect(Object.hasOwn((stored.servers as Record<string, Record<string, unknown>>).first, "label")).toBe(false);
});

test("a blank required string still fails", async () => {
	const rig = await boot();
	const result = await save(rig, { servers: { first: { url: "" } } }, "blank-required");
	expect(result.body.ok).toBe(false);
	expect((result.body.error as { field: string }).field).toBe("/servers/first/url");
});

test("a blank secret still means unchanged", async () => {
	const rig = await boot({ secrets: { token: "synthetic-top-level-value" } });
	const result = await save(rig, { token: "" }, "blank-secret");
	expect(result.body).toMatchObject({ ok: true });
	expect(await secrets(rig)).toEqual({ token: "synthetic-top-level-value" });
});

test("a blank constrained secret saves other valid values without changing the secret", async () => {
	const rig = await boot({
		settings: { interval: 30 },
		secrets: { constrainedToken: "synthetic-constrained-value" },
	});
	const result = await save(rig, { constrainedToken: "", interval: 45 }, "blank-constrained-secret");
	expect(result.body).toMatchObject({ ok: true });
	expect(await file(rig)).toEqual({ interval: 45 });
	expect(await secrets(rig)).toEqual({ constrainedToken: "synthetic-constrained-value" });
});

test("clearing a value still publishes its key", async () => {
	const rig = await boot({ settings: { endpoint: "https://a.example.invalid" } });
	await save(rig, { endpoint: "" }, "blank-notifies");
	expect(changes.some((entry) => entry.keys.includes("endpoint"))).toBe(true);
});

test("dotted nested field names save through the generated form (provider-openai shape)", async () => {
	// The regression Michael hit live: a schema whose nested objects
	// carry default-true booleans (provider-openai's chat.enabled /
	// decisions.enabled) generates DOTTED field names; the channel
	// submits them flat and the save silently dropped them — the file
	// stayed {} while the UI reported saved and re-rendered defaults.
	const rig = await boot({});
	const result = await save(rig, { "group.label": false }, "dotted-nested-off");
	expect(result.body, JSON.stringify(result.body)).toMatchObject({ ok: true });
	expect(await file(rig)).toEqual({ group: { label: false } });
	// The reload + re-save shape: submitting again (still off) persists.
	const again = await save(rig, { "group.label": false }, "dotted-nested-off-2");
	expect(again.body).toMatchObject({ ok: true });
	expect(await file(rig)).toEqual({ group: { label: false } });
	// Siblings under one parent merge, not clobber.
	const both = await save(rig, { "group.label": false, mode: "auto" }, "dotted-siblings");
	expect(both.body).toMatchObject({ ok: true });
	expect(await file(rig)).toEqual({ group: { label: false }, mode: "auto" });
});
