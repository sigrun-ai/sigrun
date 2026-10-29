/**
 * The ordered shutdown (gateway C2's extraction of serve.ts's inline
 * `shutdown`): eight steps, each in its own try/catch so a failure never
 * skips the remaining steps, with every failure collected into one
 * `AggregateError("sigrun shutdown failed")` after ALL steps ran. Every
 * asynchronous stage has a fixed cap; reaching one abandons only that wait,
 * logs, and continues, so the composed shutdown has a fixed worst case.
 *
 * The order (spec §8.0 — the gateway lifecycle slots between the server
 * drain and the event-bus flush):
 *
 * 1. `endStreams` — SSE streams FIRST (hijacked event streams never end
 *    on their own, and `closeApp`'s drain waits for in-flight requests —
 *    with any webui tab open, shutdown hung forever on its /v1/events
 *    connection);
 * 2. `closeApp` — the server drain (in-flight requests finish);
 * 3. `gateway.stopIntake` — the engine closes inbound intake BEFORE the
 *    bus drain: the drain is the last admission window, so no chat
 *    message admitted mid-drain can outrun it;
 * 4. `eventBusShutdown` — the bus's shutdown sequence (drain pending
 *    settles, then deliver `harnessShutdown` — handlers may commit);
 * 5. `gateway.stop` — the engine stops only once every settle has been
 *    delivered (its adapters' outbound side saw the final answers);
 * 6. `stopSandboxWorkers` — all per-user workers and their commands stop;
 * 7. `stopProviderRefresh` — the interval scheduler + the bounded
 *    boot-refresh join (no catalog fetch outlives the shutdown);
 * 8. `closeHarness` — the seal (joins tasks, seals storage).
 *
 * Does NOT exit the process — the caller owns exit policy (the deploy
 * entry exits 0/1; the CLI's `run` returns to its exit code).
 */

import {
	SHUTDOWN_SETTLE_WAIT_MS,
	WORKER_SHUTDOWN_AWAIT_MS,
} from "../harness/event-bus.js";
import type { GatewayHandle } from "./gateway.js";

/** Every ordered stage has a bound; these are the bounds used by the budget. */
export const END_STREAMS_SHUTDOWN_CAP_MS = 0;
export const CLOSE_APP_SHUTDOWN_CAP_MS = 10_000;
export const GATEWAY_STOP_INTAKE_SHUTDOWN_CAP_MS = 10_000;
export const GATEWAY_STOP_SHUTDOWN_CAP_MS = 10_000;
export const SANDBOX_WORKERS_SHUTDOWN_CAP_MS = 5_000;
export const PROVIDER_REFRESH_SHUTDOWN_CAP_MS = 2_000;
/**
 * Measured against a real 1.4.0 boot over a copy of the durable-v1 fixture
 * in test/shutdown-order.test.ts (0.6ms on the implementation run). The test
 * asserts this cap is at least four times that measurement, so a slow but
 * healthy close never gets converted into a counted restart by a guessed cap.
 */
export const CLOSE_HARNESS_SHUTDOWN_CAP_MS = 10_000;

/**
 * The event bus's bounded stages: worker stop + the initial drain + the
 * live-run settle wait AND the final drain that can start just before its
 * deadline + all extension handlers under one shared deadline. The settle
 * wait is a per-boot test override; the production budget uses its default.
 */
export function eventBusShutdownCapMs(config: { hookDeadlineMs: number }): number {
	return (
		WORKER_SHUTDOWN_AWAIT_MS +
		config.hookDeadlineMs +
		SHUTDOWN_SETTLE_WAIT_MS +
		config.hookDeadlineMs +
		config.hookDeadlineMs
	);
}

/** The fixed worst case of the complete ordered shutdown, in milliseconds. */
export function shutdownBudgetMs(config: { hookDeadlineMs: number }): number {
	return (
		END_STREAMS_SHUTDOWN_CAP_MS +
		CLOSE_APP_SHUTDOWN_CAP_MS +
		GATEWAY_STOP_INTAKE_SHUTDOWN_CAP_MS +
		eventBusShutdownCapMs(config) +
		GATEWAY_STOP_SHUTDOWN_CAP_MS +
		SANDBOX_WORKERS_SHUTDOWN_CAP_MS +
		PROVIDER_REFRESH_SHUTDOWN_CAP_MS +
		CLOSE_HARNESS_SHUTDOWN_CAP_MS
	);
}

/**
 * Await one stage without allowing a wedged implementation to outlive its
 * budget share. Abandonment is logged; the next ordered stage still runs.
 */
async function boundedStage(
	name: string,
	capMs: number,
	run: () => void | Promise<void>,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			console.error(
				`sigrun: shutdown stage ${name} exceeded ${capMs}ms — abandoning the wait`,
			);
			resolve();
		}, capMs);
	});
	const stage = Promise.resolve().then(run);
	// The race can abandon a stage that later rejects. Observe that rejection
	// here so it is logged rather than becoming an unhandled rejection.
	stage.catch((error: unknown) => {
		console.error(`sigrun: shutdown stage ${name} rejected after abandonment:`, error);
	});
	try {
		await Promise.race([stage, deadline]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** The eight ordered steps (the serve composition supplies every one). */
export interface ShutdownSteps {
	/** End every live SSE stream (sync — the registry's own close). */
	endStreams(): void;
	/** The Fastify drain (in-flight requests finish). */
	closeApp(): Promise<void>;
	/** The loaded engine's intake close (or the degenerate no-engine handle). */
	gateway: GatewayHandle;
	/** The event bus's shutdown sequence (drain + `harnessShutdown`). */
	eventBusShutdown(): Promise<void>;
	/** Stop every per-user sandbox worker (and therefore its commands). */
	stopSandboxWorkers(): Promise<void>;
	/** Stop the refresh scheduler + join the boot refresh (bounded). */
	stopProviderRefresh(): Promise<void>;
	/** Close the harness (joins tasks, seals storage). */
	closeHarness(): Promise<void>;
}

/**
 * Build the ordered shutdown over the eight steps. Failures from ANY step
 * are collected (the remaining steps still run) and thrown together as
 * `AggregateError(failures, "sigrun shutdown failed")` at the end; a clean
 * run resolves.
 */
export function createShutdown(steps: ShutdownSteps): () => Promise<void> {
	return async (): Promise<void> => {
		const failures: unknown[] = [];
		try {
			steps.endStreams();
		} catch (error) {
			failures.push(error);
		}
		try {
			await boundedStage("closeApp", CLOSE_APP_SHUTDOWN_CAP_MS, () => steps.closeApp());
		} catch (error) {
			failures.push(error);
		}
		try {
			await boundedStage(
				"gateway.stopIntake",
				GATEWAY_STOP_INTAKE_SHUTDOWN_CAP_MS,
				() => steps.gateway.stopIntake(),
			);
		} catch (error) {
			failures.push(error);
		}
		try {
			await steps.eventBusShutdown();
		} catch (error) {
			failures.push(error);
		}
		try {
			await boundedStage("gateway.stop", GATEWAY_STOP_SHUTDOWN_CAP_MS, () =>
				steps.gateway.stop(),
			);
		} catch (error) {
			failures.push(error);
		}
		try {
			await boundedStage(
				"stopSandboxWorkers",
				SANDBOX_WORKERS_SHUTDOWN_CAP_MS,
				() => steps.stopSandboxWorkers(),
			);
		} catch (error) {
			failures.push(error);
		}
		try {
			await steps.stopProviderRefresh();
		} catch (error) {
			failures.push(error);
		}
		try {
			await boundedStage(
				"closeHarness",
				CLOSE_HARNESS_SHUTDOWN_CAP_MS,
				() => steps.closeHarness(),
			);
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, "sigrun shutdown failed");
		}
	};
}
