/**
 * InteractionCards Decline affordance (ask-user Task 5, spec §5.2): the
 * Decline button lives in the CARD CHROME (outside the block tree), so it
 * is present on EVERY stepper step — not beside the form's submit, which
 * exists only on the review step. Covered here:
 *
 * - a pending `declinable` record shows Decline at every stepper step;
 *   clicking it calls `declineInteraction(id, callId)` and the card
 *   swaps to the settled "Declined" envelope;
 * - a settled record with `declinedVia: "message"` renders
 *   "Declined — replied in chat";
 * - a record without `declinable` has no Decline button;
 * - a read-only (settled) card has no Decline button.
 *
 * react-test-renderer harness, same pattern as SeamComponents.test.tsx.
 * Tests own their literals.
 */

import { act, createElement as h } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";
import { render, textContent } from "../test-utils";
import type { Tree } from "@sigrun/shared/blocks";
import type { InteractionWire, SigrunClient } from "../api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { InteractionCard } from "./InteractionCards";

const TREE_V = 1;

/** A root form with the given children (the §9.1 interaction shape). */
function formTree(children: readonly unknown[]): Tree {
	return {
		v: TREE_V,
		root: {
			type: "form",
			id: "ask",
			bind: "/values",
			mode: "submit",
			children,
		},
	} as Tree;
}

/** One choice section (the stepper's per-question shape, §9.1). */
function questionSection(
	name: string,
	label: string,
	options: readonly { id: string; label: string }[],
): unknown {
	return {
		type: "section",
		title: label,
		children: [{ type: "choice", name, label, options }],
	};
}

function makeClient(overrides: Record<string, unknown> = {}): SigrunClient {
	return {
		answerInteraction: vi.fn().mockResolvedValue({
			callId: "c1",
			status: "answered",
			answer: { values: {} },
		}),
		declineInteraction: vi.fn().mockResolvedValue({
			callId: "c1",
			status: "skipped",
			declinedVia: "button",
		}),
		getInteraction: vi.fn(),
		...overrides,
	} as unknown as SigrunClient;
}

const BASE: InteractionWire = {
	kind: "fixture.ask",
	callId: "c1",
	status: "pending",
	createdAt: 1,
};

/** The card chrome's Decline button (its class names it). */
function declineButton(
	renderer: TestRenderer.ReactTestRenderer,
): TestRenderer.ReactTestInstance | undefined {
	return renderer.root.findAllByType("button" as never).find(
		(b) =>
			typeof (b.props as { className?: string }).className === "string" &&
			(b.props as { className: string }).className.includes("interaction-decline"),
	);
}

describe("InteractionCard decline", () => {
	test("a pending declinable record shows Decline in the chrome at every step; clicking declines", async () => {
		const declineInteraction = vi.fn().mockResolvedValue({
			callId: "c1",
			status: "skipped",
			declinedVia: "button",
		});
		const onAnswered = vi.fn();
		const client = makeClient({ declineInteraction });
		const interaction: InteractionWire = {
			...BASE,
			declinable: true,
			body: formTree([
				questionSection("q1", "First", [
					{ id: "a", label: "A" },
					{ id: "b", label: "B" },
				]),
				questionSection("q2", "Second", [
					{ id: "x", label: "X" },
					{ id: "y", label: "Y" },
				]),
			]),
		};
		const renderer = render(
			h(InteractionCard, { conversationId: 7, interaction, client, onAnswered }),
		);
		// Step 1: Decline sits in the card chrome (not the review step's form).
		expect(textContent(renderer.toJSON())).toContain("Step 1 of 2");
		expect(declineButton(renderer)).toBeDefined();
		// Step 2: still present — the chrome is outside the stepper.
		const next = renderer.root
			.findAllByType("button" as never)
			.find((b) => textContent(b as never) === "Next");
		await act(async () => {
			next?.props.onClick();
		});
		expect(textContent(renderer.toJSON())).toContain("Step 2 of 2");
		expect(declineButton(renderer)).toBeDefined();
		// Click: the decline route is called and the card settles "Declined".
		await act(async () => {
			declineButton(renderer)?.props.onClick();
		});
		expect(declineInteraction).toHaveBeenCalledWith(7, "c1");
		expect(textContent(renderer.toJSON())).toContain("Declined");
		expect(onAnswered).toHaveBeenCalledWith("c1");
	});

	test("a settled record with declinedVia message renders 'Declined — replied in chat'", () => {
		const client = makeClient();
		const interaction: InteractionWire = {
			...BASE,
			status: "skipped",
			settledAt: 2,
			declinedVia: "message",
		};
		const renderer = render(
			h(InteractionCard, { conversationId: 7, interaction, client }),
		);
		expect(textContent(renderer.toJSON())).toContain(
			"Declined — replied in chat",
		);
	});

	test("a record without declinable has no Decline button", () => {
		const client = makeClient();
		const interaction: InteractionWire = {
			...BASE,
			body: formTree([
				{
					type: "choice",
					name: "decision",
					label: "Verdict",
					options: [
						{ id: "allow", label: "Allow" },
						{ id: "deny", label: "Deny" },
					],
				},
			]),
		};
		const renderer = render(
			h(InteractionCard, { conversationId: 7, interaction, client }),
		);
		expect(declineButton(renderer)).toBeUndefined();
	});

	test("a read-only (settled) card has no Decline button", () => {
		const client = makeClient();
		const interaction: InteractionWire = {
			...BASE,
			declinable: true,
			status: "answered",
			settledAt: 2,
			answer: { values: { decision: "allow" } },
			body: formTree([
				{
					type: "choice",
					name: "decision",
					label: "Verdict",
					options: [
						{ id: "allow", label: "Allow" },
						{ id: "deny", label: "Deny" },
					],
				},
			]),
		};
		const renderer = render(
			h(InteractionCard, { conversationId: 7, interaction, client }),
		);
		expect(declineButton(renderer)).toBeUndefined();
		// A settled-by-answer card shows its own status, never "Declined".
		expect(textContent(renderer.toJSON())).not.toContain("Declined");
	});
});
