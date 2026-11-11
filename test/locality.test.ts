/**
 * Settings split Plan 2 Task 2: locality is ONE admin switch per provider
 * extension (`localProviders`, pseudo-slug `"core"` for the env-driven
 * provider), enforced for chat, decision and embedding models alike.
 *
 * Fixtures own their literals: extensions `acme-one`/`acme-two`;
 * providers `faux` (chat), `acme-judge` (decision), `acme-embed`
 * (embedding); the env-driven degenerate provider `openai`; the seeded
 * directory admin `tester`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createLocality } from "../src/harness/locality.js";
import { migrateLocalModels } from "../src/server/locality-migration.js";
import { createServer } from "../src/server/index.js";
import { SettingsStore } from "../src/harness/settings.js";
import { seededIdentity, unclaimedIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";
import type { HostEventWire } from "../src/server/events/types.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";

const require = createRequire(import.meta.url);
const fixture = (name: string): string =>
	pathToFileURL(require.resolve(`./fixtures/${name}/index.js`)).href;
const EMBEDDING_PROVIDER = fixture("fixture-embedding-provider");
const DECISION_PROVIDER = fixture("fixture-decision-provider");

// ---------------------------------------------------------------------------
// The pure resolver
// ---------------------------------------------------------------------------

test("createLocality resolves every kind through its owning extension", () => {
	const locality = createLocality({
		localProviders: () => ["acme-one", "acme-ext", "acme-embed"],
		ownerOf(kind, providerId) {
			if (kind === "chat") return providerId === "faux" ? "acme-one" : "core";
			if (kind === "decision") return providerId === "acme-judge" ? "acme-ext" : undefined;
			return providerId === "acme-embed" ? "acme-embed" : undefined;
		},
	});
	expect(locality.isLocalExtension("acme-one")).toBe(true);
	expect(locality.isLocalExtension("acme-two")).toBe(false);
	expect(locality.isLocalModel("chat", "faux/m1")).toBe(true);
	// The env-driven fallback carries the core pseudo-slug.
	expect(locality.isLocalModel("chat", "other/env")).toBe(false);
	expect(locality.isLocalModel("decision", "acme-judge/judge-1")).toBe(true);
	expect(locality.isLocalModel("embedding", "acme-embed/embed-1")).toBe(true);
	expect(locality.isLocalModel("decision", "missing/unknown")).toBe(false);
});

test("a collided chat id follows its owning extension", () => {
	// Two extensions register the same chat provider id; the LAST one wins
	// in the ownership map, so locality follows only that slug. Flip which
	// slug is local: the verdict must flip with it.
	const locality = createLocality({
		localProviders: () => ["acme-one"],
		ownerOf: () => "acme-two",
	});
	expect(locality.isLocalModel("chat", "faux/m1")).toBe(false);
	const flipped = createLocality({
		localProviders: () => ["acme-two"],
		ownerOf: () => "acme-two",
	});
	expect(flipped.isLocalModel("chat", "faux/m1")).toBe(true);
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

describe("migrateLocalModels", () => {
	const dirs: string[] = [];
	afterAll(async () => {
		for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	});
	async function storeWith(patch: Record<string, unknown>): Promise<SettingsStore> {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-locality-migrate-"));
		dirs.push(dir);
		const store = new SettingsStore({ dir });
		store.update(patch);
		return store;
	}

	test("localModels migrate to localProviders once", async () => {
		const store = await storeWith({
			embeddingModel: "acme-embed/embed-1",
			embeddings: {
				localModels: ["acme-embed/embed-1", "acme-embed/embed-2", "missing/gone"],
			},
		});
		const owners = new Map<string, string>([
			["acme-embed/embed-1", "acme-embed"],
			["acme-embed/embed-2", "acme-embed"],
		]);
		const result = migrateLocalModels(store, (model) => owners.get(model));
		expect(result.migrated).toEqual(["acme-embed"]);
		expect(store.read().localProviders).toEqual(["acme-embed"]);
		expect(store.read().embeddings?.localModels).toEqual([]);

		// A second run is a no-op: the vacated key never re-seeds.
		expect(migrateLocalModels(store, (model) => owners.get(model)).migrated).toEqual([]);
		expect(store.read().localProviders).toEqual(["acme-embed"]);
	});

	test("migration never claims a model whose extension was already local", async () => {
		const store = await storeWith({
			embeddingModel: "acme-embed/embed-1",
			localProviders: ["acme-embed"],
			embeddings: { localModels: ["acme-embed/embed-1", "acme-embed/embed-2"] },
		});
		const owners = new Map<string, string>([
			["acme-embed/embed-1", "acme-embed"],
			["acme-embed/embed-2", "acme-embed"],
		]);
		expect(migrateLocalModels(store, (model) => owners.get(model))).toEqual({ migrated: [] });
		expect(store.read().localProviders).toEqual(["acme-embed"]);
		expect(store.read().embeddings?.localModels).toEqual([]);
	});

	test("migration with nothing to migrate is a no-op", async () => {
		const store = await storeWith({ defaultModel: "openai/gpt-test" });
		expect(migrateLocalModels(store, () => "acme-embed").migrated).toEqual([]);
		const before = store.read();
		expect(before.localProviders).toBeUndefined();
		expect(before.embeddings).toBeUndefined();
		const empty = await storeWith({ embeddings: { localModels: [] } });
		expect(migrateLocalModels(empty, () => "acme-embed").migrated).toEqual([]);
		expect(empty.read().localProviders).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// The full-boot seams: the route, the host surface, and the notice
// ---------------------------------------------------------------------------

interface Rig {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly dir: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

async function boot(
	options: {
		readonly defaultModel?: string;
		readonly envDriven?: boolean;
		readonly collidedChat?: boolean;
		readonly emptyDirectory?: boolean;
		readonly preseed?: Record<string, unknown>;
	} = {},
): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-locality-"));
	const defaultModel = options.envDriven === true
		? "openai/gpt-test"
		: (options.defaultModel ?? "faux/m");
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: defaultModel,
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_DATA_DIR: join(dir, "data"),
	});
	const identity = options.emptyDirectory === true
		? await unclaimedIdentity(dir)
		: await seededIdentity(dir);
	// Admission guard: a SECOND directory user requires helper-checked
	// isolation at the .add call; seed BEFORE boot, as providers-api does.
	if (options.emptyDirectory !== true) {
		await identity.users.add({ user: "pleb", admin: false, source: "cli" });
	}
	if (options.preseed !== undefined) {
		// A migration premise is a hand-edited file, not an API write: the
		// raw-update seam deliberately skips the settings.changed observer.
		new SettingsStore({ dir }).update(options.preseed);
	}
	const contributors: ProviderContributor[] = [];
	if (options.envDriven !== true) {
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		contributors.push({ name: "acme-one", providers: [{ provider: faux.provider }] });
		if (options.collidedChat === true) {
			const replacement = fauxProvider({
				provider: "faux",
				models: [{ id: "m", contextWindow: 128_000 }],
			});
			contributors.push({ name: "acme-two", providers: [{ provider: replacement.provider }] });
		}
	}
	const opened = await openHarness(config, {
		identity,
		extensions: contributors,
		extensionSpecifiers: [EMBEDDING_PROVIDER, DECISION_PROVIDER],
		env: {},
		settingsDir: dir,
		builtins: false,
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	await opened.bootRefresh;
	return { app, opened, dir };
}

async function localPut(
	app: FastifyInstance,
	extension: string,
	body: unknown,
	token: string,
): Promise<{ status: number; json: unknown }> {
	const response = await app.inject({
		method: "PUT",
		url: `/v1/providers/local/${extension}`,
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		payload: body as Record<string, unknown>,
	});
	return { status: response.statusCode, json: response.json() };
}

async function adminToken(opened: OpenedHarness): Promise<string> {
	return (await opened.identity.tokens.create("tester-cli", "tester")).token;
}

describe("PUT /v1/providers/local/:extension", () => {
	test("PUT local toggles and publishes", async () => {
		const { app, opened } = await boot();
		const token = await adminToken(opened);
		const events: HostEventWire[] = [];
		opened.events.subscribe((event) => events.push(event));

		const turnedOn = await localPut(app, "acme-one", { local: true }, token);
		expect(turnedOn.status).toBe(200);
		expect(turnedOn.json).toEqual({ local: true });
		expect(opened.settings.read().localProviders).toEqual(["acme-one"]);
		expect(opened.locality.isLocalModel("chat", "faux/m")).toBe(true);

		// Sorted + unique: a second extension slug lands in order.
		const second = await localPut(app, "acme-embed", { local: true }, token);
		expect(second.status).toBe(200);
		expect(opened.settings.read().localProviders).toEqual(["acme-embed", "acme-one"]);

		const turnedOff = await localPut(app, "acme-one", { local: false }, token);
		expect(turnedOff.json).toEqual({ local: false });
		expect(opened.settings.read().localProviders).toEqual(["acme-embed"]);

		const changed = events.filter((event) => event.type === "settings.changed");
		expect(changed).toHaveLength(3);
		for (const event of changed) {
			expect(event).toMatchObject({ type: "settings.changed", keys: ["localProviders"] });
		}
	});

	test("PUT local is admin-only", async () => {
		const { app, opened } = await boot();
		const { token } = await opened.identity.tokens.create("pleb-cli", "pleb");
		const forbidden = await localPut(app, "acme-one", { local: true }, token);
		expect(forbidden.status).toBe(403);
		expect(forbidden.json).toEqual({ error: "forbidden" });
		expect(opened.settings.read().localProviders).toBeUndefined();
	});

	test("PUT local 404s for a non-provider extension", async () => {
		const { app, opened } = await boot();
		const token = await adminToken(opened);
		const missing = await localPut(app, "acme-nothing", { local: true }, token);
		expect(missing.status).toBe(404);
		expect(missing.json).toEqual({ error: "provider_not_found" });
		// The core pseudo-slug counts only while an env-driven provider is
		// served; a contributor-declared boot serves none.
		const core = await localPut(app, "core", { local: true }, token);
		expect(core.status).toBe(404);
	});

	test("a non-boolean local is invalid_field", async () => {
		const { app, opened } = await boot();
		const token = await adminToken(opened);
		const bad = await localPut(app, "acme-one", { local: "yes" }, token);
		expect(bad.status).toBe(400);
		expect(bad.json).toEqual({ error: "invalid_field", field: "local" });
	});
});

test("an env-driven provider is local under the core pseudo-slug", async () => {
	const { app, opened } = await boot({ envDriven: true });
	const token = await adminToken(opened);
	// No ownership entry for the env-driven provider → pseudo-slug core.
	expect(opened.providerOwnership.has("openai")).toBe(false);
	expect(opened.locality.isLocalModel("chat", "openai/gpt-test")).toBe(false);
	const turnedOn = await localPut(app, "core", { local: true }, token);
	expect(turnedOn.status).toBe(200);
	expect(turnedOn.json).toEqual({ local: true });
	expect(opened.settings.read().localProviders).toEqual(["core"]);
	expect(opened.locality.isLocalModel("chat", "openai/gpt-test")).toBe(true);
	// The provider rows carry the local flag too.
	const report = await app.inject({
		method: "GET",
		url: "/v1/providers",
		headers: { authorization: `Bearer ${token}` },
	});
	const rows = (report.json() as { providers: { provider: string; local: boolean }[] }).providers;
	expect(rows.find((row) => row.provider === "openai")?.local).toBe(true);
});

test("host.models.isLocal follows the admin switch", async () => {
	const { app, opened } = await boot();
	const bridge = app.hostBridge;
	expect(bridge.models.isLocal("faux/m")).toBe(false);
	const token = await adminToken(opened);
	await localPut(app, "acme-one", { local: true }, token);
	expect(bridge.models.isLocal("faux/m")).toBe(true);
	expect(bridge.models.isLocal("acme-embed/embed-1")).toBe(false);
	expect(bridge.models.isLocal("acme-judge/judge-1")).toBe(false);
	// An unknown provider is never local.
	expect(bridge.models.isLocal("missing/m")).toBe(false);
});

test("a collided chat id follows its owning extension live", async () => {
	// Registering two contributors for the same chat id is legal
	// (last-registered wins). The local answer follows the CURRENT owner.
	const { app, opened } = await boot({ collidedChat: true });
	const token = await adminToken(opened);
	expect(app.hostBridge.models.isLocal("faux/m")).toBe(false);
	// acme-one (the losing contributor) has NO routable models any more;
	// toggling it must not make the id local. (The route reports it as
	// not-found under the providers-of-slug rule.)
	expect((await localPut(app, "acme-one", { local: true }, token)).status).toBe(404);
	await localPut(app, "acme-two", { local: true }, token);
	expect(app.hostBridge.models.isLocal("faux/m")).toBe(true);
	await localPut(app, "acme-two", { local: false }, token);
	expect(app.hostBridge.models.isLocal("faux/m")).toBe(false);
	expect(opened.settings.read().localProviders).toEqual([]);
});

test("localModels migrate to localProviders once, with a notice", async () => {
	const { app, opened } = await boot({
		preseed: {
			embeddingModel: "acme-embed/embed-1",
			embeddings: { localModels: ["acme-embed/embed-1", "acme-embed/embed-2"] },
		},
	});
	// Headless boot migrated the file; createServer posted the notice.
	expect(opened.localityMigration.migrated).toEqual(["acme-embed"]);
	expect(opened.settings.read().localProviders).toEqual(["acme-embed"]);
	expect(opened.settings.read().embeddings?.localModels).toEqual([]);
	expect(opened.locality.isLocalModel("embedding", "acme-embed/embed-1")).toBe(true);
	const notices = await app.sigrunContext.notices.listForUser("tester");
	expect(notices).toHaveLength(1);
	expect(notices[0]).toMatchObject({
		owner: "core",
		key: "settings.locality-migrated",
		title: "Local providers moved",
		body: expect.stringContaining("acme-embed"),
	});
});

test("migration with an empty directory logs instead of noticing", async () => {
	const logged: string[] = [];
	const original = console.info;
	console.info = (line: string) => logged.push(String(line));
	try {
		const { opened } = await boot({
			emptyDirectory: true,
			preseed: {
				embeddingModel: "acme-embed/embed-1",
				embeddings: { localModels: ["acme-embed/embed-1"] },
			},
		});
		expect(opened.localityMigration.migrated).toEqual(["acme-embed"]);
		expect(logged.some((line) => line.includes("localProviders"))).toBe(true);
	} finally {
		console.info = original;
	}
});
