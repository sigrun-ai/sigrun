/**
 * The §3 health contract (spec §3): a surface whose implementation can fail
 * at runtime exposes a health producer; core aggregates the producers
 * retained at boot into the §5 meta `health` block (Task 9e).
 *
 * Producers are SYNCHRONOUS status reads — the meta route calls them per
 * request, so the route itself never touches the network or storage. In v1
 * memory backends (through the extension factory result) and provider
 * contributors implement the contract; a degenerate implementation reports
 * `"ok"`, and BY CONVENTION the absence of a producer means the same — a
 * degenerate surface need not synthesize a constant producer.
 *
 * SPLIT (build-and-webui Task 1): the `HealthStatus` union's canonical
 * declaration lives in the `@sigrun/shared` package
 * (`shared/src/views.ts` — it rides the §5 `meta.health` wire); this
 * module owns the producer contract and aggregation runtime, re-exporting
 * the union for server-side importers.
 */

import type { HealthStatus } from "@sigrun/shared/views";

export type { HealthStatus } from "@sigrun/shared/views";

/** One named §3 health producer (the provider-contributor form). */
export interface HealthProducer {
	/** The contributing surface's name, for diagnostics. */
	readonly name: string;
	readonly health: () => HealthStatus;
}

/**
 * Aggregate §3 producers for the §5 `health.providers` field: ANY producer
 * reporting `"degraded"` degrades the surface; no producers — or all ok —
 * is `"ok"` (degenerate surfaces report ok by absence, spec §3).
 */
export function aggregateHealth(
	producers: readonly HealthProducer[],
): HealthStatus {
	for (const producer of producers) {
		if (producer.health() === "degraded") return "degraded";
	}
	return "ok";
}
