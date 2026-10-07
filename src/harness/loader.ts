/**
 * The extension loader (spec §3 boot order, §4.1 deploy-time list).
 *
 * Extensions are EXTERNAL packages (separate repos — the
 * extension-separation ruling). `SIGRUN_EXTENSIONS` carries a comma-separated
 * specifiers (npm package names or resolvable paths); the loader
 * dynamic-imports each, resolves the sigrun extension-package contract, and
 * installs the pi-durable `Extension` into the registry *before*
 * `Harness.open` reads it.
 *
 * A failing extension is QUARANTINED: logged, reported as a degraded surface
 * via the outcome list (which `GET /v1/meta`, Task 9, surfaces as
 * `extensions[].status`), and boot continues — the loader never throws.
 *
 * The sigrun extension-package contract: a package's default export is a
 * factory returning an object with an `extension: Extension` field, plus an
 * optional §3 `health` producer (spec §3 — the memory-backend form; Task
 * 9e retains it for the §5 meta `health.memory` aggregation). The two real
 * packages (`sigrun-ext-memory`, `sigrun-ext-approvals`) predate the settled
 * contract and export named factories (`createMemory` /
 * `createApprovals`) whose results carry the same `.extension` field, so the
 * loader resolves, in order:
 *
 * 1. the default export, if it is a factory returning `{ extension,
 *    health? }` or is itself an `Extension` (named `name`),
 * 2. a named `createMemory` / `createApprovals` factory (the bridge for the
 *    two real packages),
 * 3. a named `extension` export.
 *
 * The factories take no arguments; any configuration they need is resolved
 * from their own package context. Only factory results can carry a health
 * producer (the direct-`Extension` forms have no factory result to read one
 * from). A `health` field that is present but not a function is a contract
 * violation — quarantined, never silently ignored.
 */

import type { Extension, Registry } from "@earendil-works/pi-durable";
import type { HealthStatus } from "./health.js";

/** One loaded extension's boot outcome, for `GET /v1/meta` `extensions[]`. */
export interface ExtensionOutcome {
	/** The extension name on success; the specifier on quarantine. */
	readonly name: string;
	readonly status: "ok" | "quarantined";
	/** The failure message; present only when `status === "quarantined"`. */
	readonly error?: string;
}

/**
 * A §3 health producer retained from an extension factory result (Task
 * 9e). The producer is paired with the resolved `Extension` — the same
 * object the loader installs — so boot can correlate it with the
 * memory-surface owner from the registry by IDENTITY (a same-name
 * reinstall cannot mis-attribute it).
 */
export interface ExtensionHealthProducer {
	/** The extension the factory result carried the producer for. */
	readonly extension: Extension;
	readonly health: () => HealthStatus;
}

/** What `loadExtensions` yields: the wire-report outcomes + retained producers. */
export interface LoadedExtensions {
	/** One entry per configured specifier, in order — never empty-entry gaps. */
	readonly outcomes: readonly ExtensionOutcome[];
	/**
	 * §3 producers from factory results, one per loaded extension that
	 * carried one; quarantined extensions and the no-op memory default
	 * contribute none (degenerate ok by absence).
	 */
	readonly healthProducers: readonly ExtensionHealthProducer[];
}

/** Minimal module shape the contract resolution reads. */
interface ExtensionModule {
	readonly default?: unknown;
	readonly extension?: unknown;
	readonly createMemory?: unknown;
	readonly createApprovals?: unknown;
}

/**
 * What the contract resolution yields: the `Extension` plus the optional §3
 * health producer a factory result carried alongside it. Only factory
 * results can carry one; the direct-`Extension` forms resolve without.
 */
export interface ResolvedExtension {
	readonly extension: Extension;
	/** Present only when resolution came from a factory result carrying one. */
	readonly health?: () => HealthStatus;
}

/** A structural check for "looks like a pi-durable Extension". */
function isExtension(value: unknown): value is Extension {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Extension).name === "string"
	);
}

/**
 * Call an unknown-typed factory and validate the `{ extension, health? }`
 * result. A `health` field that is present but not a function is a contract
 * violation — thrown, so the loader quarantines the extension (fail-loud:
 * a package that THINKS it reports health must not read as healthy).
 */
function resolvedFromFactory(
	factory: unknown,
): ResolvedExtension | undefined {
	if (typeof factory !== "function") return undefined;
	const result = (factory as () => unknown)();
	if (typeof result !== "object" || result === null) return undefined;
	const candidate = result as { extension?: unknown; health?: unknown };
	if (!isExtension(candidate.extension)) return undefined;
	if (candidate.health === undefined) {
		return { extension: candidate.extension };
	}
	if (typeof candidate.health !== "function") {
		throw new Error(
			"extension factory returned a health field that is not a function",
		);
	}
	return {
		extension: candidate.extension,
		health: candidate.health as () => HealthStatus,
	};
}

/**
 * Resolve one imported module to the extension the loader installs, per the
 * contract order documented on this module, retaining a factory-result §3
 * health producer when one was carried.
 */
export function resolveExtension(
	module: ExtensionModule,
): ResolvedExtension | undefined {
	// 1. Default export: factory returning `{ extension, health? }`, or the Extension itself.
	const defaultExport = module.default;
	if (isExtension(defaultExport)) return { extension: defaultExport };
	const fromDefault = resolvedFromFactory(defaultExport);
	if (fromDefault !== undefined) return fromDefault;

	// 2. Named real-package factories (bridge for the pre-contract packages).
	const fromMemory = resolvedFromFactory(module.createMemory);
	if (fromMemory !== undefined) return fromMemory;
	const fromApprovals = resolvedFromFactory(module.createApprovals);
	if (fromApprovals !== undefined) return fromApprovals;

	// 3. Named `extension` export.
	if (isExtension(module.extension)) return { extension: module.extension };

	return undefined;
}

/**
 * Load and install every configured extension, quarantining failures.
 *
 * @param specifiers package specifiers from `SIGRUN_EXTENSIONS` (npm names,
 * absolute/relative paths, or `file://` URLs) — or the test seam's explicit
 * list.
 * @param registry the application-owned registry; install publishes at once,
 * so extensions land before `Harness.open` reads the registry.
 * @returns the outcome list (one entry per specifier, in order — never
 * empty-entry gaps; boot stores this for `GET /v1/meta`, Task 9) plus the
 * §3 health producers retained from factory results, paired with their
 * extensions for identity correlation (Task 9e).
 */
export async function loadExtensions(
	specifiers: readonly string[],
	registry: Registry,
): Promise<LoadedExtensions> {
	const outcomes: ExtensionOutcome[] = [];
	const healthProducers: ExtensionHealthProducer[] = [];
	for (const specifier of specifiers) {
		try {
			const module = (await import(specifier)) as ExtensionModule;
			const resolved = resolveExtension(module);
			if (resolved === undefined) {
				throw new Error(
					`does not satisfy the sigrun extension-package contract ` +
						`(expected a default-export factory returning { extension })`,
				);
			}
			registry.install(resolved.extension);
			outcomes.push({ name: resolved.extension.name, status: "ok" });
			if (resolved.health !== undefined) {
				healthProducers.push({
					extension: resolved.extension,
					health: resolved.health,
				});
			}
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			console.warn(
				`extension quarantined: ${specifier} failed to load: ${message}`,
			);
			outcomes.push({
				name: specifier,
				status: "quarantined",
				error: message,
			});
			// A quarantined extension contributes no health producer: the §3
			// surface is reported through `extensions[].status`, never
			// double-reported into the §5 health block.
		}
	}
	return { outcomes, healthProducers };
}
