/**
 * ApprovalCard (Task 22): a pending gated call (a `docs["pi.live"].tools`
 * slot with status "pending") rendered with allow/deny. Clicking POSTs
 * `{decision}` to `/v1/conversations/:id/approvals/:approvalId` via the api
 * client's seam (stub fetch). The card never self-clears: after a decision
 * it shows a decided state and the NEXT VIEW FRAME (the slot no longer
 * pending) removes it — the stream drives the transcript, not local guesses.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h, Fragment } from "react";
import { describe, expect, test } from "vitest";
import {
	createClient,
	type ConversationViewWire,
	type FetchLike,
} from "../api";
import { makeView, render, textContent } from "../test-utils";
import { ApprovalCard, pendingApprovalsFromView } from "./ApprovalCard";

/** A fetch stub recording calls; returns one canned status (default 200). */
function stubFetch(init?: { status?: number }) {
	const calls: { input: string; method?: string; body?: string }[] = [];
	const fetchImpl: FetchLike = (input, request) => {
		calls.push({ input, method: request?.method, body: request?.body });
		const status = init?.status ?? 200;
		return Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			json: () => Promise.resolve({}),
		});
	};
	return { calls, fetchImpl };
}

const APPROVAL = {
	callId: "call-1",
	toolName: "bash",
	status: "pending",
	arguments: { command: "rm -rf /tmp/x" },
} as const;

describe("ApprovalCard", () => {
	test("renders a pending gated call with its tool name and arguments", () => {
		const { fetchImpl } = stubFetch();
		const client = createClient({ fetch: fetchImpl });
		const renderer = render(
			h(ApprovalCard, { conversationId: 9, approval: APPROVAL, client }),
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("bash");
		expect(text).toContain("rm -rf /tmp/x");
		renderer.unmount();
	});

	test("allow POSTs {decision: allow} to the approval endpoint", async () => {
		const { calls, fetchImpl } = stubFetch();
		const client = createClient({ fetch: fetchImpl });
		const renderer = render(
			h(ApprovalCard, { conversationId: 9, approval: APPROVAL, client }),
		);
		const allowButton = renderer.root.findByProps({
			className: "approval-allow",
		});
		await act(async () => {
			await allowButton.props.onClick();
		});
		expect(calls).toEqual([
			{
				input: "/v1/conversations/9/approvals/call-1",
				method: "POST",
				body: JSON.stringify({ decision: "allow" }),
			},
		]);
		// Decided state: the card stays (the next view frame clears it),
		// buttons disabled so the decision can't be double-sent.
		expect(textContent(renderer.toJSON())).toContain("bash");
		expect(
			renderer.root.findByProps({ className: "approval-allow" }).props
				.disabled,
		).toBe(true);
		expect(
			renderer.root.findByProps({ className: "approval-deny" }).props
				.disabled,
		).toBe(true);
		renderer.unmount();
	});

	test("deny POSTs {decision: deny} to the approval endpoint", async () => {
		const { calls, fetchImpl } = stubFetch();
		const client = createClient({ fetch: fetchImpl });
		const renderer = render(
			h(ApprovalCard, { conversationId: 9, approval: APPROVAL, client }),
		);
		const denyButton = renderer.root.findByProps({
			className: "approval-deny",
		});
		await act(async () => {
			await denyButton.props.onClick();
		});
		expect(calls).toEqual([
			{
				input: "/v1/conversations/9/approvals/call-1",
				method: "POST",
				body: JSON.stringify({ decision: "deny" }),
			},
		]);
		renderer.unmount();
	});

	test("a failed POST surfaces the error and re-enables the buttons", async () => {
		const { fetchImpl } = stubFetch({ status: 500 });
		const client = createClient({ fetch: fetchImpl });
		const renderer = render(
			h(ApprovalCard, { conversationId: 9, approval: APPROVAL, client }),
		);
		const allowButton = renderer.root.findByProps({
			className: "approval-allow",
		});
		await act(async () => {
			await allowButton.props.onClick();
		});
		const alerts = renderer.root.findAllByProps({ role: "alert" });
		expect(alerts).toHaveLength(1);
		expect(textContent(renderer.toJSON())).toContain("500");
		expect(
			renderer.root.findByProps({ className: "approval-allow" }).props
				.disabled,
		).toBe(false);
		renderer.unmount();
	});
});

describe("pendingApprovalsFromView", () => {
	test("derives pending approvals from the live doc's pending tool slots", () => {
		const view = makeView({
			id: 9,
			docs: {
				"pi.live": {
					tools: [
						{ callId: "call-1", name: "bash", status: "pending" },
						{ callId: "call-2", name: "read", status: "running" },
					],
				},
			},
		});
		expect(pendingApprovalsFromView(view)).toEqual([
			{ callId: "call-1", toolName: "bash", status: "pending" },
		]);
	});

	test("no live doc (or no pending slots) means no approvals", () => {
		expect(pendingApprovalsFromView(makeView({}))).toEqual([]);
		expect(
			pendingApprovalsFromView(
				makeView({ docs: { "pi.live": { tools: [] } } }),
			),
		).toEqual([]);
	});
});

describe("approval lifecycle across view frames", () => {
	function Harness(props: { view: ConversationViewWire }) {
		const client = createClient({ fetch: harnessFetch });
		return h(
			Fragment,
			null,
			...pendingApprovalsFromView(props.view).map((approval) =>
				h(ApprovalCard, {
					key: approval.callId,
					conversationId: props.view.conversation.id,
					approval,
					client,
				}),
			),
		);
	}

	let harnessCalls: { input: string; method?: string; body?: string }[];
	const harnessFetch: FetchLike = (input, request) => {
		harnessCalls.push({ input, method: request?.method, body: request?.body });
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve({}),
		});
	};

	test("a pending approval clears on the next view frame, not on the click", async () => {
		harnessCalls = [];
		const frame1 = makeView({
			id: 9,
			docs: {
				"pi.live": {
					tools: [{ callId: "call-1", name: "bash", status: "pending" }],
				},
			},
		});
		const renderer = render(h(Harness, { view: frame1 }));
		expect(textContent(renderer.toJSON())).toContain("bash");

		// The click POSTs the decision but the card stays until the frame.
		await act(async () => {
			await renderer.root
				.findByProps({ className: "approval-allow" })
				.props.onClick();
		});
		expect(harnessCalls).toHaveLength(1);
		expect(textContent(renderer.toJSON())).toContain("bash");

		// The next frame: the slot flipped to running — the card is gone.
		const frame2 = makeView({
			id: 9,
			docs: {
				"pi.live": {
					tools: [{ callId: "call-1", name: "bash", status: "running" }],
				},
			},
		});
		act(() => {
			renderer.update(h(Harness, { view: frame2 }));
		});
		expect(textContent(renderer.toJSON())).not.toContain("bash");
		renderer.unmount();
	});
});
