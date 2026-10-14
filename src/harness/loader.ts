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
 * optional `submit` pass-through. Packages that predate the settled
 * contract export named factories (`createMemory`) whose results carry the
 * same `.extension` field, so the loader resolves, in order:
 *
 * 1. the default export, if it is a factory returning `{ extension,
 *    health?, submit? }` or is itself an `Extension` (named `name`),
 * 2. a named `createMemory` factory (the bridge for the pre-contract
 *    memory package),
 * 3. a named `extension` export.
 *
 * A factory MAY declare an arity-1 signature: the loader then passes the
 * host context (src/harness/seam-host.ts — the interaction/ambient seam
 * handles). Zero-arg factories keep working (extra arguments are inert in
 * JS), and the factory-result `interactionKinds`/`ambientKinds` string
 * arrays declare which seam kinds/keys the extension writes — validated
 * fail-loud here and consumed by the seam host's write gate and the
 * /v1/meta inventory. Only factory results can carry a health producer,
 * submit pass-through, or kind declarations (the direct-`Extension` forms
 * have no factory result to read one from). A `health`/`submit` field that
 * is present but not the expected shape, or kinds that are not string
 * arrays, is a contract violation — quarantined, never silently ignored.
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
import type { DeclaredKinds } from "./seam-host.js";
import { resolveExtensionEntry } from "./packages.js";

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
 * health producer / submit pass-through a factory
 * result carried alongside it. Only factory results can carry one; the
 * direct-`Extension` forms resolve without.
 */
export interface ResolvedExtension {
	readonly extension: Extension;
	/** Present only when resolution came from a factory result carrying one. */
	readonly health?: () => HealthStatus;
	/** Present only when the factory result carried one (the memory wiring's submit). */
	readonly submit?: ExtensionSubmit;
	/** Declared interaction kinds / ambient surface keys (both optional). */
	readonly interactionKinds?: readonly string[];
	readonly ambientKinds?: readonly string[];
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
 * A kinds declaration must be an array of non-empty strings (or absent).
 * The declaration drives the seam host's write gate and the /v1/meta
 * inventory — a malformed one is a contract violation, not a shrug.
 */
function validateKinds(value: unknown): string | null {
	if (value === undefined) return null;
	if (!Array.isArray(value)) return "kinds declaration must be an array of strings";
	if (value.some((k) => typeof k !== "string" || k.length === 0)) {
		return "kinds declaration must be an array of non-empty strings";
	}
	return null;
}

/**
 * Call an unknown-typed factory and validate the `{ extension, health?,
 * submit? }` result. A `health`/`submit` field that
 * is present but not the expected shape is a contract violation — thrown,
 * so the loader quarantines the extension (fail-loud: a package that THINKS
 * it reports health or owns a submit boundary must not read as healthy or
 * lose submissions from a broken capability).
 */
function resolvedFromFactory(
	factory: unknown,
	hostContext: unknown,
): ResolvedExtension | undefined {
	if (typeof factory !== "function") return undefined;
	const result = (factory as (host?: unknown) => unknown)(hostContext);
	if (typeof result !== "object" || result === null) return undefined;
	const candidate = result as {
		extension?: unknown;
		health?: unknown;
		submit?: unknown;
		interactionKinds?: unknown;
		ambientKinds?: unknown;
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
	const kindsProblem =
		validateKinds(candidate.interactionKinds) ??
		validateKinds(candidate.ambientKinds);
	if (kindsProblem !== null) throw new Error(kindsProblem);
	return {
		extension: candidate.extension,
		...(candidate.health === undefined
			? {}
			: { health: candidate.health as () => HealthStatus }),
		...(candidate.submit === undefined
			? {}
			: { submit: candidate.submit as ExtensionSubmit }),
		...(candidate.interactionKinds === undefined
			? {}
			: { interactionKinds: candidate.interactionKinds as readonly string[] }),
		...(candidate.ambientKinds === undefined
			? {}
			: { ambientKinds: candidate.ambientKinds as readonly string[] }),
	};
}

/**
 * Resolve one imported module to the extension the loader installs, per the
 * contract order documented on this module, retaining a factory-result §3
 * health producer when one was carried.
 */
export function resolveExtension(
	module: ExtensionModule,
	hostContext: unknown = undefined,
): ResolvedExtension | undefined {
	// 1. Default export: factory returning `{ extension, health? }`, or the Extension itself.
	const defaultExport = module.default;
	if (isExtension(defaultExport)) return { extension: defaultExport };
	const fromDefault = resolvedFromFactory(defaultExport, hostContext);
	if (fromDefault !== undefined) return fromDefault;

	// 2. Named real-package factories (bridge for the pre-contract packages).
	// A package whose factory result carries extra capabilities (approvals,
	// future insight/seam fields) resolves fine: only health and submit are
	// validated and retained; everything else is the extension's own business.
	const fromMemory = resolvedFromFactory(module.createMemory, hostContext);
	if (fromMemory !== undefined) return fromMemory;
	const fromApprovals = resolvedFromFactory(module.createApprovals, hostContext);
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
	/**
	 * Host-context factory (the interaction/ambient seam): invoked once per
	 * resolving extension with its pi-durable extension name and its declared
	 * kinds; the returned object is what the loader passes to arity-1
	 * factories. Omitted (or a factory that ignores the argument) = the
	 * extension uses no seam. The factory pattern lets boot own the lazy
	 * harness binding once, shared by every extension.
	 */
	readonly hostContextFactory?: (
		extensionName: string,
		kinds: DeclaredKinds,
	) => unknown;
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
			// Two-phase host: the factory receives the host at CALL time, but
			// the kinds it declares are only known from its RESULT. The host
			// therefore takes a mutable kinds cell the loader fills right
			// after resolution; a write gate that fires before the fill
			// (impossible: the factory body hasn't returned yet) would see
			// empty kinds and fail loud.
			const kindsCell: { kinds: DeclaredKinds } = { kinds: {} };
			let host: unknown;
			if (options.hostContextFactory !== undefined) {
				// The extension name is only known after resolution too —
				// pass an identity stub now, re-key after resolution.
				host = options.hostContextFactory("", kindsCell.kinds);
			}
			const resolved = resolveExtension(module, host);
			if (resolved === undefined) {
				throw new Error(
					`does not satisfy the sigrun extension-package contract ` +
						`(expected a default-export factory returning { extension })`,
				);
			}
			// Re-key the host with the real extension name + declared kinds
			// (the pre-resolution call used placeholders). The seam host
			// object is the SAME instance the factory captured, so a
			// post-hoc mutation of the cell reaches every later seam call.
			if (options.hostContextFactory !== undefined && resolved !== undefined) {
				const kinds: DeclaredKinds = {
					...(resolved.interactionKinds === undefined
						? {}
						: { interaction: resolved.interactionKinds }),
					...(resolved.ambientKinds === undefined
						? {}
						: { ambient: resolved.ambientKinds }),
				};
				// Rebuild through the factory so boot's map gets the final
				// identity; the factory's own closure captured the FIRST
				// host — acceptable because the first host already carries
				// the binding; only identity/kinds differ.
				options.hostContextFactory(resolved.extension.name, kinds);
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
			// A quarantined extension contributes no health producer or submit
			// binding: the §3 surfaces are reported through
			// `extensions[].status`, never double-reported.
		}
	}
	return { outcomes, healthProducers, submitBindings };
}
