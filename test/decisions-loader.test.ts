/**
 * Warden Task 6: decision providers on the loader, boot, host bridge,
 * auth.json and settings — the factory-result field end to end.
 *
 * Fixture extensions under `test/fixtures/` (the published-hooks-loader
 * pattern): `fixture-decision-provider` is a contributor-only provider
 * (`acme-judge`, models `judge-1`/`judge-2`, `credentialEnv`
 * TYPESAFE_API_KEY — the tests own these literals), the caller fixtures
 * stash the host and drive `host.decisions.evaluate`, and
 * `fixture-decision-bad` stages one malformed declaration per quarantine
 * rule.
 *
 * The decisions surface delegates through the host bridge (the seam
 * host awaits the harness + the bridge bind), so every boot pairs
 * `openHarness({expectHostBridge: true})` with `createServer` — the
 * seam-host-bridge suite's pattern.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import type { DecisionRequest } from "@sigrun/shared/decisions";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import {
	calls as providerCalls,
	resetDecisionProvider,
	setProviderDelay,
} from "./fixtures/fixture-decision-provider/index.js";
import {
	callFromCaller,
	pending as callerPending,
	resetDecisionCaller,
	results as callerResults,
} from "./fixtures/fixture-decision-caller/index.js";
import { setBadDecisionProviders } from "./fixtures/fixture-decision-bad/index.js";

const PROVIDER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-decision-provider", "index.js"),
).href;
const CALLER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-decision-caller", "index.js"),
).href;
const EARLY_CALLER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-decision-caller-early", "index.js"),
).href;
const BAD = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-decision-bad", "index.js"),
).href;

function configWith(dir: string, extraEnv: Record<string, string> = {}) {
	return loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		...extraEnv,
	});
}

function request(): DecisionRequest {
	return { state: "acme", questions: { q: { type: "noul" } } };
}

interface Rig {
	opened: OpenedHarness;
	config: SigrunConfig;
	/** The operator env bag the boot reads ambient credentials from. */
	env: Record<string, string>;
	/** The config dir: auth.json + settings.json live here. */
	dir: string;
}

const dirs: string[] = [];
const closes: Array<() => Promise<void>> = [];

afterAll(async () => {
	for (const close of closes.splice(0)) await close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * Boot the harness + server with the fixture specifiers (the decisions
 * surface rides the host bridge, so a server must bind for any call).
 * `extraEnv` feeds BOTH the config parse and the boot env: an env knob
 * (`SIGRUN_DECISION_TIMEOUT_MS`) wins over the file only when the boot
 * env carries it.
 */
async function boot(
	specifiers: readonly string[],
	options: {
		env?: Record<string, string>;
		configEnv?: Record<string, string>;
		extensions?: readonly ProviderContributor[];
	} = {},
): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-decisions-loader-"));
	dirs.push(dir);
	const env = { ...(options.env ?? {}) };
	const config = configWith(dir, { ...(options.configEnv ?? {}) });
	const opened = await openHarness(config, {
		env,
		identity: await seededIdentity(dir),
		builtins: false,
		settingsDir: dir,
		extensionSpecifiers: specifiers,
		...(options.extensions === undefined ? {} : { extensions: options.extensions }),
		expectHostBridge: true,
	});
	closes.push(() => opened.harness.close(BACKGROUND_CONTEXT));
	const app: FastifyInstance = await createServer(opened, config);
	closes.push(() => app.close());
	return { opened, config, env, dir };
}

function resets(): void {
	resetDecisionProvider();
	resetDecisionCaller();
}

test("a contributor-only result with decisionProviders loads, and host.decisions.evaluate from another extension returns ok with model acme-judge/judge-1", async () => {
	resets();
	const rig = await boot([PROVIDER, CALLER], {
		env: { TYPESAFE_API_KEY: "acme-env-key" },
	});
	expect(rig.opened.extensionOutcomes).toEqual([
		{ name: "acme-judge", status: "ok" },
		{ name: "acme-notes", status: "ok" },
	]);
	const result = await callFromCaller(request());
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("unreachable");
	expect(result.model).toBe("acme-judge/judge-1");
	expect(result.answers.q).toMatchObject({ type: "noul", noul: 0.5 });
});

test("the provider sees caller = the calling extension's slug", async () => {
	resets();
	await boot([PROVIDER, CALLER], { env: { TYPESAFE_API_KEY: "acme-env-key" } });
	await callFromCaller(request());
	expect(providerCalls).toHaveLength(1);
	expect(providerCalls[0]?.caller).toBe("acme-notes");
});

test("a call during loading resolves after loading finishes", async () => {
	resets();
	await boot([PROVIDER, EARLY_CALLER], {
		env: { TYPESAFE_API_KEY: "acme-env-key" },
	});
	expect(callerPending).toHaveLength(1);
	await Promise.all(callerPending);
	expect(callerResults).toHaveLength(1);
	expect(callerResults[0]?.ok).toBe(true);
	if (callerResults[0]?.ok !== true) throw new Error("unreachable");
	expect(callerResults[0]?.model).toBe("acme-judge/judge-1");
});

test("each quarantine rule quarantines", async () => {
	const validModel = { id: "judge-1" };
	const validEvaluate = async () => ({ answers: {} });
	const cases: readonly { name: string; value: unknown; match: RegExp }[] = [
		{
			name: "not an array",
			value: { id: "acme-judge" },
			match: /decisionProviders.*not an array/,
		},
		{
			name: "a bad provider id",
			value: [
				{ id: "Acme_Bad", models: [validModel], evaluate: validEvaluate },
			],
			match: /decision provider.*id/,
		},
		{
			name: "a provider id over 64 chars",
			value: [
				{
					id: `a${"b".repeat(64)}`,
					models: [validModel],
					evaluate: validEvaluate,
				},
			],
			match: /decision provider.*id/,
		},
		{
			name: "no models",
			value: [{ id: "acme-judge", models: [], evaluate: validEvaluate }],
			match: /no models/,
		},
		{
			name: "a bad model id",
			value: [
				{
					id: "acme-judge",
					models: [{ id: "judge 1" }],
					evaluate: validEvaluate,
				},
			],
			match: /model.*id/,
		},
		{
			name: "a duplicate model id",
			value: [
				{
					id: "acme-judge",
					models: [validModel, { id: "judge-1" }],
					evaluate: validEvaluate,
				},
			],
			match: /duplicate.*judge-1/,
		},
		{
			name: "evaluate not a function",
			value: [{ id: "acme-judge", models: [validModel], evaluate: 42 }],
			match: /evaluate.*not a function/,
		},
		{
			name: "a readiness that is not a function",
			value: [
				{
					id: "acme-judge",
					models: [validModel],
					evaluate: validEvaluate,
					readiness: "ready",
				},
			],
			match: /readiness.*not a function/,
		},
		{
			name: "a credentialEnv that is not a NAME",
			value: [
				{
					id: "acme-judge",
					models: [validModel],
					evaluate: validEvaluate,
					credentialEnv: "typesafe_api_key",
				},
			],
			match: /credentialEnv/,
		},
	];
	for (const one of cases) {
		setBadDecisionProviders(one.value);
		const rig = await boot([BAD]);
		expect(rig.opened.extensionOutcomes, one.name).toHaveLength(1);
		const outcome = rig.opened.extensionOutcomes[0];
		expect(outcome?.status, one.name).toBe("quarantined");
		expect(outcome?.error, one.name).toMatch(one.match);
	}
});

test("an auth.json acme-judge key wins over TYPESAFE_API_KEY; with neither, not_configured", async () => {
	resets();
	const rig = await boot([PROVIDER, CALLER], {
		env: { TYPESAFE_API_KEY: "acme-env-key" },
	});
	// auth.json wins over the ambient env.
	await writeFile(
		join(rig.dir, "auth.json"),
		JSON.stringify({ "acme-judge": { apiKey: "acme-file-key" } }),
	);
	const first = await callFromCaller(request());
	expect(first.ok).toBe(true);
	expect(providerCalls.at(-1)?.credential).toBe("acme-file-key");
	// Neither stored nor ambient: not_configured, and the provider is
	// never called.
	await writeFile(join(rig.dir, "auth.json"), "{}");
	rig.env.TYPESAFE_API_KEY = "";
	const before = providerCalls.length;
	const second = await callFromCaller(request());
	expect(second.ok).toBe(false);
	if (second.ok) throw new Error("unreachable");
	expect(second.code).toBe("not_configured");
	expect(providerCalls).toHaveLength(before);
	// The auth bridge's ""-means-unset rule: an empty env string is no key.
	delete rig.env.TYPESAFE_API_KEY;
	rig.env.TYPESAFE_API_KEY = "";
	const third = await callFromCaller(request());
	expect(third.ok).toBe(false);
	if (third.ok) throw new Error("unreachable");
	expect(third.code).toBe("not_configured");
});

test("an env-only key (no auth.json entry) reaches the provider and returns ok", async () => {
	resets();
	await boot([PROVIDER, CALLER], { env: { TYPESAFE_API_KEY: "acme-env-key" } });
	const result = await callFromCaller(request());
	expect(result.ok).toBe(true);
	expect(providerCalls.at(-1)?.credential).toBe("acme-env-key");
});

test("decisionModel set in settings.json is used live (changed between two calls without a restart)", async () => {
	resets();
	const rig = await boot([PROVIDER, CALLER], {
		env: { TYPESAFE_API_KEY: "acme-env-key" },
	});
	const first = await callFromCaller(request());
	expect(first.ok).toBe(true);
	if (!first.ok) throw new Error("unreachable");
	expect(first.model).toBe("acme-judge/judge-1");
	// The live write: no restart, the next call resolves the new default.
	await writeFile(
		join(rig.dir, "settings.json"),
		JSON.stringify({ decisionModel: "acme-judge/judge-2" }),
	);
	const second = await callFromCaller(request());
	expect(second.ok).toBe(true);
	if (!second.ok) throw new Error("unreachable");
	expect(second.model).toBe("acme-judge/judge-2");
	expect(providerCalls.at(-1)?.model).toBe("judge-2");
});

test("SIGRUN_DECISION_TIMEOUT_MS=50 caps a slow provider", async () => {
	resets();
	await boot([PROVIDER, CALLER], {
		env: { TYPESAFE_API_KEY: "acme-env-key" },
		configEnv: { SIGRUN_DECISION_TIMEOUT_MS: "50" },
	});
	setProviderDelay(5_000);
	const result = await callFromCaller(request());
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("unreachable");
	expect(result.code).toBe("timeout");
});

test("a decision provider and a chat provider may share an id", async () => {
	resets();
	const faux = fauxProvider({
		provider: "acme-judge",
		models: [{ id: "chat-1", contextWindow: 128_000 }],
	});
	const chatContributor: ProviderContributor = {
		name: "acme-judge-chat",
		providers: [{ provider: faux.provider }],
	};
	const rig = await boot([PROVIDER, CALLER], {
		env: { TYPESAFE_API_KEY: "acme-env-key" },
		extensions: [chatContributor],
	});
	// The chat provider serves its model; the decision provider answers.
	expect(rig.opened.models.getModel("acme-judge", "chat-1")).toBeDefined();
	const result = await callFromCaller(request());
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("unreachable");
	expect(result.model).toBe("acme-judge/judge-1");
});
