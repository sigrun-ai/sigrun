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
 * 9e retains it for the §5 meta `health.memory` aggregation), an optional
 * `submit` pass-through (the memory wiring's submit — Task 26a retains it so
 * boot can expose it as `OpenedHarness.memorySubmit`; it binds the
 * conversation as the memory_recall source at the submit boundary), and an
 * optional `approvals` capability (the approvals surface's structural
 * contract, publish prep 2.1 — the §5 approvals routes call through it, so
 * core imports nothing from any approvals package). Packages that predate
 * the settled contract export named factories (`createMemory` /
 * `createApprovals`) whose results carry the same `.extension` field, so the
 * loader resolves, in order:
 *
 * 1. the default export, if it is a factory returning `{ extension,
 *    health?, submit?, approvals? }` or is itself an `Extension` (named
 *    `name`),
 * 2. a named `createMemory` / `createApprovals` factory (the bridge for the
 *    two real packages),
 * 3. a named `extension` export.
 *
 * The factories take no arguments; any configuration they need is resolved
 * from their own package context. Only factory results can carry a health
 * producer, submit pass-through, or approvals capability (the
 * direct-`Extension` forms have no factory result to read one from). A
 * `health`, `submit`, or `approvals` field that is present but not the
 * expected shape is a contract violation — quarantined, never
 * silently ignored.
 */

import type { Context } from "@earendil-works/chord";
import type {
	Conversation,
	Extension,
	Registry,
	Submission,
	SubmissionDraft,
} from "@earendil-works/pi-durable";
import type { HealthStatus } from "./health.js";
import { resolveExtensionEntry } from "./packages.js";
import type {
	ExtensionApprovals,
} from "../server/approvals.js";

/** One loaded extension's boot outcome, for `GET /v1/meta` `extensions[]`. */
export interface ExtensionOutcome {
	/** The extension name on success; the specifier on quarantine. */
	readonly name: string;
	readonly status: "ok" | "quarantined";
	/** The failure message; present only when `status === "quarantined"`. */
	readonly error?: string;
}

/**
 * A factory-result submit pass-through (the memory wiring's `submit`,
 * Task 26a): binds the conversation as the memory_recall source at the
 * submit boundary, then admits the submission. Boot exposes the
 * memory-surface owner's as `OpenedHarness.memorySubmit`; the §5 server
 * submits through it when present.
 */
export type ExtensionSubmit = (
	conversation: Conversation,
	submission: SubmissionDraft,
	context: Context,
) => Promise<Submission>;

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

/**
 * A factory-result submit pass-through retained from an extension factory
 * result (Task 26a) — paired with the resolved `Extension` exactly like
 * `ExtensionHealthProducer`, so boot identity-matches it to the
 * memory-surface owner.
 */
export interface ExtensionSubmitBinding {
	/** The extension the factory result carried the submit for. */
	readonly extension: Extension;
	readonly submit: ExtensionSubmit;
}

/**
 * A factory-result approvals capability (publish prep 2.1): the approvals
 * surface's structural contract, paired with the resolved `Extension` so
 * boot identity-matches it to the extension installed under the approvals
 * name — exactly like `ExtensionHealthProducer`/`ExtensionSubmitBinding`.
 */
export interface ExtensionApprovalsBinding {
	/** The extension the factory result carried the capability for. */
	readonly extension: Extension;
	readonly approvals: ExtensionApprovals;
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
	/**
	 * Submit pass-throughs from factory results (Task 26a), one per loaded
	 * extension that carried one; quarantined extensions contribute none.
	 */
	readonly submitBindings: readonly ExtensionSubmitBinding[];
	/**
	 * Approvals capabilities from factory results (publish prep 2.1), one
	 * per loaded extension that carried one; quarantined extensions
	 * contribute none.
	 */
	readonly approvalsBindings: readonly ExtensionApprovalsBinding[];
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
 * health producer / submit pass-through / approvals capability a factory
 * result carried alongside it. Only factory results can carry one; the
 * direct-`Extension` forms resolve without.
 */
export interface ResolvedExtension {
	readonly extension: Extension;
	/** Present only when resolution came from a factory result carrying one. */
	readonly health?: () => HealthStatus;
	/** Present only when the factory result carried one (the memory wiring's submit). */
	readonly submit?: ExtensionSubmit;
	/** Present only when the factory result carried one (the approvals surface). */
	readonly approvals?: ExtensionApprovals;
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
 * Whether a factory result's `approvals` field satisfies the structural
 * capability: both members must be functions.
 */
function isApprovalsCapability(value: unknown): value is ExtensionApprovals {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		listPending?: unknown;
		decide?: unknown;
	};
	return (
		typeof candidate.listPending === "function" &&
		typeof candidate.decide === "function"
	);
}

/**
 * Call an unknown-typed factory and validate the `{ extension, health?,
 * submit?, approvals? }` result. A `health`/`submit`/`approvals` field that
 * is present but not the expected shape is a contract violation — thrown,
 * so the loader quarantines the extension (fail-loud: a package that THINKS
 * it reports health, owns a submit boundary, or speaks the approvals
 * surface must not read as healthy, lose submissions, or serve approvals
 * from a broken capability).
 */
function resolvedFromFactory(
	factory: unknown,
): ResolvedExtension | undefined {
	if (typeof factory !== "function") return undefined;
	const result = (factory as () => unknown)();
	if (typeof result !== "object" || result === null) return undefined;
	const candidate = result as {
		extension?: unknown;
		health?: unknown;
		submit?: unknown;
		approvals?: unknown;
	};
	if (!isExtension(candidate.extension)) return undefined;
	if (
		candidate.health !== undefined &&
		typeof candidate.health !== "function"
	) {
		throw new Error(
			"extension factory returned a health field that is not a function",
		);
	}
	if (
		candidate.submit !== undefined &&
		typeof candidate.submit !== "function"
	) {
		throw new Error(
			"extension factory returned a submit field that is not a function",
		);
	}
	if (
		candidate.approvals !== undefined &&
		!isApprovalsCapability(candidate.approvals)
	) {
		throw new Error(
			"extension factory returned an approvals field that is not the " +
				"approvals capability (expected listPending/decide functions)",
		);
	}
	return {
		extension: candidate.extension,
		...(candidate.health === undefined
			? {}
			: { health: candidate.health as () => HealthStatus }),
		...(candidate.submit === undefined
			? {}
			: { submit: candidate.submit as ExtensionSubmit }),
		...(candidate.approvals === undefined
			? {}
			: { approvals: candidate.approvals }),
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

/** Optional `loadExtensions` inputs. */
export interface LoadExtensionsOptions {
	/**
	 * The deployment's packages dir (`<config-dir>/packages`), consulted
	 * FIRST for every specifier — what the settings file's `packages`
	 * array installed wins over anything resolvable from the app tree.
	 * Undefined keeps bare-specifier resolution (the pre-packages boot
	 * shape; tests that never touch a packages dir).
	 */
	readonly packagesDir?: string;
	/** Optional context: the gitDir for the sync step's logging. */
	readonly gitDir?: string;
}

/** One pre-resolved extension load (the boot flow's sync output). */
export interface ResolvedExtensionInput {
	/** Optional display name (the source specifier; drives quarantine names). */
	readonly name?: string;
	/** The module entry: an absolute `file://` URL or any import() specifier. */
	readonly entry: string;
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
 * §3 health producers and submit pass-throughs retained from factory
 * results, paired with their extensions for identity correlation (Task 9e,
 * Task 26a).
 */
export async function loadExtensions(
specifiers: readonly string[] | readonly ResolvedExtensionInput[],
registry: Registry,
options: LoadExtensionsOptions = {},
): Promise<LoadedExtensions> {
// Normalize: the caller may hand pre-resolved entries (the boot flow,
// syncPackages consumer) or raw specifiers (the test seam, env-only
// deploys). Each becomes {entry, label} — label drives the warning
// name exactly as specifiers did.
const entries = specifiers.map((spec) =>
typeof spec === "string"
? { name: undefined as string | undefined, entry: spec }
: { name: spec.name, entry: spec.entry },
);
const outcomes: ExtensionOutcome[] = [];
const healthProducers: ExtensionHealthProducer[] = [];
const submitBindings: ExtensionSubmitBinding[] = [];
const approvalsBindings: ExtensionApprovalsBinding[] = [];
for (const { name: label, entry } of entries) {
const display = label ?? entry;
				try {
						// Pre-resolved entries (the boot flow) import verbatim;
						// raw specifiers (the test seam) resolve through the
						// packages dir first, then bare import resolution.
						const loaded =
								label !== undefined
										? entry
										: (options.packagesDir === undefined
												? entry
												: (resolveExtensionEntry(entry, options.packagesDir) ?? entry));
						// Resolution order (the packages-dir ruling): the deployment's
						// packages dir FIRST (what `packages[]` installed wins over
						// anything the image bundles), then bare import resolution
						// (paths, file:// URLs, dev checkouts, app-tree packages). The
						// packages dir is an unrelated node_modules tree — Node's
						// upward walk never finds it from sigrun's own imports, so it
						// must be consulted explicitly.
						const module = (await import(loaded)) as ExtensionModule;
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
			if (resolved.submit !== undefined) {
				submitBindings.push({
					extension: resolved.extension,
					submit: resolved.submit,
				});
			}
			if (resolved.approvals !== undefined) {
					approvalsBindings.push({
						extension: resolved.extension,
					approvals: resolved.approvals,
				});
			}
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			console.warn(
				`extension quarantined: ${display} failed to load: ${message}`,
			);
			outcomes.push({
				name: display,
				status: "quarantined",
				error: message,
			});
			// A quarantined extension contributes no health producer, submit
			// binding, or approvals capability: the §3/§5 surfaces are reported
			// through `extensions[].status`, never double-reported.
		}
	}
	return { outcomes, healthProducers, submitBindings, approvalsBindings };
}
