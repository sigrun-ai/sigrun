/** Plan 2 Task 3: model kinds and System → Models read the LIVE registries.
 * Every option is provider/model with the provider's display title and the
 * one locality answer; stored values absent from a roster remain visible. */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ChoiceField, Tree } from "@sigrun/shared/blocks";
import type { FastifyInstance } from "fastify";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { createLocality } from "../src/harness/locality.js";
import {
	buildModelRoster,
	withUnserved,
	withoutEmptyModelKind,
} from "../src/server/model-roster.js";
import { CORE_SETTINGS_SECTIONS } from "../src/settings/core-sections.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";

const require = createRequire(import.meta.url);
const fixture = (name: string): string =>
	pathToFileURL(require.resolve(`./fixtures/${name}/index.js`)).href;

function choices(
	tree: Tree,
	data: Record<string, unknown>,
): Map<string, ChoiceField & { options: readonly { id: string; label: string }[] }> {
	const fields = new Map<string, ChoiceField & { options: readonly { id: string; label: string }[] }>();
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const child of node) walk(child);
			return;
		}
		if (typeof node !== "object" || node === null) return;
		const record = node as Record<string, unknown>;
		if (record.type === "choice" && typeof record.name === "string") {
			const binding = record.options as { $?: string };
			const path = binding.$?.slice(1).split("/").filter(Boolean) ?? [];
			let options: unknown = data;
			for (const segment of path) {
				options = typeof options === "object" && options !== null && !Array.isArray(options)
					? (options as Record<string, unknown>)[segment]
					: undefined;
			}
			fields.set(record.name, { ...record, options: options ?? [] } as ChoiceField & {
				options: readonly { id: string; label: string }[];
			});
		}
		for (const key of ["root", "children", "fields", "item"]) walk(record[key]);
	};
	walk(tree);
	return fields;
}

interface HarnessWithMutableModels extends Omit<OpenedHarness, "models"> {
	readonly models: MutableModels;
}

function harnessWithModels(modelIds: readonly string[]): HarnessWithMutableModels {
	const models = createModels();
	models.setProvider(fauxProvider({
		provider: "acme-chat",
		models: modelIds.map((id) => ({ id, contextWindow: 128_000 })),
	}).provider);
	// SAFETY: the test requests OpenedHarness's Models read surface from the
	// real mutable registry; no other harness surface is touched here.
	return {
		models,
		providerOwnership: new Map([["acme-chat", "acme-local"]]),
		decisions: { providers: () => [] },
		embeddings: { providers: () => [], list: () => [] },
	} as unknown as HarnessWithMutableModels;
}

describe("buildModelRoster", () => {
	test("the kind table and model options name their owner and locality", () => {
		const locality = createLocality({
			localProviders: () => ["acme-local"],
			ownerOf: () => "acme-local",
		});
		const roster = buildModelRoster(harnessWithModels(["chat-1", "chat-2"]), locality, () => "Acme Provider");
		expect(roster.chat).toEqual([
			{ id: "acme-chat/chat-1", label: "acme-chat/chat-1 · Acme Provider · local" },
			{ id: "acme-chat/chat-2", label: "acme-chat/chat-2 · Acme Provider · local" },
		]);
		expect(roster.decision).toEqual([]);
		expect(roster.embedding).toEqual([]);
	});

	test("a provider refresh reaches the roster without a restart", () => {
		const opened = harnessWithModels(["chat-1"]);
		const locality = createLocality({
			localProviders: () => [],
			ownerOf: () => "acme-owner",
		});
		const titleOf = () => "Acme Provider";
		expect(buildModelRoster(opened, locality, titleOf).chat.map((row) => row.id)).toEqual([
			"acme-chat/chat-1",
		]);
		// Re-read the real registry on each call: the first roster stays an
		// ordinary value, and only the NEXT roster sees the refreshed model.
		opened.models.setProvider(fauxProvider({
			provider: "acme-chat",
			models: ["chat-1", "chat-2"].map((id) => ({ id, contextWindow: 128_000 })),
		}).provider);
		expect(buildModelRoster(opened, locality, titleOf).chat.map((row) => row.id)).toEqual([
			"acme-chat/chat-1",
			"acme-chat/chat-2",
		]);
	});
});


test("the Models form keeps empty omitted optional fields harmless", () => {
	const section = CORE_SETTINGS_SECTIONS.find((candidate) => candidate.id === "models");
	if (section === undefined) throw new Error("missing Models section");
	const rendered = withoutEmptyModelKind(section.form, {
		settings: { namingModel: "faux/chat-1" },
		modelRoster: { chat: [], decision: [], embedding: [] },
	});
	if (rendered.root.type !== "form") throw new Error("missing form");
	expect(JSON.stringify(rendered)).toContain('"name":"namingModel"');
});

test("a kind with no models and no stored value is omitted", () => {
	const section = CORE_SETTINGS_SECTIONS.find((candidate) => candidate.id === "models");
	if (section === undefined) throw new Error("missing Models section");
	const rendered = withoutEmptyModelKind(section.form, {
		settings: {},
		modelRoster: { chat: [], decision: [], embedding: [] },
	});
	if (rendered.root.type !== "form") throw new Error("missing form");
	expect(rendered.root.children.flatMap((child) => child.type === "section"
		? child.children.map((field) => "name" in field ? field.name : undefined) : [])).toEqual([]);
	expect(section.form.root.type).toBe("form");
});

test("an empty live kind never draws a sibling field without its own stored value", () => {
	const section = CORE_SETTINGS_SECTIONS.find((candidate) => candidate.id === "models");
	if (section === undefined) throw new Error("missing Models section");
	const rendered = withoutEmptyModelKind(section.form, {
		settings: { namingModel: "acme/utility-gone" },
		modelRoster: { chat: [{ id: "acme/default-gone", label: "acme/default-gone (not currently served)" }], decision: [], embedding: [] },
	});
	if (rendered.root.type !== "form") throw new Error("missing form");
	expect(JSON.stringify(rendered)).toContain('"name":"namingModel"');
	expect(JSON.stringify(rendered)).not.toContain('"name":"defaultModel"');
});

test("withUnserved only appends a stored value absent from the roster", () => {
	const served = [{ id: "acme/chat-1", label: "acme/chat-1 · Acme Provider" }];
	expect(withUnserved(served, undefined)).toEqual(served);
	expect(withUnserved(served, "")).toEqual(served);
	expect(withUnserved(served, "acme/chat-1")).toEqual(served);
	expect(withUnserved(served, "acme/gone")).toEqual([
		...served,
		{ id: "acme/gone", label: "acme/gone (not currently served)" },
	]);
});

// ---------------------------------------------------------------------------
// The live HTTP render: a refresh, an unserved value, and an empty kind
// ---------------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

interface Rig {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly token: string;
}

async function boot(options: { registries?: boolean } = {}): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-model-roster-"));
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/chat-1",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_AUTH: "token",
	});
	const identity = await seededIdentity(dir);
	const provider = fauxProvider({
		provider: "faux",
		models: [{ id: "chat-1", contextWindow: 128_000 }],
	});
	const opened = await openHarness(config, {
		identity,
		extensions: [{ name: "acme-chat", providers: [{ provider: provider.provider }] }],
		extensionSpecifiers: options.registries === false
			? []
			: [fixture("fixture-decision-provider"), fixture("fixture-embedding-provider")],
		env: {},
		settingsDir: dir,
		builtins: false,
	});
	const { token } = await opened.identity.tokens.create("tester-cli", "tester");
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, token };
}

async function renderModelSection(
	app: FastifyInstance,
	token: string,
): Promise<{ tree: Tree; data: Record<string, unknown> }> {
	const response = await app.inject({
		method: "GET",
		url: "/v1/ext/core/surfaces/models",
		headers: { authorization: `Bearer ${token}` },
	});
	expect(response.statusCode).toBe(200);
	const body = response.json() as { tree: Tree; data: Record<string, unknown> };
	return { tree: body.tree, data: body.data };
}

describe("System Models surface", () => {
	test("served kinds, the utility model, and local markers populate the live binding data", async () => {
		const { app, opened, token } = await boot();
		const general = await app.inject({
			method: "GET",
			url: "/v1/ext/core/surfaces/general",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(general.statusCode).toBe(200);
		expect((general.json() as { data: Record<string, unknown> }).data.modelRoster).toBeUndefined();

		const first = await renderModelSection(app, token);
		const fields = choices(first.tree, first.data);
		expect(first.data.modelDefaults).toEqual({ chat: "System default (faux/chat-1)" });
		expect(fields.get("defaultModel")?.placeholder).toEqual({ $: "/modelDefaults/chat" });
		expect([...fields.keys()]).toEqual([
			"defaultModel",
			"namingModel",
			"decisionModel",
			"embeddingModel",
		]);
		for (const [name, field] of fields) expect(field.presentation, name).toBe("dropdown");
		expect(fields.get("defaultModel")?.options).toEqual([
			{ id: "faux/chat-1", label: "faux/chat-1 · acme-chat" },
		]);
		expect(fields.get("namingModel")?.options).toEqual(fields.get("defaultModel")?.options);
		expect(fields.get("decisionModel")?.options).toEqual([
			{ id: "acme-judge/judge-1", label: "acme-judge/judge-1 · acme-judge" },
			{ id: "acme-judge/judge-2", label: "acme-judge/judge-2 · acme-judge" },
		]);
		// SIGRUN_DEFAULT_MODEL is the operational default, not an implicit
		// claim that the settings FILE stored it.
		expect(first.data.settings).toEqual({});
		opened.settings.apply({ localProviders: ["acme-chat", "acme-embed"] });
		const local = await renderModelSection(app, token);
		// SAFETY: models wires ChoiceOption rows into these concrete fields.
		const localRoster = local.data.modelRoster as unknown as {
			chat: readonly { id: string; label: string }[];
			embedding: readonly { id: string; label: string }[];
		};
		expect(localRoster.chat).toEqual([
			{ id: "faux/chat-1", label: "faux/chat-1 · acme-chat · local" },
		]);
		expect(localRoster.embedding).toEqual([
			{ id: "acme-embed/embed-1", label: "acme-embed/embed-1 · acme-embed · local" },
			{ id: "acme-embed/embed-2", label: "acme-embed/embed-2 · acme-embed · local" },
		]);
	});

	test("a provider refresh reaches the roster without a restart", async () => {
		const { app, token } = await boot();
		// Only the catalog changes below; no reboot, no new server instance.
		const beforeRender = await renderModelSection(app, token);
		const before = choices(beforeRender.tree, beforeRender.data);
		expect(before.get("defaultModel")?.options.map((row) => row.id)).toEqual(["faux/chat-1"]);
		// The same mutation Models.refresh applies: no SettingsStore edit, no
		// server recreation. A GET made afterwards must resolve the new id.
		// OpenedHarness types this as Models; the test checks whether a
		// subsequent getModels reflects the mutable pi-ai store's refresh.
		// Type the mutable registry at the harness boundary so refresh setup
		// needs no narrowing cast for the mutation itself.
		// SAFETY: provider refresh replaces this same mutable catalog; its
		// public OpenedHarness interface intentionally exposes read-only Models.
		const catalog = app.sigrunContext.opened.models as unknown as MutableModels;
		catalog.setProvider(fauxProvider({
			provider: "faux",
			models: [
				{ id: "chat-1", contextWindow: 128_000 },
				{ id: "chat-2", contextWindow: 128_000 },
			],
		}).provider);
		const rendered = await renderModelSection(app, token);
		const after = choices(rendered.tree, rendered.data);
		expect(after.get("defaultModel")?.options.map((row) => row.id)).toEqual([
			"faux/chat-1",
			"faux/chat-2",
		]);
		expect(after.get("namingModel")?.options).toEqual(after.get("defaultModel")?.options);
		// Removal is equally live: no snapshot of the boot catalog survives.
		catalog.setProvider(fauxProvider({
			provider: "faux",
			models: [{ id: "chat-2", contextWindow: 128_000 }],
		}).provider);
		const latest = await renderModelSection(app, token);
		expect(choices(latest.tree, latest.data).get("defaultModel")?.options.map((row) => row.id)).toEqual([
			"faux/chat-2",
		]);
		// There is no file-backed old id here: the env pin is a display/default
		// decision, not a phantom "not currently served" value pushed into data.
		expect(latest.data.settings).toEqual({});
	});

	test("a kind with no models and no stored value is omitted", async () => {
		const { app, token } = await boot({ registries: false });
		const rendered = await renderModelSection(app, token);
		expect([...choices(rendered.tree, rendered.data).keys()]).toEqual([
			"defaultModel",
			"namingModel",
		]);
		expect(rendered.data.modelRoster).toMatchObject({ decision: [], embedding: [] });
	});

	test("a stored unserved model shows as not currently served", async () => {
		const { app, opened, token } = await boot();
		await opened.settings.apply({
			embeddingModel: null,
			defaultModel: "acme-missing/default-gone",
			decisionModel: "acme-missing/judge-gone",
			namingModel: "acme-missing/namer-gone",
		});
		const rendered = await renderModelSection(app, token);
		const fields = choices(rendered.tree, rendered.data);
		expect(rendered.data.modelDefaults).toEqual({ chat: "System default (faux/chat-1)" });
		expect(rendered.data.settings).toMatchObject({ defaultModel: "acme-missing/default-gone" });
		expect(fields.get("decisionModel")?.options).toEqual([
			{ id: "acme-judge/judge-1", label: "acme-judge/judge-1 · acme-judge" },
			{ id: "acme-judge/judge-2", label: "acme-judge/judge-2 · acme-judge" },
			{ id: "acme-missing/judge-gone", label: "acme-missing/judge-gone (not currently served)" },
		]);
		expect(fields.get("namingModel")?.options.at(-1)).toEqual({
			id: "acme-missing/namer-gone",
			label: "acme-missing/namer-gone (not currently served)",
		});
		expect(rendered.data.modelRoster).toMatchObject({
			chat: [
				{ id: "faux/chat-1" },
				{ id: "acme-missing/default-gone", label: "acme-missing/default-gone (not currently served)" },
				{ id: "acme-missing/namer-gone", label: "acme-missing/namer-gone (not currently served)" },
			],
			embedding: [
				{ id: "acme-embed/embed-1" },
				{ id: "acme-embed/embed-2" },
			],
		});
		expect(fields.get("defaultModel")?.options.at(-2)).toMatchObject({ id: "acme-missing/default-gone" });
		expect(fields.get("namingModel")?.options.at(-1)).toMatchObject({ id: "acme-missing/namer-gone" });
		// No default-first surrogate options on this system section: its
		// bindings ARE the system defaults.
		for (const field of fields.values()) expect(field.options[0]?.id).not.toBe("");
	});

	test("an empty embedding kind can save after its field is omitted", async () => {
		const { app, opened, token } = await boot();
		opened.settings.apply({ embeddingModel: null });
		const initial = await app.inject({
			method: "GET",
			url: "/v1/ext/core/surfaces/models",
			headers: { authorization: `Bearer ${token}` },
		});
		const rev = (initial.json() as { rev: number }).rev;
		const saved = await app.inject({
			method: "POST",
			url: "/v1/ext/core/surfaces/models/actions",
			headers: { authorization: `Bearer ${token}` },
			payload: {
				action: "save",
				actionId: "acme-save-without-embedding",
				params: {},
				payload: { rev, values: { namingModel: "faux/chat-1", decisionModel: "", embeddingModel: "" } },
			},
		});
		expect(saved.json()).toMatchObject({ ok: true });
		expect(opened.settings.read().namingModel).toBe("faux/chat-1");
	});
});
