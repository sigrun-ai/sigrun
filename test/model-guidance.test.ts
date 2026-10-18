/**
 * Per-model-family prompt guidance (system-prompt spec §Design, model
 * table + keying): `MODEL_GUIDANCE` is an ordered first-match-wins table
 * keyed off the resolved `provider/model-id` string (section renderers
 * have no `Models` catalog access, so matching is name-substring only).
 * The extension's two sections render the matched entry's `tool` /
 * `execution` field or `undefined` — absent sections are the designed
 * empty case for unmatched models.
 */

import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ModelRef, PromptInput } from "@earendil-works/pi-durable";
import {
	matchGuidance,
	MODEL_GUIDANCE,
	modelGuidanceExtension,
} from "../src/harness/sections/model-guidance.js";

/**
 * The `PromptInput` the guidance sections read: only `agent.model` matters
 * here. The remaining fields are stubbed the same way the context-file
 * section tests stub them — a full `Agent` is not needed to test table
 * matching.
 */
function promptInput(model: ModelRef | undefined): PromptInput {
	return {
		conversationId: ROOT_CONVERSATION_ID,
		agent: { model } as never,
		env: undefined,
		shown: {},
		read: null as never,
	};
}

/** Look up one section of the extension by key. */
function sectionByKey(key: string) {
	const found = modelGuidanceExtension.sections?.find(
		(section) => section.key === key,
	);
	if (found === undefined) throw new Error(`no section keyed ${key}`);
	return found;
}

test("the extension ships exactly the two guidance sections in pinned order", () => {
	// Order is the load-bearing part: guidance sections must be appendable
	// last (spec placement rule), and the extension's declared section order
	// is the registry install order.
	expect(modelGuidanceExtension.name).toBe("sigrun.model-guidance");
	expect(
		modelGuidanceExtension.sections?.map((section) => section.key),
	).toEqual(["tool-guidance", "execution-guidance"]);
});

test("first match wins", () => {
	// MODEL_GUIDANCE order: a ref matching two entries resolves the earlier
	// one. Proven pairwise (reference identity, not deep equality — two
	// entries may carry equal guidance text) and for a modelId containing
	// every match pattern at once.
	for (let i = 0; i < MODEL_GUIDANCE.length; i += 1) {
		for (let j = i + 1; j < MODEL_GUIDANCE.length; j += 1) {
			const modelId = `${MODEL_GUIDANCE[i].match}-${MODEL_GUIDANCE[j].match}`;
			expect(matchGuidance({ provider: "acme", modelId })).toBe(
				MODEL_GUIDANCE[i].guidance,
			);
		}
	}
	const all = MODEL_GUIDANCE.map((entry) => entry.match).join("-");
	expect(matchGuidance({ provider: "acme", modelId: all })).toBe(
		MODEL_GUIDANCE[0].guidance,
	);
});

test("matching is case-insensitive substring on provider/modelId", () => {
	// The joined `${provider}/${modelId}` is normalized to lowercase before
	// substring matching; either half of the ref can carry the pattern.
	expect(matchGuidance({ provider: "Bifrost", modelId: "Kimi-K3" })).toBe(
		MODEL_GUIDANCE[0].guidance,
	);
	expect(
		matchGuidance({ provider: "acme", modelId: "DeepSeek-V4.1-Flash" }),
	).toBeDefined();
	expect(
		matchGuidance({ provider: "ACME-Qwen-Host", modelId: "some-model" }),
	).toBeDefined();
});

test("no match returns undefined (absent sections)", () => {
	expect(
		matchGuidance({ provider: "acme", modelId: "unmatched-1" }),
	).toBeUndefined();
});

test("undefined model yields undefined (defensive; upstream no_model gates first)", () => {
	// A section renderer may still see `agent.model === undefined` if the
	// harness ever renders without a resolved model; the matcher is total.
	expect(matchGuidance(undefined)).toBeUndefined();
});

test("sections render undefined when unmatched, the guidance text when matched", async () => {
	const toolGuidance = sectionByKey("tool-guidance");
	const executionGuidance = sectionByKey("execution-guidance");

	// Matched (kimi): execution guidance present verbatim, tool guidance
	// absent — kimi's entry carries no `tool` field.
	const kimi = matchGuidance({ provider: "acme", modelId: "kimi-k3" });
	expect(kimi).toBeDefined();
	expect(
		await executionGuidance.render(
			promptInput({ provider: "acme", modelId: "kimi-k3" }),
			BACKGROUND_CONTEXT,
		),
	).toBe(kimi?.execution);
	expect(
		await toolGuidance.render(
			promptInput({ provider: "acme", modelId: "kimi-k3" }),
			BACKGROUND_CONTEXT,
		),
	).toBeUndefined();

	// Matched (qwen): tool guidance present, execution guidance absent.
	const qwen = matchGuidance({ provider: "acme", modelId: "qwen3.8" });
	expect(qwen).toBeDefined();
	expect(
		await toolGuidance.render(
			promptInput({ provider: "acme", modelId: "qwen3.8" }),
			BACKGROUND_CONTEXT,
		),
	).toBe(qwen?.tool);
	expect(
		await executionGuidance.render(
			promptInput({ provider: "acme", modelId: "qwen3.8" }),
			BACKGROUND_CONTEXT,
		),
	).toBeUndefined();

	// Unmatched: both sections absent (render → undefined), never an error.
	const unmatched = promptInput({ provider: "acme", modelId: "unmatched-1" });
	expect(await toolGuidance.render(unmatched, BACKGROUND_CONTEXT)).toBeUndefined();
	expect(
		await executionGuidance.render(unmatched, BACKGROUND_CONTEXT),
	).toBeUndefined();

	// No resolved model: same absent-sections result.
	const noModel = promptInput(undefined);
	expect(await toolGuidance.render(noModel, BACKGROUND_CONTEXT)).toBeUndefined();
	expect(
		await executionGuidance.render(noModel, BACKGROUND_CONTEXT),
	).toBeUndefined();
});
