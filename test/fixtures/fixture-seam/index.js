/**
 * Test-fixture extension for the seam host contract (docs/approval-ux-
 * seams.md implementation).
 *
 * Plain JavaScript, no build step — the loader imports it directly. The
 * factory takes the HOST CONTEXT (arity-1): it declares one interaction
 * kind and one ambient key, and its `emit_interaction` tool seeds a real
 * interaction record through the seam; `set_ambient` writes an ambient
 * surface. Both tools return the seam's outcome so tests can assert.
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

/**
 * @param host {{ seedInteraction: Function, answerInteraction: Function,
 *   snapshotInteraction: Function, setAmbient: Function, clearAmbient: Function }}
 *   the sigrun seam host (src/harness/seam-host.ts) — required here so the
 *   fixture exercises the arity-1 contract end to end.
 */
export default function createSeamFixture(host) {
	if (host === undefined) {
		throw new Error("seam fixture requires the host context");
	}
	// Stash the received host: the loader's identity test asserts the
	// instance the factory captured is the SAME instance boot's seamHosts
	// map holds (re-key mutates in place — never a second host).
	globalThis.__fixtureSeamHost = host;

	const emitInteraction = defineTool({
		name: "emit_interaction",
		description: "Seeds an interaction record through the seam host.",
		parameters: Type.Object({
			prompt: Type.String({ description: "The prompt text." }),
			options: Type.Array(Type.String(), { description: "Option labels." }),
		}),
		async execute(args, api, context) {
			const callId = `fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			await host.seedInteraction(
				api.conversationId,
				{
					kind: "fixture.ask",
					callId,
					status: "pending",
					createdAt: Date.now(),
					body: {
						text: args.prompt,
						options: args.options.map((label, i) => ({
							id: `opt-${i}`,
							label,
							tone: i === 0 ? "ok" : "neutral",
						})),
					},
				},
				context,
			);
			// Leave the record pending; the route answers it.
			return { callId };
		},
	});

	const answerInteraction = defineTool({
		name: "fixture_answer",
		description: "Answers a pending interaction from the extension side.",
		parameters: Type.Object({
			callId: Type.String({ description: "The pending interaction's id." }),
			choice: Type.String({ description: "Chosen option id." }),
		}),
		async execute(args, api, context) {
			const applied = await host.answerInteraction(
				api.conversationId,
				args.callId,
				{ ids: [args.choice] },
				context,
			);
			return { applied };
		},
	});

	const setAmbient = defineTool({
		name: "set_ambient",
		description: "Writes an ambient surface through the seam host.",
		parameters: Type.Object({
			text: Type.String({ description: "The statusline text." }),
			done: Type.Optional(Type.Number({ description: "Completed count." })),
			total: Type.Optional(Type.Number({ description: "Total count." })),
		}),
		async execute(args, api, context) {
			await host.setAmbient(
				api.conversationId,
				{
					key: "fixture.panel",
					place: "status",
					body: {
						line: {
							text: args.text,
							segments: [{ id: "main", text: args.text, place: "left" }],
						},
						...(args.done !== undefined && args.total !== undefined
							? {
									rows: [
										{
											id: "progress",
											label: "steps",
											status: "running",
											metrics: {
												completed: args.done,
												total: args.total,
												format: "compact",
											},
										},
									],
								}
							: {}),
					},
				},
				context,
			);
			return { written: true };
		},
	});

	const clearAmbient = defineTool({
		name: "clear_ambient",
		description: "Clears the fixture ambient surface.",
		parameters: Type.Object({}),
		async execute(_args, api, context) {
			await host.clearAmbient(api.conversationId, "fixture.panel", context);
			return { cleared: true };
		},
	});

	return {
		// The kinds declarations the loader validates and /v1/meta inventories.
		interactionKinds: ["fixture.ask"],
		ambientKinds: ["fixture.panel"],
		extension: defineExtension({
			name: "sigrun.fixture-seam",
			tools: [emitInteraction, answerInteraction, setAmbient, clearAmbient],
		}),
	};
}
