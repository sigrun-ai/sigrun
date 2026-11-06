/**
 * Test-fixture extension package (warden Task 16): the warden e2e's
 * fake media server + fake judge in ONE package. It contributes:
 *
 *   (a) the published hook `mcp.tool-annotations` — answering
 *       `{server:"acme-media", mcpName, annotations:{destructiveHint:true}}`
 *       for `acme-media/torrents_remove`, `{unknown:true}` otherwise;
 *   (b) the MCP-style tool `acme-media/torrents_remove` (whose execute
 *       marks a call module-side — the observable the allow assertions
 *       read);
 *   (c) a `decisionProviders` contribution `acme-judge` with model
 *       `judge-1`: every `evaluate` records the request module-side and
 *       answers from a module-side results queue (`responses`; the last
 *       entry repeats). The warden's judge reads `answers` keys off the
 *       request's question names (e.g. `clear_ask`, `t0_meets`).
 *
 * Plain JavaScript so `import(specifier)` resolves it directly (the
 * fixture-hook-provider pattern: the loader and the test import the
 * SAME file:// URL, one module instance).
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

/** Every judge `evaluate` call: the raw request the warden sent. */
export const calls = [];

/** The judge answers, consumed in order; the last one repeats. */
export const responses = [];

/** Every `acme-media/torrents_remove` execution: `{ids}`. */
export const toolRuns = [];

/** Reset every module-side record (tests own their fixtures' state). */
export function resetWardenE2e() {
	calls.length = 0;
	responses.length = 0;
	toolRuns.length = 0;
}

/** A schema-valid answers bag for the request's question names. */
function answersFor(request) {
	const next =
		responses.length > 1 ? responses.shift() : responses[0];
	if (next === undefined) {
		// No scripted answer: a HIGH clear-ask/meets, LOW escalate —
		// "allow" defaults so a mis-queued test fails at its own
		// assertion, not at a silent hold.
		const answers = {};
		for (const key of Object.keys(request.questions ?? {})) {
			const score = /escalate/.test(key) ? 0.1 : 0.9;
			answers[key] = { type: "noul", noul: score };
		}
		return { answers };
	}
	return next;
}

export default function createFixtureWardenE2e() {
	return {
		name: "acme-media",
		extension: defineExtension({
			name: "acme-media",
			tools: [
				defineTool({
					name: "acme-media/torrents_remove",
					description: "Remove torrents by id (fixture).",
					parameters: Type.Object({
						ids: Type.Array(Type.Number()),
					}),
					async execute(args) {
						toolRuns.push({ ids: [...args.ids] });
						return {
							output: [
								{ type: "text", text: `removed ${args.ids.join(",")}` },
							],
						};
					},
				}),
			],
		}),
		publishedHooks: [
			{
				name: "mcp.tool-annotations",
				description: "annotations for the fixture media tools",
				input: Type.Object({ tool: Type.String() }),
				output: Type.Object({
					server: Type.Optional(Type.String()),
					mcpName: Type.Optional(Type.String()),
					annotations: Type.Optional(
						Type.Object({ destructiveHint: Type.Optional(Type.Boolean()) }),
					),
					unknown: Type.Optional(Type.Boolean()),
				}),
				async run(payload) {
					if (payload.tool === "acme-media/torrents_remove") {
						return {
							server: "acme-media",
							mcpName: "torrents_remove",
							annotations: { destructiveHint: true },
						};
					}
					return { unknown: true };
				},
			},
		],
		decisionProviders: [
			{
				id: "acme-judge",
				label: "Acme Judge",
				credentialEnv: "ACME_JUDGE_API_KEY",
				models: [{ id: "judge-1" }],
				async evaluate(request) {
					calls.push({ request });
					return answersFor(request);
				},
			},
		],
	};
}
