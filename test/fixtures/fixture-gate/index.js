/**
 * Test-fixture gate extension (core hardening, task-3): the IN-REPO
 * replacement for the retired sibling-checkout approvals dependency the
 * decide round-trip used to import.
 *
 * Plain JavaScript, no build step — the loader imports it directly via
 * its file URL. The factory takes the HOST CONTEXT (arity-1): it
 * declares one interaction kind and installs TWO pieces:
 *
 *   - `guarded_write`, the GATED TOOL (its execute writes the marker
 *     `guarded-write-executed` into the tool result — the observable
 *     the tests assert: present after allow, absent after deny), and
 *   - a `beforeTool` hook that holds EVERY call to `guarded_write` by
 *     seeding a pending interaction record through the seam host
 *     (today's interaction format: a `text` + `options` body with
 *     allow/deny ids), then long-polls the record until a channel
 *     answers it through the generic answer route. Resolution
 *     semantics are the fixture's own: `allow` returns undefined (the
 *     tool runs); `deny` returns a `{ block }` refusal (the tool never
 *     executes and the refusal rides the tool result).
 *
 * Seeding through the host seam (seedInteraction/snapshotInteraction)
 * is the sanctioned hook-adjacent write path — the hook itself cannot
 * commit through HookApi, and the seam host's commit lands on the
 * Session mutation line like every other interaction write. The poll
 * sleeps cancellation-safely (awaitWithContext) so abort/close unwinds
 * the held call.
 */

import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { awaitWithContext } from "@earendil-works/chord/context";

/** The marker the guarded tool's execute writes into its result. */
export const GUARDED_MARKER = "guarded-write-executed";

/** The interaction kind this fixture declares (the seam's write gate). */
const GATE_KIND = "gate.ask";

/** How long the hook sleeps between record polls (pi-durable hook shape). */
const POLL_MS = 25;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param host {{ seedInteraction: Function, snapshotInteraction: Function }}
 *   the sigrun seam host (src/harness/seam-host.ts) — required so the
 *   fixture seeds and reads interaction records through the same seam
 *   the server routes serve.
 */
export default function createGateFixture(host) {
	if (host === undefined) {
		throw new Error("gate fixture requires the host context");
	}

	const guardedWrite = defineTool({
		name: "guarded_write",
		description: "Gated test tool: held until the seeded interaction is answered.",
		parameters: Type.Object({
			path: Type.String({ description: "Path the tool pretends to write." }),
		}),
		async execute(args) {
			// pi-durable 1.2.0 tool-result contract: `output` content blocks.
			return {
				output: [
					{ type: "text", text: `${GUARDED_MARKER}:${args.path}` },
				],
			};
		},
	});

	async function beforeTool(call, api, context) {
		if (call.name !== "guarded_write") return undefined;

		// Seed (idempotently: a re-entered hook after a crash re-reads the
		// same callId-keyed record — first-write-wins inside the commit) and
		// then long-poll until a channel answers.
		await host.seedInteraction(
			api.conversationId,
			{
				kind: GATE_KIND,
				callId: call.id,
				status: "pending",
				createdAt: Date.now(),
				body: {
					text: `Allow the gated tool call ${call.name}?`,
					options: [
						{ id: "allow", label: "Allow", tone: "ok" },
						{ id: "deny", label: "Deny", tone: "danger" },
					],
				},
				details: {
					toolName: call.name,
					arguments: call.arguments,
				},
			},
			context,
		);
		for (;;) {
			const record = await host.snapshotInteraction(
				api.conversationId,
				call.id,
				context,
			);
			if (record?.status === "answered") {
				const ids = record.answer?.ids ?? [];
				if (ids.includes("allow")) return undefined; // the tool runs
				return { block: "denied by the answering user" }; // refusal
			}
			// Cancellation-safe sleep: rejects this waiter on abort/close.
			await awaitWithContext(sleep(POLL_MS), context);
		}
	}

	return {
		// The kinds declaration the loader validates and /v1/meta inventories.
		interactionKinds: [GATE_KIND],
		extension: defineExtension({
			name: "sigrun-fixture-gate",
			tools: [guardedWrite],
			hooks: [hook(ToolTask, { beforeTool })],
		}),
	};
}
