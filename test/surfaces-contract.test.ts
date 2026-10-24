/**
 * UI-blocks U3 Task 1: the `surfaces` contract field (spec §7.1), its
 * load-time validation (spec §15 — a malformed declaration quarantines
 * the extension), the reserved route prefixes (spec §7.2), and the
 * `GET /v1/extensions` inventory rows.
 *
 * Fixtures: `fixture-surfaces` (a view `board` with lanes + a panel
 * `stats`, built with the U0 builders through `@sigrun/sigrun/blocks`),
 * `fixture-surfaces-bad` (single-problem factories; the default export
 * is the duplicate-id case the loader quarantines), and
 * `fixture-surfaces-route-clash` (a route under `surfaces/`).
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { resolveExtension } from "../src/harness/loader.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

/** Repo root (test/ → ..): where tsconfig.extension.json lives. */
const REPO_ROOT = realpathSync(join(import.meta.dirname, ".."));

const SURFACES_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-surfaces", "index.js"),
).href;
const BAD_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-surfaces-bad", "index.js"),
).href;
const CLASH_SPECIFIER = pathToFileURL(
	join(
		import.meta.dirname,
		"fixtures",
		"fixture-surfaces-route-clash",
		"index.js",
	),
).href;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly adminToken: string;
}

/** The one shared boot (all three fixtures); memoized across tests. */
let booted: Promise<TestServer> | undefined;
function server(): Promise<TestServer> {
	booted ??= bootServer();
	return booted;
}

/** Boot one hermetic token-method server with all three fixtures loaded. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-surfaces-contract-"));
	const configDir = join(dir, "config");
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "openai/gpt-test",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_WEBUI: "false",
		SIGRUN_AUTH: "token",
		SIGRUN_CONFIG_DIR: configDir,
	});
	const identity = await seededIdentity(join(dir, "seed"));
	const opened = await openHarness(config, {
		identity,
		extensionSpecifiers: [SURFACES_SPECIFIER, BAD_SPECIFIER, CLASH_SPECIFIER],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	const { token: adminToken } = await opened.identity.tokens.create(
		"tester-cli",
		"tester",
	);
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, adminToken };
}

/** One row of the /v1/extensions surfaces inventory. */
interface SurfaceRow {
	readonly id: string;
	readonly title: string;
	readonly icon: string;
	readonly placement: string;
}

/** One injected request; returns status + parsed body. */
async function call(
	app: FastifyInstance,
	options: {
		readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
		readonly url: string;
		readonly token?: string;
	},
): Promise<{ status: number; body: unknown }> {
	const response = await app.inject({
		method: options.method,
		url: options.url,
		headers:
			options.token === undefined
				? {}
				: { authorization: `Bearer ${options.token}` },
	});
	return { status: response.statusCode, body: response.json() };
}

/** The single-problem factories from the bad fixture module. */
async function badFactories(): Promise<{
	createDuplicateId: () => unknown;
	createBadIcon: () => unknown;
	createFastRefresh: () => unknown;
	createRefreshWithoutData: () => unknown;
}> {
	return (await import(BAD_SPECIFIER)) as {
		createDuplicateId: () => unknown;
		createBadIcon: () => unknown;
		createFastRefresh: () => unknown;
		createRefreshWithoutData: () => unknown;
	};
}

describe("surfaces contract (U3 Task 1)", () => {
	test("fixture-surfaces loads and appears in GET /v1/extensions with its surfaces", async () => {
		const { app, opened, adminToken } = await server();
		const outcome = opened.extensionOutcomes.find(
			(entry) => entry.name === "fixture-surfaces",
		);
		expect(outcome?.status).toBe("ok");
		const response = await call(app, {
			method: "GET",
			url: "/v1/extensions",
			token: adminToken,
		});
		expect(response.status).toBe(200);
		const extensions = (
			response.body as {
				extensions: Array<{
					name: string;
					surfaces?: readonly SurfaceRow[];
				}>;
			}
		).extensions;
		const fixture = extensions.find(
			(entry) => entry.name === "fixture-surfaces",
		);
		expect(fixture?.surfaces).toEqual([
			{
				id: "board",
				title: "Acme board",
				icon: "board",
				placement: "view",
				// §7.3: sharedData projects through (channels fall back to a
				// full fetch on ops-only since answers).
				sharedData: true,
			},
			{ id: "stats", title: "Acme stats", icon: "chart", placement: "panel" },
		]);
		// Extensions that declared none carry no surfaces field (the sparse
		// inventory rule — version/builtin behave the same).
		const quarantined = extensions.find((entry) =>
			entry.name.includes("fixture-surfaces-route-clash"),
		);
		expect(quarantined?.surfaces).toBeUndefined();
	});

	test("a duplicate surface id quarantines the extension naming the id", async () => {
		const { createDuplicateId } = await badFactories();
		await expect(
			resolveExtension({ default: createDuplicateId }),
		).rejects.toThrow('duplicate surface id "board"');
		const { opened } = await server();
		const outcome = opened.extensionOutcomes.find((entry) =>
			entry.name.includes("fixture-surfaces-bad"),
		);
		expect(outcome?.status).toBe("quarantined");
		expect(outcome?.error).toContain('duplicate surface id "board"');
	});

	test("an unknown icon is its own quarantine message", async () => {
		const { createBadIcon } = await badFactories();
		await expect(resolveExtension({ default: createBadIcon })).rejects.toThrow(
			'unknown icon "not-an-icon"',
		);
	});

	test("refreshMs below 5000 is its own quarantine message", async () => {
		const { createFastRefresh } = await badFactories();
		await expect(
			resolveExtension({ default: createFastRefresh }),
		).rejects.toThrow('surface "board" declaring refreshMs 1000');
		await expect(
			resolveExtension({ default: createFastRefresh }),
		).rejects.toThrow("minimum 5000");
	});

	test("refreshMs without data() is its own quarantine message", async () => {
		const { createRefreshWithoutData } = await badFactories();
		await expect(
			resolveExtension({ default: createRefreshWithoutData }),
		).rejects.toThrow('surface "board" declaring refreshMs without data()');
	});

	test("a malformed surfaces.settings declaration quarantines naming the section (U4 Task 3)", () => {
		// The contract owns the key now (readonly SettingsSectionDef[]); a
		// malformed entry quarantines fail-loud, like every other surfaces
		// member — the section's id names the problem.
		return expect(
			resolveExtension({
				default: () => ({
					extension: { name: "surfaces-settings", hooks: [], tools: [] },
					surfaces: {
					settings: [
						{
							id: "prefs",
							title: "Prefs",
							form: { v: 1, root: { type: "form", rows: [] } },
						},
					],
					},
				}),
			}),
		).rejects.toThrow('settings section "prefs"');
	});

	test("a non-function action handler quarantines naming the action", () => {
		return expect(
			resolveExtension({
				default: () => ({
					extension: { name: "surfaces-bad-action", hooks: [], tools: [] },
					surfaces: {
						views: [
							{
								id: "board",
								title: "Board",
								icon: "board",
								placement: "view",
								render: async () => ({
									tree: { v: 1, root: { type: "page", title: "b", main: [] } },
									data: {},
									access: "read",
								}),
								actions: { move: 42 },
							},
						],
					},
				}),
			}),
		).rejects.toThrow('action "move"');
	});

	test("a non-boolean sharedData quarantines naming the field", () => {
		return expect(
			resolveExtension({
				default: () => ({
					extension: { name: "surfaces-bad-shared", hooks: [], tools: [] },
					surfaces: {
						views: [
							{
								id: "board",
								title: "Board",
								icon: "board",
								placement: "view",
								sharedData: "yes",
								render: async () => ({
									tree: { v: 1, root: { type: "page", title: "b", main: [] } },
									data: {},
									access: "read",
								}),
							},
						],
					},
				}),
			}),
		).rejects.toThrow('surface "board" whose sharedData is not a boolean');
	});

	test("a route path under surfaces/ quarantines naming the route", async () => {
		const { opened, app, adminToken } = await server();
		const outcome = opened.extensionOutcomes.find((entry) =>
			entry.name.includes("fixture-surfaces-route-clash"),
		);
		expect(outcome?.status).toBe("quarantined");
		expect(outcome?.error).toContain("surfaces/x");
		// The reserved route never mounted: the path answers 404, not the
		// fixture handler's response.
		const response = await call(app, {
			method: "GET",
			url: "/v1/ext/fixture-surfaces-route-clash/x",
			token: adminToken,
		});
		expect(response.status).toBe(404);
	});

	test("a route path under assets/ quarantines naming the route", () => {
		return expect(
			resolveExtension({
				default: () => ({
					extension: { name: "surfaces-assets-clash", hooks: [], tools: [] },
					routes: [
						{
							method: "GET",
							path: "assets/logo.png",
							auth: "public",
							handler: async () => new Response("never"),
						},
					],
				}),
			}),
		).rejects.toThrow("assets/logo.png");
	});

	test("the contract d.ts build exports the new types", () => {
		// Emit to a PRIVATE outDir: the repo's own dist/extension.d.ts is
		// owned by test/extension-contract.test.ts's full build (which
		// rmSync's dist mid-suite — a shared target would race).
		const outDir = join(
			tmpdir(),
			`sigrun-ext-dts-${process.pid}-${Date.now()}`,
		);
		try {
			execFileSync(
				process.execPath,
				[
					join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
					"-p",
					join(REPO_ROOT, "tsconfig.extension.json"),
					"--outDir",
					outDir,
				],
				{ cwd: REPO_ROOT, stdio: "pipe" },
			);
			const declarations = readFileSync(
				join(outDir, "extension.d.ts"),
				"utf8",
			);
			for (const name of [
				"SurfaceDef",
				"SurfaceContext",
				"UploadedFile",
				"ActionResult",
				"SurfacesContribution",
			]) {
				expect(
					declarations,
					`extension.d.ts must export ${name}`,
				).toMatch(new RegExp(`(?:interface|type) ${name}\\b`));
			}
		} finally {
			// Scratch under tmpdir; a failed removal never fails the test.
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
