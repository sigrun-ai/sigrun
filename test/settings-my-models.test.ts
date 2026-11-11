/**
 * Settings split Plan 2 Task 5: My settings → Models.
 *
 * The `my-models` section (group mine) mounts as a USER-scope schema
 * surface over `overridesSchema(coreSchema)` under the reserved `core`
 * slug. A save writes `user-settings/<user>/core.json` (never the system
 * settings file), the first dropdown option is the System default (an
 * empty-string save removes the key), and a managed system value stays
 * overridable per user. The userless superuser edits the PRIMARY ADMIN's
 * overrides; an empty directory lists no My Models.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import type { ChoiceField, Tree } from "@sigrun/shared/blocks";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity, unclaimedIdentity } from "./helpers/identity.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

interface Rig {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly dir: string;
	readonly configDir: string;
}

async function boot(options: {
	/** Seed the named admin user (default "alice"); pass false for an empty directory. */
	readonly seed?: string | false;
	/** Extra non-admin directory users. */
	readonly users?: readonly string[];
	readonly defaultModel?: string;
	/** "naive" boots the empty-method loopback path (no credentials). */
	readonly auth?: "token" | "naive";
} = {}): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-my-models-"));
	const configDir = join(dir, "config");
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: options.defaultModel ?? "faux/chat-1",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_CONFIG_DIR: configDir,
		SIGRUN_API_TOKEN: "acme-service-token",
		...(options.auth === "naive" ? {} : { SIGRUN_AUTH: "token" }),
	});
	const identity = options.seed === false
		? await unclaimedIdentity(join(dir, "seed"))
		: await seededIdentity(join(dir, "seed"), options.seed ?? "alice");
	for (const user of options.users ?? []) {
		await identity.users.add({ user, admin: false, source: "cli" });
	}
	const provider = fauxProvider({
		provider: "faux",
		models: [
			{ id: "chat-1", contextWindow: 128_000 },
			{ id: "chat-2", contextWindow: 128_000 },
		],
	});
	const opened = await openHarness(config, {
		identity,
		extensions: [{ name: "acme-chat", providers: [{ provider: provider.provider }] }],
		extensionSpecifiers: [],
		env: { SIGRUN_CONFIG_DIR: configDir },
		settingsDir: configDir,
		builtins: false,
		listenHost: options.auth === "naive" ? "127.0.0.1" : "0.0.0.0",
	});
	const app = await createServer(opened, config, [], {
		listenHost: options.auth === "naive" ? "127.0.0.1" : "0.0.0.0",
	});
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, dir, configDir };
}

async function call(
	app: FastifyInstance,
	options: {
		readonly method: "GET" | "POST";
		readonly url: string;
		readonly token?: string;
		readonly payload?: unknown;
	},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await app.inject({
		method: options.method,
		url: options.url,
		...(options.token === undefined ? {} : { headers: { authorization: `Bearer ${options.token}` } }),
		...(options.payload === undefined
			? {}
			: { payload: options.payload as Record<string, unknown> }),
	});
	return {
		status: response.statusCode,
		body: response.json() as Record<string, unknown>,
	};
}

async function renderMyModels(
	app: FastifyInstance,
	token?: string,
): Promise<{ tree: Tree; data: Record<string, unknown>; rev: number }> {
	const result = await call(app, {
		method: "GET",
		url: "/v1/ext/core/surfaces/my-models",
		token,
	});
	expect(result.status).toBe(200);
	return result.body as { tree: Tree; data: Record<string, unknown>; rev: number };
}

async function saveMyModels(
	app: FastifyInstance,
	token: string | undefined,
	values: Record<string, unknown>,
	actionId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const rendered = await renderMyModels(app, token);
	return call(app, {
		method: "POST",
		url: "/v1/ext/core/surfaces/my-models/actions",
		token,
		payload: {
			action: "save",
			actionId,
			params: {},
			payload: { rev: rendered.rev, values },
		},
	});
}

/** Walk the tree + data into choice fields with their resolved options. */
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

async function userOverrides(
	rig: Rig,
	user: string,
): Promise<Record<string, unknown>> {
	return JSON.parse(
		await readFile(join(rig.configDir, "user-settings", user, "core.json"), "utf8"),
	) as Record<string, unknown>;
}

describe("My settings → Models", () => {
	test("a user's pick lands in user-settings/<user>/core.json", async () => {
		const rig = await boot({ users: ["bob"] });
		const { token } = await rig.opened.identity.tokens.create("bob-cli", "bob");
		const save = await saveMyModels(rig.app, token, { defaultModel: "faux/chat-2" }, "pick-chat");
		expect(save.body).toMatchObject({ ok: true });
		expect(await userOverrides(rig, "bob")).toMatchObject({ defaultModel: "faux/chat-2" });
		// The SYSTEM settings file never gains a user pick.
		expect(rig.opened.settings.read().defaultModel).toBeUndefined();
		// And the effective value resolves for that user.
		expect(await rig.opened.effective.value("defaultModel", "bob")).toBe("faux/chat-2");
	});

	test("choosing System default removes the key", async () => {
		const rig = await boot({ users: ["bob"] });
		const { token } = await rig.opened.identity.tokens.create("bob-cli", "bob");
		const set = await saveMyModels(rig.app, token, { defaultModel: "faux/chat-2" }, "set-chat");
		expect(set.body).toMatchObject({ ok: true });
		expect(await userOverrides(rig, "bob")).toMatchObject({ defaultModel: "faux/chat-2" });
		// The first option saves "" — plan 1's blank rule turns it into key-removed.
		const cleared = await saveMyModels(rig.app, token, { defaultModel: "" }, "clear-chat");
		expect(cleared.body).toMatchObject({ ok: true });
		expect(await userOverrides(rig, "bob")).not.toHaveProperty("defaultModel");
		expect(await rig.opened.effective.value("defaultModel", "bob")).toBe("faux/chat-1");
	});

	test("the first option names the current system value", async () => {
		const rig = await boot({ users: ["bob"], defaultModel: "faux/chat-1" });
		const { token } = await rig.opened.identity.tokens.create("bob-cli", "bob");
		const rendered = await renderMyModels(rig.app, token);
		const fields = choices(rendered.tree, rendered.data);
		expect([...fields.keys()]).toEqual(["defaultModel", "decisionModel", "embeddingModel"]);
		for (const field of fields.values()) expect(field.presentation).toBe("dropdown");
		// defaultModel's system value is env-resolved (SIGRUN_DEFAULT_MODEL).
		expect(fields.get("defaultModel")?.options[0]).toEqual({
			id: "",
			label: "System default (faux/chat-1)",
		});
		expect(fields.get("decisionModel")?.options[0]).toEqual({
			id: "",
			label: "System default (none)",
		});
		// A file-stored system decisionModel shows up by name.
		await rig.opened.settings.apply({ decisionModel: "acme-judge/judge-1" });
		const after = await renderMyModels(rig.app, token);
		expect(choices(after.tree, after.data).get("decisionModel")?.options[0]).toEqual({
			id: "",
			label: "System default (acme-judge/judge-1)",
		});
		// The live chat roster follows the default-first row.
		expect(fields.get("defaultModel")?.options.slice(1).map((row) => row.id)).toEqual([
			"faux/chat-1",
			"faux/chat-2",
		]);
	});

	test("only overridable keys save", async () => {
		const rig = await boot({ users: ["bob"] });
		const { token } = await rig.opened.identity.tokens.create("bob-cli", "bob");
		const save = await saveMyModels(rig.app, token, { namingModel: "faux/chat-2" }, "naming-reject");
		expect(save.body).toMatchObject({
			ok: false,
			error: { field: "namingModel" },
		});
		// Nothing was written.
		await expect(userOverrides(rig, "bob")).rejects.toThrow();
	});

	test("a managed system default can still be overridden", async () => {
		const rig = await boot({ users: ["bob"] });
		await writeFile(join(rig.configDir, "managed-settings.json"), '["defaultModel"]', "utf8");
		const { token } = await rig.opened.identity.tokens.create("bob-cli", "bob");
		const save = await saveMyModels(rig.app, token, { defaultModel: "faux/chat-2" }, "managed-override");
		expect(save.body).toMatchObject({ ok: true });
		expect(await userOverrides(rig, "bob")).toMatchObject({ defaultModel: "faux/chat-2" });
		expect(await rig.opened.effective.value("defaultModel", "bob")).toBe("faux/chat-2");
	});

	test("the userless admin edits the primary admin's overrides", async () => {
		const rig = await boot({ auth: "naive" });
		// The naive loopback principal (no X-Sigrun-User header) is the
		// userless superuser: it resolves to the PRIMARY ADMIN.
		const save = await saveMyModels(rig.app, undefined, { defaultModel: "faux/chat-2" }, "userless-save");
		expect(save.body).toMatchObject({ ok: true });
		// Lands on the PRIMARY ADMIN (alice), never a synthetic user.
		expect(await userOverrides(rig, "alice")).toMatchObject({ defaultModel: "faux/chat-2" });
		expect(await rig.opened.effective.value("defaultModel", "alice")).toBe("faux/chat-2");
		// The render's instance identity resolves too (no named_user_required).
		const rendered = await renderMyModels(rig.app);
		expect(rendered.data.settings).toMatchObject({ defaultModel: "faux/chat-2" });
	});

	test("an empty directory lists no My Models", async () => {
		const rig = await boot({ seed: false });
		// The env service token skips the setup gate (no users exist to
		// claim). Its default principal user is not a directory user and
		// the directory is EMPTY, so no My Models entry lists and the
		// surface answers named_user_required.
		const sections = await call(rig.app, {
			method: "GET",
			url: "/v1/settings/sections",
			token: "acme-service-token",
		});
		const body = sections.body as { sections: { slug: string; id: string }[] };
		expect(body.sections.some((s) => s.slug === "core" && s.id === "my-models")).toBe(false);
		// The surface itself refuses with named_user_required.
		const rendered = await call(rig.app, {
			method: "GET",
			url: "/v1/ext/core/surfaces/my-models",
			token: "acme-service-token",
		});
		expect(rendered.status).toBe(400);
		expect(rendered.body).toEqual({ error: "named_user_required" });
	});

	test("a save publishes server-scoped with the user", async () => {
		const rig = await boot({ users: ["bob"] });
		const { token } = await rig.opened.identity.tokens.create("bob-cli", "bob");
		const emitSpy = vi.spyOn(rig.opened.eventBus, "emitSettingsChanged");
		const save = await saveMyModels(rig.app, token, { defaultModel: "faux/chat-2" }, "publish-save");
		expect(save.body).toMatchObject({ ok: true });
		expect(emitSpy).toHaveBeenCalledWith(["defaultModel"], "bob");
		emitSpy.mockRestore();
	});
});
