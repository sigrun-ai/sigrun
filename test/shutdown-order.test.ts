/**
 * Gateway C2: the ordered shutdown (`createShutdown`, src/server/shutdown.ts)
 * — the extraction of serve.ts's inline shutdown with the gateway
 * lifecycle inserted.
 *
 * Unit cases drive recording fakes (the seven-step order; a throwing
 * step still runs the remaining six and rides the AggregateError).
 *
 * The integration case boots the REAL composition (the
 * host-conversations pattern: faux provider + fixture-gateway-engine)
 * and asserts the engine observes `stopIntake` BEFORE the run's
 * `runSettled` delivery (the event bus's shutdownSequence drains
 * pending settles — intake must already be closed so the drain is the
 * LAST admission window) and `stop` AFTER it (the engine's adapters
 * stop only once every settle has been delivered).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import {
	fauxAssistantMessage,
	fauxProvider,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { startGateway, type GatewayHandle } from "../src/server/gateway.js";
import { createShutdown, type ShutdownSteps } from "../src/server/shutdown.js";
import { seededIdentity } from "./helpers/identity.js";

const ENGINE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-gateway-engine", "index.js"),
).href;

/** The fixture's shared log (the gateway-engine test's reader). */
function gatewayLog(): { type: string }[] {
	const log = (
		globalThis as { __fixtureGatewayLog?: { type: string }[] }
	).__fixtureGatewayLog;
	if (log === undefined) throw new Error("fixture-gateway-engine log not captured");
	return log;
}

// ---------------------------------------------------------------------------
// createShutdown: the seven steps, in order, failure-collecting
// ---------------------------------------------------------------------------

/** A recording fake for one step; `throwIn` makes the step throw. */
function step(name: string, order: string[], throwIn?: Error): () => Promise<void> {
	return async (): Promise<void> => {
		order.push(name);
		if (throwIn !== undefined) throw throwIn;
	};
}

/** Recording fakes for every step, sharing one order log. */
function fakeSteps(order: string[], overrides?: {
	closeApp?: Error;
	gatewayStopIntake?: Error;
	gatewayStop?: Error;
}): ShutdownSteps {
	return {
		endStreams: step("endStreams", order),
		closeApp: step("closeApp", order, overrides?.closeApp),
		gateway: {
			started: Promise.resolve(),
			health: () => "ok",
			stopIntake: step("gateway.stopIntake", order, overrides?.gatewayStopIntake),
			stop: step("gateway.stop", order, overrides?.gatewayStop),
		},
		eventBusShutdown: step("eventBusShutdown", order),
		stopProviderRefresh: step("stopProviderRefresh", order),
		closeHarness: step("closeHarness", order),
	};
}

describe("createShutdown", () => {
	test("runs the seven steps in order", async () => {
		const order: string[] = [];
		const shutdown = createShutdown(fakeSteps(order));
		await shutdown();
		expect(order).toEqual([
			"endStreams",
			"closeApp",
			"gateway.stopIntake",
			"eventBusShutdown",
			"gateway.stop",
			"stopProviderRefresh",
			"closeHarness",
		]);
	});

	test("a throwing closeApp still runs the remaining six; the AggregateError carries it", async () => {
		const order: string[] = [];
		const failure = new Error("closeApp exploded");
		const shutdown = createShutdown(
			fakeSteps(order, { closeApp: failure }),
		);
		await expect(shutdown()).rejects.toSatisfy((error: unknown) => {
			expect(error).toBeInstanceOf(AggregateError);
			const aggregate = error as AggregateError;
			expect(aggregate.message).toBe("sigrun shutdown failed");
			expect(aggregate.errors).toEqual([failure]);
			return true;
		});
		expect(order).toEqual([
			"endStreams",
			"closeApp",
			"gateway.stopIntake",
			"eventBusShutdown",
			"gateway.stop",
			"stopProviderRefresh",
			"closeHarness",
		]);
	});

	test("collects failures from every throwing step", async () => {
		const order: string[] = [];
		const intake = new Error("stopIntake exploded");
		const stop = new Error("stop exploded");
		const shutdown = createShutdown(
			fakeSteps(order, { gatewayStopIntake: intake, gatewayStop: stop }),
		);
		await expect(shutdown()).rejects.toSatisfy((error: unknown) => {
			const aggregate = error as AggregateError;
			expect(aggregate.errors).toEqual([intake, stop]);
			return true;
		});
		// Every step ran regardless.
		expect(order).toHaveLength(7);
	});
});

// ---------------------------------------------------------------------------
// Integration: the real composition's shutdown order
// ---------------------------------------------------------------------------

describe("the booted composition's shutdown order", () => {
	test("stopIntake → the run's runSettled → stop (real boot)", { timeout: 60_000 }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-shutdown-order-"));
		const configDir = join(dir, "config");
		const faux = fauxProvider({
			provider: "faux",
			models: [{ id: "m", contextWindow: 128_000 }],
		});
		faux.setResponses([fauxAssistantMessage("the shutdown-order answer")]);
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "faux/m",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
			SIGRUN_AUTH: "none",
			SIGRUN_WORKSPACE_PATH: dir,
			SIGRUN_CONFIG_DIR: configDir,
		});
		await writeFile(join(dir, "settings.json"), '{"namingModel": false}');;
		const contributor: ProviderContributor = {
			name: "ext-faux",
			providers: [{ provider: faux.provider }],
		};
		const opened = await openHarness(config, {
			identity: await seededIdentity(dir),
			extensions: [contributor],
			builtins: false,
			extensionSpecifiers: [ENGINE_SPECIFIER],
			env: { SIGRUN_CONFIG_DIR: configDir },
			settingsDir: dir,
		});
		const gateway: GatewayHandle = startGateway(opened);
		let app: FastifyInstance | undefined;
		try {
			app = await createServer(opened, config, [], { gateway });
			await gateway.started;
			// Hold the settle DELIVERY: the gate keeps the fixture's runSettled
			// pending until the test observes stopIntake — the boot-scheduled
			// drain would otherwise deliver before shutdown starts, hiding the
			// drain-time ordering under test.
			let releaseSettle!: () => void;
			const settleGate = new Promise<void>((resolve) => {
				releaseSettle = resolve;
			});
			(globalThis as { __fixtureGatewaySettleGate?: Promise<void> })
				.__fixtureGatewaySettleGate = settleGate;
			// Submit over the real wire (the HTTP admission path) and wait for
			// the run to SETTLE (the record's status flips to done) — the
			// runSettled DELIVERY stays gated in the event bus's queue/loop.
			const response = await app.inject({
				method: "POST",
				url: "/v1/conversations/1/submissions",
				payload: { input: "hello" },
				headers: { "content-type": "application/json" },
			});
			expect(response.statusCode).toBe(202);
			const { submission } = response.json() as {
				submission: { id: number; conversationId: number; status: string };
			};
			const conversationId = submission.conversationId;
			const submissionId = submission.id;
			await (async () => {
				const deadline = Date.now() + 10_000;
				for (;;) {
					const body = (
						await app!.inject({
							method: "GET",
							url: `/v1/conversations/${conversationId}/submissions/${submissionId}`,
						})
					).json() as { submission: { status: string } };
					if (body.submission.status === "done") return;
					if (Date.now() > deadline) throw new Error("run never settled");
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
			})();
			// The ordered shutdown over the REAL composition (the serve shape),
			// with a watchdog releasing the settle gate the moment stopIntake
			// lands — the drain inside eventBusShutdown then delivers the run's
			// runSettled, and only after it does gateway.stop run.
			const watchFor = async (type: string): Promise<void> => {
				for (;;) {
					if (gatewayLog().some((entry) => entry.type === type)) return;
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
			};
			const releaseOnStopIntake = (async () => {
				await watchFor("stopIntake");
				releaseSettle();
			})();
			const shutdown = createShutdown({
				endStreams: () => app!.sse.endAll(),
				closeApp: () => app!.close(),
				gateway,
				eventBusShutdown: () =>
					opened.eventBus.shutdownSequence(BACKGROUND_CONTEXT),
				stopProviderRefresh: async () => {
					opened.stopProviderRefresh();
					// The serve path's bounded boot-refresh join (behavior
					// identical to the inline shutdown it replaces).
					let joined = false;
					const join = opened.bootRefresh.then(() => {
						joined = true;
					}).catch(() => {});
					const BOOT_REFRESH_JOIN_MS = 2_000;
					await Promise.race([
						join,
						new Promise<void>((resolve) => {
							const timer = setTimeout(resolve, BOOT_REFRESH_JOIN_MS);
							timer.unref?.();
						}),
					]);
					if (!joined) {
						console.warn(
							`sigrun: boot refresh still in flight after ${BOOT_REFRESH_JOIN_MS}ms at shutdown — abandoning the join`,
						);
					}
				},
				closeHarness: () => opened.harness.close(BACKGROUND_CONTEXT),
			});
			await shutdown();
			await releaseOnStopIntake;
			delete (globalThis as { __fixtureGatewaySettleGate?: Promise<void> })
				.__fixtureGatewaySettleGate;
			// THE order: intake closes BEFORE the bus drains the pending
			// runSettled; the engine stops only after every settle landed.
			const types = gatewayLog().map((entry) => entry.type);
			const stopIntakeAt = types.indexOf("stopIntake");
			const settledAt = types.indexOf("runSettled");
			const stopAt = types.indexOf("stop");
			expect(stopIntakeAt).toBeGreaterThanOrEqual(0);
			expect(settledAt).toBeGreaterThan(stopIntakeAt);
			expect(stopAt).toBeGreaterThan(settledAt);
			// The engine started once over this boot's log slice.
			expect(types.filter((type) => type === "start")).toHaveLength(1);
			app = undefined;
		} finally {
			if (app !== undefined) await app.close().catch(() => {});
			// The shutdown path may already have closed the harness; a second
			// close throws, so guard it.
			await opened.harness
				.close(BACKGROUND_CONTEXT)
				.catch(() => {});
			await rm(dir, { recursive: true, force: true });
		}
	});
});
