/**
 * The TUI interaction transport's submit gate (UI-blocks U6 Task 3,
 * fix round 2): only a real `submit` action NAMED the form's submit
 * action answers the record. A callout itemAction named "submit" (the
 * default onSubmit name) and a live-mode `edit` dispatch named
 * `onSubmit` must never POST `{values}`.
 */

import { describe, expect, test, vi } from "vitest";
import type { Tree } from "@sigrun/shared/blocks";
import type { SigrunClient } from "../src/api.js";
import { createInteractionTransport } from "../src/blocks/interaction-transport.js";

const TREE: Tree = {
	v: 1,
	root: {
		type: "form",
		id: "ask",
		bind: "/values",
		mode: "submit",
		children: [],
	},
} as Tree;

function transportStub(overrides?: {
	submitAction?: string;
	answerInteraction?: ReturnType<typeof vi.fn>;
}) {
	const answerInteraction =
		overrides?.answerInteraction ??
		vi.fn().mockResolvedValue({ callId: "c1", status: "answered" });
	const client = { answerInteraction } as unknown as SigrunClient;
	const transport = createInteractionTransport({
		client,
		conversationId: 7,
		callId: "c1",
		tree: TREE,
		data: { values: {} },
		access: "write",
		submitAction: overrides?.submitAction ?? "submit",
	});
	return { transport, answerInteraction };
}

describe("interaction transport submit gate", () => {
	test("the real submit answers the record", async () => {
		const { transport, answerInteraction } = transportStub();
		const result = await transport.act({
			action: "submit",
			type: "submit",
			payload: { values: { decision: "allow" } },
			actionId: "a1",
		});
		expect(result.ok).toBe(true);
		expect(answerInteraction).toHaveBeenCalledWith(7, "c1", {
			values: { decision: "allow" },
		});
	});

	test("a callout itemAction NAMED \"submit\" does not answer", async () => {
		const { transport, answerInteraction } = transportStub();
		// A callout button's action is type "edit"/arbitrary — never
		// "submit" — even when its name collides with the default.
		const result = await transport.act({
			action: "submit",
			type: "edit",
			payload: {},
			actionId: "a2",
		});
		expect(result.ok).toBe(true);
		expect(answerInteraction).not.toHaveBeenCalled();
	});

	test("a live-mode edit NAMED the onSubmit action does not answer", async () => {
		const { transport, answerInteraction } = transportStub({
			submitAction: "save",
		});
		const result = await transport.act({
			action: "save",
			type: "edit",
			payload: { values: { note: "typed" } },
			actionId: "a3",
		});
		expect(result.ok).toBe(true);
		expect(answerInteraction).not.toHaveBeenCalled();
		// …but the real submit with that name does.
		const submit = await transport.act({
			action: "save",
			type: "submit",
			payload: { values: { note: "typed" } },
			actionId: "a4",
		});
		expect(submit.ok).toBe(true);
		expect(answerInteraction).toHaveBeenCalledTimes(1);
	});

	test("a submit with the WRONG name does not answer", async () => {
		const { transport, answerInteraction } = transportStub();
		const result = await transport.act({
			action: "other",
			type: "submit",
			payload: { values: {} },
			actionId: "a5",
		});
		expect(result.ok).toBe(true);
		expect(answerInteraction).not.toHaveBeenCalled();
	});
});
