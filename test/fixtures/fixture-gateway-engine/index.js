/**
 * Test-fixture extension package (gateway C2): the gateway ENGINE fixture.
 * The factory result carries an `extension` (declared name
 * "fixture-gateway-engine" — the slug the loader derives) plus a `gateway`
 * engine object and a `runSettled` handler (legal: a factory result may
 * carry both; Task 3 only requires the engine field).
 *
 * Records `start`/`stopIntake`/`stop` calls — with the ctx the engine
 * received (channels + signal) on `start` — and the `runSettled`
 * deliveries into `globalThis.__fixtureGatewayLog` (the fixture-channel
 * globalThis-stash pattern: the loader's `import()` and a test's static
 * import may run in different module instances — globalThis is the one
 * shared address space). `health()` returns
 * `globalThis.__fixtureGatewayHealth ?? "ok"` so tests flip the reported
 * health without reloading.
 *
 * `runSettled` awaits `globalThis.__fixtureGatewaySettleGate` (a promise)
 * BEFORE recording when one is set: the shutdown-order test holds the
 * settle delivery until `stopIntake` has been observed, making the
 * drain-time ordering (stopIntake → runSettled → stop) deterministic
 * instead of racing the boot-scheduled drain.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is an arity-0 factory returning
 * `{ extension, gateway, runSettled }`.
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** The call/delivery log: `{type: "start"|"stopIntake"|"stop"|"runSettled", ...}`. */
export const log = [];

globalThis.__fixtureGatewayLog = log;

export default function createFixtureGatewayEngine() {
	return {
		extension: defineExtension({ name: "fixture-gateway-engine", sections: [] }),
		gateway: {
			async start(ctx) {
				log.push({
					type: "start",
					channels: ctx.channels.map((channel) => ({
						extension: channel.extension,
						id: channel.channel.id,
					})),
					signal: ctx.signal,
				});
			},
			async stopIntake() {
				log.push({ type: "stopIntake" });
			},
			async stop() {
				log.push({ type: "stop" });
			},
			health() {
				return globalThis.__fixtureGatewayHealth ?? "ok";
			},
		},
		async runSettled() {
			const gate = globalThis.__fixtureGatewaySettleGate;
			if (gate !== undefined) await gate;
			log.push({ type: "runSettled" });
		},
	};
}
