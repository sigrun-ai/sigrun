/**
 * Warden Task 5: the decision-provider core — typebox schemas for the
 * decision wire shape, request/answer validators, and the pure
 * {@link buildDecisionRegistry} (fixture-testable; the loader/boot
 * wiring lands in Task 6). The wire TYPES live in
 * `@sigrun/shared/decisions`; the schemas live here because the shared
 * leaf is import-free.
 *
 * `evaluate` NEVER throws: every failure is a `DecisionResult`
 * `ok:false` with one of the spec's codes. Error text never carries the
 * credential (scrubbed) nor the submitted request.
 */

import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import type { Validator } from "typebox/compile";
import {
	DECISION_MAX_BYTES,
	DECISION_MAX_QUESTIONS,
	type DecisionAnswers,
	type DecisionLimits,
	type DecisionRequest,
	type DecisionResult,
} from "@sigrun/shared/decisions";
import type {
	DecisionProviderContribution,
	ProviderReadiness,
} from "../extension.js";
import type { SettingsFile } from "./settings.js";

// A strict-JSON value schema. `Type.Unknown()` leaves a node unchecked;
// depth/self-reference aren't expressible without a recursive builder the
// pi-ai Type mirror doesn't carry, so deep validation happens in
// `assertJsonValue` below (the wire contract is strict JSON).
const JsonValue: TSchema = Type.Unknown();

/** The depth/self-reference bound for {@link assertJsonValue}. */
const JSON_MAX_DEPTH = 64;

/**
 * Throw unless `value` is a strict-JSON value (finite numbers,
 * plain objects/arrays only). The typebox schema admits unknowns;
 * this pass keeps the wire contract strict.
 */
function assertJsonValue(value: unknown, path: string, depth: number): void {
	if (depth > JSON_MAX_DEPTH) {
		throw new Error(`${path}: JSON nesting exceeds ${JSON_MAX_DEPTH}`);
	}
	if (value === null || typeof value === "boolean" || typeof value === "string") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${path}: a number must be finite`);
		return;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) assertJsonValue(value[i], `${path}/${i}`, depth + 1);
		return;
	}
	if (typeof value === "object") {
		const proto = Object.getPrototypeOf(value);
		if (proto !== Object.prototype && proto !== null) {
			throw new Error(`${path}: not a plain JSON object`);
		}
		for (const [key, entry] of Object.entries(value)) {
			assertJsonValue(entry, `${path}/${key}`, depth + 1);
		}
		return;
	}
	throw new Error(`${path}: not a JSON value`);
}

const NoulQuestion = Type.Object({
	type: Type.Literal("noul"),
	instructions: Type.Optional(JsonValue),
	criteria: Type.Optional(
		Type.Union([
			Type.Object({
				true: Type.Optional(JsonValue),
				false: Type.Optional(JsonValue),
			}),
			Type.Null(),
		]),
	),
});

const ChoiceQuestion = Type.Object({
	type: Type.Literal("choice"),
	instructions: Type.Optional(JsonValue),
	criteria: Type.Record(Type.String(), Type.Union([JsonValue, Type.Null()])),
});

const ScoreQuestion = Type.Object({
	type: Type.Literal("score"),
	instructions: Type.Optional(JsonValue),
	criteria: Type.Array(JsonValue),
});

const DecisionQuestionSchema = Type.Union([NoulQuestion, ChoiceQuestion, ScoreQuestion]);

const DecisionRequestSchema = Type.Object({
	state: Type.Union([Type.String(), Type.Record(Type.String(), JsonValue), Type.Array(JsonValue)]),
	questions: Type.Record(Type.String(), DecisionQuestionSchema),
});

const Probability = Type.Number({ minimum: 0, maximum: 1 });

const DecisionAnswerSchema = Type.Union([
	Type.Object({ type: Type.Literal("noul"), noul: Probability }),
	Type.Object({
		type: Type.Literal("choice"),
		choice: Type.String(),
		confidence: Probability,
		probabilities: Type.Record(Type.String(), Probability),
	}),
	Type.Object({
		type: Type.Literal("score"),
		score: Type.Number(),
		confidence: Probability,
		probabilities: Type.Record(Type.String(), Probability),
		legend: Type.Optional(Type.Record(Type.String(), JsonValue)),
	}),
]);

const DecisionAnswersSchema = Type.Object({
	answers: Type.Record(Type.String(), DecisionAnswerSchema),
	usage: Type.Optional(
		Type.Object({
			input_tokens: Type.Union([Type.Integer(), Type.Null()]),
			output_tokens: Type.Union([Type.Integer(), Type.Null()]),
		}),
	),
	model: Type.Optional(Type.String()),
});

const requestValidator = Compile(DecisionRequestSchema);
const answersValidator = Compile(DecisionAnswersSchema);

export type DecisionRequestValidation =
	| { ok: true; request: DecisionRequest }
	| { ok: false; code: "invalid_request" | "over_limits"; errors: { path: string; message: string }[] };

function describeErrors(validator: Validator, value: unknown): { path: string; message: string }[] {
	const out: { path: string; message: string }[] = [];
	for (const err of validator.Errors(value)) {
		out.push({ path: err.instancePath, message: err.message ?? "invalid" });
	}
	return out.length > 0 ? out : [{ path: "", message: "invalid" }];
}

function questionEntries(value: unknown): [string, unknown][] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	const questions = (value as { questions?: unknown }).questions;
	if (typeof questions !== "object" || questions === null || Array.isArray(questions)) return [];
	return Object.entries(questions);
}

/**
 * Validate an unknown value as a {@link DecisionRequest}: schema shape
 * first (`invalid_request`, errors carry `instancePath`), then the
 * limits (`over_limits`) — the built-in caps, narrowed by the model's
 * declared `limits`.
 */
export function validateDecisionRequest(value: unknown, limits?: DecisionLimits): DecisionRequestValidation {
	if (!requestValidator.Check(value)) {
		return { ok: false, code: "invalid_request", errors: describeErrors(requestValidator, value) };
	}
	try {
		assertJsonValue((value as { state: unknown }).state, "/state", 0);
	} catch (err) {
		return { ok: false, code: "invalid_request", errors: [{ path: "/state", message: errorMessage(err) }] };
	}
	const request = value as DecisionRequest;

	const entries = questionEntries(value);
	for (const [key, question] of entries) {
		const q = questionOf(key, question);
		if (!q) {
			return {
				ok: false,
				code: "invalid_request",
				errors: [{ path: `/questions/${key}`, message: "unknown question type" }],
			};
		}
		const minChoiceOptions = limits?.minChoiceOptions ?? 1;
		if (q.type === "choice" && Object.keys(q.criteria).length < minChoiceOptions) {
			return {
				ok: false,
				code: "invalid_request",
				errors: [
					{
						path: `/questions/${key}/criteria`,
						message: `a choice needs at least ${minChoiceOptions} label${minChoiceOptions === 1 ? "" : "s"}`,
					},
				],
			};
		}
		const maxScore = limits?.maxScoreLevels ?? Number.POSITIVE_INFINITY;
		const minScore = 2;
		const levels = q.type === "score" ? q.criteria.length : minScore;
		if (q.type === "score" && (levels < minScore || levels > maxScore)) {
			return {
				ok: false,
				code: "invalid_request",
				errors: [
					{
						path: `/questions/${key}/criteria`,
						message:
							levels < minScore
								? "a score needs at least 2 levels"
								: `a score has ${levels} levels; the cap is ${maxScore}`,
					},
				],
			};
		}
	}

	const maxQuestions = Math.min(limits?.maxQuestions ?? DECISION_MAX_QUESTIONS, DECISION_MAX_QUESTIONS);
	if (entries.length < 1) {
		return {
			ok: false,
			code: "over_limits",
			errors: [{ path: "/questions", message: "a request needs at least 1 question" }],
		};
	}
	if (entries.length > maxQuestions) {
		return {
			ok: false,
			code: "over_limits",
			errors: [
				{ path: "/questions", message: `${entries.length} questions; the cap is ${maxQuestions}` },
			],
		};
	}

	const maxBytes = Math.min(limits?.maxInputBytes ?? DECISION_MAX_BYTES, DECISION_MAX_BYTES);
	const stateBytes = byteLength(JSON.stringify((value as { state: unknown }).state));
	if (stateBytes > maxBytes) {
		return {
			ok: false,
			code: "over_limits",
			errors: [
				{ path: "/state", message: `the state is ${stateBytes} bytes; the cap is ${maxBytes}` },
			],
		};
	}

	return { ok: true, request };
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function questionOf(_key: string, question: unknown):
	| { type: "noul" }
	| { type: "choice"; criteria: Record<string, unknown> }
	| { type: "score"; criteria: unknown[] }
	| undefined {
	if (typeof question !== "object" || question === null) return undefined;
	const q = question as { type?: unknown; criteria?: unknown };
	if (q.type === "noul") return { type: "noul" };
	if (q.type === "choice" && typeof q.criteria === "object" && q.criteria !== null && !Array.isArray(q.criteria)) {
		return { type: "choice", criteria: q.criteria as Record<string, unknown> };
	}
	if (q.type === "score" && Array.isArray(q.criteria)) {
		return { type: "score", criteria: q.criteria };
	}
	return undefined;
}

/**
 * Validate an unknown value as the {@link DecisionAnswers} for
 * `request`: the schema shape, then coverage — every question answered
 * with the matching type (probabilities are already range-checked by the
 * schema).
 */
export function validateDecisionAnswers(
	request: DecisionRequest,
	value: unknown,
): { ok: true; answers: DecisionAnswers } | { ok: false; error: string } {
	if (!answersValidator.Check(value)) {
		const first = describeErrors(answersValidator, value)[0];
		return { ok: false, error: `answers fail the wire schema at ${first?.path ?? ""}: ${first?.message ?? "invalid"}` };
	}
	const answers = value as DecisionAnswers;
	for (const [key, question] of Object.entries(request.questions) as [string, { type: string }][]) {
		const answer = answers.answers[key] as { type?: string } | undefined;
		if (answer === undefined) {
			return { ok: false, error: `missing an answer for question "${key}"` };
		}
		if (answer.type !== question.type) {
			return {
				ok: false,
				error: `question "${key}" is ${question.type} but its answer is ${answer.type}`,
			};
		}
	}
	return { ok: true, answers };
}

/** One loader declaration: a contribution plus its extension slug. */
export interface DecisionDeclaration {
	readonly extension: string;
	readonly contribution: DecisionProviderContribution;
}

export interface DecisionRegistry {
	evaluate(
		caller: string,
		request: unknown,
		opts: { model?: string; signal?: AbortSignal; timeoutMs?: number },
	): Promise<DecisionResult>;
	list(): readonly { model: string; provider: string; status: ProviderReadiness["status"] }[];
	providers(): readonly {
		id: string;
		label?: string;
		extension: string;
		models: readonly string[];
		status: ProviderReadiness["status"];
	}[];
	resolvedDefault(): string | undefined;
	collisions(): readonly { id: string; winner: string; losers: readonly string[] }[];
}

interface Entry {
	readonly declaration: DecisionDeclaration;
	readonly models: ReadonlyMap<string, DecisionProviderContribution["models"][number]>;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function readiness(contribution: DecisionProviderContribution): ProviderReadiness["status"] {
	try {
		return contribution.readiness?.().status ?? "ready";
	} catch {
		return "degraded";
	}
}

/**
 * Build the pure decision registry. Last-registered wins per provider id
 * (each loser warns once, naming both); `evaluate` resolves the model,
 * validates the request against the model's limits, resolves the
 * credential (core decides `not_configured` — never the tracker), runs
 * the provider under `min(timeoutMs, timeoutCapMs)` linked to the
 * caller's signal, and validates the answers. It never throws.
 */
export function buildDecisionRegistry(
	declarations: readonly DecisionDeclaration[],
	deps: {
		/** auth.json[id].apiKey, else the process env `env` ("" = unset). */
		credential(id: string, env: string | undefined): string | undefined;
		/** The live settings (decisionModel, server.decisions.timeoutMs). */
		readSettings(): SettingsFile;
		timeoutCapMs: number;
		now(): number;
		warn(message: string): void;
	},
): DecisionRegistry {
	// Last-registered wins per id (the chat-provider collision rule).
	const entries = new Map<string, Entry>();
	const collisionList: { id: string; winner: string; losers: string[] }[] = [];
	for (const declaration of declarations) {
		const id = declaration.contribution.id;
		const existing = entries.get(id);
		if (existing) {
			deps.warn(
				`decision provider "${id}": ${declaration.extension} wins over ${existing.declaration.extension} (last-registered wins)`,
			);
			const recorded = collisionList.find((c) => c.id === id);
			if (recorded) {
				recorded.losers.push(declaration.extension);
				recorded.winner = declaration.extension;
			} else {
				collisionList.push({
					id,
					winner: declaration.extension,
					losers: [existing.declaration.extension],
				});
			}
		}
		entries.set(id, {
			declaration,
			models: new Map(declaration.contribution.models.map((m) => [m.id, m])),
		});
	}

	function resolveModel(spec: string | undefined): { entry: Entry; modelId: string; full: string } | undefined {
		if (spec !== undefined) {
			const slash = spec.indexOf("/");
			if (slash < 0) return undefined;
			const providerId = spec.slice(0, slash);
			const modelId = spec.slice(slash + 1);
			const entry = entries.get(providerId);
			if (!entry || !entry.models.has(modelId)) return undefined;
			return { entry, modelId, full: `${providerId}/${modelId}` };
		}
		const first = entries.values().next().value;
		if (!first) return undefined;
		const firstModel = first.declaration.contribution.models[0];
		if (!firstModel) return undefined;
		return { entry: first, modelId: firstModel.id, full: `${first.declaration.contribution.id}/${firstModel.id}` };
	}

	function settingsTimeoutMs(): number {
		const decisions = (deps.readSettings() as { server?: { decisions?: { timeoutMs?: number } } }).server
			?.decisions;
		return decisions?.timeoutMs ?? deps.timeoutCapMs;
	}

	async function evaluate(
		caller: string,
		request: unknown,
		opts: { model?: string; signal?: AbortSignal; timeoutMs?: number },
	): Promise<DecisionResult> {
		// 1. Resolve the model: opts.model, else the live decisionModel
		//    setting, else the first model of the first-registered provider.
		const settings = deps.readSettings() as SettingsFile & { decisionModel?: string };
		const spec = opts.model ?? settings.decisionModel;
		if (spec === undefined && entries.size === 0) {
			return { ok: false, code: "no_model", error: "no decision provider is registered" };
		}
		const resolved = resolveModel(spec);
		if (!resolved) {
			return spec !== undefined
				? { ok: false, code: "unknown_model", error: `unknown decision model "${spec}"` }
				: { ok: false, code: "no_model", error: "no decision provider is registered" };
		}

		// 2. Validate the request against the model's declared limits.
		const modelInfo = resolved.entry.models.get(resolved.modelId);
		const validation = validateDecisionRequest(request, modelInfo?.limits);
		if (!validation.ok) {
			const first = validation.errors[0];
			return {
				ok: false,
				code: validation.code,
				error: `${validation.code} at ${first?.path ?? ""}: ${first?.message ?? "invalid"}`,
			};
		}

		// 3. Credential — core decides not_configured, never the tracker.
		const contribution = resolved.entry.declaration.contribution;
		const credential = deps.credential(contribution.id, contribution.credentialEnv);
		if (credential === undefined || credential === "") {
			return {
				ok: false,
				code: "not_configured",
				error: `no credential for decision provider "${contribution.id}"`,
			};
		}

		// 4. Run under min(timeoutMs, cap), linked to the caller's signal.
		const deadlineMs = Math.min(opts.timeoutMs ?? settingsTimeoutMs(), deps.timeoutCapMs);
		const controller = new AbortController();
		let timedOut = false;
		let callerAborted = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, deadlineMs);
		const onCallerAbort = () => {
			callerAborted = true;
			controller.abort();
		};
		opts.signal?.addEventListener("abort", onCallerAbort, { once: true });

		const started = deps.now();
		let value: DecisionAnswers;
		try {
			value = await contribution.evaluate(validation.request, {
				model: resolved.modelId,
				credential,
				signal: controller.signal,
				caller,
			});
		} catch (err) {
			const raw = errorMessage(err);
			const scrubbed = credential === "" ? raw : raw.replaceAll(credential, "[redacted]");
			if (timedOut) {
				return { ok: false, code: "timeout", error: `timed out after ${deadlineMs}ms` };
			}
			if (callerAborted) {
				return { ok: false, code: "aborted", error: "aborted by the caller" };
			}
			return { ok: false, code: "failed", error: scrubbed };
		} finally {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onCallerAbort);
		}
		if (timedOut) {
			return { ok: false, code: "timeout", error: `timed out after ${deadlineMs}ms` };
		}
		if (callerAborted) {
			return { ok: false, code: "aborted", error: "aborted by the caller" };
		}

		// 5. Validate the answers.
		const answersValidation = validateDecisionAnswers(validation.request, value);
		if (!answersValidation.ok) {
			return { ok: false, code: "bad_answer", error: answersValidation.error };
		}

		return {
			ok: true,
			model: resolved.full,
			answers: answersValidation.answers.answers,
			usage: {
				input_tokens: answersValidation.answers.usage?.input_tokens ?? null,
				output_tokens: answersValidation.answers.usage?.output_tokens ?? null,
			},
			elapsedMs: deps.now() - started,
		};
	}

	return {
		evaluate,
		list() {
			const out: { model: string; provider: string; status: ProviderReadiness["status"] }[] = [];
			for (const entry of entries.values()) {
				const contribution = entry.declaration.contribution;
				const status = readiness(contribution);
				for (const model of contribution.models) {
					out.push({ model: `${contribution.id}/${model.id}`, provider: contribution.id, status });
				}
			}
			return out;
		},
		providers() {
			return [...entries.values()].map((entry) => ({
				id: entry.declaration.contribution.id,
				label: entry.declaration.contribution.label,
				extension: entry.declaration.extension,
				models: entry.declaration.contribution.models.map((m) => m.id),
				status: readiness(entry.declaration.contribution),
			}));
		},
		resolvedDefault() {
			const settings = deps.readSettings() as SettingsFile & { decisionModel?: string };
			if (settings.decisionModel !== undefined) return settings.decisionModel;
			const first = entries.values().next().value;
			const firstModel = first?.declaration.contribution.models[0];
			return first && firstModel ? `${first.declaration.contribution.id}/${firstModel.id}` : undefined;
		},
		collisions() {
			return collisionList;
		},
	};
}
