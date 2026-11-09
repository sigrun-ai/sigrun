/**
 * Interactions in chat e2e (Task 9): the real loader, engine, delivery
 * ledger, loopback adapter, generic answer route and fixture gate.
 * Users/platform ids are synthetic (alice/bob, "100000001").
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { PathLike } from "node:fs";
import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ActionEvent, InboundEvent, OutboundMessage } from "../../src/extension.js";
import { bootGateway, type GatewayBoot } from "./harness.js";
import { selfPackageRoot } from "../../src/harness/packages.js";
import { resolveWorkerEntry, testLauncher } from "../../src/sandbox/pool.js";

const GATE_SPECIFIER = pathToFileURL(join(import.meta.dirname, "..", "fixtures", "fixture-gate", "index.js")).href;
const SECRET_SPECIFIER = pathToFileURL(join(import.meta.dirname, "..", "fixtures", "fixture-secret-interaction", "index.js")).href;
const SETTINGS = {
	channels: {
		loop: {
			dm: "allowlist",
			allow: [
				{ sender: "100000001", user: "alice" },
				{ sender: "200000002", user: "bob" },
			],
			groups: [{ chat: "300000003", owner: "alice", members: "linked", mention: "always" }],
		},
	},
};

const ISOLATION = {
	isolationProbe: async () => ({ available: true, abi: 6 }),
	sandboxLauncher: testLauncher(resolveWorkerEntry(selfPackageRoot()!)),
};

function event(over: Partial<InboundEvent> & { messageId: string }): InboundEvent {
	return {
		chat: { chatId: "100000001", chatType: "dm" },
		sender: { id: "100000001", name: "Alice" },
		text: "run the gated tool",
		...over,
	};
}

function script(boot: GatewayBoot): void {
	boot.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("guarded_write", { path: "notes.txt" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("gate finished"),
	]);
}

async function boot(users: readonly { user: string; admin?: boolean }[] = [{ user: "alice", admin: true }], extra = true): Promise<GatewayBoot> {
	return await bootGateway({
		...ISOLATION,
		users,
		gatewaySettings: SETTINGS,
		...(extra ? { extraExtensions: [GATE_SPECIFIER] } : {}),
	});
}

interface ConversationRow { id: number; owner?: string; source?: string }
interface InteractionRow { callId: string; kind: string; status?: string }

async function conversations(boot: GatewayBoot, token: string): Promise<ConversationRow[]> {
	const response = await boot.app.inject({ method: "GET", url: "/v1/conversations", headers: { authorization: `Bearer ${token}` } });
	if (response.statusCode !== 200) throw new Error(`conversation list ${response.statusCode}`);
	return response.json().conversations as ConversationRow[];
}

async function boundConversation(boot: GatewayBoot): Promise<ConversationRow> {
	await boot.waitFor(async () => (await conversations(boot, boot.tokens.alice)).some((row) => row.source === "gateway"));
	const row = (await conversations(boot, boot.tokens.alice)).find((candidate) => candidate.source === "gateway");
	if (row === undefined) throw new Error("no bound conversation");
	return row;
}

async function pending(boot: GatewayBoot, id: number, token = boot.tokens.alice): Promise<InteractionRow> {
	await boot.waitFor(async () => {
		const response = await boot.app.inject({ method: "GET", url: `/v1/conversations/${id}/interactions`, headers: { authorization: `Bearer ${token}` } });
		return response.statusCode === 200 && (response.json().interactions as unknown[]).length > 0;
	});
	const response = await boot.app.inject({ method: "GET", url: `/v1/conversations/${id}/interactions`, headers: { authorization: `Bearer ${token}` } });
	const rows = response.json().interactions as InteractionRow[];
	if (rows[0] === undefined) throw new Error("no pending interaction");
	return rows[0];
}

async function toolResult(boot: GatewayBoot, id: number): Promise<{ content?: { text?: string }[] } | undefined> {
	const response = await boot.app.inject({ method: "GET", url: `/v1/conversations/${id}`, headers: { authorization: `Bearer ${boot.tokens.alice}` } });
	const entries = response.json().entries as { kind: string; model?: { role: string; toolName?: string; content?: { text?: string }[] }[] }[];
	for (const entry of entries) {
		if (entry.kind !== "pi.tool-result") continue;
		const result = entry.model?.find((message) => message.role === "toolResult" && message.toolName === "guarded_write");
		if (result !== undefined) return result;
	}
	return undefined;
}

function prompt(boot: GatewayBoot, chatId = "100000001"): OutboundMessage {
	const found = [...boot.loop.sent].reverse().find((message) => message.chat.chatId === chatId && message.buttons !== undefined);
	if (found === undefined) throw new Error(`no button prompt in ${chatId}`);
	return found;
}

async function waitPrompt(boot: GatewayBoot, chatId = "100000001"): Promise<OutboundMessage> {
	await boot.waitFor(() => boot.loop.sent.some((message) => message.chat.chatId === chatId && message.buttons !== undefined));
	// Sending precedes receipt persistence by a microtask. Stage 8 needs
	// the durable ref, not merely the platform-visible prompt.
	await boot.waitFor(async () => {
		const text = await readFile(join(boot.dir, "state", "ext-gateway", "gateway", "prompts.json") as PathLike, "utf8").catch(() => "{}");
		const state = JSON.parse(text) as {
			prompts?: { ref?: { chat?: { chatId?: string }; messageId?: string } }[];
		};
		return state.prompts?.some((row) => row.ref?.chat?.chatId === chatId && row.ref.messageId !== "") === true;
	});
	return prompt(boot, chatId);
}

async function tap(boot: GatewayBoot, message: OutboundMessage, index = 0, sender = "100000001"): Promise<void> {
	const button = message.buttons?.[0]?.[index];
	if (button === undefined) throw new Error("missing interaction button");
	const action: ActionEvent = {
		chat: message.chat,
		sender: { id: sender },
		data: button.data,
	};
	await boot.loop.tap(action);
}

describe("gateway interactions e2e (Task 9)", () => {
	test("a button tap allows the gated tool and settlement edits the prompt", { timeout: 60_000 }, async () => {
		const b = await boot();
		try {
			script(b);
			await b.loop.inbound(event({ messageId: "interaction-button-1" }));
			const conversation = await boundConversation(b);
			await pending(b, conversation.id);
			const sent = await waitPrompt(b);
			await tap(b, sent, 0);
			await b.waitFor(async () => (await toolResult(b, conversation.id))?.content?.some((part) => part.text?.includes("guarded-write-executed:notes.txt")) === true);
			await b.waitFor(() => b.loop.edits.length > 0);
			expect(b.loop.edits.at(-1)?.message.buttons).toBeUndefined();
			expect(b.loop.edits.at(-1)?.message.text).toContain("allow");
		} finally { await b.shutdown(); }
	});

	test("a numbered reply answers the only pending choice", { timeout: 60_000 }, async () => {
		const b = await boot();
		try {
			script(b);
			await b.loop.inbound(event({ messageId: "interaction-number-1" }));
			const conversation = await boundConversation(b);
			await pending(b, conversation.id);
			await waitPrompt(b);
			const outcome = await b.loop.inbound(event({ messageId: "interaction-number-2", text: "1" }));
			expect(outcome).toEqual({ outcome: "command" });
			await b.waitFor(async () => (await toolResult(b, conversation.id))?.content?.some((part) => part.text?.includes("guarded-write-executed")) === true);
		} finally { await b.shutdown(); }
	});

	test("an unlinked group member is refused and cannot answer", { timeout: 60_000 }, async () => {
		const b = await boot();
		try {
			script(b);
			await b.loop.inbound(event({
				messageId: "interaction-group-1",
				chat: { chatId: "300000003", chatType: "group" },
			}));
			const conversation = await boundConversation(b);
			await pending(b, conversation.id);
			const sent = await waitPrompt(b, "300000003");
			const before = (await b.app.inject({ method: "GET", url: `/v1/conversations/${conversation.id}/interactions`, headers: { authorization: `Bearer ${b.tokens.alice}` } })).json().interactions.length;
			await tap(b, sent, 0, "400000004");
			await b.waitFor(() => b.loop.sent.some((message) => message.text.includes("write access")));
			const after = (await b.app.inject({ method: "GET", url: `/v1/conversations/${conversation.id}/interactions`, headers: { authorization: `Bearer ${b.tokens.alice}` } })).json().interactions.length;
			expect(after).toBe(before);
		} finally { await b.shutdown(); }
	});

	test("a secret form renders the webui pointer, never a chat answer control", { timeout: 60_000 }, async () => {
		const b = await bootGateway({
			...ISOLATION,
			gatewaySettings: SETTINGS,
			publicUrl: "https://sigrun.example.invalid",
			extraExtensions: [SECRET_SPECIFIER],
		});
		try {
			await b.loop.inbound(event({ messageId: "secret-home-1", text: "establish home" }));
			await b.waitFor(() => b.loop.sent.some((message) => message.text === "gateway answer"));
			const created = await b.app.inject({ method: "POST", url: "/v1/conversations", headers: { authorization: `Bearer ${b.tokens.alice}` } });
			const id = (created.json() as ConversationRow).id;
			await b.opened.seamHosts.get("fixture-secret-interaction")?.seedInteraction(
				id as ConversationId,
				{
					kind: "fixture.secret", callId: "secret-call", status: "pending", createdAt: Date.now(),
					body: { v: 1, root: { type: "form", id: "secret-form", bind: "/values", mode: "submit", children: [{ type: "secret", name: "token", label: "Token" }] } },
				},
				BACKGROUND_CONTEXT,
			);
			await b.waitFor(() => b.loop.sent.some((message) => message.text.includes("Answer this in the webui")));
			const sent = b.loop.sent.find((message) => message.text.includes("Answer this in the webui"));
			expect(sent?.buttons).toBeUndefined();
			expect(sent?.text).toContain(`https://sigrun.example.invalid/#/c/${id}`);
		} finally { await b.shutdown(); }
	});

	test("an unbound gate reaches both write users' home chats", { timeout: 60_000 }, async () => {
		const b = await boot([{ user: "alice", admin: true }, { user: "bob" }]);
		try {
			await b.loop.inbound(event({ messageId: "home-alice-1", text: "establish alice home" }));
			await b.waitFor(() => b.loop.sent.some((message) => message.text === "gateway answer"));
			// Sending as Bob is enough to establish his home DM; no second
			// scripted model response is needed for this notification-only setup.
			await b.loop.inbound(event({
				messageId: "home-bob-1", text: "establish bob home",
				chat: { chatId: "200000002", chatType: "dm" },
				sender: { id: "200000002", name: "Bob" },
			}));
			await b.waitFor(() => b.loop.sent.some((message) => message.text.includes("model_error")), 1000).catch(() => undefined);
			await b.opened.identity.users.update("bob", { admin: true });
			b.faux.setResponses([fauxAssistantMessage("bob home ready")]);
			await b.loop.inbound(event({
				messageId: "home-bob-link-2", text: "confirm bob home",
				chat: { chatId: "200000002", chatType: "dm" },
				sender: { id: "200000002", name: "Bob" },
			}));
			await b.waitFor(() => b.loop.sent.some((message) => message.chat.chatId === "200000002" && message.text === "bob home ready"));
			script(b);
			const created = await b.app.inject({ method: "POST", url: "/v1/conversations", headers: { authorization: `Bearer ${b.tokens.alice}` } });
			const id = (created.json() as ConversationRow).id;
			const submitted = await b.app.inject({
				method: "POST", url: `/v1/conversations/${id}/submissions`,
				headers: { authorization: `Bearer ${b.tokens.alice}`, "content-type": "application/json" },
				payload: { input: [{ type: "text", text: "run the gated tool" }] },
			});
			expect(submitted.statusCode).toBe(202);
			await pending(b, id);
			await waitPrompt(b, "100000001");
			await b.waitFor(() => b.loop.sent.some((message) => message.chat.chatId === "200000002" && message.text.includes("Allow the gated tool call")), 1000).catch((error: unknown) => {
				throw new Error(`home prompts missing: ${JSON.stringify(b.loop.sent.map((message) => ({ chat: message.chat.chatId, text: message.text })))}`, { cause: error });
			});
			await waitPrompt(b, "200000002");
		} finally { await b.shutdown(); }
	});

	test("a webui answer edits chat; a later stale tap replies with the outcome", { timeout: 60_000 }, async () => {
		const b = await boot();
		try {
			script(b);
			await b.loop.inbound(event({ messageId: "interaction-stale-1" }));
			const conversation = await boundConversation(b);
			const gate = await pending(b, conversation.id);
			const sent = await waitPrompt(b);
			const answer = await b.app.inject({
				method: "POST", url: `/v1/conversations/${conversation.id}/interactions/${gate.callId}/answer`,
				headers: { authorization: `Bearer ${b.tokens.alice}`, "content-type": "application/json" },
				payload: { values: { decision: "allow" } },
			});
			expect(answer.statusCode).toBe(200);
			await b.waitFor(() => b.loop.edits.length > 0);
			expect(b.loop.edits.at(-1)?.message.buttons).toBeUndefined();
			await tap(b, sent, 0);
			// The tap is already terminal; its outcome reply may arrive before
			// the preceding assertion in a heavily loaded full-suite run.
			expect(b.loop.sent.some((message) => message.text.includes("Already answered"))).toBe(true);
		} finally { await b.shutdown(); }
	});
});
