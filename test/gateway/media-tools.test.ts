/**
 * Gateway media/tools/prompt e2e (Task 11): real upload-backed image
 * submissions, declared-size short-circuiting, a scripted send_message
 * tool round, and bound-only gateway-channel prompt rendering.
 * Tests own their literals: alice, "100000001".
 */

import { describe, expect, test, vi } from "vitest";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { InboundEvent } from "../../src/extension.js";
import { bootGateway, type GatewayBoot } from "./harness.js";

const GATEWAY_SETTINGS = {
	channels: {
		loop: {
			dm: "allowlist",
			allow: [{ sender: "100000001", user: "alice" }],
		},
	},
};

function dmEvent(over: Partial<InboundEvent> & { messageId: string }): InboundEvent {
	return {
		chat: { chatId: "100000001", chatType: "dm" },
		sender: { id: "100000001", name: "Alice" },
		text: "hello gateway",
		...over,
	};
}

interface ConversationRow {
	readonly id: number;
	readonly owner?: string;
	readonly source?: string;
}

async function listConversations(boot: GatewayBoot): Promise<readonly ConversationRow[]> {
	const response = await boot.app.inject({
		method: "GET",
		url: "/v1/conversations",
		headers: { authorization: `Bearer ${boot.tokens.alice}` },
	});
	if (response.statusCode !== 200) throw new Error(`list returned ${response.statusCode}`);
	return response.json().conversations as ConversationRow[];
}

async function gatewayConversation(boot: GatewayBoot): Promise<ConversationRow> {
	await boot.waitFor(async () => (await listConversations(boot)).some((row) => row.source === "gateway"));
	const row = (await listConversations(boot)).find((candidate) => candidate.source === "gateway");
	if (row === undefined) throw new Error("no gateway conversation");
	return row;
}

interface ConversationEntry {
	readonly kind: string;
	readonly model?: readonly {
		readonly role: string;
		readonly content: readonly {
			readonly type: string;
			readonly text?: string;
			readonly data?: string;
			readonly mimeType?: string;
		}[];
	}[];
}

async function entries(boot: GatewayBoot, conversationId: number): Promise<readonly ConversationEntry[]> {
	const response = await boot.app.inject({
		method: "GET",
		url: `/v1/conversations/${conversationId}`,
		headers: { authorization: `Bearer ${boot.tokens.alice}` },
	});
	if (response.statusCode !== 200) throw new Error(`view returned ${response.statusCode}`);
	return response.json().entries as ConversationEntry[];
}

describe("gateway media and agent tools e2e (Task 11)", () => {
	test("an image attachment becomes an image part on the submitted entry", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({ gatewaySettings: GATEWAY_SETTINGS });
		try {
			const outcome = await boot.loop.inbound(dmEvent({
				messageId: "image-1",
				text: "look at this",
				attachments: [{
					kind: "image",
					filename: "pixel.png",
					mime: "image/png",
					size: 3,
					fetch: async () => new Uint8Array([137, 80, 78]),
				}],
			}));
			expect(outcome).toEqual({ outcome: "admitted" });
			const conversation = await gatewayConversation(boot);
			await boot.waitFor(async () => (await entries(boot, conversation.id)).some((entry) =>
				entry.kind === "pi.user" && entry.model?.some((message) =>
					message.role === "user" && message.content.some((part) => part.type === "image"),
				),
			));
			const user = (await entries(boot, conversation.id)).find((entry) => entry.kind === "pi.user");
			const image = user?.model?.flatMap((message) => message.content).find((part) => part.type === "image");
			expect(image?.mimeType).toBe("image/png");
			expect(image?.data).toBe(Buffer.from([137, 80, 78]).toString("base64"));
		} finally {
			await boot.shutdown();
		}
	});

	test("an oversized declared attachment is never fetched and submits the size note", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: { ...GATEWAY_SETTINGS, media: { maxBytes: 2 } },
		});
		try {
			const fetch = vi.fn(async () => new Uint8Array([1, 2, 3]));
			await boot.loop.inbound(dmEvent({
				messageId: "large-1",
				attachments: [{ kind: "document", filename: "large.txt", size: 3, fetch }],
			}));
			const conversation = await gatewayConversation(boot);
			expect(fetch).not.toHaveBeenCalled();
			await boot.waitFor(async () => (await entries(boot, conversation.id)).some((entry) =>
				entry.kind === "pi.user" && entry.model?.some((message) =>
					message.content.some((part) => part.text === "[attachment skipped: too large]"),
				),
			));
		} finally {
			await boot.shutdown();
		}
	});

	test("a scripted send_message call to loop delivers to alice's home DM", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: GATEWAY_SETTINGS,
			responses: [
				fauxAssistantMessage(
					fauxToolCall("send_message", { to: "loop", text: "tool-delivered" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("tool finished"),
			],
		});
		try {
			const sentBefore = boot.loop.sent.length;
			await boot.loop.inbound(dmEvent({ messageId: "tool-1", text: "send me a note" }));
			await boot.waitFor(() => boot.loop.sent.slice(sentBefore).some((message) =>
				message.text === "tool-delivered" && message.chat.chatId === "100000001",
			));
		} finally {
			await boot.shutdown();
		}
	});

	test("gateway-channel appears only in a bound conversation's system prompt", { timeout: 60_000 }, async () => {
		const prompts: string[] = [];
		const capture: FauxResponseFactory = (context) => {
			const system = context.messages.find((message) => message.role === "system") as
				| { sections?: Record<string, string> }
				| undefined;
			prompts.push(Object.values(system?.sections ?? {}).join("\n"));
			return fauxAssistantMessage("captured");
		};
		const boot = await bootGateway({ gatewaySettings: GATEWAY_SETTINGS, responses: [capture, capture] });
		try {
			await boot.loop.inbound(dmEvent({ messageId: "prompt-1" }));
			const bound = await gatewayConversation(boot);
			const created = await boot.app.inject({
				method: "POST",
				url: "/v1/conversations",
				headers: { authorization: `Bearer ${boot.tokens.alice}`, "content-type": "application/json" },
				payload: {},
			});
			expect(created.statusCode).toBe(201);
			const webui = created.json() as { id: number };
			const submitted = await boot.app.inject({
				method: "POST",
				url: `/v1/conversations/${webui.id}/submissions`,
				headers: { authorization: `Bearer ${boot.tokens.alice}`, "content-type": "application/json" },
				payload: { input: [{ type: "text", text: "webui prompt" }] },
			});
			expect(submitted.statusCode).toBe(202);
			await boot.waitFor(() => prompts.length >= 2);
			expect(prompts[0]).toContain("<gateway-channel>");
			expect(prompts[0]).toContain("This conversation is connected to Loop (direct message).");
			expect(prompts[1]).not.toContain("<gateway-channel>");
			expect(bound.id).not.toBe(webui.id);
		} finally {
			await boot.shutdown();
		}
	});
});
