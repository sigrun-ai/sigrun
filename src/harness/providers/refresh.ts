/**
 * Core-owned refresh policy (spec §"Core: refresh policy"): WHEN pi-ai's
 * refresh runs. The protocol is pi-ai's — `Models.refresh({providers,
 * allowNetwork, signal})` drives every dynamic provider, per-provider
 * failures land in `ModelsRefreshResult.errors` without rejecting, and a
 * failed refresh retains the previous catalog by contract. This module
 * owns the two policy call sites:
 *
 * 1. {@link bootRefresh} — one network-allowed refresh started by boot
 *    fire-and-tracked (never awaited on the boot path — it runs
 *    concurrently with `Harness.open` and listen), bounded by a deadline
 *    (default {@link DEFAULT_REFRESH_TIMEOUT_MS}) so a wedged upstream
 *    cannot stall deploy readiness. Timeout/failure only warns
 *    (`console.warn` — repo convention, no shared logger): the server
 *    starts, readiness reports the provider's state, the interval
 *    refresh heals.
 * 2. {@link resolveServedModelRefreshing} — refresh-on-miss at the submit
 *    call site: ONE bounded refresh of the named provider + re-resolve
 *    when `requireServedModel` reports a miss, so a model added upstream
 *    five minutes after the last interval tick is immediately usable
 *    instead of a 4xx. Still absent → the ORIGINAL
 *    {@link UnservedModelError} rethrows (the available-ids snapshot the
 *    caller surfaces is the one from the first check). The auto-namer's
 *    model resolution deliberately does NOT go through this wrapper —
 *    naming is a background lane (spec ruling).
 */

import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { requireServedModel, UnservedModelError } from "./index.js";

/**
 * The refresh deadline default (boot and refresh-on-miss share it): long
 * enough for a real catalog fetch, short enough that a wedged upstream
 * cannot stall deploy readiness or hang a submit.
 */
export const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;

/** The bound + cancellation surface every policy refresh takes. */
export interface RefreshBound {
	/** Hard deadline on the whole refresh (per-provider aborts ride it). */
	readonly timeoutMs: number;
	/** Caller cancellation (e.g. request abort), OR-ed into the deadline. */
	readonly signal?: AbortSignal;
	/**
	 * Readiness observer (core hardening W3 Task 4, spec §7.4): invoked
	 * after every completed refresh with a per-provider readiness snapshot
	 * derived through `snapshotReadiness`; the caller (boot wiring) diffs
	 * it against the last snapshot and publishes `providers.changed`. Never
	 * invoked when the refresh threw before completing (a wedge holds the
	 * previous snapshot).
	 */
	readonly onReadinessChange?: (
		readiness: ReadonlyMap<string, string>,
	) => void;
	/**
	 * The readiness derivation (boot wiring supplies it): pi-ai's
	 * `Provider` carries no readiness field, so the snapshot derives from
	 * sigrun's boot-retained state (`providerAuthStatus`). Absent = the
	 * observer receives the bare provider-id → `"ready"` catalog map.
	 */
	readonly snapshotReadiness?: (models: Models) => ReadonlyMap<string, string>;
}

/**
 * The fallback readiness snapshot (no derivation wired): provider id →
 * `"ready"` for every catalog provider. Boot always wires
 * `snapshotReadiness`; this keeps the option structurally optional.
 */
export function refreshReadinessSnapshot(
	models: Models,
): ReadonlyMap<string, string> {
	const snapshot = new Map<string, string>();
	for (const provider of models.getProviders()) {
		snapshot.set(provider.id, "ready");
	}
	return snapshot;
}

/**
 * One network-allowed refresh of every dynamic provider, bounded by
 * `opts.timeoutMs`. Never rejects and never blocks boot beyond the
 * deadline: an aborted (deadline/cancelled) or failed refresh logs ONE
 * `console.warn` naming what did not complete — the catalogs simply stay
 * at their last-known state. Boot starts this fire-and-tracked; the
 * tracked promise rides on `OpenedHarness.bootRefresh`.
 */
export async function bootRefresh(
	models: Models,
	opts: RefreshBound,
): Promise<void> {
	await refreshBounded(models, { label: "boot refresh", ...opts });
}

/** Options for {@link resolveServedModelRefreshing}. */
export interface ResolveRefreshingOptions {
	/** Refresh deadline; defaults to {@link DEFAULT_REFRESH_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
	/** Caller cancellation, threaded into the retry refresh. */
	readonly signal?: AbortSignal;
}

/**
 * `requireServedModel` with ONE refresh+retry: on an
 * {@link UnservedModelError}, refresh the named provider (bounded; its
 * failures only warn — a failed refresh is not a submit error) and
 * re-resolve. Still absent after the retry → the ORIGINAL miss rethrows,
 * available ids attached. The submit call site wraps its resolution in
 * this; the auto-namer's resolution stays on bare `requireServedModel`.
 */
export async function resolveServedModelRefreshing(
	models: Models,
	ref: ModelRef,
	opts: ResolveRefreshingOptions = {},
): Promise<Model<Api>> {
	let miss: unknown;
	try {
		return requireServedModel(models, ref);
	} catch (error) {
		if (!(error instanceof UnservedModelError)) throw error;
		miss = error;
	}
	await refreshBounded(models, {
		label: `refresh-on-miss (${ref.provider})`,
		timeoutMs: opts.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS,
		...(opts.signal === undefined ? {} : { signal: opts.signal }),
		providers: [ref.provider],
	});
	try {
		return requireServedModel(models, ref);
	} catch {
		// Still absent: rethrow the ORIGINAL miss. `requireServedModel`
		// only ever throws UnservedModelError, and the available-ids list
		// the caller surfaces is deliberately the first check's snapshot.
		throw miss;
	}
}

/**
 * The shared bounded refresh: `allowNetwork: true`, an abort controller
 * armed at `timeoutMs` (unref'd — a bare boot never holds the process
 * open) and OR-ed with any caller signal, errors/aborts collapsed into
 * one `console.warn`. `refresh()` itself reports per-provider failures
 * through its result rather than rejecting; the catch is the belt for the
 * unexpected throw — either way this resolves, never rejects.
 */
async function refreshBounded(
	models: Models,
	opts: RefreshBound & {
		/** Log prefix identifying the policy call site. */
		readonly label: string;
		/** Restrict the refresh to these provider ids. */
		readonly providers?: readonly string[];
	},
): Promise<void> {
	const controller = new AbortController();
	const signal =
		opts.signal === undefined
			? controller.signal
			: AbortSignal.any([opts.signal, controller.signal]);
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
	timer.unref?.();
	try {
		const result = await models.refresh({
			allowNetwork: true,
			...(opts.providers === undefined ? {} : { providers: opts.providers }),
			signal,
		});
		if (result.aborted) {
			console.warn(
				`${opts.label} aborted before completing (deadline ${opts.timeoutMs}ms) — ` +
					`provider catalogs stay at their last-known state`,
			);
			return;
		}
		if (result.errors.size > 0) {
			const failed = [...result.errors]
				.map(
					([id, error]) =>
						`${id} (${error instanceof Error ? error.message : String(error)})`,
				)
				.join("; ");
			console.warn(
				`${opts.label} failed for ${result.errors.size} provider(s): ${failed}`,
			);
		}
		// The readiness observation runs for EVERY completed refresh
		// (success or partial failure) so a provider that flips either way
		// is observed; a refresh that threw before completing holds the
		// previous snapshot (the catch below skips the observer).
		try {
			const snapshot = (opts.snapshotReadiness ?? refreshReadinessSnapshot)(models);
			opts.onReadinessChange?.(snapshot);
		} catch (error) {
			console.warn(
				`${opts.label}: readiness observation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} catch (error) {
		console.warn(
			`${opts.label} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timer);
	}
}
