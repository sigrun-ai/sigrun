/**
 * The approvals surface's STRUCTURAL contract (publish prep 2.1).
 *
 * The approval SEMANTICS are extension-owned (the "core never hard-imports
 * an optional extension" ruling): the doc-family tokens (the policy doc +
 * the per-call record family) are runtime objects the approvals package
 * produces, so core can neither construct them nor read the docs they key —
 * and the conversation view's `docs` record mounts only pi-durable's five
 * built-ins (AgentDoc, LiveDoc, InboxDoc, ProviderDoc, UsageDoc), so
 * extension docs never materialize in the view either.
 *
 * The honest seam is the loader's factory-result wiring: an approvals
 * extension's factory returns `{ extension, health?, submit?, approvals }`
 * where `approvals` is the structural capability below. The loader retains
 * it (like the §3 health producers and the memory submit pass-through),
 * boot identity-matches it to the extension installed under
 * {@link APPROVALS_EXTENSION_NAME}, and the §5 approvals routes call
 * through it — core imports NOTHING from any extension package. Absent
 * capability → the routes degrade (empty list / 503).
 */

import type { Context } from "@earendil-works/chord";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import type { ApprovalSummary } from "./views.js";

/**
 * The extension name the approvals package contributes (the loader-install
 * name boot identity-matches the capability against).
 */
export const APPROVALS_EXTENSION_NAME = "sigrun.approvals";

/** One pending-approval decision: allow runs the gated call, deny blocks it. */
export type ApprovalDecision = "allow" | "deny";

/**
 * The structural approvals capability an approvals extension's factory result
 * may carry. `listPending` takes the harness because committed doc reads
 * (policy + records) live on `Session.snapshot` — `Conversation` exposes no
 * doc read, and reading through `commit` would create missing docs and
 * serialize reads against live generation commits.
 */
export interface ExtensionApprovals {
	/**
	 * List the conversation's pending approvals — which calls are gated and
	 * await a decision is extension-owned semantics; the §5 route serializes
	 * the result as-is.
	 */
	listPending(
		harness: Harness,
		conversation: Conversation,
		context: Context,
	): Promise<readonly ApprovalSummary[]>;
	/**
	 * Record a decision for a pending approval (first decision wins, decided
	 * inside the commit). Returns whether THIS call applied the decision —
	 * `false` means the approval was unknown or already decided.
	 */
	decide(
		conversation: Conversation,
		callId: string,
		decision: ApprovalDecision,
		context: Context,
		reason?: string,
	): Promise<boolean>;
}