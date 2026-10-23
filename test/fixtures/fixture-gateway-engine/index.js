/**
 * Test-fixture extension package (gateway C2): the gateway ENGINE fixture.
 * The factory result carries an `extension` (declared name
 * "fixture-gateway-engine" — the slug the loader derives) plus a `gateway`
 * engine object and a `runSettled` handler (legal: a factory result may
 * carry both; Task 3 only requires the engine field).
 *
 * Records `start`/`stopIntake`/`stop` calls — with the ctx the engine
 * received (channels + signal) on `start` — and the `runSettled`
 * deliveries into a PER-BOOT log: each factory call pushes its own array
 * onto `globalThis.__fixtureGatewayLogs`, and the engine records into the
 * array its factory call created. The loader invokes the factory exactly
 * once per boot, so one boot = one registry entry — a test reads the
 * entry its boot appended (captured as `logs[logsBeforeBoot]`), never a
 * shared log, and repeated boots in one process never interleave. The
 * globalThis stash is the fixture-channel pattern: the loader's
 * `import()` and a test's static import may run in different module
 * instances — globalThis is the one shared address space.
 *
 * `health()` returns `globalThis.__fixtureGatewayHealth ?? "ok"` so tests
 * flip the reported health without reloading.
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

/**
 * The per-boot log registry: one entry per factory call, each entry the
 * `{type: "start"|"stopIntake"|"stop"|"runSettled", ...}` array that
 * factory call's engine records into.
 */
const logs = (globalThis.__fixtureGatewayLogs ??= []);

export default function createFixtureGatewayEngine() {
	// One log per FACTORY CALL (one per boot): the engine closures below
	// record into this array only — never a module-level shared log.
	const log = [];
	logs.push(log);
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
