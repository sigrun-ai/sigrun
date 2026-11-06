/**
 * Warden Task 7: the core-owned `decision_evaluate` tool. The
 * `sigrun.decisions` extension installs it when the boot-built registry
 * lists ≥ 1 decision model — a no-provider boot carries no tool (the
 * model is never offered a tool that can only refuse).
 *
 * Boot ordering: the registry builds AFTER the loader runs, while core
 * extensions install BEFORE it. The extension therefore installs with
 * an empty tool list (the placeholder), and boot RE-INSTALLS it with
 * the tool once the registry exists (`registry.install` replaces a
 * same-name extension in place) — the same late-fill seam the skills
 * extension's collected-roots array uses, one level up.
 *
 * The execution reads `decisions.tool` from the LIVE settings per call
 * (a settings write flips the tool without a restart) and evaluates
 * through the boot-built registry with the core caller stamp `"sigrun"`.
 * The result returns as JSON text for the model AND as
 * `structuredOutput` under the declared schema (pi-durable rejects
 * structuredOutput without one).
 */

import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { DecisionResult } from "@sigrun/shared/decisions";
import { validateDecisionRequest, type DecisionRegistry } from "./decisions.js";

/** The core extension's reserved slug (boot.ts keeps the core slugs). */
export const DECISIONS_EXTENSION_NAME = "sigrun.decisions";

/** The tool's disabled refusal (the exact text the brief pins). */
export const DECISION_TOOL_DISABLED =
	"decision_evaluate is disabled; set decisions.tool to true";

/** The settings read the tool's enabled gate consults per execution. */
export interface DecisionToolSettings {
	read(): { decisions?: { tool?: boolean } };
}

function decisionError(message: string): ToolExecutionResult {
	return { output: [{ type: "text", text: message }], isError: true };
}

/**
 * The `decision_evaluate` tool registration, built against the LIVE
 * slots: the boot-built registry and the settings store (the read is
 * per execution, so `decisions.tool` and `decisionModel` apply without
 * a restart).
 */
export function buildDecisionEvaluateTool(deps: {
	decisions: DecisionRegistry;
	settings: DecisionToolSettings;
}) {
	return defineTool({
		name: "decision_evaluate",
		description:
			"Small structured judgments over a state: one judgment per question, answered by a " +
			"dedicated decision model. Every question is a `noul` (a probability), a `choice` over " +
			"labels, or a `score` over ordered levels — include a no-match option (for example " +
			"\"none of the above\") in every choice so the judge is never forced.",
		parameters: Type.Object({
			state: Type.Union([Type.String(), Type.Unknown()], {
				description: "The state the judgments run over (a string or any strict-JSON value).",
			}),
			questions: Type.Record(Type.String(), Type.Unknown(), {
				description: "Question key → the question ({type, instructions?, criteria}).",
			}),
			model: Type.Optional(
				Type.String({
					description:
						"A decision model as `provider/model`; the default resolves from settings.",
				}),
			),
		}),
		structuredOutputSchema: Type.Object(
			{ ok: Type.Boolean() },
			{ additionalProperties: true },
		),
		async execute(args): Promise<ToolExecutionResult> {
			const enabled = deps.settings.read().decisions?.tool === true;
			if (!enabled) {
				return decisionError(DECISION_TOOL_DISABLED);
			}
			// Validate the shape BEFORE the registry (the registry validates
			// again against the resolved model's limits — this keeps the
			// refusal vocabulary identical for every caller).
			const validation = validateDecisionRequest(args);
			const model = typeof args.model === "string" ? args.model : undefined;
			const result: DecisionResult = validation.ok
				? await deps.decisions.evaluate("sigrun", validation.request, {
						...(model === undefined ? {} : { model }),
					})
				: {
						ok: false,
						code: validation.code,
						error: `${validation.code} at ${validation.errors[0]?.path ?? ""}: ${validation.errors[0]?.message ?? "invalid"}`,
					};
			return {
				output: [{ type: "text", text: JSON.stringify(result) }],
				structuredOutput: result,
			};
		},
	});
}

/**
 * The `sigrun.decisions` core extension. `tools` empty = the boot-time
 * placeholder (a no-provider boot KEEPS the placeholder — no tool);
 * boot re-installs with `buildDecisionEvaluateTool` once the registry
 * lists ≥ 1 decision model.
 */
export function createDecisionsExtension(
	tools: readonly ReturnType<typeof buildDecisionEvaluateTool>[] = [],
) {
	return defineExtension({
		name: DECISIONS_EXTENSION_NAME,
		tools: [...tools],
	});
}
