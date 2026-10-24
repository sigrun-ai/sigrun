/**
 * Gateway shutdown and user deletion e2e (Task 12): the real ordered
 * shutdown delivers a settling run before adapter stop; deleting a user
 * forgets their chat link, so their next DM starts pairing again.
 *
 * Tests own their literals: alice/bob, "100000001", "200000002".
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { bootGateway, type GatewayBoot } from "./harness.js";
import type { InboundEvent } from "../../src/extension.js";

const SETTINGS = { channels: { loop: { dm: "pairing" } } };

interface LoopEvent {
	readonly type: "send" | "stop";
	readonly text?: string;
}

function loopLog(events: LoopEvent[]): void {
	(globalThis as { __loopLog?: LoopEvent[] }).__loopLog = events;
}

function clearLoopLog(): void {
	delete (globalThis as { __loopLog?: LoopEvent[] }).__loopLog;
}

function dm(messageId: string, sender = "100000001", text = "hello"): InboundEvent {
	return {
		messageId,
		chat: { chatId: sender, chatType: "dm" },
		sender: { id: sender, name: sender === "200000002" ? "Bob" : "Alice" },
		text,
	};
}

async function createConversation(boot: GatewayBoot): Promise<number> {
	const response = await boot.app.inject({
		method: "POST",
		url: "/v1/conversations",
		headers: { authorization: `Bearer ${boot.tokens.alice}` },
	});
	expect(response.statusCode).toBe(201);
	return response.json().id as number;
}

async function pair(boot: GatewayBoot, sender: string, user: string): Promise<void> {
	const before = boot.loop.sent.length;
	await boot.loop.inbound(dm(`pair-${sender}`, sender, "pair me"));
	const code = boot.loop.sent.slice(before).at(-1)?.text.match(/[A-Z2-9]{8}/)?.[0];
	if (code === undefined) throw new Error("pairing code missing");
	const conversation = await createConversation(boot);
	const response = await boot.app.inject({
		method: "POST",
		url: `/v1/conversations/${conversation}/commands/pair`,
		headers: { authorization: `Bearer ${boot.tokens.alice}` },
		payload: { args: `approve ${code} ${user}` },
	});
	expect(response.statusCode).toBe(200);
}

describe("gateway shutdown e2e (Task 12)", () => {
	test("a run settling during shutdown is delivered before adapter stop", { timeout: 60_000 }, async () => {
		const events: LoopEvent[] = [];
		loopLog(events);
		const boot = await bootGateway({
			gatewaySettings: {
				channels: {
					loop: {
						dm: "allowlist",
						allow: [{ sender: "100000001", user: "alice" }],
						stream: false,
					},
				},
			},
		});
		try {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			boot.faux.setResponses([async () => {
				await gate;
				return fauxAssistantMessage("settled during shutdown");
			}]);
			let settled!: () => void;
			const settleObserved = new Promise<void>((resolve) => {
				settled = resolve;
			});
			boot.opened.eventBus.onSettled(() => {
				settled();
			});
			expect(await boot.loop.inbound(dm("shutdown-run"))).toEqual({ outcome: "admitted" });
			await boot.waitFor(() => boot.faux.state.callCount === 1);
			let intakeClosed!: () => void;
			const intake = new Promise<void>((resolve) => {
				intakeClosed = resolve;
			});
			const stopIntake = boot.gateway.stopIntake.bind(boot.gateway);
			boot.gateway.stopIntake = async () => {
				await stopIntake();
				intakeClosed();
			};
			const stopping = boot.shutdown();
			await intake;
			// Release after intake closes. The bus sees the settle during its
			// shutdown drain; its handler must deliver before adapter stop.
			release();
			await settleObserved;
			await stopping;
			const answerAt = events.findIndex((event) => event.text === "settled during shutdown");
			const stopAt = events.findIndex((event) => event.type === "stop");
			expect(answerAt).toBeGreaterThanOrEqual(0);
			expect(stopAt).toBeGreaterThan(answerAt);
			expect(boot.loop.sent.some((message) => message.text === "settled during shutdown")).toBe(true);
		} finally {
			clearLoopLog();
		}
	});

	test("DELETE /v1/users/bob with transfer forgets bob's linked sender and homes", { timeout: 90_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: SETTINGS,
			users: [{ user: "alice", admin: true }, { user: "bob" }],
		});
		try {
			await pair(boot, "200000002", "bob");
			expect(await boot.loop.inbound(dm("bob-linked", "200000002"))).toEqual({ outcome: "admitted" });
			const deleted = await boot.app.inject({
				method: "DELETE",
				url: "/v1/users/bob?transferTo=alice",
				headers: { authorization: `Bearer ${boot.tokens.alice}` },
			});
			expect(deleted.statusCode).toBe(204);
			const identitiesPath = join(boot.dir, "ext-gateway", "gateway", "identities.json");
			await boot.waitFor(async () => {
				const raw = JSON.parse(await readFile(identitiesPath, "utf8")) as {
					links: Record<string, { user: string }>;
					homes: Record<string, unknown>;
				};
				return raw.homes.bob === undefined && !Object.values(raw.links).some((link) => link.user === "bob");
			});
			const binding = boot.opened.gatewayEngine;
			if (binding === undefined) throw new Error("gateway engine unavailable");
			const identities = (
				binding.engine as import("../../src/extension.js").GatewayEngine &
					import("@sigrun/ext-gateway").EngineInternals
			).accessState().identities;
			const { parseGatewayConfig } = await import("@sigrun/ext-gateway");
			const block = parseGatewayConfig(SETTINGS).channels.loop;
			if (block === undefined || "failed" in block) throw new Error("bad test config");
			expect(identities.userFor(block, "loop", "200000002")).toBeUndefined();
			// The next DM resolves through the unknown-sender pairing branch.
			// Its original request cooldown still applies; deleting a user does
			// not manufacture a second immediate code reply.
			expect(await boot.loop.inbound(dm("bob-after-delete", "200000002", "hello again"))).toEqual({ outcome: "dropped" });
		} finally {
			await boot.shutdown();
		}
	});
});
