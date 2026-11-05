/**
 * Warden Task 7: the decision-provider HTTP surfaces — `/v1/providers`
 * decision entries (`kind: "decision"`, modelIds, owner), the
 * credential routes accepting a decision-only id (no refresh, the entry
 * back), and `/v1/meta`'s `decisions` projection.
 *
 * Boot pattern mirrors decisions-loader.test.ts: the decisions surface
 * rides the host bridge, so every boot pairs
 * `openHarness({expectHostBridge: true})` with `createServer`; the
 * fixture provider is the shared `fixture-decision-provider` module
 * (`acme-judge`, models `judge-1`/`judge-2`, `credentialEnv`
 * TYPESAFE_API_KEY — the tests own these literals).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { AuthCheckProvider, MetaResponse, ProvidersResponse } from "../src/server/views.js";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import { resetDecisionProvider, setReadiness } from "./fixtures/fixture-decision-provider/index.js";

const PROVIDER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-decision-provider", "index.js"),
).href;

interface Rig {
	opened: OpenedHarness;
	app: FastifyInstance;
	dir: string;
	admin: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

async function boot(
	specifiers: readonly string[],
	options: { env?: Record<string, string>; extensions?: readonly ProviderContributor[] } = {},
): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-decisions-routes-"));
	const env: Record<string, string> = { SIGRUN_AUTH: "token", ...(options.env ?? {}) };
	const config = loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_AUTH: "token",
	});
	const opened = await openHarness(config, {
		env,
		identity: await seededIdentity(dir),
		builtins: false,
		settingsDir: dir,
		extensionSpecifiers: specifiers,
		...(options.extensions === undefined ? {} : { extensions: options.extensions }),
		expectHostBridge: true,
	});
	const app = await createServer(opened, config);
	const admin = (await opened.identity.tokens.create("test", "tester")).token;
	cleanups.push(async () => {
		await app.close().catch(() => {});
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return { opened, app, dir, admin };
}

async function getProviders(app: FastifyInstance, token: string): Promise<ProvidersResponse> {
	const res = await app.inject({
		method: "GET",
		url: "/v1/providers",
		headers: { authorization: `Bearer ${token}` },
	});
	expect(res.statusCode).toBe(200);
	return res.json() as ProvidersResponse;
}

test("GET /v1/providers lists acme-judge with kind decision, its models and status", async () => {
	resetDecisionProvider();
	const rig = await boot([PROVIDER], { env: { TYPESAFE_API_KEY: "acme-env-key" } });
	const { providers } = await getProviders(rig.app, rig.admin);
	const entry = providers.find((p) => p.provider === "acme-judge");
	expect(entry).toBeDefined();
	expect(entry).toMatchObject({
		provider: "acme-judge",
		kind: "decision",
		models: 2,
		owner: "acme-judge",
	});
	expect((entry as AuthCheckProvider & { modelIds?: string[] }).modelIds).toEqual([
		"judge-1",
		"judge-2",
	]);
});

test("PUT /v1/providers/acme-judge/credential stores it and the entry turns ready without a restart", async () => {
	resetDecisionProvider();
	// No env credential: the registry's readiness row is not_configured.
	const rig = await boot([PROVIDER]);
	const before = await getProviders(rig.app, rig.admin);
	expect(before.providers.find((p) => p.provider === "acme-judge")?.status).toBe(
		"not_configured",
	);
	// The owning extension flips its tracker once the key lands (the
	// registry re-derives readiness per call — the entry reflects it
	// without a restart).
	setReadiness("ready");
	const put = await rig.app.inject({
		method: "PUT",
		url: "/v1/providers/acme-judge/credential",
		headers: { authorization: `Bearer ${rig.admin}` },
		payload: { apiKey: "acme-written-key" },
	});
	expect(put.statusCode).toBe(200);
	const entry = put.json() as AuthCheckProvider & { modelIds?: string[] };
	expect(entry).toMatchObject({
		provider: "acme-judge",
		kind: "decision",
		status: "ready",
	});
	// The report reflects the written key without a restart.
	const after = await getProviders(rig.app, rig.admin);
	expect(after.providers.find((p) => p.provider === "acme-judge")?.status).toBe("ready");
	// And the credential actually evaluates.
	const result = await rig.opened.decisions.evaluate(
		"sigrun",
		{ state: "acme", questions: { q: { type: "noul" } } },
		{},
	);
	expect(result.ok).toBe(true);
	// DELETE removes it again (decision ids: no refresh, the entry back).
	setReadiness("not_configured");
	const del = await rig.app.inject({
		method: "DELETE",
		url: "/v1/providers/acme-judge/credential",
		headers: { authorization: `Bearer ${rig.admin}` },
	});
	expect(del.statusCode).toBe(200);
	expect((del.json() as AuthCheckProvider).status).toBe("not_configured");
});

test("GET /v1/meta lists decision providers, the resolved default and collisions", async () => {
	resetDecisionProvider();
	setReadiness("ready");
	const rig = await boot([PROVIDER], { env: { TYPESAFE_API_KEY: "acme-env-key" } });
	const res = await rig.app.inject({
		method: "GET",
		url: "/v1/meta",
		headers: { authorization: `Bearer ${rig.admin}` },
	});
	expect(res.statusCode).toBe(200);
	const meta = res.json() as MetaResponse;
	expect(meta.decisions.default).toBe("acme-judge/judge-1");
	expect(meta.decisions.collisions).toEqual([]);
	expect(meta.decisions.providers).toEqual([
		{
			id: "acme-judge",
			label: "Acme Judge",
			extension: "acme-judge",
			models: ["judge-1", "judge-2"],
			status: "ready",
		},
	]);
});

test("a chat provider and a decision provider with the same id stay separate entries", async () => {
	resetDecisionProvider();
	const faux = fauxProvider({
		provider: "acme-judge",
		models: [{ id: "chat-1", contextWindow: 128_000 }],
	});
	const chatContributor: ProviderContributor = {
		name: "acme-judge-chat",
		providers: [{ provider: faux.provider }],
	};
	const rig = await boot([PROVIDER], {
		env: { TYPESAFE_API_KEY: "acme-env-key" },
		extensions: [chatContributor],
	});
	const { providers } = await getProviders(rig.app, rig.admin);
	const named = providers.filter((p) => p.provider === "acme-judge");
	expect(named).toHaveLength(2);
	const kinds = named.map((p) => (p as AuthCheckProvider & { kind?: string }).kind ?? "chat");
	expect(kinds.sort()).toEqual(["chat", "decision"]);
});
