/**
 * Per-model-family prompt guidance (system-prompt spec §Design, model
 * table): an ordered, first-match-wins table of name patterns with tool /
 * execution guidance, plus the extension that renders each field as its
 * own prompt section.
 *
 * Section renderers have no access to the `Models` catalog (`Agent` carries
 * no `models` field), so the matcher keys off the resolved
 * `${provider}/${modelId}` string alone — case-insensitive substring,
 * first hit wins, `undefined` when nothing matches. `MODEL_GUIDANCE` match
 * strings are lowercase by convention: matching lowercases the joined ref
 * but not the table.
 *
 * The two fields are separate section keys (`tool-guidance`,
 * `execution-guidance`) rather than one guidance blob so a matched→matched
 * model swap that changes only one dimension patches by value — a few
 * lines re-emitted instead of the whole blob. Both render `undefined` (the
 * section is omitted from the request) for an unmatched model or an
 * unset `agent.model`; that is the designed empty case, not an error.
 *
 * Boot installs this extension LAST, after `loadExtensions` and the memory
 * section (Task 3): guidance sections appear and disappear with the
 * matched model, and trailing placement keeps those transitions minimal
 * patches instead of full prompt re-emits.
 */

import { defineExtension, section } from "@earendil-works/pi-durable";
import type { ModelRef, PromptInput } from "@earendil-works/pi-durable";

/** One family's guidance; each field backs its own prompt section. */
export interface ModelGuidance {
	readonly tool?: string;
	readonly execution?: string;
}

/**
 * Ordered guidance table: first matching entry wins. Seeded conservative —
 * the mechanism is the deliverable; entries accumulate with operational
 * experience.
 */
export const MODEL_GUIDANCE: readonly {
	readonly match: string;
	readonly guidance: ModelGuidance;
}[] = [
	// Reasoning family: spend the thinking on planning and verification.
	{
		match: "kimi",
		guidance: {
			execution:
				"Think through the full plan before acting; verify the result before finalizing.",
		},
	},
	// Reasoning family: spend the thinking on planning and verification.
	{
		match: "deepseek",
		guidance: {
			execution:
				"Think through the full plan before acting; verify the result before finalizing.",
		},
	},
	// Known under-caller family: prefer checking over recollecting.
	{
		match: "qwen",
		guidance: {
			tool: "Prefer your tools over recollection when the answer is checkable on disk or in the environment.",
		},
	},
];

/**
 * Resolve the first table entry whose pattern is a substring of the
 * lowercased `${provider}/${modelId}`, or `undefined` when the ref is
 * unset or nothing matches.
 */
export function matchGuidance(
	modelRef: ModelRef | undefined,
): ModelGuidance | undefined {
	if (modelRef === undefined) return undefined;
	const key = `${modelRef.provider}/${modelRef.modelId}`.toLowerCase();
	return MODEL_GUIDANCE.find((entry) => key.includes(entry.match))?.guidance;
}

/**
 * The model-guidance extension: `tool-guidance` and `execution-guidance`
 * sections keyed on the request's resolved model, each rendering the
 * matched entry's field or `undefined` (absent section).
 */
export const modelGuidanceExtension = defineExtension({
	name: "sigrun.model-guidance",
	sections: [
		section(
			"tool-guidance",
			(input: PromptInput) => matchGuidance(input.agent.model)?.tool,
		),
		section(
			"execution-guidance",
			(input: PromptInput) => matchGuidance(input.agent.model)?.execution,
		),
	],
});
