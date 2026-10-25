/**
 * Gateway access e2e (Task 4, spec §8.2/§10 over the real boot): the
 * claimed gate, the pairing round trip through the HTTP command route,
 * pairing limits, self-linking, and the C8 proxy-admin approve.
 *
 * Tests own their literals: alice/bob, "100000001", synthetic codes
 * read at runtime — no fixture asserts a literal code value.
 */

import { describe, expect, test } from "vitest";
import { bootGateway, type GatewayBoot } from "./harness.js";
import type { InboundEvent } from "../../src/extension.js";

/** The loop DM event factory. */
function dmEvent(
	senderId: string,
	messageId: string,
	text = "hello gateway",
	name = "Sender",
): InboundEvent {
	return {
		messageId,
		chat: { chatId: senderId, chatType: "dm" },
		sender: { id: senderId, name },
		text,
	};
}

/** The pairing gateway settings (bob seeded as a plain user). */
const PAIRING_SETTINGS = {
	channels: { loop: { dm: "pairing" } },
};

/**
 * Extract the 8-char code from the requester's LATEST pairing reply —
 * the loopback fixture's `sent` array is module-global and accumulates
 * across boots in one file, so the LAST reply for a chat id is the
 * current boot's.
 */
function codeFromReplies(boot: GatewayBoot, senderId: string): string {
	const reply = boot.loop.sent
		.filter((message) => message.chat.chatId === senderId)
		.at(-1);
	const code = reply?.text.match(/[A-Z2-9]{8}/)?.[0];
	if (code === undefined) {
		throw new Error(`no pairing code in the reply for ${senderId}`);
	}
	return code;
}

/** One row of GET /v1/conversations. */
interface ConversationRow {
	readonly id: number;
	readonly owner?: string;
	readonly source?: string;
}

/** alice's conversation list. */
async function listConversations(
	boot: GatewayBoot,
	token: string,
): Promise<readonly ConversationRow[]> {
	const response = await boot.app.inject({
		method: "GET",
		url: "/v1/conversations",
		headers: { authorization: `Bearer ${token}` },
	});
	if (response.statusCode !== 200) {
		throw new Error(`list returned ${response.statusCode}`);
	}
	return response.json().conversations as ConversationRow[];
}

/** Run /pair through the invoke route as `token`. */
async function runPairCommand(
	boot: GatewayBoot,
	token: string,
	args: string,
): Promise<{ status: number; body: { notice?: string } }> {
	// The command runs in alice's own conversation (WRITE-gated: create
	// one first as the invoking user).
	const created = await boot.app.inject({
		method: "POST",
		url: "/v1/conversations",
		headers: { authorization: `Bearer ${token}` },
	});
	if (created.statusCode !== 201) {
		throw new Error(`conversation create returned ${created.statusCode}`);
	}
	const conversationId = (created.json() as ConversationRow).id;
	const response = await boot.app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/commands/pair`,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		payload: { args },
	});
	return {
		status: response.statusCode,
		body: response.json() as { notice?: string },
	};
}

describe("gateway access e2e (Task 4)", () => {
	test("an unclaimed setup drops inbound with no reply", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: PAIRING_SETTINGS,
			unclaimed: true,
		});
		try {
			const outcome = await boot.loop.inbound(dmEvent("100000001", "m1"));
			expect(outcome).toEqual({ outcome: "dropped" });
			expect(boot.loop.sent).toEqual([]);
		} finally {
			await boot.shutdown();
		}
	});

	test("unknown DM → pairing reply → /pair approve from alice → bob admitted as owner", { timeout: 90_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: PAIRING_SETTINGS,
			users: [
				{ user: "alice", admin: true },
				{ user: "bob" },
			],
		});
		try {
			// bob's platform account DMs: one pairing reply, no submission.
			const first = await boot.loop.inbound(dmEvent("200000002", "m1", "pair me", "Bob"));
			expect(first).toEqual({ outcome: "dropped" });
			const code = codeFromReplies(boot, "200000002");
			// No conversation was created for the message.
			let rows = await listConversations(boot, boot.tokens.alice);
			expect(rows.filter((row) => row.source === "gateway")).toHaveLength(0);

			// alice approves through the webui command route.
			const approve = await runPairCommand(
				boot,
				boot.tokens.alice,
				`approve ${code} bob`,
			);
			expect(approve.status).toBe(200);
			expect(approve.body.notice).toContain("bob");
			// The requester got the "linked" message in their DM.
			await boot.waitFor(() => {
				const linked = boot.loop.sent
					.filter((m) => m.chat.chatId === "200000002")
					.at(-1);
				return linked !== undefined && linked.text.includes("bob");
			});

			// bob's NEXT message is admitted with owner bob.
			const second = await boot.loop.inbound(dmEvent("200000002", "m2", "thanks"));
			expect(second).toEqual({ outcome: "admitted" });
			await boot.waitFor(async () => {
				rows = await listConversations(boot, boot.tokens.bob);
				return rows.some(
					(row) => row.source === "gateway" && row.owner === "bob",
				);
			});

			// A plain user cannot approve: carol's request stands, her tap
			// through the command route is refused.
			const third = await boot.loop.inbound(dmEvent("300000003", "m3", "me too", "Carol"));
			expect(third).toEqual({ outcome: "dropped" });
			const carolCode = codeFromReplies(boot, "300000003");
			const refused = await runPairCommand(
				boot,
				boot.tokens.bob,
				`approve ${carolCode} bob`,
			);
			expect(refused.body.notice).toContain("admin");
		} finally {
			await boot.shutdown();
		}
	});

	test("pairing limits through the wire: a second request from one sender gets no reply", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: PAIRING_SETTINGS,
			users: [
				{ user: "alice", admin: true },
				{ user: "bob" },
			],
		});
		try {
			await boot.loop.inbound(dmEvent("200000002", "m1", "pair me", "Bob"));
			expect(codeFromReplies(boot, "200000002")).toHaveLength(8);
			const repliesBefore = boot.loop.sent.length;
			const second = await boot.loop.inbound(dmEvent("200000002", "m2", "again", "Bob"));
			expect(second).toEqual({ outcome: "dropped" });
			// No NEW reply: the limited request is silent.
			expect(boot.loop.sent.length).toBe(repliesBefore);
		} finally {
			await boot.shutdown();
		}
	});

	test("self-link round trip: /link loop via HTTP → code → loop DM → linked to alice", { timeout: 90_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: PAIRING_SETTINGS,
			users: [{ user: "alice", admin: true }],
		});
		try {
			// alice runs /link loop in her webui conversation.
			const created = await boot.app.inject({
				method: "POST",
				url: "/v1/conversations",
				headers: { authorization: `Bearer ${boot.tokens.alice}` },
			});
			const conversationId = (created.json() as ConversationRow).id;
			const link = await boot.app.inject({
				method: "POST",
				url: `/v1/conversations/${conversationId}/commands/link`,
				headers: {
					authorization: `Bearer ${boot.tokens.alice}`,
					"content-type": "application/json",
				},
				payload: { args: "loop" },
			});
			expect(link.statusCode).toBe(200);
			const notice = (link.json() as { notice?: string }).notice ?? "";
			const code = notice.match(/[A-Z2-9]{8}/)?.[0];
			expect(code).toBeDefined();

			// The platform DM redeems it.
			const outcome = await boot.loop.inbound(
				dmEvent("100000001", "m1", `/link ${code}`, "Alice"),
			);
			expect(outcome).toEqual({ outcome: "command" });
			const reply = boot.loop.sent.at(-1);
			expect(reply?.text).toContain("alice");

			// The link is visible through core's own account-link route.
			const accounts = await boot.app.inject({
				method: "GET",
				url: "/v1/auth/accounts",
				headers: { authorization: `Bearer ${boot.tokens.alice}` },
			});
			expect(accounts.statusCode).toBe(200);
			expect(accounts.json()).toEqual({
				accounts: [expect.objectContaining({
					provider: "chat:loop",
					subject: "100000001",
					user: "alice",
					via: "self",
				})],
			});

			// The link admits: alice's next DM creates her gateway conversation.
			const admitted = await boot.loop.inbound(dmEvent("100000001", "m2"));
			expect(admitted).toEqual({ outcome: "admitted" });
			await boot.waitFor(async () => {
				const rows = await listConversations(boot, boot.tokens.alice);
				return rows.some(
					(row) => row.source === "gateway" && row.owner === "alice",
				);
			});
		} finally {
			await boot.shutdown();
		}
	});

	test("DELETE /v1/auth/accounts revokes a self-link and the next DM pairs again", { timeout: 90_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: PAIRING_SETTINGS,
			users: [{ user: "alice", admin: true }],
		});
		try {
			const created = await boot.app.inject({
				method: "POST",
				url: "/v1/conversations",
				headers: { authorization: `Bearer ${boot.tokens.alice}` },
			});
			const conversationId = (created.json() as ConversationRow).id;
			const link = await boot.app.inject({
				method: "POST",
				url: `/v1/conversations/${conversationId}/commands/link`,
				headers: {
					authorization: `Bearer ${boot.tokens.alice}`,
					"content-type": "application/json",
				},
				payload: { args: "loop" },
			});
			const code = ((link.json() as { notice?: string }).notice ?? "").match(
				/[A-Z2-9]{8}/,
			)?.[0];
			if (code === undefined) throw new Error("test setup: no link code");
			expect(await boot.loop.inbound(
				dmEvent("100000001", "m1", `/link ${code}`, "Alice"),
			)).toEqual({ outcome: "command" });
			expect(await boot.loop.inbound(dmEvent("100000001", "m2"))).toEqual({
				outcome: "admitted",
			});
			const removed = await boot.app.inject({
				method: "DELETE",
				url: "/v1/auth/accounts?provider=chat%3Aloop&subject=100000001",
				headers: { authorization: `Bearer ${boot.tokens.alice}` },
			});
			expect(removed.statusCode).toBe(204);
			const after = await boot.app.inject({
				method: "GET",
				url: "/v1/auth/accounts",
				headers: { authorization: `Bearer ${boot.tokens.alice}` },
			});
			expect(after.json()).toEqual({ accounts: [] });
			expect(await boot.loop.inbound(
				dmEvent("100000001", "m3", "hello again"),
			)).toEqual({ outcome: "dropped" });
			expect(codeFromReplies(boot, "100000001")).toHaveLength(8);
		} finally {
			await boot.shutdown();
		}
	});

	test("/link <code> in a group is refused and the code then fails in a DM", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: PAIRING_SETTINGS,
			users: [{ user: "alice", admin: true }],
		});
		try {
			const created = await boot.app.inject({
				method: "POST",
				url: "/v1/conversations",
				headers: { authorization: `Bearer ${boot.tokens.alice}` },
			});
			const conversationId = (created.json() as ConversationRow).id;
			const link = await boot.app.inject({
				method: "POST",
				url: `/v1/conversations/${conversationId}/commands/link`,
				headers: {
					authorization: `Bearer ${boot.tokens.alice}`,
					"content-type": "application/json",
				},
				payload: { args: "loop" },
			});
			const code = ((link.json() as { notice?: string }).notice ?? "").match(
				/[A-Z2-9]{8}/,
			)?.[0];
			if (code === undefined) throw new Error("test setup: no link code");

			const groupOutcome = await boot.loop.inbound({
				messageId: "g1",
				chat: { chatId: "-100000000002", chatType: "group", title: "Dev" },
				sender: { id: "100000001", name: "Alice" },
				text: `/link ${code}`,
			});
			expect(groupOutcome).toEqual({ outcome: "command" });
			expect(boot.loop.sent.at(-1)?.text).toBe("send this in a direct message");

			// The exposed code is dead in a DM.
			const dmOutcome = await boot.loop.inbound(
				dmEvent("100000001", "m1", `/link ${code}`, "Alice"),
			);
			expect(dmOutcome).toEqual({ outcome: "command" });
			expect(boot.loop.sent.at(-1)?.text).not.toContain("alice");
			expect(boot.loop.sent.at(-1)?.text.toLowerCase()).toContain("code");
		} finally {
			await boot.shutdown();
		}
	});

	test("selfLink: false on an allowlist channel drops /link", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: {
				channels: {
					loop: {
						dm: "allowlist",
						selfLink: false,
						allow: [{ sender: "100000001", user: "alice" }],
					},
				},
			},
			users: [{ user: "alice", admin: true }],
		});
		try {
			// The fixture's sent array is file-global: snapshot so this boot's
			// replies are the delta.
			const sentBefore = boot.loop.sent.length;
			const created = await boot.app.inject({
				method: "POST",
				url: "/v1/conversations",
				headers: { authorization: `Bearer ${boot.tokens.alice}` },
			});
			const conversationId = (created.json() as ConversationRow).id;
			const link = await boot.app.inject({
				method: "POST",
				url: `/v1/conversations/${conversationId}/commands/link`,
				headers: {
					authorization: `Bearer ${boot.tokens.alice}`,
					"content-type": "application/json",
				},
				payload: { args: "loop" },
			});
			const code = ((link.json() as { notice?: string }).notice ?? "").match(
				/[A-Z2-9]{8}/,
			)?.[0];
			if (code === undefined) throw new Error("test setup: no link code");

			// An UNLINKED sender's /link drops (no selfLink shortcut, no
			// allowlist entry — the access policy owns it).
			const outcome = await boot.loop.inbound(
				dmEvent("200000002", "m1", `/link ${code}`, "Bob"),
			);
			expect(outcome).toEqual({ outcome: "dropped" });
			expect(boot.loop.sent.length).toBe(sentBefore);
		} finally {
			await boot.shutdown();
		}
	});

	test("an admins-group proxy user (C8) can approve; a plain proxy user cannot", { timeout: 90_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: PAIRING_SETTINGS,
			users: [{ user: "alice", admin: true }, { user: "pat" }],
			authEnv: {
				SIGRUN_AUTH: "proxy",
				SIGRUN_AUTH_TRUSTED_PROXIES: "10.42.0.0/16",
			},
			serverAuth: {
				adminGroups: ["admins"],
				// The proxy secret header (M1's guard: proxy isolation needs a
				// shared secret before it activates).
				proxy: { secretHeader: "x-sigrun-proxy-secret" },
			},
			// M1's admission guard refuses a third user while the sandbox is
			// unavailable; this e2e exercises the PROXY+GROUP pipeline, not
			// isolation, so the probe reports available.
			isolationProbe: async () => ({ available: true, abi: 6 }),
		});
		try {
			await boot.loop.inbound(dmEvent("200000002", "m1", "pair me", "Bob"));
			const code = codeFromReplies(boot, "200000002");

			// pat carries the admins group through the proxy headers: the
			// write-through stamps groupAdmin on the record (C8), and the
			// command's principal carries EFFECTIVE admin.
			const proxyHeaders = {
				"remote-user": "pat",
				"remote-groups": "users,admins",
			};
			const created = await boot.app.inject({
				method: "POST",
				url: "/v1/conversations",
				remoteAddress: "10.42.3.4",
				headers: proxyHeaders,
			});
			expect(created.statusCode).toBe(201);
			const conversationId = (created.json() as ConversationRow).id;
			const approve = await boot.app.inject({
				method: "POST",
				url: `/v1/conversations/${conversationId}/commands/pair`,
				remoteAddress: "10.42.3.4",
				headers: {
					...proxyHeaders,
					"content-type": "application/json",
				},
				payload: { args: `approve ${code} pat` },
			});
			expect(approve.statusCode).toBe(200);
			expect((approve.json() as { notice?: string }).notice).toContain("pat");

			// A plain proxy user (no admin group) is refused.
			await boot.loop.inbound(dmEvent("300000003", "m2", "me too", "Carol"));
			const carolCode = codeFromReplies(boot, "300000003");
			const plainHeaders = { "remote-user": "quinn", "remote-groups": "users" };
			const created2 = await boot.app.inject({
				method: "POST",
				url: "/v1/conversations",
				remoteAddress: "10.42.3.4",
				headers: plainHeaders,
			});
			const conversationId2 = (created2.json() as ConversationRow).id;
			console.log("DEBUG created2:", created2.statusCode, created2.body, "conv2:", (created2.json() as ConversationRow).id);
			const refused = await boot.app.inject({
				method: "POST",
				url: `/v1/conversations/${conversationId2}/commands/pair`,
				remoteAddress: "10.42.3.4",
				headers: {
					...plainHeaders,
					"content-type": "application/json",
				},
				payload: { args: `approve ${carolCode} quinn` },
			});
			expect(refused.statusCode).toBe(200);
			expect((refused.json() as { notice?: string }).notice).toContain("admin");
		} finally {
			await boot.shutdown();
		}
	});

	test("pending pairing appears in GET status without the code", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: PAIRING_SETTINGS,
			users: [{ user: "alice", admin: true }, { user: "bob" }],
		});
		try {
			await boot.loop.inbound(dmEvent("200000002", "m1", "pair me", "Bob"));
			const code = codeFromReplies(boot, "200000002");
			const response = await boot.app.inject({
				method: "GET",
				url: "/v1/ext/gateway/status",
				headers: { authorization: `Bearer ${boot.tokens.alice}` },
			});
			expect(response.statusCode).toBe(200);
			const body = response.json() as {
				pairing: { channel: string; sender: string; createdAt: number }[];
			};
			expect(body.pairing).toHaveLength(1);
			expect(body.pairing[0]?.channel).toBe("loop");
			// The hashed sender is 8 hex chars, never the raw platform id.
			expect(body.pairing[0]?.sender).toMatch(/^[0-9a-f]{8}$/);
			// The code NEVER appears in operator output.
			expect(JSON.stringify(body)).not.toContain(code);
		} finally {
			await boot.shutdown();
		}
	});
});
