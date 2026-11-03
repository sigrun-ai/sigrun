/**
 * AssistantTurn (polish pass Task 5, spec §5.1): the model meta reads as a
 * breadcrumb — every path segment but the leaf collapsed, the provider
 * always a segment — and the untouched id rides the meta's `title`.
 *
 * The turn's last assistant message is a NEW bifrost chain message
 * (`provider: "bifrost"`, `model: "chain/acme-flash"` — Task 4's shape),
 * so the display side must render `b/c/acme-flash · in … · out …` while
 * hovering still reveals `bifrost/chain/acme-flash`. Fixtures are
 * synthetic (tests own their literals).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { createElement as h } from "react";
import { describe, expect, test } from "vitest";
import type { ConversationEntryWire, SigrunClient } from "../api";
import { makeEntry, render, textContent, textMessage, usageOf } from "../test-utils";
import { AssistantTurn, type AssistantTurnData } from "./AssistantTurn";

/** The turn's one assistant entry: a chain reply carrying usage. */
function chainEntry(): ConversationEntryWire {
	return makeEntry(
		"pi.assistant",
		[
			textMessage("assistant", "Done.", {
				provider: "bifrost",
				model: "chain/acme-flash",
				usage: { ...usageOf(120), input: 84, output: 36 },
			}),
		],
		{ id: 2 },
	);
}

/** The turn AssistantTurn renders (the shape groupTurns hands down). */
function chainTurn(): AssistantTurnData {
	return {
		entries: [chainEntry()],
		thinking: [],
		tools: [],
		text: "Done.",
		lastEntryId: 2,
		timeline: [{ kind: "text", text: "Done." }],
	};
}

const client = {} as unknown as SigrunClient;

describe("AssistantTurn: the model meta", () => {
	test("meta shows the breadcrumb with the full id on hover", () => {
		const renderer = render(
			h(AssistantTurn, {
				conversationId: 1,
				turn: chainTurn(),
				slots: [],
				showThinking: true,
				client,
				onNavigate: () => {},
			}),
		);
		const meta = renderer.root.findByProps({ className: "message-meta" });
		const label = meta.children.join("");
		expect(label).toContain("b/c/acme-flash · in");
		expect(label).toBe("b/c/acme-flash · in 84 · out 36");
		expect(meta.props.title).toBe("bifrost/chain/acme-flash");
		// The plain model id never leaks into the visible text — only the
		// hover title carries it.
		expect(textContent(renderer.toJSON())).not.toContain("chain/acme-flash");
		renderer.unmount();
	});
});
