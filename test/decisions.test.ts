/**
 * Warden Task 5: decision wire types, validation and the provider
 * registry (the PURE core — fixture declarations only; the loader/boot
 * wiring lands in Task 6).
 *
 * Fixtures own their literals: provider `acme-judge`, model `judge-1`,
 * caller `acme-notes`, state `"acme"`.
 */

import { describe, expect, it } from "vitest";
import {
	DECISION_MAX_BYTES,
	DECISION_MAX_QUESTIONS,
	type DecisionAnswers,
	type DecisionRequest,
} from "@sigrun/shared/decisions";
import {
	buildDecisionRegistry,
	validateDecisionAnswers,
	validateDecisionRequest,
	type DecisionDeclaration,
} from "../src/harness/decisions.js";
import type { DecisionProviderContribution } from "../src/extension.js";
import type { SettingsFile } from "../src/harness/settings.js";
import { createLocality } from "../src/harness/locality.js";

const CREDENTIAL = "acme-secret-key";

function noulQuestion() {
	return { type: "noul" as const };
}

function validRequest(): DecisionRequest {
	return {
		state: "acme",
		questions: {
			q: noulQuestion(),
			c: { type: "choice", criteria: { yes: null, no: null } },
			s: { type: "score", criteria: [{ name: "low" }, { name: "high" }] },
		},
	};
}

function validAnswers(): DecisionAnswers {
	return {
		answers: {
			q: { type: "noul", noul: 0.75 },
			c: { type: "choice", choice: "yes", confidence: 0.9, probabilities: { yes: 0.9, no: 0.1 } },
			s: { type: "score", score: 1, confidence: 0.8, probabilities: { "0": 0.2, "1": 0.8 } },
		},
	};
}

interface Fixture {
	declarations: DecisionDeclaration[];
	warnings: string[];
	calls: { request: DecisionRequest; ctx: Record<string, unknown> }[];
	credential: (id: string, env: string | undefined) => string | undefined;
	settings: SettingsFile & { decisionModel?: string };
	evaluateImpl: (
		request: DecisionRequest,
		ctx: Record<string, unknown>,
	) => Promise<DecisionAnswers>;
	registry: ReturnType<typeof buildDecisionRegistry>;
}

function makeFixture(overrides: {
	contribution?: Partial<DecisionProviderContribution>;
	secondContribution?: DecisionProviderContribution;
	credential?: (id: string, env: string | undefined) => string | undefined;
	settings?: Partial<SettingsFile & { decisionModel?: string }>;
	evaluateImpl?: Fixture["evaluateImpl"];
	effectiveModel?: (user: string | undefined) => Promise<string | undefined>;
	now?: () => number;
	timeoutCapMs?: number;
} = {}): Fixture {
	const warnings: string[] = [];
	const calls: Fixture["calls"] = [];
	const evaluateImpl =
		overrides.evaluateImpl ??
		(async () => validAnswers());
	const base: DecisionProviderContribution = {
		id: "acme-judge",
		credentialEnv: "ACME_JUDGE_API_KEY",
		models: [{ id: "judge-1" }],
		evaluate: async (request, ctx) => {
			calls.push({ request, ctx: ctx as unknown as Record<string, unknown> });
			return evaluateImpl(request, ctx as unknown as Record<string, unknown>);
		},
		...overrides.contribution,
	};
	const declarations: DecisionDeclaration[] = [
		{ extension: "acme-ext", contribution: base },
	];
	if (overrides.secondContribution) {
		declarations.push({ extension: "acme-ext-two", contribution: overrides.secondContribution });
	}
	const settings = (overrides.settings ?? {}) as Fixture["settings"];
	const credential =
		overrides.credential ??
		(() => CREDENTIAL);
	const registry = buildDecisionRegistry(declarations, {
		credential,
		readSettings: () => settings,
		locality: createLocality({
			localProviders: () => (settings.localProviders as string[] | undefined) ?? [],
			ownerOf: (kind, providerId) =>
				kind === "decision" && providerId === "acme-judge" ? "acme-ext" : undefined,
		}),
		...(overrides.effectiveModel === undefined
			? {}
			: { effectiveModel: overrides.effectiveModel }),
		timeoutCapMs: overrides.timeoutCapMs ?? 15_000,
		now: overrides.now ?? Date.now,
		warn: (message) => warnings.push(message),
	});
	return { declarations, warnings, calls, credential, settings, evaluateImpl, registry };
}

describe("decision locality (settings split Plan 2 Task 2)", () => {
	it("local-only decision returns not_local", async () => {
		const fixture = makeFixture();
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {
			confidentiality: "local-only",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("not_local");
		expect(fixture.calls.length).toBe(0);
	});

	it("a local-only call to a local model evaluates", async () => {
		const fixture = makeFixture({ settings: { localProviders: ["acme-ext"] } });
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {
			confidentiality: "local-only",
		});
		expect(result.ok).toBe(true);
		expect(fixture.calls.length).toBe(1);
	});

	it("decision list rows carry local", () => {
		const notLocal = makeFixture();
		expect(notLocal.registry.list()).toEqual([
			{ model: "acme-judge/judge-1", provider: "acme-judge", local: false, status: expect.any(String) },
		]);
		const local = makeFixture({ settings: { localProviders: ["acme-ext"] } });
		expect(local.registry.list()).toEqual([
			{ model: "acme-judge/judge-1", provider: "acme-judge", local: true, status: expect.any(String) },
		]);
	});
});

describe("per-user decision defaults (settings split Plan 2 Task 6)", () => {
	it("evaluate with user picks the user's decision override", async () => {
		const fixture = makeFixture({
			contribution: { models: [{ id: "judge-1" }, { id: "judge-2" }] },
			settings: { decisionModel: "acme-judge/judge-1" },
			effectiveModel: async (user) =>
				user === "bob" ? "acme-judge/judge-2" : "acme-judge/judge-1",
		});
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), { user: "bob" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.model).toBe("acme-judge/judge-2");
		expect(fixture.calls[0]?.ctx.model).toBe("judge-2");
	});
});

describe("validateDecisionRequest", () => {
	it("accepts a valid noul/choice/score request", () => {
		const result = validateDecisionRequest(validRequest());
		expect(result.ok).toBe(true);
	});

	it("rejects 33 questions as over_limits", () => {
		const questions: Record<string, unknown> = {};
		for (let i = 0; i < DECISION_MAX_QUESTIONS + 1; i++) questions[`q${i}`] = noulQuestion();
		const result = validateDecisionRequest({ state: "acme", questions });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("over_limits");
	});

	it("rejects a 70 KB state as over_limits", () => {
		const result = validateDecisionRequest({
			state: "x".repeat(70 * 1024),
			questions: { q: noulQuestion() },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("over_limits");
			expect(result.errors[0]?.message).toContain(String(DECISION_MAX_BYTES));
		}
	});

	it("rejects 17 questions under a model maxQuestions of 16", () => {
		const questions: Record<string, unknown> = {};
		for (let i = 0; i < 17; i++) questions[`q${i}`] = noulQuestion();
		const result = validateDecisionRequest(
			{ state: "acme", questions },
			{ maxQuestions: 16 },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("over_limits");
	});

	it("rejects a choice with no labels as invalid_request at /questions/q/criteria", () => {
		const result = validateDecisionRequest({
			state: "acme",
			questions: { q: { type: "choice", criteria: {} } },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("invalid_request");
			expect(result.errors[0]?.path).toBe("/questions/q/criteria");
		}
	});

	it("rejects an empty questions record as over_limits", () => {
		const result = validateDecisionRequest({ state: "acme", questions: {} });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("over_limits");
	});

	it("a function inside criteria → invalid_request (the whole request is strict JSON)", () => {
		const result = validateDecisionRequest({
			state: "acme",
			questions: { q: { type: "score", criteria: [{ name: "low" }, () => "high"] } },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("invalid_request");
	});
});

describe("validateDecisionAnswers", () => {
	it("accepts valid answers covering every question", () => {
		const result = validateDecisionAnswers(validRequest(), validAnswers());
		expect(result.ok).toBe(true);
	});

	it("rejects answers missing a question", () => {
		const answers = validAnswers();
		delete (answers.answers as Record<string, unknown>).c;
		const result = validateDecisionAnswers(validRequest(), answers);
		expect(result.ok).toBe(false);
	});

	it("rejects an answer of the wrong type", () => {
		const answers = validAnswers();
		(answers.answers as Record<string, unknown>).q = {
			type: "choice",
			choice: "yes",
			confidence: 0.9,
			probabilities: { yes: 0.9, no: 0.1 },
		};
		const result = validateDecisionAnswers(validRequest(), answers);
		expect(result.ok).toBe(false);
	});

	it("rejects a probability above 1", () => {
		const answers = validAnswers();
		(answers.answers as Record<string, unknown>).q = { type: "noul", noul: 1.2 };
		const result = validateDecisionAnswers(validRequest(), answers);
		expect(result.ok).toBe(false);
	});
});

describe("buildDecisionRegistry", () => {
	it("no providers → no_model", async () => {
		const fixture = makeFixture();
		fixture.declarations.length = 0;
		const empty = buildDecisionRegistry([], {
			credential: fixture.credential,
			readSettings: () => ({}),
			locality: createLocality({ localProviders: () => [], ownerOf: () => undefined }),
			timeoutCapMs: 15_000,
			now: Date.now,
			warn: () => {},
		});
		const result = await empty.evaluate("acme-notes", validRequest(), {});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("no_model");
	});

	it("a decisionModel naming an unknown model → unknown_model", async () => {
		const fixture = makeFixture({ settings: { decisionModel: "acme-judge/nope" } });
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("unknown_model");
	});

	it("opts.model naming an unknown provider → unknown_model", async () => {
		const fixture = makeFixture();
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {
			model: "other/judge-1",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("unknown_model");
	});

	it("unset decisionModel uses the first model of the first-registered provider", async () => {
		const fixture = makeFixture();
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.model).toBe("acme-judge/judge-1");
		expect(fixture.calls[0]?.ctx.model).toBe("judge-1");
	});

	it("the provider receives model, credential, caller and a signal", async () => {
		const fixture = makeFixture();
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {});
		expect(result.ok).toBe(true);
		const ctx = fixture.calls[0]?.ctx;
		expect(ctx?.model).toBe("judge-1");
		expect(ctx?.credential).toBe(CREDENTIAL);
		expect(ctx?.caller).toBe("acme-notes");
		expect(ctx?.signal).toBeInstanceOf(AbortSignal);
	});

	it("no credential → not_configured without calling the provider, even when its tracker says ready", async () => {
		const fixture = makeFixture({
			credential: () => undefined,
			contribution: { readiness: () => ({ status: "ready" }) },
		});
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("not_configured");
		expect(fixture.calls.length).toBe(0);
	});

	it("a credential with a tracker that has never been called → the provider is called", async () => {
		const trackerCalls: number[] = [];
		const fixture = makeFixture({
			contribution: {
				readiness: () => {
					trackerCalls.push(1);
					return { status: "ready" };
				},
			},
		});
		// Never read the tracker before evaluate.
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {});
		expect(result.ok).toBe(true);
		expect(fixture.calls.length).toBe(1);
	});

	it("a throw → failed with the credential scrubbed from the message", async () => {
		const fixture = makeFixture({
			evaluateImpl: async () => {
				throw new Error(`upstream rejected key ${CREDENTIAL}`);
			},
		});
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("failed");
			expect(result.error).not.toContain(CREDENTIAL);
			expect(result.error).toContain("[redacted]");
		}
	});

	it("a slow provider → timeout at min(timeoutMs, cap) and its signal aborts", async () => {
		const fixture = makeFixture({
			timeoutCapMs: 50,
			evaluateImpl: async (_request, ctx) => {
				const signal = ctx.signal as AbortSignal;
				await new Promise((resolve) => {
					signal.addEventListener("abort", resolve, { once: true });
				});
				return validAnswers();
			},
		});
		const start = Date.now();
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {
			timeoutMs: 60_000, // above the 50ms cap
		});
		const elapsed = Date.now() - start;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("timeout");
		expect(elapsed).toBeLessThan(1_000);
	});

	it("a caller abort → aborted", async () => {
		const controller = new AbortController();
		const fixture = makeFixture({
			evaluateImpl: async (_request, ctx) => {
				const signal = ctx.signal as AbortSignal;
				await new Promise((resolve) => {
					signal.addEventListener("abort", resolve, { once: true });
				});
				return validAnswers();
			},
		});
		setTimeout(() => controller.abort(), 10);
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {
			signal: controller.signal,
			timeoutMs: 5_000,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("aborted");
	});

	it("a bad answer → bad_answer", async () => {
		const fixture = makeFixture({
			evaluateImpl: async () => ({ answers: {} }),
		});
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("bad_answer");
	});

	it("three declarations with one id: every prior winner lands in losers", () => {
		const warnings: string[] = [];
		const mk = (modelId: string): DecisionProviderContribution => ({
			id: "acme-judge",
			models: [{ id: modelId }],
			evaluate: async () => validAnswers(),
		});
		const registry = buildDecisionRegistry(
			[
				{ extension: "acme-a", contribution: mk("m1") },
				{ extension: "acme-b", contribution: mk("m2") },
				{ extension: "acme-c", contribution: mk("m3") },
			],
			{
				credential: () => CREDENTIAL,
				readSettings: () => ({}),
				locality: createLocality({ localProviders: () => [], ownerOf: () => undefined }),
				timeoutCapMs: 15_000,
				now: Date.now,
				warn: (message) => warnings.push(message),
			},
		);
		expect(registry.collisions()).toEqual([
			{ id: "acme-judge", winner: "acme-c", losers: ["acme-a", "acme-b"] },
		]);
		expect(warnings.length).toBe(2);
	});

	it("a pre-aborted caller signal → aborted without calling the provider", async () => {
		const fixture = makeFixture();
		const controller = new AbortController();
		controller.abort();
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {
			signal: controller.signal,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("aborted");
		expect(fixture.calls.length).toBe(0);
	});

	it("list() returns qualified model names with the provider and status", () => {
		const fixture = makeFixture({
			contribution: { readiness: () => ({ status: "ready" }) },
		});
		expect(fixture.registry.list()).toEqual([
			{ model: "acme-judge/judge-1", provider: "acme-judge", local: false, status: "ready" },
		]);
	});

	it("providers() returns the declaration, models and readiness per id", () => {
		const fixture = makeFixture({
			contribution: { label: "Acme Judge", readiness: () => ({ status: "ready" }) },
		});
		expect(fixture.registry.providers()).toEqual([
			{
				id: "acme-judge",
				label: "Acme Judge",
				extension: "acme-ext",
				models: ["judge-1"],
				status: "ready",
			},
		]);
	});

	it("resolvedDefault() is the decisionModel setting when set, else the first model", () => {
		const fixture = makeFixture({ settings: { decisionModel: "acme-judge/judge-9" } });
		// The setting wins verbatim even when it names an unregistered model.
		expect(fixture.registry.resolvedDefault()).toBe("acme-judge/judge-9");
		const unset = makeFixture();
		expect(unset.registry.resolvedDefault()).toBe("acme-judge/judge-1");
	});

	it("a non-Error throw that cannot stringify still yields failed (never rejects)", async () => {
		const fixture = makeFixture({
			evaluateImpl: async () => {
				throw Object.create(null); // eslint-disable-line no-throw-literal -- the hostile-throw shape
			},
		});
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("failed");
			expect(result.error).toBe("non-Error throw");
		}
	});

	it("two providers with one id: the last wins and one warning names both", async () => {
		const second: DecisionProviderContribution = {
			id: "acme-judge",
			models: [{ id: "judge-2" }],
			evaluate: async () => validAnswers(),
		};
		const fixture = makeFixture({ secondContribution: second });
		expect(fixture.warnings.length).toBe(1);
		expect(fixture.warnings[0]).toContain("acme-ext");
		expect(fixture.warnings[0]).toContain("acme-ext-two");
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.model).toBe("acme-judge/judge-2");
		expect(fixture.registry.collisions()).toEqual([
			{ id: "acme-judge", winner: "acme-ext-two", losers: ["acme-ext"] },
		]);
	});

	it("usage defaults to nulls and elapsedMs comes from now", async () => {
		let tick = 1_000;
		const fixture = makeFixture({
			now: () => tick,
			evaluateImpl: async () => {
				tick += 7;
				return { answers: validAnswers().answers };
			},
		});
		const result = await fixture.registry.evaluate("acme-notes", validRequest(), {});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.usage).toEqual({ input_tokens: null, output_tokens: null });
			expect(result.elapsedMs).toBe(7);
		}
	});
});
