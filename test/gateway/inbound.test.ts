/**
 * Gateway inbound e2e (Task 3, spec §8.4 over the real boot): the
 * loopback fixture's DM pipeline — allowlisted admission creates a
 * `source: "gateway"` conversation, the in-flight dedupe (Review Focus
 * 1) admits one submission under a concurrent redelivery, redelivery
 * after a full gateway restart is a no-op (the persisted seen set), and
 * a bound archived conversation unarchives on the next message.
 *
 * Tests own their literals: alice, "100000001", no real tokens.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bootGateway, type GatewayBoot } from "./harness.js";

/** The loopback DM event factory (sender 100000001 → alice's allowlist). */
function dmEvent(over: { messageId: string; text?: string }): {
	messageId: string;
	chat: { chatId: string; chatType: "dm" };
	sender: { id: string; name: string };
	text: string;
} {
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
	readonly archived: boolean;
}

/** The caller's conversation list (alice's token). */
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

/** How many `pi.user` submission entries the conversation's view holds. */
async function submissionCount(
	boot: GatewayBoot,
	conversationId: number,
): Promise<number> {
	const response = await boot.app.inject({
		method: "GET",
		url: `/v1/conversations/${conversationId}`,
		headers: { authorization: `Bearer ${boot.tokens.alice}` },
	});
	if (response.statusCode !== 200) {
		throw new Error(`view returned ${response.statusCode}`);
	}
	const view = response.json() as {
		readonly entries?: readonly { readonly kind: string }[];
	};
	return (
		view.entries?.filter((entry) => entry.kind === "pi.user").length ?? 0
	);
}

describe("gateway inbound e2e (Task 3)", () => {
	test("an allowlisted loop DM creates a gateway conversation and admits the submission", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({ gatewaySettings: GATEWAY_SETTINGS });
		try {
			const outcome = await boot.loop.inbound(dmEvent({ messageId: "m1" }));
			expect(outcome).toEqual({ outcome: "admitted" });
			await boot.waitFor(async () => {
				const rows = await listConversations(boot);
				return rows.some(
					(row) => row.source === "gateway" && row.owner === "alice",
				);
			});
			const rows = await listConversations(boot);
			const gatewayRow = rows.find((row) => row.source === "gateway");
			expect(gatewayRow).toBeDefined();
			expect(gatewayRow?.owner).toBe("alice");
			// A second message in the same chat reuses the conversation.
			const before = rows.filter((row) => row.source === "gateway").length;
			await boot.loop.inbound(dmEvent({ messageId: "m2", text: "second" }));
			await boot.waitFor(async () => {
				const next = await listConversations(boot);
				return (
					next.filter((row) => row.source === "gateway").length === before
				);
			});
		} finally {
			await boot.shutdown();
		}
	});

	test("the same messageId delivered concurrently admits exactly once (Review Focus 1)", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({ gatewaySettings: GATEWAY_SETTINGS });
		try {
			const [a, b] = await Promise.all([
				boot.loop.inbound(dmEvent({ messageId: "m1" })),
				boot.loop.inbound(dmEvent({ messageId: "m1" })),
			]);
			const outcomes = [a.outcome, b.outcome].sort();
			expect(outcomes).toEqual(["admitted", "dropped"]);
			await boot.waitFor(async () => {
				const rows = await listConversations(boot);
				return rows.filter((row) => row.source === "gateway").length === 1;
			});
			// The settled history holds exactly ONE submission for the id.
			const rows = await listConversations(boot);
			const row = rows.find((r) => r.source === "gateway");
			expect(row).toBeDefined();
			await boot.waitFor(async () => {
				return (await submissionCount(boot, row!.id)) === 1;
			});
		} finally {
			await boot.shutdown();
		}
	});

	test("redelivery after a gateway restart submits nothing new (the persisted seen set)", { timeout: 120_000 }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-gw-restart-"));
		try {
			// Both boots share one stores dir: the seen set survives the
			// process boundary exactly as it survives a real deployment
			// restart (the same state root).
			const first = await bootGateway({
				gatewaySettings: GATEWAY_SETTINGS,
				storesDir: join(dir, "stores"),
			});
			try {
				await first.loop.inbound(dmEvent({ messageId: "m1" }));
				await first.waitFor(async () => {
					const rows = await listConversations(first);
					return rows.some((row) => row.source === "gateway");
				});
			} finally {
				// The shutdown runs the ordered steps but LEAVES the stores dir
				// (a caller-supplied dir is the caller's — the harness only
				// removes the dir it owned).
				await first.shutdown();
			}
			const second = await bootGateway({
				gatewaySettings: GATEWAY_SETTINGS,
				storesDir: join(dir, "stores"),
			});
			try {
				// The redelivery of m1 over the SAME state root: the persisted
				// seen set drops it — exactly one gateway conversation, ever.
				const outcome = await second.loop.inbound(dmEvent({ messageId: "m1" }));
				expect(outcome).toEqual({ outcome: "dropped" });
				const rows = await listConversations(second);
				expect(rows.filter((row) => row.source === "gateway").length).toBe(1);
			} finally {
				await second.shutdown();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a bound archived conversation unarchives on the next message", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({ gatewaySettings: GATEWAY_SETTINGS });
		try {
			await boot.loop.inbound(dmEvent({ messageId: "m1" }));
			await boot.waitFor(async () => {
				const rows = await listConversations(boot);
				return rows.some((row) => row.source === "gateway");
			});
			const rows = await listConversations(boot);
			const row = rows.find((r) => r.source === "gateway");
			expect(row).toBeDefined();
			// Archive it from the webui side (the spec §8.3 my-call: archiving
			// never silently breaks a chat).
			const archived = await boot.app.inject({
				method: "PATCH",
				url: `/v1/conversations/${row!.id}/meta`,
				payload: { archived: true },
				headers: {
					authorization: `Bearer ${boot.tokens.alice}`,
					"content-type": "application/json",
				},
			});
			expect(archived.statusCode).toBe(200);
			// The next message unarchives before submit.
			await boot.loop.inbound(dmEvent({ messageId: "m2" }));
			await boot.waitFor(async () => {
				const next = await listConversations(boot);
				const same = next.find((r) => r.id === row!.id);
				return same !== undefined && same.archived === false;
			});
		} finally {
			await boot.shutdown();
		}
	});
});
