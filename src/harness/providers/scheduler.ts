/**
 * Core-owned refresh policy 2 (spec §"Core: refresh policy"): the
 * interval scheduler. The boot refresh (T4, `refresh.ts`) populates
 * every dynamic provider's catalog once at boot; THIS module keeps them
 * current — ONE host-owned `setInterval` re-running `models.refresh()`
 * with NO provider filter on a cadence, so an upstream roster change
 * lands without a restart (and well inside the refresh-on-miss fallback
 * at the submit call site).
 *
 * The cadence resolves at boot from the settings file's
 * `server.providers.refreshIntervalMinutes` under the
 * `SIGRUN_PROVIDER_REFRESH_MINUTES` env override, default 15 minutes;
 * `0` disables the scheduler outright (no timer is created — the
 * designed off switch, not an error).
 *
 * Lifecycle contract:
 * - the timer is `unref()`ed — a running sigrun keeps the process alive,
 *   the refresh cadence alone never does;
 * - `stop()` clears the timer (idempotent); the deploy shutdown path
 *   (`src/serve.ts`) calls it BEFORE the harness closes, alongside the
 *   ordered shutdown;
 * - a failed tick — per-provider failures in the refresh result
 *   (`ModelsRefreshResult.errors`, the pi-ai contract: provider errors
 *   are returned, not thrown), an abort, or an unexpected throw — logs
 *   ONCE per outage, on the TRANSITION into failure. Consecutive
 *   failures stay silent (the cadence IS the retry); a successful tick
 *   resets the state so the next outage warns again. One warn per
 *   episode, not one per tick.
 */

import type { Models } from "@earendil-works/pi-ai";
import { refreshReadinessSnapshot } from "./refresh.js";

/** Options for {@link startProviderRefresh}. */
export interface ProviderRefreshOptions {
	/**
	 * The refresh cadence in minutes. `0` (or any non-positive value —
	 * validation upstream makes those unreachable) disables the
	 * scheduler: no timer is created.
	 */
	readonly intervalMinutes: number;
	/**
	 * The failure-transition sink; defaults to `console.warn` (the repo
	 * convention — no shared logger; `refresh.ts` warns the same way).
	 */
	readonly log?: (message: string) => void;
	/**
	 * Readiness observer (core hardening W3 Task 4, spec §7.4): invoked
	 * after every completed tick with a per-provider readiness snapshot
	 * (provider id → status string); the caller (boot wiring) diffs it
	 * against the last snapshot and publishes `providers.changed`. Never
	 * invoked for a tick that threw before refreshing (a wedge holds the
	 * previous snapshot).
	 */
	readonly onReadinessChange?: (
		readiness: ReadonlyMap<string, string>,
	) => void;
	/**
	 * The readiness derivation (boot wiring supplies it); absent = the
	 * bare provider-id → `"ready"` map (`refreshReadinessSnapshot`).
	 */
	readonly snapshotReadiness?: (models: Models) => ReadonlyMap<string, string>;
}

/** The scheduler handle: {@link ProviderRefreshHandle.stop} clears it. */
export interface ProviderRefreshHandle {
	/** Clear the interval timer. Idempotent. */
	stop(): void;
}

/**
 * Start the interval refresh: one `unref()`ed `setInterval` re-running
 * `models.refresh()` (every dynamic provider, network allowed —
 * `refresh()` with no options is pi-ai's full refresh) every
 * `intervalMinutes`. A tick's failures never reject and never stack
 * retries — the next tick IS the retry; see the module docblock for
 * the once-per-outage logging rule.
 */
export function startProviderRefresh(
	models: Models,
	opts: ProviderRefreshOptions,
): ProviderRefreshHandle {
	if (!(opts.intervalMinutes > 0)) {
		return { stop(): void {} };
	}
	const log = opts.log ?? console.warn;
	// The outage latch: `true` while the current run of consecutive
	// failures has already logged. Success resets it.
	let inOutage = false;
	const tick = async (): Promise<void> => {
		let failure: string | undefined;
		try {
			const result = await models.refresh();
			if (result.aborted) {
				failure = "aborted before completing";
			} else if (result.errors.size > 0) {
				failure = [...result.errors]
					.map(
						([id, error]) =>
							`${id} (${error instanceof Error ? error.message : String(error)})`,
					)
					.join("; ");
			}
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		// The readiness observation runs for EVERY completed tick — success
		// or failure — so a provider that flips either way is observed; a
		// tick that threw before refreshing holds the previous snapshot.
		try {
			opts.onReadinessChange?.(
				(opts.snapshotReadiness ?? refreshReadinessSnapshot)(models),
			);
		} catch (error) {
			log(
				`provider readiness observation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (failure === undefined) {
			inOutage = false;
			return;
		}
		if (!inOutage) {
			inOutage = true;
			log(
				`provider interval refresh failed: ${failure} — ` +
					`retrying on cadence (logging once per outage)`,
			);
		}
	};
	const timer = setInterval(() => void tick(), opts.intervalMinutes * 60_000);
	timer.unref?.();
	return {
		stop(): void {
			clearInterval(timer);
		},
	};
}
