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

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import type { ChoiceField, EntriesField, JsonObject, Tree } from "@sigrun/shared/blocks";
import { validateTree } from "../src/blocks/validate.js";
import { loadConfig } from "../src/config.js";
import { buildSettingsSections } from "../src/server/routes/settings-sections.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import {
	CORE_SECTION_IDS,
	CORE_SETTINGS_SECTIONS,
} from "../src/settings/core-sections.js";
import {
	CORE_LAYOUT,
	coreProperty,
	coreSchema,
} from "../src/settings/core-schema.js";
import { snapshotRestartKeys } from "../src/settings/pending.js";
import { applyOf, CORE_SETTING_KEYS } from "../src/settings/registry.js";
import { MODEL_KINDS } from "../src/settings/model-kinds.js";
import { seededIdentity } from "./helpers/identity.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly aliceToken: string;
	readonly configDir: string;
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
		extensionSpecifiers: [],
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
	return { app, opened, aliceToken, configDir };
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

/** The pre-Task-8 capture: generated forms must preserve this UI exactly. */
const beforeForms = JSON.parse(
	await readFile(
		new URL("./fixtures/core-section-forms-before-task8.json", import.meta.url),
		"utf8",
	),
) as Record<"general" | "tools" | "advanced", Tree>;

/** Normalize ids and omit perModelThinking (its table conversion is intended).
 * General's Models group is excluded from the before/after comparison in both
 * directions: the review guard structurally compares General's remaining
 * fields, while the dedicated Models assertions below supply the new section's
 * independently written expectations. Never infer those expectations from the
 * generated tree. */
function normalizedForm(form: Tree): unknown {
	const copy = structuredClone(form) as unknown as Record<string, unknown>;
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (typeof node !== "object" || node === null) return;
		const record = node as Record<string, unknown>;
		delete record.id;
		if (record.type === "form") record.submitLabel = "Save";
		if (Array.isArray(record.children)) {
			record.children = record.children.filter(
				(child) => {
					const entry = child as { name?: string; type?: string; title?: string };
					return entry.name !== "perModelThinking" &&
						!(entry.type === "section" && entry.title === "Models");
				},
			);
		}
		// The Queueing group was renamed Conversations (plan 2 Task 1).
		if (record.type === "section" && record.title === "Conversations") {
				record.title = "Queueing";
		}
		if (record.type === "section" && record.title === "Embeddings") {
			const children = record.children as unknown[];
			record.children = children.filter(
				(child) => {
					const name = (child as { name?: string }).name;
					// Settings split Plan 2 Task 2: the deprecated list moved out
					// of the form entirely; the timeout is the whole group.
					return (
						name !== "embeddingModel" &&
						name !== "embeddings.localModels"
					);
				},
			);
		}
		for (const child of Object.values(record)) walk(child);
	};
	walk(copy);
	return copy;
}

describe("core settings sections (U4 Task 4)", () => {
	test("generated core sections equal today's, apart from the thinking table", () => {
		for (const id of ["general", "advanced"] as const) {
			const section = CORE_SETTINGS_SECTIONS.find((candidate) => candidate.id === id);
			expect(section).toBeDefined();
			const normalized = normalizedForm(section!.form) as Record<string, unknown>;
			// Advanced gained a Tools group at the top (from the former Tools
			// section); the fixture predates it — drop it for the comparison.
			if (id === "advanced") {
				const root = (normalized as { root?: { children?: unknown[] } }).root;
				if (root?.children !== undefined) {
					root.children = (root.children as { title?: string }[]).filter(
						(group) => group.title !== "Tools",
					);
				}
			}
			expect(normalized, id).toEqual(normalizedForm(beforeForms[id]));
		}
		const advanced = CORE_SETTINGS_SECTIONS.find((section) => section.id === "advanced");
		const root = advanced?.form.root;
		const group = root?.type === "form" ? root.children.find(
			(child) => child.type === "section" && child.title === "Model overrides",
		) : undefined;
		const thinking = group?.type === "section"
			? group.children.find((child) => "name" in child && child.name === "perModelThinking")
			: undefined;
		expect(thinking).toMatchObject({
			type: "entries",
			shape: "table",
			name: "perModelThinking",
			keyLabel: "Model",
			summary: ["value"],
			item: [{
				type: "choice",
				name: "value",
				label: "Thinking level",
				options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
					(level) => ({ id: level, label: level }),
				),
			}],
		} satisfies Partial<EntriesField>);
	});

	test("System Models draws one dropdown per served kind plus the utility model", () => {
		expect(MODEL_KINDS).toEqual([
			{ kind: "chat", settingKey: "defaultModel", title: "Chat model" },
			{ kind: "decision", settingKey: "decisionModel", title: "Decision model" },
			{ kind: "embedding", settingKey: "embeddingModel", title: "Embedding model" },
		]);
		const models = CORE_SETTINGS_SECTIONS.find((section) => section.id === "models");
		expect(models?.form.root.type).toBe("form");
		if (models?.form.root.type !== "form") throw new Error("models form root missing");
		const fields = models.form.root.children.flatMap((child) =>
			child.type === "section" && child.title === "Models" ? child.children : [],
		).filter((child): child is ChoiceField => child.type === "choice");
		expect(CORE_LAYOUT.models).toBeDefined();
		expect(CORE_LAYOUT.general?.some((group) => group.title === "Models")).toBe(false);
		expect(models?.form.root.children.some(
			(child) => child.type === "section" && child.title === "Models",
		)).toBe(true);
		const expected = [
			["defaultModel", "Chat model", "The boot default model (provider/model-id); env SIGRUN_DEFAULT_MODEL wins over the file — a change applies at restart", "restart"],
			["namingModel", "Utility model", "Names conversations and builds skill cards. Absent: the default chat model.", "live"],
			["decisionModel", "Decision model", "Default model for decision-provider evaluations", "live"],
			["embeddingModel", "Embedding model", "The model every extension embeds with, as provider/model. Unset: embeddings are off.", "live"],
		] as const;
		expect(fields.map((field) => field.name)).toEqual(expected.map(([name]) => name));
		for (const [name, label, help, apply] of expected) {
			const kind = name === "decisionModel" ? "decision"
				: name === "embeddingModel" ? "embedding"
					: "chat";
			// The full relevant field shape is the guard: removing a field, losing
			// its dropdown override, or dropping its roster binding/label/help
			// cannot be normalized green by the old before-fixture comparison.
			expect(fields.find((field) => field.name === name), name).toMatchObject({
				type: "choice",
				presentation: "dropdown",
				label,
				help,
				apply,
				options: { $: `/modelRoster/${kind}` },
				allowOther: { label: "Other model id (provider/model)" },
			});
		}
	});

	test("General no longer has model fields", () => {
		const general = CORE_SETTINGS_SECTIONS.find((section) => section.id === "general");
		const root = general?.form.root;
		if (root?.type !== "form") throw new Error("general form root missing");
		expect(root.children.map((child) => child.type === "section" ? child.title : undefined)).toEqual([
			"Conversations",
			"Behaviour",
		]);
		for (const name of ["defaultModel", "namingModel", "decisionModel", "embeddingModel"]) {
			expect(
				root.children.some((group) => group.type === "section" && group.children.some(
					(field) => "name" in field && field.name === name,
				)),
				name,
			).toBe(false);
		}
	});

	test("defaultTools keeps the tool roster binding", () => {
		const advanced = CORE_SETTINGS_SECTIONS.find((section) => section.id === "advanced");
		const root = advanced?.form.root;
		const toolsGroup = root?.type === "form"
			? root.children.find((child) => child.type === "section" && child.title === "Tools")
			: undefined;
		const json = JSON.stringify(toolsGroup);
		expect(json).toContain('"$":"/toolRoster"');
	});

	test("unlisted keys are not rendered", () => {
		const json = JSON.stringify(
			CORE_SETTINGS_SECTIONS.filter((section) =>
				["general", "advanced"].includes(section.id),
			),
		);
		for (const key of [
			"jobs",
			"decisions.tool",
			"server.workspacePath",
			"server.storagePath",
			"server.compaction.modelOverrides",
		]) expect(json).not.toContain(`"name":"${key}"`);
	});

	test("every registry key has a nested schema property with x-sigrun-apply", () => {
		expect(coreSchema.type).toBe("object");
		for (const entry of CORE_SETTING_KEYS) {
			const property = coreProperty(entry.key);
			expect(property, entry.key).toBeDefined();
			expect(property?.title, entry.key).toEqual(expect.any(String));
			expect(property?.description, entry.key).toEqual(expect.any(String));
			expect(property).toHaveProperty("default");
			expect(property?.["x-sigrun-apply"], entry.key).toMatch(/^(live|restart)$/);
			expect(entry, entry.key).not.toHaveProperty("apply");
		}
		expect(Object.keys(CORE_LAYOUT)).toEqual(["general", "models", "advanced"]);
		const general = CORE_SETTINGS_SECTIONS.find((section) => section.id === "general");
		const root = general?.form.root;
		expect(root?.type === "form" ? root.children.map((child) => "id" in child ? child.id : undefined) : []).toEqual([
			"core-general-queue",
			"core-general-behaviour",
		]);
		expect(snapshotRestartKeys({ server: { port: 4000 } }).has("server.port")).toBe(true);
		expect(snapshotRestartKeys({ namingModel: "acme/namer" }).has("namingModel")).toBe(false);
	});

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

	test("Default Tools explains the allow-list", () => {
		const advanced = CORE_SETTINGS_SECTIONS.find((section) => section.id === "advanced");
		const root = advanced?.form.root as unknown as { children?: { children?: unknown[] }[] };
		const toolsGroup = root?.children?.find(
			(child) => (child as { title?: string }).title === "Tools",
		);
		const field = toolsGroup?.children?.[0];
		expect(field).toMatchObject({
			name: "defaultTools",
			label: "Tools offered to the model",
			help: "Only the selected tools are offered to the model in new conversations; the others stay callable by other tools. Leave empty to offer every installed tool. Applies to conversations created after the change.",
		});
	});

	test("the section ids are the plan's list, in nav order", () => {
		expect([...CORE_SECTION_IDS]).toEqual([
			"general",
			"models",
			"interface",
			"my-models",
			"advanced",
			"providers",
			"accounts",
			"tokens",
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
				!["section", "form", "page", "stack"].includes(record.type) &&
				record.type !== "entries"
			) {
				if (record.type === "choice" && record.name === "value") return;
				// A scalar list's synthetic item row inherits the wrapping
				// field's apply (the drawn rows share it; the item schema's
				// keyword feeds validation, not the form).
				if (record.name === "item" && record.type !== "secret") return;
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
				expect(field.apply, `${id}.${field.name}`).toBe(applyOf(field.name));
			}
		}
		const accounts = CORE_SETTINGS_SECTIONS.find((section) => section.id === "accounts");
		expect(accounts?.title).toBe("Account links");
		expect(accounts?.admin).toBe(false);
		// The tokens section (Task 5): immediately after accounts, per-user
		// (not admin-gated), and a cove (empty form — the channels render
		// their native component over the entry).
		expect(CORE_SECTION_IDS.indexOf("tokens")).toBe(CORE_SECTION_IDS.indexOf("accounts") + 1);
		const tokens = CORE_SETTINGS_SECTIONS.find((section) => section.id === "tokens");
		expect(tokens?.title).toBe("API tokens");
		expect(tokens?.admin).toBe(false);

		// The searchable keys render somewhere (the index's core-key
		// rows).
		expect(fieldsBySection.get("models")?.some((f) => f.name === "namingModel")).toBe(true);
		expect(fieldsBySection.get("advanced")?.some((f) => f.name === "server.port")).toBe(true);
		expect(fieldsBySection.get("advanced")?.some((f) => f.name === "defaultTools")).toBe(true);
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
			url: "/v1/ext/core/surfaces/models",
			token: aliceToken,
		});
		const rev = (render.body as { rev: number }).rev;
		const save = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/models/actions",
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
			url: "/v1/ext/core/surfaces/models",
			token: aliceToken,
		});
		const meta = (after.body as { data: JsonObject }).data.meta as JsonObject;
		expect(meta.pendingRestart).toEqual([]);
		const modelRead = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/models",
			token: aliceToken,
		});
		expect((modelRead.body as { data: JsonObject }).data.settings).toMatchObject({
			namingModel: "acme/namer-1",
		});
	});

	test("the Models surface carries a live per-kind model roster", async () => {
		const { app, aliceToken } = await server();
		const result = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/models",
			token: aliceToken,
		});
		expect(result.status).toBe(200);
		const data = (result.body as { data: JsonObject }).data;
		const roster = data.modelRoster as Record<string, unknown>;
		for (const kind of ["chat", "decision", "embedding"] as const) {
			expect(Array.isArray(roster[kind])).toBe(true);
		}
		expect(data.modelRoster).not.toHaveProperty("default");
		for (const row of roster.chat as { id: string }[]) {
			expect(row.id).toMatch(/^[^\/]+\/[^\/]+$/);
		}
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
			url: "/v1/ext/core/surfaces/models",
			token: aliceToken,
		});
		const rev = (render.body as { rev: number }).rev;
		// Set a value first (so the clear is observable).
		const set = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/models/actions",
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
			url: "/v1/ext/core/surfaces/models",
			token: aliceToken,
		});
		const rev2 = (after.body as { rev: number }).rev;
		const clear = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/models/actions",
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
			url: "/v1/ext/core/surfaces/models",
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
		const applySpy = vi.spyOn(opened.settings, "apply");
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
						perModelThinking: {},
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
		// Clearing an unset scalar table is a no-op, not a null write.
		expect(applySpy).toHaveBeenCalledExactlyOnceWith({ server: { port: null } });
		applySpy.mockRestore();
		const file = opened.settings.read();
		expect(file.retry?.enabled).toBeUndefined();
		expect(file.server?.compaction?.enabled).toBeUndefined();
		// The same rule on the other default-on toggles (Tools group, now under Advanced).
		const tools = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/advanced",
			token: aliceToken,
		});
		const toolsRev = (tools.body as { rev: number }).rev;
		const toolsSave = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/advanced/actions",
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

	test("the per-model thinking table saves scalar levels without channel identity markers", async () => {
		const { app, opened, aliceToken } = await server();
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
				actionId: "core-thinking-table",
				params: {},
				payload: {
					rev,
					values: {
						perModelThinking: {
							"acme/model": { value: "low", $from: "acme/model" },
						},
					},
				},
			},
		});
		expect(save.body).toMatchObject({ ok: true });
		expect(opened.settings.read().perModelThinking).toEqual({ "acme/model": "low" });

		const reread = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/advanced",
			token: aliceToken,
		});
		expect((reread.body as { data: JsonObject }).data.settings).toMatchObject({
			perModelThinking: { "acme/model": "low" },
		});
		const deleted = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/advanced/actions",
			token: aliceToken,
			payload: {
				action: "save",
				actionId: "core-thinking-table-delete",
				params: {},
				payload: {
					rev: (reread.body as { rev: number }).rev,
					values: { perModelThinking: {} },
				},
			},
		});
		expect(deleted.body).toMatchObject({ ok: true });
		expect(opened.settings.read().perModelThinking).toBeUndefined();
	});

	test("the Advanced section's Tools group carries the tool roster (the defaultTools options)", async () => {
		const { app, aliceToken } = await server();
		const result = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/advanced",
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

	test("the Models section render marks a deployment-managed field disabled", async () => {
		const { app, aliceToken, configDir } = await server();
		const managedPath = join(configDir, "managed-settings.json");
		await writeFile(managedPath, '["defaultModel"]', "utf8");
		try {
			const result = await call(app, {
				method: "GET",
				url: "/v1/ext/core/surfaces/models",
				token: aliceToken,
			});
			expect(result.status).toBe(200);
			const tree = (result.body as { tree: { root: unknown } }).tree;
			const findField = (node: unknown): Record<string, unknown> | undefined => {
				if (Array.isArray(node)) {
					for (const child of node) {
						const found = findField(child);
						if (found !== undefined) return found;
					}
					return undefined;
				}
				if (typeof node !== "object" || node === null) return undefined;
				const record = node as Record<string, unknown>;
				if (record.name === "defaultModel") return record;
				return findField(record.children) ?? findField(record.root);
			};
			const field = findField(tree.root);
			expect(field).toMatchObject({
				disabled: true,
				help: expect.stringMatching(/^Managed by deployment\. /),
			});
			const meta = (result.body as { data: JsonObject }).data.meta as JsonObject;
			expect(meta.managed).toEqual(["defaultModel"]);
		} finally {
			await rm(managedPath, { force: true });
		}
	});

	test("a section save carrying a managed key refuses and leaves the settings file unchanged", async () => {
		const { app, opened, aliceToken, configDir } = await server();
		const managedPath = join(configDir, "managed-settings.json");
		await writeFile(managedPath, '["defaultModel"]', "utf8");
		try {
			const render = await call(app, {
				method: "GET",
				url: "/v1/ext/core/surfaces/models",
				token: aliceToken,
			});
			const rev = (render.body as { rev: number }).rev;
			const before = await readFile(opened.settings.path, "utf8");
			const save = await call(app, {
				method: "POST",
				url: "/v1/ext/core/surfaces/models/actions",
				token: aliceToken,
				payload: {
					action: "save",
					actionId: "core-save-managed",
					params: {},
					payload: {
						rev,
						values: {
							namingModel: "acme/namer-unmanaged",
							defaultModel: "acme/model-managed",
						},
					},
				},
			});
			expect(save.body).toEqual({
				ok: false,
				error: {
					message: "managed by deployment: defaultModel",
					field: "defaultModel",
				},
			});
			expect(await readFile(opened.settings.path, "utf8")).toBe(before);
		} finally {
			await rm(managedPath, { force: true });
		}
	});

	test("a stale rev rejects with 'changed by someone else'", async () => {
		const { app, opened, aliceToken } = await server();
		const render = await call(app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/models",
			token: aliceToken,
		});
		const rev = (render.body as { rev: number }).rev;
		const first = await call(app, {
			method: "POST",
			url: "/v1/ext/core/surfaces/models/actions",
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
			url: "/v1/ext/core/surfaces/models/actions",
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
	test("non-admins receive only mine sections", async () => {
		// A second boot with a non-admin bob seeded into the identity.
		const dir = await mkdtemp(join(tmpdir(), "sigrun-sections-bob-"));
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
		await identity.users.add({ user: "bob", admin: false, source: "cli" });
		const opened = await openHarness(config, {
			identity,
			extensionSpecifiers: [],
			env: { SIGRUN_CONFIG_DIR: configDir },
			settingsDir: dir,
		});
		const { token: bobToken } = await opened.identity.tokens.create("bob-cli", "bob");
		const app = await createServer(opened, config);
		cleanups.push(async () => {
			await app.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
			await rm(dir, { recursive: true, force: true });
		});
		const result = await call(app, {
			method: "GET",
			url: "/v1/settings/sections",
			token: bobToken,
		});
		expect(result.status).toBe(200);
		const body = result.body as { sections: { slug: string; group?: string }[] };
		// Non-admin must see no system sections.
		const system = body.sections.filter((s) => s.group === "system");
		expect(system).toHaveLength(0);
		// Must see at least one mine section (Interface, Account links, API tokens).
		const mine = body.sections.filter((s) => s.group === "mine");
		expect(mine.length).toBeGreaterThan(0);
	});

	test("admins receive both groups", async () => {
		const { app, aliceToken } = await server();
		const result = await call(app, {
			method: "GET",
			url: "/v1/settings/sections",
			token: aliceToken,
		});
		expect(result.status).toBe(200);
		const body = result.body as { sections: { slug: string; group?: string }[] };
		const mine = body.sections.filter((s) => s.group === "mine");
		const system = body.sections.filter((s) => s.group === "system");
		expect(mine.length).toBeGreaterThan(0);
		expect(system.length).toBeGreaterThan(0);
	});

	test("no tools section; Advanced draws defaultTools first", async () => {
		const { app, aliceToken } = await server();
		const result = await call(app, {
			method: "GET",
			url: "/v1/settings/sections",
			token: aliceToken,
		});
		const body = result.body as { sections: { slug: string; id: string }[] };
		const tools = body.sections.find((s) => s.id === "tools");
		expect(tools).toBeUndefined();
		// Advanced section must contain defaultTools as its first field group.
		const advanced = CORE_SETTINGS_SECTIONS.find((s) => s.id === "advanced");
		const root = advanced?.form.root;
		const firstGroup = root?.type === "form" ? root.children[0] : undefined;
		const fields = firstGroup?.type === "section" ? firstGroup.children : [];
		expect(fields.some((f) => "name" in f && f.name === "defaultTools")).toBe(true);
	});

	test("General's queue modes sit under Conversations", () => {
		const general = CORE_SETTINGS_SECTIONS.find((s) => s.id === "general");
		const root = general?.form.root;
		if (root?.type !== "form") throw new Error("general form root missing");
		const conversations = root.children.find(
			(child) => child.type === "section" && child.title === "Conversations",
		);
		expect(conversations).toBeDefined();
		const fields = conversations?.type === "section" ? conversations.children : [];
		const names = fields.map((f) => ("name" in f ? f.name : undefined));
		expect(names).toContain("steeringMode");
		expect(names).toContain("followUpMode");
	});

	test("search hits land on the right section after an insert", async () => {
		// Pin the positional zip: CORE_SECTION_IDS and CORE_SETTINGS_SECTIONS
		// must match exactly so later tasks can insert sections mid-array.
		expect([...CORE_SECTION_IDS]).toEqual(CORE_SETTINGS_SECTIONS.map((s) => s.id));
		// Insert a synthetic section mid-array (between general and
		// interface, where Tasks 3 and 5 will insert models/my-models) and
		// build the real index: every title row must carry its own section's
		// id. The old positional zip against a separately-maintained id list
		// mislabels every row after the insertion point.
		const inserted = CORE_SETTINGS_SECTIONS[0]!;
		const withInsert = [
			inserted,
			{ ...inserted, id: "models", title: "Models" },
			...CORE_SETTINGS_SECTIONS.slice(1),
		];
		const built = buildSettingsSections([], new Map(), withInsert);
		for (const section of withInsert) {
			// Models appears twice (System Models + My Models share the
			// title) — the row must exist for THIS section id.
			expect(
				built.index.some(
					(row) => row.slug === "core" && row.kind === "section" && row.label === section.title && row.sectionId === section.id,
				),
				`title row for '${section.title}' (${section.id})`,
			).toBe(true);
		}
		// Verify that the search index's sectionId for each core section title
		// matches the actual section id (not an off-by-one from a stale id list).
		const { app, aliceToken } = await server();
		const result = await call(app, {
			method: "GET",
			url: "/v1/settings/sections",
			token: aliceToken,
		});
		const body = result.body as {
			sections: { slug: string; id: string; title: string }[];
			index: { slug: string; sectionId: string; kind: string; label: string }[];
		};
		for (const section of CORE_SETTINGS_SECTIONS) {
			const sectionEntry = body.sections.find(
				(s) => s.slug === "core" && s.id === section.id,
			);
			expect(sectionEntry, `section ${section.id} is in the payload`).toBeDefined();
			// The title-row index entry for this section carries the same sectionId.
			// Models appears twice (System Models and My Models share the
			// title) — match on sectionId AND label, not the first title hit.
			const indexRow = body.index.find(
				(e) => e.slug === "core" && e.kind === "section" && e.label === section.title && e.sectionId === section.id,
			);
			expect(indexRow, `index row for '${section.title}' (${section.id}) exists`).toBeDefined();
		}
	});

	test("orders core first, then extensions alphabetically", async () => {
		const { app, aliceToken } = await server();
		const result = await call(app, {
			method: "GET",
			url: "/v1/settings/sections",
			token: aliceToken,
		});
		expect(result.status).toBe(200);
		const body = result.body as {
			sections: {
				slug: string;
				id: string;
				title: string;
				icon: string;
				page?: string;
				pageTitle?: string;
				admin?: boolean;
				scope?: "user";
				group?: "mine" | "system";
			}[];
		};
		const core = body.sections.filter((s) => s.slug === "core");
		expect(core.map((s) => s.id)).toEqual([...CORE_SECTION_IDS]);
		// Task 7's generated-section coverage against the declaring
		// dev-linked built-ins: curator's shared then per-user pages,
		// gateway's shared-only page (Task 13), oauth's shared-only page,
		// then MCP's shared and per-user pages.
		expect(body.sections.filter((s) => s.slug !== "core")).toEqual([
			{
				slug: "curator",
				id: "settings",
				page: "curator",
				pageTitle: "Curator",
				title: "Settings",
				icon: "key",
				admin: true,
				group: "system",
			},
			{
				slug: "curator",
				id: "user-settings",
				page: "curator",
				pageTitle: "Curator",
				title: "Your settings",
				icon: "key",
				scope: "user",
				admin: false,
				group: "mine",
			},
			{
				slug: "gateway",
				id: "settings",
				page: "gateway",
				pageTitle: "Gateway",
				title: "Settings",
				icon: "key",
				admin: true,
				group: "system",
			},
			{
				slug: "oauth",
				id: "settings",
				page: "oauth",
				pageTitle: "OAuth login",
				title: "Settings",
				icon: "key",
				admin: true,
				group: "system",
			},
			{
				slug: "sigrun-mcp",
				id: "settings",
				page: "sigrun-mcp",
				pageTitle: "MCP",
				title: "Settings",
				icon: "key",
				admin: true,
				group: "system",
			},
			{
				slug: "sigrun-mcp",
				id: "user-settings",
				page: "sigrun-mcp",
				pageTitle: "MCP",
				title: "Your settings",
				icon: "key",
				scope: "user",
				admin: false,
				group: "mine",
			},
		]);
	});

	test("the search index covers every core key's label and help; 'utility' resolves to Models' utility model", async () => {
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
		expect(body.index.some(
			(entry) => entry.slug === "core" && entry.sectionId === "models" &&
				entry.key === "namingModel" && entry.label === "Utility model",
		)).toBe(true);
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
				!["section", "form", "page", "stack"].includes(record.type) &&
				record.type !== "entries" &&
				!(record.type === "choice" && record.name === "value") &&
				!(record.name === "item")
			) {
				out.push(record.name);
			}
		};
		const fieldSection = new Map<string, string>();
		for (const section of CORE_SETTINGS_SECTIONS) {
			const names: string[] = [];
			walkNames(section.form, names);
			// A key rendered in TWO sections (defaultModel et al. render in
			// System Models AND My Models) indexes under the FIRST — the
			// index's own first-match walk (coreFieldEntry) agrees.
			for (const name of names) {
				if (!fieldSection.has(name)) fieldSection.set(name, section.id);
			}
			if (names.includes("perModelThinking")) fieldSection.set("perModelThinking", section.id);
		}
		// Cove-rendered sections (Interface/Providers — the
		// channels draw them natively) drop their core-key rows: a hit
		// must land on a form field, and a cove has none.
		const coveSections = new Set(["interface", "providers"]);
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
		expect(coreRows.find((entry) => entry.key === "defaultTools")?.sectionId).toBe("advanced");
		// Every core row carries a label.
		expect(coreRows.every((entry) => entry.label.length > 0)).toBe(true);
	});
});
