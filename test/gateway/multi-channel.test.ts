/**
 * Two real adapters boot under one engine: workers, supervisors, pair
 * notices and durable bindings remain channel-isolated.
 * Tests own their synthetic ids and users.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { EngineInternals } from "@sigrun/ext-gateway";
import type { GatewayEngine } from "../../src/extension.js";
import { bootGateway } from "./harness.js";

function dm(sender: string, messageId: string) {
	return {
		messageId,
		chat: { chatId: sender, chatType: "dm" as const },
		sender: { id: sender, name: "Synthetic Sender" },
		text: "pair me",
	};
}

describe("gateway two-channel boot", () => {
	test("supervisors, pair notices and bindings stay on their own channel", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			secondChannel: true,
			gatewaySettings: {
				channels: {
					loop: { dm: "pairing" },
					loop2: { dm: "pairing" },
				},
			},
		});
		try {
			const binding = boot.opened.gatewayEngine;
			if (binding === undefined) throw new Error("gateway engine unavailable");
			const engine = binding.engine as GatewayEngine & EngineInternals;
			expect(boot.opened.channelBindings.flatMap((row) =>
				row.channels.map((channel) => channel.id),
			)).toEqual(expect.arrayContaining(["loop", "loop2"]));
			expect(Object.keys(engine.status().channels)).toEqual(["loop", "loop2"]);
			expect(engine.status().channels.loop?.state).toBe("running");
			expect(engine.status().channels.loop2?.state).toBe("running");

			const loop2 = boot.loop2;
			if (loop2 === undefined) throw new Error("second channel did not boot");
			const loopBefore = boot.loop.sent.length;
			const loop2Before = loop2.sent.length;
			expect(await boot.loop.inbound(dm("100000001", "loop-pair"))).toEqual({ outcome: "dropped" });
			expect(boot.loop.sent.slice(loopBefore)).toHaveLength(1);
			expect(loop2.sent.slice(loop2Before)).toHaveLength(0);

			expect(await loop2.inbound(dm("200000002", "loop2-pair"))).toEqual({ outcome: "dropped" });
			expect(loop2.sent.slice(loop2Before)).toHaveLength(1);
			expect(loop2.sent.at(-1)?.chat.chatId).toBe("200000002");
			expect(boot.loop.sent.slice(loopBefore)).toHaveLength(1);

			// Bind one conversation through each channel's admitted event.
			const config = {
				channels: {
					loop: {
						dm: "allowlist",
						allow: [{ sender: "100000001", user: "alice" }],
					},
					loop2: {
						dm: "allowlist",
						allow: [{ sender: "200000002", user: "alice" }],
					},
				},
			};
			await writeFile(
				join(boot.dir, "config", "settings", "gateway.json"),
				JSON.stringify(config),
			);
			expect(await boot.loop.inbound(dm("100000001", "loop-bound"))).toEqual({ outcome: "admitted" });
			expect(await loop2.inbound(dm("200000002", "loop2-bound"))).toEqual({ outcome: "admitted" });
			const bindingsPath = join(boot.dir, "state", "ext-gateway", "gateway", "bindings.json");
			await boot.waitFor(async () => {
				const state = JSON.parse(await readFile(bindingsPath, "utf8")) as {
					bindings: Record<string, unknown>;
				};
				return Object.keys(state.bindings).length === 2;
			});
			const state = JSON.parse(await readFile(bindingsPath, "utf8")) as {
				bindings: Record<string, unknown>;
			};
			expect(Object.keys(state.bindings).sort()).toEqual([
				"loop2:default:dm:200000002",
				"loop:default:dm:100000001",
			]);
		} finally {
			await boot.shutdown();
		}
	});
});
