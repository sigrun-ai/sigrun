/**
 * Gateway group e2e (Task 8, spec §10): mention gating, linked/anyone
 * members, exact anyone-agent selection, people sharing, and live group
 * removal over the real built-in engine and loopback adapter.
 *
 * Tests own their literals: alice/bob/mallory and "-100000000002".
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, test } from "vitest";
import type { InboundEvent, Sharing } from "../../src/extension.js";
import { accessOf } from "@sigrun/shared/access";
import { bootGateway, type GatewayBoot } from "./harness.js";

const CHAT_ID = "-100000000002";
const BINDING_KEY = `loop:default:group:${CHAT_ID}`;

function groupEvent(over: {
	messageId: string;
	senderId?: string;
	name?: string;
	text?: string;
	mentioned?: boolean;
}): InboundEvent {
	return {
		messageId: over.messageId,
		chat: { chatId: CHAT_ID, chatType: "group", title: "Dev" },
		sender: { id: over.senderId ?? "100000001", name: over.name ?? "Alice" },
		text: over.text ?? "hello group",
		mentioned: over.mentioned ?? true,
	};
}

function settings(groups: readonly Record<string, unknown>[]): Record<string, unknown> {
	return {
		channels: {
			loop: {
				dm: "allowlist",
				allow: [
					{ sender: "100000001", user: "alice" },
					{ sender: "200000002", user: "bob" },
				],
				groups,
			},
		},
	};
}

const LINKED = settings([{ chat: CHAT_ID, owner: "alice", members: "linked" }]);

interface ConversationRow {
	readonly id: number;
	readonly owner?: string;
	readonly source?: string;
}

async function conversations(boot: GatewayBoot): Promise<readonly ConversationRow[]> {
	const response = await boot.app.inject({
		method: "GET",
		url: "/v1/conversations",
		headers: { authorization: `Bearer ${boot.tokens.alice}` },
	});
	if (response.statusCode !== 200) throw new Error(`list returned ${response.statusCode}`);
	return response.json().conversations as ConversationRow[];
}

async function gatewayConversation(boot: GatewayBoot): Promise<ConversationRow> {
	const rows = (await conversations(boot)).filter((row) => row.source === "gateway");
	if (rows.length !== 1) throw new Error(`expected one gateway conversation, got ${rows.length}`);
	return rows[0]!;
}

async function submittedTexts(boot: GatewayBoot, id: number): Promise<string[]> {
	const conversation = await boot.opened.harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
	if (conversation === undefined) throw new Error(`conversation ${id} not found`);
	const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	return page.items.flatMap((entry) => {
		if (entry.kind !== "pi.user") return [];
		const model = (entry as {
			model?: readonly {
				role: string;
				content: string | readonly { type: string; text?: string }[];
			}[];
		}).model;
		return (model ?? []).flatMap((message) => {
			if (message.role !== "user") return [];
			if (typeof message.content === "string") return [message.content];
			return message.content.flatMap((part) =>
				part.type === "text" && typeof part.text === "string" ? [part.text] : [],
			);
		});
	});
}

async function waitForSubmission(boot: GatewayBoot, id: number, count: number): Promise<void> {
	await boot.waitFor(async () => (await submittedTexts(boot, id)).length >= count);
}

describe("gateway groups e2e (Task 8)", () => {
	test("an unlisted group is ignored", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({ gatewaySettings: settings([]) });
		try {
			expect(await boot.loop.inbound(groupEvent({ messageId: "unlisted" }))).toEqual({
				outcome: "dropped",
			});
			expect((await conversations(boot)).filter((row) => row.source === "gateway")).toEqual([]);
		} finally {
			await boot.shutdown();
		}
	});

	test("mention required drops an unmentioned message", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: settings([
				{ chat: CHAT_ID, owner: "alice", members: "linked", mention: "required" },
			]),
		});
		try {
			expect(
				await boot.loop.inbound(groupEvent({ messageId: "unmentioned", mentioned: false })),
			).toEqual({ outcome: "dropped" });
			expect((await conversations(boot)).filter((row) => row.source === "gateway")).toEqual([]);
		} finally {
			await boot.shutdown();
		}
	});

	test("linked mode drops Mallory, admits Alice with a directory label, and grants write sharing", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: LINKED,
			users: [{ user: "alice", admin: true }, { user: "bob" }],
		});
		try {
			await boot.opened.identity.users.update("alice", { name: "Alice" });
			expect(
				await boot.loop.inbound(
					groupEvent({ messageId: "mallory-linked", senderId: "300000003", name: "Mallory" }),
				),
			).toEqual({ outcome: "dropped" });
			expect(await boot.loop.inbound(groupEvent({ messageId: "alice-linked" }))).toEqual({
				outcome: "admitted",
			});
			const row = await gatewayConversation(boot);
			await waitForSubmission(boot, row.id, 1);
			expect((await submittedTexts(boot, row.id))[0]).toBe("[Alice] hello group");
			// The owner needs no people row. A second linked speaker gains it.
			expect(
				await boot.loop.inbound(
					groupEvent({ messageId: "bob-linked", senderId: "200000002", name: "Bob", text: "bob speaks" }),
				),
			).toEqual({ outcome: "admitted" });
			await waitForSubmission(boot, row.id, 2);
			const metaResponse = await boot.app.inject({
				method: "GET",
				url: `/v1/conversations/${row.id}/meta`,
				headers: { authorization: `Bearer ${boot.tokens.alice}` },
			});
			expect(metaResponse.statusCode).toBe(200);
			const meta = metaResponse.json() as { owner?: string; sharing?: Sharing };
			expect(meta.sharing).toEqual({ scope: "people", users: ["bob"], level: "write" });
			expect(accessOf({ user: "bob" }, { owner: meta.owner, sharing: meta.sharing })).toBe("write");
		} finally {
			await boot.shutdown();
		}
	});

	test("anyone mode admits Mallory, pins exactly its tools, and refuses /attach", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: settings([
				{
					chat: CHAT_ID,
					owner: "alice",
					members: "anyone",
					mention: "always",
					tools: ["read"],
				},
			]),
		});
		try {
			expect(
				await boot.loop.inbound(
					groupEvent({ messageId: "mallory-anyone", senderId: "300000003", name: "Mallory" }),
				),
			).toEqual({ outcome: "admitted" });
			const row = await gatewayConversation(boot);
			await waitForSubmission(boot, row.id, 1);
			expect((await submittedTexts(boot, row.id))[0]).toBe("[Mallory (not linked)] hello group");
			const conversation = await boot.opened.harness.conversation(
				row.id as ConversationId,
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) throw new Error("group conversation not found");
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			expect(agent.tools.map((tool) => tool.name)).toEqual(["read"]);
			expect(await boot.loop.inbound(groupEvent({ messageId: "attach-anyone", text: "/attach 1" }))).toEqual({
				outcome: "command",
			});
			expect(boot.loop.sent.at(-1)?.text).toBe("/attach is not available in this group.");
		} finally {
			await boot.shutdown();
		}
	});

	test("removing a live group drops its next message but keeps its binding (Review Focus 3)", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({ gatewaySettings: LINKED });
		try {
			expect(await boot.loop.inbound(groupEvent({ messageId: "before-removal" }))).toEqual({
				outcome: "admitted",
			});
			const row = await gatewayConversation(boot);
			await waitForSubmission(boot, row.id, 1);
			const bindingsPath = join(boot.dir, "ext-gateway", "gateway", "bindings.json");
			const before = JSON.parse(await readFile(bindingsPath, "utf8")) as {
				bindings: Record<string, unknown>;
			};
			expect(before.bindings[BINDING_KEY]).toBeDefined();
			await writeFile(
				join(boot.dir, "config", "settings", "gateway.json"),
				JSON.stringify(settings([])),
			);
			expect(await boot.loop.inbound(groupEvent({ messageId: "after-removal" }))).toEqual({
				outcome: "dropped",
			});
			const after = JSON.parse(await readFile(bindingsPath, "utf8")) as {
				bindings: Record<string, { conversationId: number }>;
			};
			expect(after.bindings[BINDING_KEY]).toEqual(before.bindings[BINDING_KEY]);
			expect(await submittedTexts(boot, row.id)).toHaveLength(1);
		} finally {
			await boot.shutdown();
		}
	});
});
