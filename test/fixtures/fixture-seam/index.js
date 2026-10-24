/**
 * Test-fixture extension for the seam host contract (the seam doc's
 * implementation).
 *
 * Plain JavaScript, no build step — the loader imports it directly. The
 * factory takes the HOST CONTEXT (arity-1): it declares one interaction
 * kind and one ambient key, and its `emit_interaction` tool seeds a real
 * interaction record through the seam; `set_ambient` writes an ambient
 * surface. Both tools return the seam's outcome so tests can assert.
 *
 * UI-blocks U6 Task 2: every record this fixture writes is a BLOCK TREE
 * (spec §9.1/§9.2 — legacy `text`/`options`/`fields`/`line`/`rows` bodies
 * are gone, ruling 16). The fixture owns its tree literals (tests own
 * their literals; the host-side builders in `@sigrun/sigrun/blocks` are
 * for EXTENSION authors — a fixture under the test runner resolves the
 * host package unreliably under parallel vitest workers, so literals keep
 * the fixture load deterministic; `BLOCK_SET_VERSION` comes from the
 * workspace-linked shared leaf, stable in every worker):
 *   - the interaction body is a root `form` with a `choice` (tones are
 *     the block tones: `good`, never the legacy `ok`);
 *   - the ambient body is a one-line `markdown` (place: status) or a
 *     `collection(list)` (place: panel).
 */

import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { BLOCK_SET_VERSION } from "@sigrun/shared/blocks";

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
					// Spec §9.1 mapping: `text` → `markdown`, `options[]` → a
					// `choice` field; tone `ok` → `good` (the tone renames).
					body: {
						v: BLOCK_SET_VERSION,
						root: {
							type: "form",
							id: "ask",
							bind: "/values",
							mode: "submit",
							children: [
								{ type: "markdown", text: args.prompt },
								{
									type: "choice",
									name: "decision",
									label: args.prompt,
									options: args.options.map((label, i) => ({
										id: `opt-${i}`,
										label,
										tone: i === 0 ? "good" : "neutral",
									})),
								},
							],
						},
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
			// Ruling 20: the answer is {values} — the chosen option under
			// the choice field's name.
			const applied = await host.answerInteraction(
				api.conversationId,
				args.callId,
				{ values: { decision: args.choice } },
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
			// Progress numbers present → a panel collection (spec §9.2's
			// mapping for `rows[]`; the item template binds the row slots);
			// otherwise a one-line status markdown (the `line {text}` mapping).
			const progress =
				args.done !== undefined && args.total !== undefined
					? { done: args.done, total: args.total }
					: undefined;
			const body =
				progress === undefined
					? { v: BLOCK_SET_VERSION, root: { type: "markdown", text: args.text } }
					: {
							v: BLOCK_SET_VERSION,
							root: {
								type: "collection",
								id: "progress",
								// Literal rows: ambient collections never bind (the
								// 2026-10-24 ruling — the envelope has no data slot).
								items: [
									{
										id: "progress",
										label: args.text,
										status: "running",
										running: true,
										completed: progress.done,
										total: progress.total,
									},
								],
								display: "list",
								item: {
									type: "card",
									title: "./label",
									status: { label: "./status", spinner: "./running" },
									metrics: [
										{ label: "steps", value: "./completed" },
										{ label: "of", value: "./total" },
									],
								},
							},
						};
			await host.setAmbient(
				api.conversationId,
				{
					key: "fixture.panel",
					place: progress === undefined ? "status" : "panel",
					maxRows: progress === undefined ? undefined : 5,
					body,
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
		interactionKinds: ["fixture.ask"],
		ambientKinds: ["fixture.panel"],
		extension: defineExtension({
			name: "sigrun-fixture-seam",
			tools: [emitInteraction, answerInteraction, setAmbient, clearAmbient],
		}),
	};
}
