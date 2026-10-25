/**
 * UI-blocks U4 Task 4 (spec §13.4): the core settings sections
 * (`src/settings/core-sections.ts`) + the sections route
 * (`src/server/routes/settings-sections.ts`).
 *
 * - Every core section's form validates against the `settings`
 *   placement; every field declares the §13.1 registry's `apply`.
 * - The sections mount under the reserved `core` slug — the SAME
 *   renderer the extension sections use (one code path).
 * - A core save folds dotted field names into a SettingsStore apply
 *   (a restart key lands in `pendingRestart`; a stale rev rejects).
 * - `GET /v1/settings/sections` orders core first, then extensions
 *   alphabetically, and its search index covers every core key's
 *   label + help (searching "naming" resolves to General's field).
 *
 * Hermetic shape: the settings-sections test pattern (token auth, one
 * admin) with the settings-section fixture loaded (its section extends
 * the sections list past core).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import type { JsonObject } from "@sigrun/shared/blocks";
import { validateTree } from "../src/blocks/validate.js";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import {
	CORE_SECTION_IDS,
	CORE_SETTINGS_SECTIONS,
} from "../src/settings/core-sections.js";
import { CORE_SETTING_KEYS } from "../src/settings/registry.js";
import { seededIdentity } from "./helpers/identity.js";

const SECTION_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-settings-section", "index.js"),
).href;

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

/** Boot one hermetic token-method server with the settings-section fixture. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-core-sections-"));
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
		extensionSpecifiers: [SECTION_SPECIFIER],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: dir,
	});
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	const app = await createServer(opened, config);
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

// ─── The declarations (pure, no server) ───────────────────────────────────

describe("core settings sections (U4 Task 4)", () => {
	test("every core section's form validates against the settings placement", () => {
		for (const section of CORE_SETTINGS_SECTIONS) {
			const result = validateTree(section.form, {
				placement: "settings",
				handlers: new Set(["save"]),
			});
			expect(
				result.ok,
				`${section.id}: ${result.ok ? "" : result.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
			).toBe(true);
		}
	});

	test("the section ids are the plan's list, in nav order", () => {
		expect([...CORE_SECTION_IDS]).toEqual([
			"general",
			"tools",
			"interface",
			"advanced",
			"providers",
			"extensions",
			"accounts",
		]);
		expect(CORE_SETTINGS_SECTIONS.map((s) => s.id)).toEqual([...CORE_SECTION_IDS]);
	});

	test("every field declares the §13.1 registry's apply, and every rendered core key's registry section lands in the section it renders in", () => {
		// Collect the rendered fields per section.
		const fieldsBySection = new Map<string, { name: string; apply?: string }[]>();
		const walk = (node: unknown, out: { name: string; apply?: string }[]): void => {
			if (Array.isArray(node)) {
				for (const child of node) walk(child, out);
				return;
			}
			if (typeof node !== "object" || node === null) return;
			const record = node as Record<string, unknown>;
			for (const key of ["children", "fields", "root", "item"]) {
				if (record[key] !== undefined) walk(record[key], out);
			}
			if (
				typeof record.name === "string" &&
				typeof record.type === "string" &&
				!["section", "form", "page", "stack"].includes(record.type)
			) {
				out.push({
					name: record.name,
					apply: typeof record.apply === "string" ? record.apply : undefined,
				});
			}
		};
		for (const section of CORE_SETTINGS_SECTIONS) {
			const fields: { name: string; apply?: string }[] = [];
			walk(section.form, fields);
			fieldsBySection.set(section.id, fields);
		}
		// Every field carries an apply.
		for (const [id, fields] of fieldsBySection) {
			for (const field of fields) {
				expect(field.apply, `${id}.${field.name} declares apply`).toMatch(
					/^(live|restart)$/,
				);
			}
		}
		// The apply matches the registry (the registry is the §13.1 source).
		const registryByKey = new Map(CORE_SETTING_KEYS.map((e) => [e.key, e]));
		for (const [id, fields] of fieldsBySection) {
			for (const field of fields) {
				const entry = registryByKey.get(field.name);
				if (entry === undefined) continue; // not a registry key (none today)
				expect(field.apply, `${id}.${field.name}`).toBe(entry.apply);
			}
		}
		const accounts = CORE_SETTINGS_SECTIONS.find((section) => section.id === "accounts");
		expect(accounts?.title).toBe("Account links");
		expect(accounts?.admin).toBe(false);

		// The searchable keys render somewhere (the index's core-key
		// rows).
		expect(fieldsBySection.get("general")?.some((f) => f.name === "namingModel")).toBe(true);
		expect(fieldsBySection.get("advanced")?.some((f) => f.name === "server.port")).toBe(true);
		// NO unregistry'd field renders (a field with no §13.1 entry would
		// write through the SettingsStore's allowlist at save time and
		// reject the whole save — the panel's one-renderer rule pins the
		// fields to the registry).
		for (const [id, fields] of fieldsBySection) {
			for (const field of fields) {
				expect(
					registryByKey.has(field.name),
					`${id}.${field.name} is a §13.1 registry key`,
				).toBe(true);
			}
		}
	});
});

// ─── The core surfaces (the shared renderer over the core store) ─────────

describe("core settings surfaces (U4 Task 4)", () => {
	test("the General section renders with the stored value and the meta block", async () => {
		const { app, aliceToken } = await server();
		const result = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/general",
			token: aliceToken,
		});
		expect(result.status).toBe(200);
		const body = result.body as {
			tree: { root: { type: string } };
			data: JsonObject;
			access: string;
		};
		expect(body.tree.root.type).toBe("form");
		expect(body.access).toBe("write");
		expect(typeof body.data.settings).toBe("object");
		// The pending-restart block (the channels' callout reads it).
		const meta = body.data.meta as JsonObject;
		expect(Array.isArray(meta.pendingRestart)).toBe(true);
		expect(typeof meta.supervised).toBe("boolean");
	});

	test("a save applies a live key immediately (no pendingRestart) and lands in the store", async () => {
		const { app, opened, aliceToken } = await server();
		const render = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/general",
			token: aliceToken,
		});
		const rev = (render.body as { rev: number }).rev;
		const save = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/general/actions",
			token: aliceToken,
			payload: {
				action: "save",
				actionId: "core-save-live",
				params: {},
				payload: { rev, values: { namingModel: "acme/namer-1" } },
			},
		});
		expect(save.status).toBe(200);
		expect((save.body as { ok: boolean }).ok).toBe(true);
		expect(opened.settings.read().namingModel).toBe("acme/namer-1");
		// namingModel is LIVE (§13.1): no pending restart.
		const after = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/general",
			token: aliceToken,
		});
		const meta = (after.body as { data: JsonObject }).data.meta as JsonObject;
		expect(meta.pendingRestart).toEqual([]);
		expect((after.body as { data: JsonObject }).data.settings).toMatchObject({
			namingModel: "acme/namer-1",
		});
	});

	test("a restart key's save lands it in pendingRestart", async () => {
		const { app, aliceToken } = await server();
		const render = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/advanced",
			token: aliceToken,
		});
		const rev = (render.body as { rev: number }).rev;
		const save = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/advanced/actions",
			token: aliceToken,
			payload: {
				action: "save",
				actionId: "core-save-restart",
				params: {},
				payload: { rev, values: { "server.port": 4599 } },
			},
		});
		expect((save.body as { ok: boolean }).ok).toBe(true);
		const after = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/advanced",
			token: aliceToken,
		});
		const meta = (after.body as { data: JsonObject }).data.meta as JsonObject;
		expect(meta.pendingRestart).toContain("server.port");
	});

	test("an empty string CLEARS the key via the store's delete-key merge", async () => {
		const { app, opened, aliceToken } = await server();
		const render = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/general",
			token: aliceToken,
		});
		const rev = (render.body as { rev: number }).rev;
		// Set a value first (so the clear is observable).
		const set = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/general/actions",
			token: aliceToken,
			payload: {
				action: "save",
				actionId: "core-clear-set",
				params: {},
				payload: { rev, values: { namingModel: "acme/namer-clear" } },
			},
		});
		expect((set.body as { ok: boolean }).ok).toBe(true);
		expect(opened.settings.read().namingModel).toBe("acme/namer-clear");
		// Now clear it: the empty string is the unset affordance (the
		// nullable fields' "(server default)" gesture) — null rides the
		// store's delete-key merge.
		const after = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/general",
			token: aliceToken,
		});
		const rev2 = (after.body as { rev: number }).rev;
		const clear = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/general/actions",
			token: aliceToken,
			payload: {
				action: "save",
				actionId: "core-clear-now",
				params: {},
				payload: { rev: rev2, values: { namingModel: "" } },
			},
		});
		expect((clear.body as { ok: boolean }).ok).toBe(true);
		expect(opened.settings.read().namingModel).toBeUndefined();
		// And the read-back reflects the clear (no stale value).
		const reread = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/general",
			token: aliceToken,
		});
		const settings = (reread.body as { data: JsonObject }).data.settings as JsonObject;
		expect(settings.namingModel).toBeUndefined();
	});

	test("a full-form save never writes a default-on toggle; explicitly flipping it OFF writes false", async () => {
		const { app, opened, aliceToken } = await server();
		// The Advanced form's untouched values (the channels initialize an
		// absent default-on toggle to its default; the nullable fields
		// submit the empty string = the unset affordance).
		const render = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/advanced",
			token: aliceToken,
		});
		const rev = (render.body as { rev: number }).rev;
		const untouched = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/advanced/actions",
			token: aliceToken,
			payload: {
				action: "save",
				actionId: "core-default-on-untouched",
				params: {},
				payload: {
					rev,
					values: {
						"retry.enabled": true,
						"retry.maxRetries": "",
						"retry.baseDelayMs": "",
						"retry.maxAgentDelayMs": "",
						"stream.timeoutMs": "",
						"stream.maxRetries": "",
						"stream.maxRetryDelayMs": "",
						perModelThinking: "",
						"server.port": "",
						"server.publicUrl": "",
						"server.timezone": "",
						"server.compaction.enabled": true,
						"server.compaction.reserveTokens": "",
						"server.compaction.keepRecentTokens": "",
						"server.compaction.backgroundTokens": "",
						"jobHistory.runs": "",
						"jobHistory.revisions": "",
					},
				},
			},
		});
		expect((untouched.body as { ok: boolean }).ok).toBe(true);
		const file = opened.settings.read();
		expect(file.retry?.enabled).toBeUndefined();
		expect(file.server?.compaction?.enabled).toBeUndefined();
		// The same rule on the other default-on toggles (Tools +
		// Extensions sections).
		const tools = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/tools",
			token: aliceToken,
		});
		const toolsRev = (tools.body as { rev: number }).rev;
		const toolsSave = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/tools/actions",
			token: aliceToken,
			payload: {
				action: "save",
				actionId: "core-default-on-tools",
				params: {},
				payload: {
					rev: toolsRev,
					values: { defaultTools: [], autoEnableCodemode: true },
				},
			},
		});
		expect((toolsSave.body as { ok: boolean }).ok).toBe(true);
		expect(opened.settings.read().autoEnableCodemode).toBeUndefined();
		const extensions = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/extensions",
			token: aliceToken,
		});
		const extRev = (extensions.body as { rev: number }).rev;
		const extSave = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/extensions/actions",
			token: aliceToken,
			payload: {
				action: "save",
				actionId: "core-default-on-extensions",
				params: {},
				payload: {
					rev: extRev,
					values: {
						extensions: "",
						"builtinExtensions.codemode": true,
						"builtinExtensions.mcp": true,
						"builtinExtensions.toolSearch": true,
						"builtinExtensions.oauth": true,
					},
				},
			},
		});
		expect((extSave.body as { ok: boolean }).ok).toBe(true);
		expect(opened.settings.read().builtinExtensions).toBeUndefined();

		// Explicitly flipping the default-on toggle OFF writes the false.
		const render2 = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/advanced",
			token: aliceToken,
		});
		const rev2 = (render2.body as { rev: number }).rev;
		const flipped = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/advanced/actions",
			token: aliceToken,
			payload: {
				action: "save",
				actionId: "core-default-on-off",
				params: {},
				payload: { rev: rev2, values: { "retry.enabled": false } },
			},
		});
		expect((flipped.body as { ok: boolean }).ok).toBe(true);
		expect(opened.settings.read().retry?.enabled).toBe(false);
		// Flipping it back ON writes the true (the stored false differs
		// from the default, so no skip — the re-enable must persist).
		const render3 = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/advanced",
			token: aliceToken,
		});
		const rev3 = (render3.body as { rev: number }).rev;
		const backOn = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/advanced/actions",
			token: aliceToken,
			payload: {
				action: "save",
				actionId: "core-default-on-back-on",
				params: {},
				payload: { rev: rev3, values: { "retry.enabled": true } },
			},
		});
		expect((backOn.body as { ok: boolean }).ok).toBe(true);
		expect(opened.settings.read().retry?.enabled).toBe(true);
	});

	test("the Tools section's data carries the tool roster (the defaultTools options)", async () => {
		const { app, aliceToken } = await server();
		const result = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/tools",
			token: aliceToken,
		});
		expect(result.status).toBe(200);
		const data = (result.body as { data: JsonObject }).data;
		const roster = data.toolRoster;
		expect(Array.isArray(roster)).toBe(true);
		// Every built-in tool's name is an option (the registry snapshot
		// drives it); the form's defaultTools field binds the options here.
		const ids = (roster as { id: string; label: string }[]).map((entry) => entry.id);
		expect(ids.length).toBeGreaterThan(0);
		expect(ids).toContain("read");
		// The form binds the roster (not a hardcoded empty list).
		const tree = (result.body as { tree: { root: unknown } }).tree;
		const json = JSON.stringify(tree);
		expect(json).toContain('"$":"/toolRoster"');
		expect(json).not.toContain('"options":[]');
	});

	test("a stale rev rejects with 'changed by someone else'", async () => {
		const { app, opened, aliceToken } = await server();
		const render = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/general",
			token: aliceToken,
		});
		const rev = (render.body as { rev: number }).rev;
		const first = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/general/actions",
			token: aliceToken,
			payload: {
				action: "save",
				actionId: "core-save-stale-1",
				params: {},
				payload: { rev, values: { namingModel: "acme/namer-2" } },
			},
		});
		expect((first.body as { ok: boolean }).ok).toBe(true);
		// A second save against the SAME (now stale) rev rejects.
		const stale = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/general/actions",
			token: aliceToken,
			payload: {
				action: "save",
				actionId: "core-save-stale-2",
				params: {},
				payload: { rev, values: { namingModel: "acme/namer-3" } },
			},
		});
		expect((stale.body as { ok: boolean }).ok).toBe(false);
		expect((stale.body as { error: { message: string } }).error.message).toBe(
			"changed by someone else",
		);
		expect(opened.settings.read().namingModel).toBe("acme/namer-2");
	});
});

// ─── The sections route (the list + search index) ─────────────────────────

describe("GET /v1/settings/sections (U4 Task 4)", () => {
	test("orders core first, then extensions alphabetically", async () => {
		const { app, aliceToken } = await server();
		const result = await call(app, {
			method: "GET",
			url: "/v1/settings/sections",
			token: aliceToken,
		});
		expect(result.status).toBe(200);
		const body = result.body as {
			sections: { slug: string; id: string; title: string; icon: string }[];
		};
		const core = body.sections.filter((s) => s.slug === "core");
		expect(core.map((s) => s.id)).toEqual([...CORE_SECTION_IDS]);
		// The fixture's sections follow core (alphabetical by slug+id).
		const extensions = body.sections.filter((s) => s.slug !== "core");
		expect(extensions.map((s) => s.slug)).toEqual([
			"acme-settings-section",
			"acme-settings-section",
			"acme-settings-section",
			"acme-settings-section",
			"acme-settings-section",
		]);
		expect(extensions.map((s) => s.id)).toEqual([
			"connection",
			"display",
			"profile",
			"dedup-profile",
			"personal-admin",
		]);
		expect(extensions.find((s) => s.id === "profile")).toMatchObject({
			scope: "user",
			admin: false,
		});
	});

	test("the search index covers every core key's label and help; 'naming' resolves to General's naming model", async () => {
		const { app, aliceToken } = await server();
		const result = await call(app, {
			method: "GET",
			url: "/v1/settings/sections",
			token: aliceToken,
		});
		const body = result.body as {
			index: {
				slug: string;
				sectionId: string;
				kind: string;
				label: string;
				help?: string;
				key?: string;
			}[];
		};
		// Searching "naming" (case-insensitive, over label + help) hits
		// General's naming-model row.
		const hits = body.index.filter(
			(entry) =>
				entry.label.toLowerCase().includes("naming") ||
				(entry.help ?? "").toLowerCase().includes("naming"),
		);
		expect(
			hits.some(
				(entry) =>
					entry.slug === "core" &&
					entry.sectionId === "general" &&
					entry.key === "namingModel",
			),
		).toBe(true);
		// Every field CORE_SETTINGS_SECTIONS renders indexes under the
		// section it renders IN (the walk is the section source — the
		// registry's `section` metadata drifts: retry/stream say
		// `general` but render under Advanced).
		const walkNames = (node: unknown, out: string[]): void => {
			if (Array.isArray(node)) {
				for (const child of node) walkNames(child, out);
				return;
			}
			if (typeof node !== "object" || node === null) return;
			const record = node as Record<string, unknown>;
			for (const key of ["children", "fields", "root", "item"]) {
				if (record[key] !== undefined) walkNames(record[key], out);
			}
			if (
				typeof record.name === "string" &&
				typeof record.type === "string" &&
				!["section", "form", "page", "stack"].includes(record.type)
			) {
				out.push(record.name);
			}
		};
		const fieldSection = new Map<string, string>();
		for (const section of CORE_SETTINGS_SECTIONS) {
			const names: string[] = [];
			walkNames(section.form, names);
			for (const name of names) fieldSection.set(name, section.id);
		}
		// Cove-rendered sections (Interface/Providers/Extensions — the
		// channels draw them natively) drop their core-key rows: a hit
		// must land on a form field, and a cove has none.
		const coveSections = new Set(["interface", "providers", "extensions"]);
		const coreRows = body.index.filter((entry) => entry.kind === "core-key");
		for (const [key, sectionId] of fieldSection) {
			const row = coreRows.find((entry) => entry.key === key);
			if (coveSections.has(sectionId)) {
				expect(row, `cove key ${key} stays OUT of the index`).toBeUndefined();
				continue;
			}
			expect(row, `index covers ${key}`).toBeDefined();
			expect(
				row?.sectionId,
				`${key} indexes under the section it renders in (${sectionId})`,
			).toBe(sectionId);
			// The row carries the field's label and help (not the raw key).
			expect(row?.label, `${key}'s row carries the rendered label`).not.toBe(key);
		}
		// The mis-titled keys the round-1 index misplaced (registry says
		// `general`/`tools`; the fields render under Advanced/Tools).
		expect(coreRows.find((entry) => entry.key === "retry.enabled")?.sectionId).toBe("advanced");
		expect(coreRows.find((entry) => entry.key === "stream.timeoutMs")?.sectionId).toBe("advanced");
		expect(coreRows.find((entry) => entry.key === "perModelThinking")?.sectionId).toBe("advanced");
		expect(coreRows.find((entry) => entry.key === "server.port")?.sectionId).toBe("advanced");
		expect(coreRows.find((entry) => entry.key === "defaultTools")?.sectionId).toBe("tools");
		// Every row carries a label; extension fields index too.
		const extRows = body.index.filter(
			(entry) => entry.slug === "acme-settings-section",
		);
		expect(extRows.some((entry) => entry.label === "API URL")).toBe(true);
		expect(extRows.some((entry) => entry.label === "Connection")).toBe(true);
	});
});
