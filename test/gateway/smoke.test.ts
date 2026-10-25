/**
 * Gateway Task 1 smoke e2e: `bootGateway` with `channels: {loop: {}}`
 * boots the built-in gateway engine, `startGateway` started it once
 * with the `loop` channel, `/v1/meta` reports `health.gateway === "ok"`,
 * and the `gateway` row in `/v1/extensions` is `ok`.
 */

import { describe, expect, test } from "vitest";
import { bootGateway } from "./harness.js";

describe("gateway smoke (Task 1)", () => {
	test("the built-in engine starts with the loop channel; health ok; /v1/extensions row ok", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: { channels: { loop: {} } },
		});
		try {
			// The engine's start ran once: the loopback adapter's
			// ChannelContext was handed over (the fixture records it).
			expect(boot.loop.ctx).toBeDefined();
			// /v1/meta: health.gateway reads "ok" (the engine loaded —
			// the meta route keys on opened.gatewayEngine).
			const meta = await boot.app.inject({
				method: "GET",
				url: "/v1/meta",
				headers: { authorization: `Bearer ${boot.tokens.alice}` },
			});
			expect(meta.statusCode).toBe(200);
			const health = (meta.json() as { health: Record<string, unknown> })
				.health;
			expect(health.gateway).toBe("ok");
			// /v1/extensions: the gateway row is ok and builtin.
			const extensions = await boot.app.inject({
				method: "GET",
				url: "/v1/extensions",
				headers: { authorization: `Bearer ${boot.tokens.alice}` },
			});
			expect(extensions.statusCode).toBe(200);
			const rows = (
				extensions.json() as {
					extensions: {
						name: string;
						status: string;
						builtin?: boolean;
						inert?: string;
					}[];
				}
			).extensions;
			const gatewayRow = rows.find((row) => row.name === "gateway");
			expect(gatewayRow).toMatchObject({ status: "ok", builtin: true });
			// The loopback adapter row is NOT inert (an engine loaded).
			const loopRow = rows.find(
				(row) => row.name === "fixture-loopback-channel",
			);
			expect(loopRow?.inert).toBeUndefined();
			// The engine's health through the handle too.
			expect(boot.gateway.health()).toBe("ok");
		} finally {
			await boot.shutdown();
		}
	});
});
