/**
 * The gateway engine lifecycle (gateway C2, spec §8.0).
 *
 * `startGateway` wraps the ONE loaded engine (boot's
 * `OpenedHarness.gatewayEngine` — first declarer wins) in a
 * {@link GatewayHandle}: the serve composition creates the handle BEFORE
 * `createServer` (threaded through `ServerContext.gateway` so the meta
 * route reaches it) and starts it after `app.listen`.
 *
 * The no-engine deploy (core ships no engine) gets a degenerate handle:
 * every method resolves, `health()` reads "ok" but is NEVER consulted —
 * the meta route keys `health.gateway` on `opened.gatewayEngine`, not on
 * the handle, so a deploy with channel adapters and no engine reports NO
 * gateway health (the adapters are inert; the extensions inventory marks
 * their rows `inert: "no gateway"`).
 *
 * Failure posture (the spec's Review Focus 1): a `start` rejection is
 * logged once (`gateway: engine start failed`) and LATCHES degraded —
 * `started` still RESOLVES (a failed engine must not wedge boot or the
 * ordered shutdown); a throwing `health()` reads "degraded" and logs
 * once per process (never per call). Health stays degraded until
 * restart — recovery is a new process, never a live re-start.
 */

import type { GatewayEngine, GatewayEngineContext } from "../extension.js";
import type { OpenedHarness } from "../harness/boot.js";
import type { HealthStatus } from "../harness/health.js";

/** The serve-side handle over the loaded engine (or the degenerate no-engine form). */
export interface GatewayHandle {
	/**
	 * The engine's start promise — READING IT STARTS THE ENGINE (once;
	 * later reads return the same promise). The serve composition creates
	 * the handle before `createServer` and reads `started` after
	 * `app.listen` (gateway C2's lifecycle: start after listen). Resolves
	 * EITHER way: a rejected start latches degraded and this STILL resolves
	 * (never rejects), so boot and shutdown never wedge on a failed engine.
	 */
	readonly started: Promise<void>;
	/** The wrapped engine health: "degraded" on throw (logged once) or when start latched. */
	health(): HealthStatus;
	/** Close inbound intake — the ordered shutdown's step 3 (before the bus drain). */
	stopIntake(): Promise<void>;
	/**
	 * Stop the engine (aborting the `start` ctx's signal) — the ordered
	 * shutdown's step 5 (after the bus drain delivered every pending
	 * settle). Idempotent for safety; the shutdown path calls it once.
	 */
	stop(): Promise<void>;
}

/**
 * The degenerate no-engine handle: everything resolves, health reads
 * "ok" (never consulted — the meta route keys on
 * `opened.gatewayEngine`, not the handle).
 */
function noEngineHandle(): GatewayHandle {
	return {
		started: Promise.resolve(),
		health: () => "ok",
		stopIntake: () => Promise.resolve(),
		stop: () => Promise.resolve(),
	};
}

/**
 * The once-per-process no-engine warning flag: adapters contributed
 * channels but no engine loaded, so the adapters are INERT (the
 * `/v1/extensions` inventory marks their rows `inert: "no gateway"`).
 * Logged once per process — `startGateway` may be called more than once
 * over one boot (tests), and a deploy reboot re-runs it legitimately
 * only on a new process.
 */
let noEngineWarned = false;

/** Start the loaded gateway engine, wrapping it in the shutdown-side handle. */
export function startGateway(opened: OpenedHarness): GatewayHandle {
	const binding = opened.gatewayEngine;
	if (binding === undefined) {
		if (opened.channelBindings.length > 0 && !noEngineWarned) {
			noEngineWarned = true;
			console.warn(
				"channels contributed but no gateway engine is loaded",
			);
		}
		return noEngineHandle();
	}
	const engine: GatewayEngine = binding.engine;
	// The shutdown signal: `stop()` aborts the controller the engine's
	// start ctx carried — receive loops observe it (the same contract as a
	// `ChannelContext.signal`).
	const abort = new AbortController();
	const ctx: GatewayEngineContext = {
		channels: opened.channelBindings.flatMap((binding) =>
			binding.channels.map((channel) => ({
				extension: binding.extension,
				channel,
			})),
		),
		signal: abort.signal,
	};
	// Latched by a start rejection: health reads degraded until restart.
	let startFailed = false;
	// LAZY start: the handle is created BEFORE `createServer` (the meta
	// route needs it at construction) but the ENGINE starts on the first
	// `started` read — the serve composition reads it after `app.listen`
	// (gateway C2's lifecycle: start after listen). One promise forever
	// (re-reads join the same start).
	let startPromise: Promise<void> | undefined;
	const beginStart = (): Promise<void> => {
		startPromise ??= engine
			.start(ctx)
			.catch((error: unknown) => {
				startFailed = true;
				console.error("gateway: engine start failed", error);
			});
		return startPromise;
	};
	// A throwing health() logs ONCE per process — the meta route calls
	// health per request, and a persistently-throwing engine would spam
	// the log on every poll otherwise.
	let healthFailureLogged = false;
	return {
		get started(): Promise<void> {
			return beginStart();
		},
		health: (): HealthStatus => {
			if (startFailed) return "degraded";
			try {
				return engine.health();
			} catch (error) {
				if (!healthFailureLogged) {
					healthFailureLogged = true;
					console.error("gateway: engine health failed", error);
				}
				return "degraded";
			}
		},
		stopIntake: () => engine.stopIntake(),
		stop: async (): Promise<void> => {
			abort.abort();
			await engine.stop();
		},
	};
}
