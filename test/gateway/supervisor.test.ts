/**
 * Gateway Task 2 e2e: supervision through the real boot. The engine's
 * `status` route (admin-gated `GET /v1/ext/gateway/status`), the
 * loopback fixture's not_configured override, and a `failNext("start")`
 * round trip into backoff and back to running.
 *
 * Tests own their literals: alice/bob, synthetic sender ids.
 */

import { describe, expect, test } from "vitest";
import { bootGateway } from "./harness.js";

/** The status route's channels read (one row's shape). */
interface StatusChannelRow {
	readonly state: string;
	readonly detail?: string;
	readonly since: number;
	readonly lastError?: string;
	readonly counts: {
		readonly admitted: number;
		readonly dropped: number;
		readonly delivered: number;
		readonly failed: number;
	};
}

/** The status route's response body. */
interface StatusBody {
	readonly channels: Readonly<Record<string, StatusChannelRow>>;
	readonly pairing: readonly unknown[];
}

async function getStatus(
	boot: Awaited<ReturnType<typeof bootGateway>>,
	token: string,
): Promise<StatusBody> {
	const response = await boot.app.inject({
		method: "GET",
		url: "/v1/ext/gateway/status",
		headers: { authorization: `Bearer ${token}` },
	});
	if (response.statusCode !== 200) {
		throw new Error(`status route returned ${response.statusCode}`);
	}
	return response.json() as StatusBody;
}

describe("gateway supervision e2e (Task 2)", () => {
	test("a not_configured channel shows not_configured in the status route and never starts", { timeout: 60_000 }, async () => {
		const globalScope = globalThis as { __loopConfigured?: unknown };
		globalScope.__loopConfigured = {
			status: "not_configured",
			detail: "no credentials",
		};
		const boot = await bootGateway({
			gatewaySettings: { channels: { loop: {} } },
		});
		try {
			// The adapter never started: no ChannelContext was handed over.
			expect(boot.loop.ctx).toBeUndefined();
			const body = await getStatus(boot, boot.tokens.alice);
			expect(body.channels.loop).toMatchObject({
				state: "not_configured",
			});
			// The pairing list ships empty (Task 4 fills it).
			expect(body.pairing).toEqual([]);
			// An unconfigured channel is not health-degrading.
			expect(boot.gateway.health()).toBe("ok");
		} finally {
			delete globalScope.__loopConfigured;
			await boot.shutdown();
		}
	});

	test("a failed start enters backoff, then the retry reaches running", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: { channels: { loop: {} } },
		});
		try {
			// The channel came up running in the boot (Task 1 behavior).
			expect(boot.loop.ctx).toBeDefined();
			const ctxBefore = boot.loop.ctx;
			// ctx.fail on the live context: the supervisor enters backoff
			// (a post-connect failure) and schedules the 1 s retry.
			boot.loop.failNext("start");
			boot.loop.ctx?.fail(new Error("synthetic post-connect failure"));
			await boot.waitFor(async () => {
				const body = await getStatus(boot, boot.tokens.alice);
				return body.channels.loop?.state === "backoff";
			}, 15_000);
			const backoff = await getStatus(boot, boot.tokens.alice);
			expect(backoff.channels.loop?.lastError).toContain(
				"synthetic post-connect failure",
			);
			// The 1 s retry (real timers): the NEXT start was failed too
			// (failNext), so the retry lands in backoff again — then the
			// following retry (2 s) succeeds and a FRESH context arrives.
			await boot.waitFor(() => boot.loop.ctx !== undefined && boot.loop.ctx !== ctxBefore, 15_000);
			expect(boot.loop.ctx).toBeDefined();
			await boot.waitFor(async () => {
				const body = await getStatus(boot, boot.tokens.alice);
				return body.channels.loop?.state === "running";
			}, 15_000);
			const running = await getStatus(boot, boot.tokens.alice);
			expect(running.channels.loop?.state).toBe("running");
			expect(running.channels.loop?.counts).toMatchObject({
				admitted: 0,
				dropped: 0,
				delivered: 0,
				failed: 0,
			});
		} finally {
			await boot.shutdown();
		}
	});

	test("GET status as a non-admin token is 403", { timeout: 60_000 }, async () => {
		const boot = await bootGateway({
			gatewaySettings: { channels: { loop: {} } },
			users: [{ user: "bob", admin: false }],
		});
		try {
			const response = await boot.app.inject({
				method: "GET",
				url: "/v1/ext/gateway/status",
				headers: { authorization: `Bearer ${boot.tokens.bob}` },
			});
			expect(response.statusCode).toBe(403);
		} finally {
			await boot.shutdown();
		}
	});
});
