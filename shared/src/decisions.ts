/**
 * The decision-provider wire types (the decision-providers spec): a
 * provider TYPE whose models answer typed questions (noul / choice /
 * score) over a JSON state, for extensions that need small structured
 * judgments rather than a chat completion.
 *
 * TYPE-ONLY module, with NO imports at all: `JsonValue`/`JsonObject` are
 * declared locally exactly the way `shared/src/json.ts` mirrors them, so
 * the shared leaf keeps its zero-import invariant (enforced by
 * test/views-purity.test.ts). The two `DECISION_MAX_*` constants are
 * pure VALUES — wire modules carry "types + pure constants".
 */

/** A strict-JSON value (local mirror — see shared/src/json.ts). */
export type DecisionJsonValue =
	| null
	| boolean
	| number
	| string
	| DecisionJsonValue[]
	| { [key: string]: DecisionJsonValue };

/** A strict-JSON object (local mirror — see shared/src/json.ts). */
export type DecisionJsonObject = { [key: string]: DecisionJsonValue };

/** The state a decision question is asked over: a string or strict JSON. */
export type DecisionState = string | DecisionJsonObject | DecisionJsonValue[];

/** One typed question. Choice needs at least one label; score at least two levels. */
export type DecisionQuestion =
	| {
			readonly type: "noul";
			readonly instructions?: DecisionJsonValue;
			readonly criteria?: { readonly true?: DecisionJsonValue; readonly false?: DecisionJsonValue } | null;
	  }
	| {
			readonly type: "choice";
			readonly instructions?: DecisionJsonValue;
			readonly criteria: Readonly<Record<string, DecisionJsonValue | null>>;
	  }
	| {
			readonly type: "score";
			readonly instructions?: DecisionJsonValue;
			readonly criteria: readonly DecisionJsonValue[];
	  };

/** One evaluation: a state plus 1..32 typed questions. */
export interface DecisionRequest {
	readonly state: DecisionState;
	readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

/** One answer, matching its question's type; probabilities are in [0, 1]. */
export type DecisionAnswer =
	| { readonly type: "noul"; readonly noul: number }
	| {
			readonly type: "choice";
			readonly choice: string;
			readonly confidence: number;
			readonly probabilities: Readonly<Record<string, number>>;
	  }
	| {
			readonly type: "score";
			readonly score: number;
			readonly confidence: number;
			readonly probabilities: Readonly<Record<string, number>>;
			readonly legend?: Readonly<Record<string, DecisionJsonValue>>;
	  };

/** The provider's answer set plus optional usage bookkeeping. */
export interface DecisionAnswers {
	readonly answers: Readonly<Record<string, DecisionAnswer>>;
	readonly usage?: {
		readonly input_tokens: number | null;
		readonly output_tokens: number | null;
	};
	readonly model?: string;
}

/** The outcome of one `evaluate` call; NEVER a throw. */
export type DecisionResult =
	| {
			readonly ok: true;
			readonly model: string;
			readonly answers: Readonly<Record<string, DecisionAnswer>>;
			readonly usage: {
				readonly input_tokens: number | null;
				readonly output_tokens: number | null;
			};
			readonly elapsedMs: number;
	  }
	| {
			readonly ok: false;
			readonly code:
				| "no_model"
				| "unknown_model"
				| "invalid_request"
				| "over_limits"
				| "not_configured"
				| "timeout"
				| "aborted"
				| "failed"
				| "bad_answer";
			readonly error: string;
	  };

/** A model's declared limits (narrower than the built-in caps win). */
export interface DecisionLimits {
	readonly maxQuestions?: number;
	readonly maxInputBytes?: number;
	readonly minChoiceOptions?: number;
	readonly maxScoreLevels?: number;
}

/** Built-in cap: at most this many questions per request. */
export const DECISION_MAX_QUESTIONS = 32;

/** Built-in cap: the JSON state serialized size, in bytes. */
export const DECISION_MAX_BYTES = 65_536;
