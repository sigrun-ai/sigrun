/**
 * Gateway streaming e2e (Task 6): real admission → live watch → settled
 * delivery over the loopback channel. The faux provider's streamed
 * deltas exercise the engine's live-text path; tests own their literals.
 */

import { describe, expect, test } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { bootGateway } from "./harness.js";
import type { InboundEvent } from "../../src/extension.js";

const ANSWER = "Hello world, this is a streamed gateway answer with enough text to edit.";

const SETTINGS = {
	channels: {
		loop: {
			dm: "allowlist",
			allow: [{ sender: "100000001", user: "alice" }],
			stream: true,
		},
	},
};

function dmEvent(): InboundEvent {
	return {
		messageId: "stream-m1",
		chat: { chatId: "100000001", chatType: "dm" },
		sender: { id: "100000001", name: "Alice" },
		text: "stream this reply",
	};
}

describe("gateway streaming e2e (Task 6)", () => {
	test("streamed edits are prefix-stable and the last edit is the settled answer", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: SETTINGS,
			responses: [fauxAssistantMessage(ANSWER)],
			tokensPerSecond: 10,
		});
		try {
			const sentBefore = boot.loop.sent.length;
			const editsBefore = boot.loop.edits.length;
			await boot.loop.inbound(dmEvent());
			await boot.waitFor(() => boot.loop.edits.length > editsBefore);
			await boot.waitFor(() => boot.loop.edits.at(-1)?.message.text === ANSWER);
			const streamed = [
				...boot.loop.sent.slice(sentBefore).map((row) => row.text),
				...boot.loop.edits.slice(editsBefore).map((row) => row.message.text),
			];
			for (let index = 1; index < streamed.length; index++) {
				expect(streamed[index]!.startsWith(streamed[index - 1]!)).toBe(true);
			}
			expect(boot.loop.edits.at(-1)?.message.text).toBe(ANSWER);
			expect(boot.loop.sent.slice(sentBefore).map((row) => row.text)).not.toContain(ANSWER);
		} finally {
			await boot.shutdown();
		}
	});

	test("without edit capabilities typing runs until settle then one final sends", { timeout: 60_000 }, async () => {
		(globalThis as { __loopCaps?: unknown }).__loopCaps = {
			chatTypes: ["dm", "group", "thread"],
			maxMessageLength: 200,
			format: "markdown",
			typing: { intervalMs: 50 },
		};
		const boot = await bootGateway({
			gatewaySettings: SETTINGS,
			responses: [fauxAssistantMessage(ANSWER)],
			tokensPerSecond: 10,
		});
		try {
			const sentBefore = boot.loop.sent.length;
			const editsBefore = boot.loop.edits.length;
			const typingBefore = boot.loop.typing.length;
			await boot.loop.inbound(dmEvent());
			await boot.waitFor(() => boot.loop.sent.slice(sentBefore).some((row) => row.text === ANSWER));
			expect(boot.loop.typing.length).toBeGreaterThan(typingBefore);
			expect(boot.loop.edits.slice(editsBefore)).toHaveLength(0);
			expect(boot.loop.sent.slice(sentBefore).map((row) => row.text)).toEqual([ANSWER]);
		} finally {
			delete (globalThis as { __loopCaps?: unknown }).__loopCaps;
			await boot.shutdown();
		}
	});
});
