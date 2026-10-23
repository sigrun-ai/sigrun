/**
 * The ordered shutdown (gateway C2's extraction of serve.ts's inline
 * `shutdown`): seven steps, each in its own try/catch so a failure never
 * skips the remaining steps, with every failure collected into one
 * `AggregateError("sigrun shutdown failed")` after ALL steps ran (the
 * pre-extraction semantics, byte-for-byte).
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
 * 6. `stopProviderRefresh` — the interval scheduler + the bounded
 *    boot-refresh join (no catalog fetch outlives the shutdown);
 * 7. `closeHarness` — the seal (joins tasks, seals storage).
 *
 * Does NOT exit the process — the caller owns exit policy (the deploy
 * entry exits 0/1; the CLI's `run` returns to its exit code).
 */

import type { GatewayHandle } from "./gateway.js";

/** The seven ordered steps (the serve composition supplies every one). */
export interface ShutdownSteps {
	/** End every live SSE stream (sync — the registry's own close). */
	endStreams(): void;
	/** The Fastify drain (in-flight requests finish). */
	closeApp(): Promise<void>;
	/** The loaded engine's intake close (or the degenerate no-engine handle). */
	gateway: GatewayHandle;
	/** The event bus's shutdown sequence (drain + `harnessShutdown`). */
	eventBusShutdown(): Promise<void>;
	/** Stop the refresh scheduler + join the boot refresh (bounded). */
	stopProviderRefresh(): Promise<void>;
	/** Close the harness (joins tasks, seals storage). */
	closeHarness(): Promise<void>;
}

/**
 * Build the ordered shutdown over the seven steps. Failures from ANY step
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
			await steps.closeApp();
		} catch (error) {
			failures.push(error);
		}
		try {
			await steps.gateway.stopIntake();
		} catch (error) {
			failures.push(error);
		}
		try {
			await steps.eventBusShutdown();
		} catch (error) {
			failures.push(error);
		}
		try {
			await steps.gateway.stop();
		} catch (error) {
			failures.push(error);
		}
		try {
			await steps.stopProviderRefresh();
		} catch (error) {
			failures.push(error);
		}
		try {
			await steps.closeHarness();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length > 0) {
			throw new AggregateError(failures, "sigrun shutdown failed");
		}
	};
}
