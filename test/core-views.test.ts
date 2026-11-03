/**
 * Tabs+skills Task 4: core views — registration, listing, bump-all.
 *
 * The reserved `core` slug's built-in views (the Jobs/Skills views,
 * Tasks 5/12) attach via `SurfaceService.attachCoreViews` and run the
 * SAME surface code path as extension surfaces. Pinned behaviors:
 *
 * - `GET /v1/ext/core/surfaces/<id>` renders an attached core view;
 * - `GET /v1/meta` and `GET /v1/extensions` both carry `coreViews`
 *   (id/title/icon), and `extensions[]` carries NO `core` row (the
 *   health dot is unaffected — core views are not extensions);
 * - `bumpAllInstances("core", id)` after two instances were rendered
 *   (params `{a:1}`, `{a:2}`) bumps BOTH revs and publishes two
 *   `surface.changed` events;
 * - `coreViewInfos` projects the def list (sparse `refreshMs`).
 *
 * Hermetic shape: the settings-sections test pattern (token auth, one
 * admin, no extension specifiers — the core views attach in-process).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import type { JsonObject, Tree } from "@sigrun/shared/blocks";
import type { SurfaceDef } from "../src/extension.js";
import type { Principal } from "../src/server/auth/principal.js";
import type {
	SurfaceChangedInternal,
} from "../src/server/surfaces/service.js";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { coreViewInfos } from "../src/server/core-views/index.js";
import { SurfaceService } from "../src/server/surfaces/service.js";
import { seededIdentity } from "./helpers/identity.js";

// The fixture core view: a minimal valid tree (the root page's title is
// the DEF's title); Task 5/12's real defs replace it.
const FIXTURE_VIEW: SurfaceDef<"view"> = {
	id: "fixture",
	title: "Fixture view",
	icon: "board",
	placement: "view",
	render: async () => ({
		tree: {
			v: 1,
			root: { type: "page", title: "Fixture view", main: [] },
		} as unknown as Tree,
		data: {},
		access: "write",
	}),
};

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly aliceToken: string;
}

let booted: Promise<TestServer> | undefined;
function server(): Promise<TestServer> {
	booted ??= bootServer();
	return booted;
}

/** Boot one hermetic token-method server with the fixture core view attached. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-core-views-"));
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
	const opened = await openHarness(config, {
		identity,
		extensionSpecifiers: [],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	const app = await createServer(opened, config);
	app.surfaces.attachCoreViews([FIXTURE_VIEW]);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, aliceToken };
}

interface CallResult {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

async function call(
	app: FastifyInstance,
	options: {
		readonly method: "GET" | "POST";
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

describe("core views (tabs+skills Task 4)", () => {
	test("GET /v1/ext/core/surfaces/fixture renders the attached core view", async () => {
		const { app, aliceToken } = await server();
		const result = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/fixture",
			token: aliceToken,
		});
		expect(result.status).toBe(200);
		expect(result.body.rev).toBe(0);
		expect(result.body.treeRev).toBe(0);
		expect(result.body.access).toBe("write");
		expect(result.body.tree).toMatchObject({
			root: { type: "page", title: "Fixture view" },
		});
	});

	test("GET /v1/meta carries coreViews; extensions[] has no core row", async () => {
		const { app, aliceToken } = await server();
		const result = await call(app, { method: "GET", url: "/v1/meta", token: aliceToken });
		expect(result.status).toBe(200);
		const meta = result.body as unknown as {
			coreViews?: { id: string; title: string; icon: string }[];
			extensions: { name: string }[];
		};
		expect(meta.coreViews).toEqual([
			{ id: "fixture", title: "Fixture view", icon: "board" },
		]);
		expect(meta.extensions.some((one) => one.name === "core")).toBe(false);
	});

	test("GET /v1/extensions carries coreViews; extensions[] has no core row", async () => {
		const { app, aliceToken } = await server();
		const result = await call(app, {
			method: "GET",
			url: "/v1/extensions",
			token: aliceToken,
		});
		expect(result.status).toBe(200);
		const body = result.body as unknown as {
			coreViews?: { id: string; title: string; icon: string }[];
			extensions: { name: string }[];
		};
		expect(body.coreViews).toEqual([
			{ id: "fixture", title: "Fixture view", icon: "board" },
		]);
		expect(body.extensions.some((one) => one.name === "core")).toBe(false);
	});

	test("no coreViews block appears when no core views are attached", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-core-views-empty-"));
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
		const opened = await openHarness(config, {
			identity,
			extensionSpecifiers: [],
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
		const meta = await call(app, { method: "GET", url: "/v1/meta", token });
		expect(meta.status).toBe(200);
		expect("coreViews" in meta.body).toBe(false);
		const list = await call(app, { method: "GET", url: "/v1/extensions", token });
		expect(list.status).toBe(200);
		expect("coreViews" in list.body).toBe(false);
	});
});

// ─── bumpAllInstances + coreViewInfos (service-level, no server) ─────────

const ALICE: Principal = {
	user: "alice",
	name: "Alice Acme",
	admin: false,
	service: false,
	method: "token",
};

describe("bumpAllInstances (tabs+skills Task 4)", () => {
	test("two rendered instances both bump and publish surface.changed", async () => {
		const events: SurfaceChangedInternal[] = [];
		const service = new SurfaceService([], {
			publishChanged: (event) => events.push(event),
		});
		service.attachCoreViews([FIXTURE_VIEW]);
		await service.render("core", "fixture", { a: 1 }, ALICE);
		await service.render("core", "fixture", { a: 2 }, ALICE);
		service.bumpAllInstances("core", "fixture");
		expect(events).toHaveLength(2);
		// Key order: canonical JSON — {"a":1} then {"a":2}.
		const keys = events.map((event) => event.k);
		expect(new Set(keys).size).toBe(2);
		expect(events.map((event) => event.rev)).toEqual([1, 1]);
		expect(events.every((event) => event.type === "surface.changed")).toBe(true);
		expect(events.every((event) => event.slug === "core")).toBe(true);
		expect(events.every((event) => event.id === "fixture")).toBe(true);
		// The rev advanced on both instances.
		expect(service.currentRev("core", "fixture", '{"a":1}')).toBe(1);
		expect(service.currentRev("core", "fixture", '{"a":2}')).toBe(1);
	});

	test("an unrendered (slug,id) is a no-op (no event, no rev)", () => {
		const events: SurfaceChangedInternal[] = [];
		const service = new SurfaceService([], {
			publishChanged: (event) => events.push(event),
		});
		service.attachCoreViews([FIXTURE_VIEW]);
		service.bumpAllInstances("core", "fixture");
		expect(events).toHaveLength(0);
	});
});

describe("coreViewInfos (tabs+skills Task 4)", () => {
	test("projects id/title/icon; refreshMs is sparse", () => {
		const withRefresh: SurfaceDef<"view"> = {
			...FIXTURE_VIEW,
			id: "jobs",
			title: "Jobs",
			icon: "clock",
			refreshMs: 5000,
		};
		expect(coreViewInfos([FIXTURE_VIEW, withRefresh])).toEqual([
			{ id: "fixture", title: "Fixture view", icon: "board" },
			{ id: "jobs", title: "Jobs", icon: "clock", refreshMs: 5000 },
		]);
	});
});
