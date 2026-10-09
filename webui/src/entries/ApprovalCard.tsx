/**
 * ApprovalCard (Task 22, spec §6.1): one pending gated tool call with
 * allow/deny buttons. Clicking POSTs `{decision: "allow" | "deny"}` to
 * `/v1/conversations/:id/approvals/:approvalId` via the §5 client.
 *
 * The card NEVER self-clears: after a successful decision it shows a
 * decided state (buttons disabled — the decision cannot be double-sent) and
 * the NEXT approvals-list refresh removes it. Pending approvals are sourced
 * from the server's approvals endpoint (`listApprovals`) by the Composers,
 * NOT derived from view slots — the endpoint is the sole truth for the
 * approval lifecycle. A failed POST surfaces the error (fail loud) and
 * re-enables the buttons.
 */

import { useState } from "react";
import {
	createClient,
	type ApprovalDecision,
	type ApprovalWire,
	type SigrunClient,
} from "../api";

const defaultClient = createClient();

type DecisionState = "idle" | "sending" | "decided" | "error";

export function ApprovalCard(props: {
	conversationId: number;
	approval: ApprovalWire;
	/** Injected for tests; defaults to a same-origin §5 client. */
	client?: SigrunClient;
}) {
	const client = props.client ?? defaultClient;
	const [state, setState] = useState<DecisionState>("idle");
	const [error, setError] = useState<string | null>(null);

	async function decide(decision: ApprovalDecision): Promise<void> {
		setState("sending");
		setError(null);
		try {
			await client.decideApproval(
				props.conversationId,
				props.approval.callId,
				decision,
			);
			setState("decided");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setState("error");
		}
	}

	const disabled = state === "sending" || state === "decided";
	return (
		<div className="approval-card">
			<div className="approval-card-title">
				approval required: {props.approval.toolName}
			</div>
			{props.approval.arguments !== undefined && (
				<pre className="approval-card-arguments">
					{JSON.stringify(props.approval.arguments, null, 2)}
				</pre>
			)}
			<div className="approval-card-actions">
				<button
					type="button"
					className="approval-allow"
					disabled={disabled}
					onClick={() => decide("allow")}
				>
					Allow
				</button>
				<button
					type="button"
					className="approval-deny"
					disabled={disabled}
					onClick={() => decide("deny")}
				>
					Deny
				</button>
			</div>
			{state === "decided" && (
				<span className="approval-decided">
					decision sent — awaiting the next frame
				</span>
			)}
			{state === "error" && <p role="alert">{error}</p>}
		</div>
	);
}
