/**
 * Test-fixture extension package (publish prep 2.1): the approvals-surface
 * stand-in for the real `sigrun-ext-approvals` package — the repo no longer
 * pins the personal git+ssh package, so this fixture mirrors its contract and
 * semantics: the same loader-install name (`sigrun.approvals`), the same doc
 * kinds, the same conservative default policy, the same long-poll gate, and
 * the same factory-result `approvals` capability (listPending view-join +
 * boolean decide) the sigrun core's §5 approvals routes call through.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly — the same
 * dynamic-import path the loader uses for installed packages. Contract: the
 * default export is a factory returning `{ extension, approvals }`.
 *
 * Mirrors: ~/repos/sigrun-ext-approvals/src/approvals.ts (keep the two in
 * lockstep when the real package's semantics change).
 */

import { awaitWithContext } from "@earendil-works/chord/context";
import {
	defineDoc,
	defineDocFamily,
	defineExtension,
	defineTool,
	hook,
	ToolTask,
} from "@earendil-works/pi-durable";

/** The conservative default policy: common read-only tools pass, rest gate. */
export const DEFAULT_APPROVAL_POLICY = {
	readOnlyTools: [
		"read",
		"read_file",
		"list",
		"list_dir",
		"ls",
		"grep",
		"search",
		"glob",
		"find",
		"memory_recall",
		"recall",
		"decide_approval",
	],
	gateWrites: true,
};

/** The per-conversation policy document (latest-only singleton). */
export const ApprovalsPolicyDoc = defineDoc({
	kind: "sigrun.approvals.policy",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({
		...DEFAULT_APPROVAL_POLICY,
		readOnlyTools: [...DEFAULT_APPROVAL_POLICY.readOnlyTools],
	}),
});

/** The pending/decided approval records, one per gated tool call. */
export const ApprovalsDoc = defineDocFamily({
	kind: "sigrun.approvals.approval",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	family: true,
	initial: (callId) => ({
		callId,
		toolName: "",
		arguments: {},
		status: "pending",
		requestedAt: 0,
	}),
});

/** How long the gate hook sleeps between decision-doc polls. */
const POLL_MS = 25;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether `toolName` is gated under `policy` (mirrors the real package). */
export function isGated(toolName, policy) {
	if (!policy.gateWrites) return false;
	return !policy.readOnlyTools.includes(toolName);
}

/** Read the conversation's LiveDoc tool slots structurally (fail-soft). */
function liveToolSlots(view) {
	const live = view.docs["pi.live"];
	if (typeof live !== "object" || live === null) return [];
	const tools = live.tools;
	if (!Array.isArray(tools)) return [];
	const slots = [];
	for (const candidate of tools) {
		if (
			typeof candidate === "object" &&
			candidate !== null &&
			typeof candidate.callId === "string" &&
			typeof candidate.name === "string" &&
			typeof candidate.status === "string"
		) {
			slots.push(candidate);
		}
	}
	return slots;
}

/** Default export: factory returning the extension + the approvals capability. */
export default function createFixtureApprovals() {
	async function beforeTool(call, api, context) {
		const policy =
			(await api.snapshot(ApprovalsPolicyDoc, api.conversationId, context)) ??
			DEFAULT_APPROVAL_POLICY;
		if (!isGated(call.name, policy)) return undefined;

		// Long-poll the decision doc until decided or cancelled (mirrors the
		// real gate: the hook never returns pending, so abort must auto-deny).
		for (;;) {
			const record = await api.snapshot(
				ApprovalsDoc,
				api.conversationId,
				call.id,
				context,
			);
			if (record?.status === "allow") return undefined;
			if (record?.status === "deny") {
				return { block: record.reason ?? "denied" };
			}
			// Crash-idempotent pending seeding (first-write-wins memo), so a
			// resumed conversation still carries the pending record.
			const seedMarker = `sigrun.approvals.seeded:${call.id}`;
			const seeded = await api.memo(seedMarker, context);
			if (seeded === undefined) {
				await api.memo(seedMarker, { seeded: true }, context);
			}
			await awaitWithContext(sleep(POLL_MS), context);
		}
	}

	async function listPending(harness, root, context) {
		const state = await root.viewState(context);
		const view = state.value;
		await state.dispose();
		const slots = liveToolSlots(view).filter(
			(slot) => slot.status === "pending" || slot.status === "running",
		);
		if (slots.length === 0) return [];
		const policy =
			(await harness.snapshot(ApprovalsPolicyDoc, root.id, context)) ??
			DEFAULT_APPROVAL_POLICY;
		const pending = [];
		for (const slot of slots) {
			if (!isGated(slot.name, policy)) continue;
			const record = await harness.snapshot(
				ApprovalsDoc,
				root.id,
				slot.callId,
				context,
			);
			if (record !== undefined && record.status !== "pending") continue;
			pending.push({
				callId: slot.callId,
				toolName: slot.name,
				status: "pending",
				...(record?.arguments === undefined
					? {}
					: { arguments: record.arguments }),
				...(record?.requestedAt === undefined
					? {}
					: { requestedAt: record.requestedAt }),
			});
		}
		return pending;
	}

	async function decide(root, callId, decision, context, reason) {
		const applied = await root.commit(async (tx) => {
			const draft = await tx.doc(ApprovalsDoc, root.id, callId, callId);
			if (draft.status !== "pending") return false; // first decision wins
			draft.status = decision;
			if (reason !== undefined) draft.reason = reason;
			draft.decidedAt = Date.now();
			return true;
		}, context);
		return applied;
	}

	const extension = defineExtension({
		name: "sigrun.approvals",
		hooks: [hook(ToolTask, { beforeTool })],
	});

	return { extension, approvals: { listPending, decide } };
}