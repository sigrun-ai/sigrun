/**
 * Gateway chat-command e2e (Task 7, spec §8.5): real loopback admission,
 * inline conversation operations, rebinding, abort settlement, webui
 * fan-out after attach, compaction, and the native command menu.
 * Tests own their literals: alice, "100000001", synthetic answers.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, test } from "vitest";
import type { InboundEvent } from "../../src/extension.js";
import { bootGateway, type GatewayBoot } from "./harness.js";

const SETTINGS = {
	channels: {
		loop: {
			dm: "allowlist",
			allow: [{ sender: "100000001", user: "alice" }],
		},
	},
};

function dmEvent(over: { messageId: string; text: string }): InboundEvent {
	return {
		messageId: over.messageId,
		chat: { chatId: "100000001", chatType: "dm" },
		sender: { id: "100000001", name: "Alice" },
		text: over.text,
	};
}

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

async function createWebuiConversation(boot: GatewayBoot): Promise<number> {
	const response = await boot.app.inject({
		method: "POST",
		url: "/v1/conversations",
		headers: {
			authorization: `Bearer ${boot.tokens.alice}`,
			"content-type": "application/json",
		},
		payload: {},
	});
	if (response.statusCode !== 201) throw new Error(`create returned ${response.statusCode}`);
	return (response.json() as ConversationRow).id;
}

async function webuiSubmit(boot: GatewayBoot, id: number, text: string): Promise<void> {
	const response = await boot.app.inject({
		method: "POST",
		url: `/v1/conversations/${id}/submissions`,
		headers: {
			authorization: `Bearer ${boot.tokens.alice}`,
			"content-type": "application/json",
		},
		payload: { input: [{ type: "text", text }] },
	});
	if (response.statusCode !== 202) throw new Error(`submit returned ${response.statusCode}`);
}

async function submissionCount(boot: GatewayBoot, id: number): Promise<number> {
	const response = await boot.app.inject({
		method: "GET",
		url: `/v1/conversations/${id}`,
		headers: { authorization: `Bearer ${boot.tokens.alice}` },
	});
	if (response.statusCode !== 200) throw new Error(`view returned ${response.statusCode}`);
	const view = response.json() as { entries?: readonly { kind: string }[] };
	return view.entries?.filter((entry) => entry.kind === "pi.user").length ?? 0;
}

async function resolvedModel(
	boot: GatewayBoot,
	id: number,
): Promise<{ provider: string; modelId: string } | undefined> {
	const conversation = await boot.opened.harness.conversation(
		id as ConversationId,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) throw new Error(`conversation ${id} not found`);
	return (await conversation.agent(BACKGROUND_CONTEXT)).model;
}

describe("gateway chat commands e2e (Task 7)", () => {
	test("/new rebinds; the next message lands only in the new conversation", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: SETTINGS,
			responses: [fauxAssistantMessage("new conversation answer")],
		});
		try {
			expect(await boot.loop.inbound(dmEvent({ messageId: "cmd-new", text: "/new" }))).toEqual({ outcome: "command" });
			const rows = await conversations(boot);
			expect(rows.filter((row) => row.source === "gateway")).toHaveLength(2);
			const oldId = rows.find((row) => row.source === "gateway")?.id;
			const newId = rows.filter((row) => row.source === "gateway").at(-1)?.id;
			if (oldId === undefined || newId === undefined || oldId === newId) {
				throw new Error("expected two distinct gateway conversations");
			}
			expect(await boot.loop.inbound(dmEvent({ messageId: "cmd-new-next", text: "hello new conversation" }))).toEqual({ outcome: "admitted" });
			await boot.waitFor(() => boot.loop.sent.some((message) => message.text === "new conversation answer"));
			expect(await submissionCount(boot, newId)).toBe(1);
			expect(await submissionCount(boot, oldId)).toBe(0);
		} finally {
			await boot.shutdown();
		}
	});

	test("/stop aborts a delayed run and sends exactly Stopped.", { timeout: 60_000 }, async () => {
		const answer = `A delayed answer ${"that keeps the run live ".repeat(80)}`;
		const boot = await bootGateway({
			gatewaySettings: SETTINGS,
			responses: [fauxAssistantMessage(answer)],
			tokensPerSecond: 1,
		});
		try {
			const sentBefore = boot.loop.sent.length;
			await boot.loop.inbound(dmEvent({ messageId: "cmd-stop-start", text: "run slowly" }));
			await boot.waitFor(() => boot.faux.state.callCount === 1);
			expect(await boot.loop.inbound(dmEvent({ messageId: "cmd-stop", text: "/stop" }))).toEqual({ outcome: "command" });
			await boot.waitFor(() => boot.loop.sent.slice(sentBefore).some((message) => message.text === "Stopped."));
			const stopped = boot.loop.sent.slice(sentBefore).filter((message) => message.text === "Stopped.");
			expect(stopped).toHaveLength(1);
			expect(boot.loop.sent.slice(sentBefore).some((message) => message.text === answer)).toBe(false);
			const inspection = await boot.opened.harness.inspect(BACKGROUND_CONTEXT);
			const row = (await conversations(boot)).find((entry) => entry.source === "gateway");
			if (row === undefined) throw new Error("no gateway conversation");
			expect(inspection.submissions.filter((entry) => entry.conversationId === row.id)).toEqual([]);
		} finally {
			await boot.shutdown();
		}
	});

	test("/model faux/m2 configures the bound conversation inline", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({ gatewaySettings: SETTINGS });
		try {
			expect(await boot.loop.inbound(dmEvent({ messageId: "cmd-model", text: "/model faux/m2" }))).toEqual({ outcome: "command" });
			const row = (await conversations(boot)).find((entry) => entry.source === "gateway");
			if (row === undefined) throw new Error("no gateway conversation");
			expect(await resolvedModel(boot, row.id)).toEqual({ provider: "faux", modelId: "m2" });
		} finally {
			await boot.shutdown();
		}
	});

	test("/attach binds a webui conversation and its webui answer reaches chat", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: SETTINGS,
			responses: [fauxAssistantMessage("attached webui answer")],
		});
		try {
			const id = await createWebuiConversation(boot);
			expect(await boot.loop.inbound(dmEvent({ messageId: "cmd-attach", text: `/attach ${id}` }))).toEqual({ outcome: "command" });
			const sentBefore = boot.loop.sent.length;
			await webuiSubmit(boot, id, "answer from the webui");
			await boot.waitFor(() => boot.loop.sent.slice(sentBefore).some((message) => message.text === "attached webui answer"));
		} finally {
			await boot.shutdown();
		}
	});

	test("/compact admits a manual compaction", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: SETTINGS,
			compactionEnv: { keepRecentTokens: 1, backgroundTokens: 0 },
			responses: [
				fauxAssistantMessage("turn one answer"),
				fauxAssistantMessage("turn two answer"),
				fauxAssistantMessage("manual history summary"),
			],
		});
		try {
			await boot.loop.inbound(dmEvent({
				messageId: "cmd-compact-turn",
				text: `hello ${"filler ".repeat(200)}`,
			}));
			await boot.waitFor(() => boot.loop.sent.some((message) => message.text === "turn one answer"));
			// Two turns leave an old prefix to summarize; a single turn can
			// legitimately produce "nothing to compact" at any keep window.
			await boot.loop.inbound(dmEvent({
				messageId: "cmd-compact-turn-two",
				text: `second question ${"context ".repeat(160)}`,
			}));
			await boot.waitFor(() => boot.loop.sent.some((message) => message.text === "turn two answer"));
			const row = (await conversations(boot)).find((entry) => entry.source === "gateway");
			if (row === undefined) throw new Error("no gateway conversation");
			expect(await boot.loop.inbound(dmEvent({ messageId: "cmd-compact", text: "/compact" }))).toEqual({ outcome: "command" });
			await boot.waitFor(async () => {
				const conversation = await boot.opened.harness.conversation(
					row.id as ConversationId,
					BACKGROUND_CONTEXT,
				);
				if (conversation === undefined) throw new Error("conversation vanished");
				const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
				return page.items.some((entry) => entry.kind === "pi.compaction");
			});
		} finally {
			await boot.shutdown();
		}
	});

	test("the loop receives the merged native menu at engine start", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({ gatewaySettings: SETTINGS });
		try {
			const menu = boot.loop.commands.at(-1);
			expect(menu).toBeDefined();
			const names = menu?.map((command) => command.name) ?? [];
			for (const name of ["new", "stop", "model", "thinking", "compact", "attach", "status", "home", "link", "pair", "help"]) {
				expect(names).toContain(name);
			}
			expect(new Set(names).size).toBe(names.length);
		} finally {
			await boot.shutdown();
		}
	});
});
