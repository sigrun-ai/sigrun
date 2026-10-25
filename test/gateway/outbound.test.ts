/**
 * Gateway outbound e2e (Task 5, spec §8.6 over the real boot): the
 * settled-run fan-out — an allowlisted DM's answer delivers to the
 * chat, a webui-originated run delivers to the bound chat (ruling 4),
 * chunking respects maxMessageLength, chat_gone marks the binding
 * dead, crash recovery resends an attempting entry with the marker,
 * and a revoked share unbinds and stops delivery.
 *
 * Tests own their literals: alice, "100000001", synthetic answers.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { bootGateway, type GatewayBoot } from "./harness.js";
import type { InboundEvent, OutboundMessage } from "../../src/extension.js";

/** The loop DM event factory (sender 100000001 → alice's allowlist). */
function dmEvent(over: { messageId: string; text?: string }): InboundEvent {
	return {
		messageId: over.messageId,
		chat: { chatId: "100000001", chatType: "dm" },
		sender: { id: "100000001", name: "Alice" },
		text: over.text ?? "hello gateway",
	};
}

/** The gateway settings: the loop channel, allowlist DMs, alice mapped. */
const GATEWAY_SETTINGS = {
	channels: {
		loop: {
			dm: "allowlist",
			allow: [{ sender: "100000001", user: "alice" }],
		},
	},
};

/** One row of `GET /v1/conversations`. */
interface ConversationRow {
	readonly id: number;
	readonly owner?: string;
	readonly source?: string;
}

/** alice's conversation list. */
async function listConversations(
	boot: GatewayBoot,
): Promise<readonly ConversationRow[]> {
	const response = await boot.app.inject({
		method: "GET",
		url: "/v1/conversations",
		headers: { authorization: `Bearer ${boot.tokens.alice}` },
	});
	if (response.statusCode !== 200) {
		throw new Error(`list returned ${response.statusCode}`);
	}
	return response.json().conversations as ConversationRow[];
}

/** The boot's gateway-sourced conversation row (alice's). */
async function gatewayConversation(
	boot: GatewayBoot,
): Promise<ConversationRow> {
	const rows = await listConversations(boot);
	const row = rows.find((row) => row.source === "gateway");
	if (row === undefined) throw new Error("no gateway conversation");
	return row;
}

/** This boot's sends (the fixture's `sent` array is file-global; the
 *  delta from the snapshot is this boot's). */
function sendsSince(boot: GatewayBoot, from: number): readonly OutboundMessage[] {
	return boot.loop.sent.slice(from);
}

/** Submit into alice's gateway conversation through the HTTP route. */
async function webuiSubmit(
	boot: GatewayBoot,
	conversationId: number,
	text: string,
): Promise<void> {
	const response = await boot.app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/submissions`,
		headers: {
			authorization: `Bearer ${boot.tokens.alice}`,
			"content-type": "application/json",
		},
		payload: { input: [{ type: "text", text }] },
	});
	if (response.statusCode !== 202) {
		throw new Error(`submit returned ${response.statusCode}`);
	}
}

describe("gateway outbound e2e (Task 5)", () => {
	test("an allowlisted DM's settled answer delivers once to the chat", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: GATEWAY_SETTINGS,
			responses: [fauxAssistantMessage("gateway answer")],
		});
		try {
			const sentBefore = boot.loop.sent.length;
			const outcome = await boot.loop.inbound(dmEvent({ messageId: "m1" }));
			expect(outcome).toEqual({ outcome: "admitted" });
			await boot.waitFor(() => {
				const sends = sendsSince(boot, sentBefore);
				return (
					sends.length === 1 &&
					sends[0]?.text === "gateway answer" &&
					sends[0]?.chat.chatId === "100000001"
				);
			});
			// Exactly one send, no edits (markdown caps, no stream yet —
			// Task 6 owns streaming).
			expect(sendsSince(boot, sentBefore)).toHaveLength(1);
			expect(boot.loop.edits).toHaveLength(0);
		} finally {
			await boot.shutdown();
		}
	});

	test("a 450-char answer with maxMessageLength 200 delivers as 3 sends", { timeout: 60_000 }, async () => {
		const answer = `${"a".repeat(90)}\n\n${"b".repeat(90)}\n\n${"c".repeat(90)}`;
		const boot = await bootGateway({
			gatewaySettings: GATEWAY_SETTINGS,
			responses: [fauxAssistantMessage(answer)],
		});
		// The caps override: the fixture reads globalThis.__loopCaps.
		(globalThis as { __loopCaps?: unknown }).__loopCaps = {
			chatTypes: ["dm", "group", "thread"],
			maxMessageLength: 200,
			format: "markdown",
		};
		try {
			const sentBefore = boot.loop.sent.length;
			await boot.loop.inbound(dmEvent({ messageId: "m1" }));
			await boot.waitFor(() => sendsSince(boot, sentBefore).length === 3);
			const sends = sendsSince(boot, sentBefore).map((m) => m.text);
			// The paragraphs split at their boundaries, every chunk ≤ 200.
			expect(sends).toEqual([
				"a".repeat(90),
				"b".repeat(90),
				"c".repeat(90),
			]);
			for (const text of sends) expect(text.length).toBeLessThanOrEqual(200);
		} finally {
			delete (globalThis as { __loopCaps?: unknown }).__loopCaps;
			await boot.shutdown();
		}
	});

	test("a webui-originated submit into a bound conversation delivers the final to the chat (ruling 4)", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: GATEWAY_SETTINGS,
			responses: [
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("webui answer"),
			],
		});
		try {
			// Bind the chat first (a DM run creates the binding).
			const sentBefore = boot.loop.sent.length;
			await boot.loop.inbound(dmEvent({ messageId: "m1" }));
			await boot.waitFor(() =>
				sendsSince(boot, sentBefore).some((m) => m.text === "first answer"),
			);
			const row = await gatewayConversation(boot);
			// The webui submit: whoever started the run, the chat is bound.
			const webuiBefore = boot.loop.sent.length;
			await webuiSubmit(boot, row.id, "from the webui");
			await boot.waitFor(() =>
				sendsSince(boot, webuiBefore).some((m) => m.text === "webui answer"),
			);
		} finally {
			await boot.shutdown();
		}
	});

	test("failNext(chat_gone) marks the binding dead; the next inbound clears it", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: GATEWAY_SETTINGS,
			responses: [fauxAssistantMessage("gone answer")],
		});
		try {
			// The classifyError override routes the fixture's marker error to
			// chat_gone for THIS boot (the failure itself is the fixture's
			// synthetic send error; its classification is what the worker
			// reads).
			(globalThis as { __loopClassify?: unknown }).__loopClassify = (
				_error: { kind?: string },
			) => "chat_gone" as const;
			const sentBefore = boot.loop.sent.length;
			boot.loop.failNext("send");
			await boot.loop.inbound(dmEvent({ messageId: "m1" }));
			// The run settles; the delivery fails chat_gone: the send never
			// lands and the binding goes dead. The proof: the ledger's entry
			// fails AND the bindings file records dead — read directly (the
			// send array cannot show a non-event).
			const bindingsPath = join(
				boot.dir,
				"state",
				"ext-gateway",
				"gateway",
				"bindings.json",
			);
			await boot.waitFor(async () => {
				const raw = JSON.parse(await readFile(bindingsPath, "utf8")) as {
					bindings: Record<string, { dead?: boolean }>;
				};
				return raw.bindings["loop:default:dm:100000001"]?.dead === true;
			});
			expect(
				sendsSince(boot, sentBefore).some((m) => m.text === "gone answer"),
			).toBe(false);
			// The next inbound (a fresh message) clears the dead flag and the
			// conversation is reused — the admission runs clean.
			const outcome = await boot.loop.inbound(
				dmEvent({ messageId: "m2", text: "still here" }),
			);
			expect(outcome).toEqual({ outcome: "admitted" });
			const after = JSON.parse(await readFile(bindingsPath, "utf8")) as {
				bindings: Record<string, { dead?: boolean }>;
			};
			expect(
				Object.hasOwn(after.bindings, "loop:default:dm:100000001"),
			).toBe(true);
			expect(
				after.bindings["loop:default:dm:100000001"]?.dead,
			).toBeUndefined();
		} finally {
			delete (globalThis as { __loopClassify?: unknown }).__loopClassify;
			await boot.shutdown();
		}
	});

	test("an attempting ledger entry written before boot resends with the marker", { timeout: 90_000 }, async () => {
		// A caller-owned stores dir: the crash wrote an `attempting` entry
		// into the engine's ledger BEFORE this boot.
		const storesDir = await mkdtemp(join(tmpdir(), "sigrun-gw-restart-"));
		try {
			const stateDir = join(storesDir, "state", "ext-gateway", "gateway");
			await mkdir(stateDir, { recursive: true });
			const ledgerFile = join(stateDir, "ledger.json");
			const entry = {
				channel: "loop",
				bindingKey: "loop:default:dm:100000001",
				chat: { chatId: "100000001", chatType: "dm" },
				kind: "final",
				message: {
					chat: { chatId: "100000001", chatType: "dm" },
					text: "pre-crash answer",
				},
				id: "crash-entry-1",
				state: "attempting",
				attempts: 1,
				createdAt: 1,
			};
			await writeFile(ledgerFile, JSON.stringify({ entries: [entry] }));
			const boot = await bootGateway({
				gatewaySettings: GATEWAY_SETTINGS,
				storesDir,
			});
			try {
				const sentBefore = boot.loop.sent.length;
				// The recovery resend carries the pinned marker line.
				await boot.waitFor(() => {
					const sends = sendsSince(boot, sentBefore);
					return (
						sends.length === 1 &&
						sends[0]?.text === "(resent after restart)\npre-crash answer"
					);
				});
			} finally {
				await boot.shutdown();
			}
		} finally {
			await rm(storesDir, { recursive: true, force: true });
		}
	});

	test("revoking sharing on a bound conversation unbinds and stops delivery", { timeout: 90_000 }, async () => {
		// The brief's shape: bind a chat through the STORE, not /attach —
		// bob's chat is bound (a pre-boot bindings.json write) to a
		// conversation alice owns with the default private sharing. Bob's
		// access is revoked at the check: the settle unbinds his chat and
		// enqueues nothing for it.
		const storesDir = await mkdtemp(join(tmpdir(), "sigrun-gw-revoke-"));
		const settings = {
			channels: {
				loop: {
					dm: "allowlist",
					allow: [
						{ sender: "100000001", user: "alice" },
						{ sender: "200000002", user: "bob" },
					],
				},
			},
		};
		const users = [
			{ user: "alice", admin: true },
			{ user: "bob" },
		];
		try {
			// alice seeds the conversation first: one boot over the shared dir
			// creates it and binds HER chat (her access stays write — the
			// owner).
			const first = await bootGateway({
				gatewaySettings: settings,
				responses: [fauxAssistantMessage("first answer")],
				storesDir,
				users,
			});
			try {
				const sentBefore = first.loop.sent.length;
				await first.loop.inbound(dmEvent({ messageId: "m1" }));
				await first.waitFor(() =>
					sendsSince(first, sentBefore).some((m) => m.text === "first answer"),
				);
				const row = await gatewayConversation(first);
				// Bind BOB's chat to alice's conversation through the store file
				// (the pre-Task-7 /attach shape the brief names): alice owns it,
				// sharing private (the default) — bob has NO access.
				const bindingsPath = join(
					storesDir,
					"state",
					"ext-gateway",
					"gateway",
					"bindings.json",
				);
				const bindings = JSON.parse(
					await readFile(bindingsPath, "utf8"),
				) as { bindings: Record<string, unknown> };
				bindings.bindings["loop:default:dm:200000002"] = {
					conversationId: row.id,
					chat: { chatId: "200000002", chatType: "dm" },
					boundAt: Date.now(),
					previous: [],
				};
				await writeFile(bindingsPath, JSON.stringify(bindings, null, "	"));
			} finally {
				await first.shutdown();
			}
			// The second boot: alice submits through the webui; the settle
			// re-checks BOTH bindings. Bob's is revoked → unbind + skip.
			const second = await bootGateway({
				gatewaySettings: settings,
				responses: [fauxAssistantMessage("after revoke")],
				storesDir,
				users,
			});
			try {
				const revokedBefore = second.loop.sent.length;
				const row = await gatewayConversation(second);
				await webuiSubmit(second, row.id, "after the revoke");
				// The run settles; alice's chat delivers, bob's never does.
				await second.waitFor(() =>
					sendsSince(second, revokedBefore).some(
						(m) => m.text === "after revoke",
					),
				);
				const bobSends = sendsSince(second, revokedBefore).filter(
					(m) => m.chat.chatId === "200000002",
				);
				expect(bobSends).toEqual([]);
				// The binding is GONE (the unbind path ran).
				const bindingsPath = join(
					storesDir,
					"state",
					"ext-gateway",
					"gateway",
					"bindings.json",
				);
				const after = JSON.parse(
					await readFile(bindingsPath, "utf8"),
				) as { bindings: Record<string, unknown> };
				expect(
					Object.hasOwn(after.bindings, "loop:default:dm:200000002"),
				).toBe(false);
			} finally {
				await second.shutdown();
			}
		} finally {
			await rm(storesDir, { recursive: true, force: true });
		}
	});
});
