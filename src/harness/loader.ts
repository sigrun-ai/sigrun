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
 * Extension IDENTITY is the slug (spec §6): each resolved extension's
 * declared name is sanitized ONCE at load (`slugifyName`,
 * src/harness/stores.ts) and the slug replaces the name for everything
 * downstream — the registry key, the seam host's identity, interaction/
 * ambient records, worker names, and health correlation. A declared name
 * that sanitizes to an empty slug, or a slug already claimed by another
 * loaded extension this boot, fails the LOAD (quarantine naming the
 * declared name(s)) — never the first store use mid-run.
 *
 * The sigrun extension-package contract: a package's default export is a
 * factory returning an object with an `extension: Extension` field, plus an
 * optional §3 `health` producer (spec §3 — the memory-backend form; Task
 * 9e retains it for the §5 meta `health.memory` aggregation), an optional
 * `submit` pass-through (the memory wiring's submit — Task 26a retains it so
 * boot can expose it as `OpenedHarness.memorySubmit`; it binds the
 * conversation as the memory_recall source at the submit boundary), and an
 * optional `submit` pass-through. A factory result may also carry a
 * `providers` array (`ProviderContribution[]`, provider plugins Task 1):
 * boot feeds every loaded contributor into `collectProviders` after the
 * `options.extensions` seam — and a result carrying `providers` with NO
 * `extension` is a valid PROVIDER-ONLY contributor (the model-plugin shape:
 * no pi-durable surface, identified by its `name` field). Factories may
 * return a Promise (the plugins read their scoped settings store inside the
 * factory); the loader awaits the result. Packages that predate the settled
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
 * handles plus the scoped extension-stores handle `stores` (spec §5:
 * get/set on the extension's OWN secrets section and settings file, and
 * its own raw data/cache/state paths; src/harness/stores.ts). Zero-arg
 * factories keep working (extra arguments are inert in
 * JS), and the factory-result `interactionKinds`/`ambientKinds` string
 * arrays declare which seam kinds/keys the extension writes — validated
 * fail-loud here and consumed by the seam host's write gate and the
 * /v1/meta inventory. Only factory results can carry a health producer,
 * submit pass-through, or kind declarations (the direct-`Extension` forms
 * have no factory result to read one from). A `health`/`submit` field that
 * is present but not the expected shape, or kinds that are not string
 * arrays, is a contract violation — quarantined, never silently ignored.
 * A `providers` entry whose `provider` has no string `id` is the same class
 * of violation (a plugin that THINKS it contributed a provider must not
 * silently lose it).
 */

import type { Context } from "@earendil-works/chord";
import type {
	Conversation,
	Extension,
	Registry,
	Submission,
	SubmissionDraft,
} from "@earendil-works/pi-durable";
import type {
	ExtensionEventHandlers,
	ExtensionRunSettledHandler,
	ExtensionWorker,
} from "./event-bus.js";
import type { HealthStatus } from "./health.js";
import type { ProviderContribution, ProviderContributor } from "./providers/index.js";
import type { DeclaredKinds } from "./seam-host.js";
import { resolveExtensionEntry } from "./packages.js";
import { slugifyName } from "./stores.js";

/** One loaded extension's boot outcome, for `GET /v1/meta` `extensions[]`. */
export interface ExtensionOutcome {
	/** The extension's slug identity on success; the specifier on quarantine. */
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
 * A factory-result `runSettled` handler retained from an extension factory
 * result (memory-seam Task 3) — paired with the resolved `Extension` like
 * the health/submit bindings, so boot registers it on the event bus under
 * the extension's final name.
 */
export interface ExtensionRunSettledBinding {
	/** The extension the factory result carried the handler for. */
	readonly extension: Extension;
	readonly runSettled: ExtensionRunSettledHandler;
}

/** The lifecycle handler fields a factory result may carry (memory-seam Task 4). */
export type ExtensionLifecycleHandlers = Pick<
	ExtensionEventHandlers,
	"conversationCreated" | "conversationForked" | "conversationArchived" | "conversationIdle" | "harnessShutdown"
>;

/** Every lifecycle field name, in validation order (mirrors the contract doc). */
const LIFECYCLE_FIELDS = [
	"conversationCreated",
	"conversationForked",
	"conversationArchived",
	"conversationIdle",
	"harnessShutdown",
] as const;

/**
 * The lifecycle handlers retained from one extension factory result
 * (memory-seam Task 4) — paired with the resolved `Extension` like the
 * runSettled binding; boot merges the two lists per extension name before
 * registering on the event bus (a same-name `registerExtension` call
 * REPLACES, so the merge must happen boot-side).
 */
export interface ExtensionLifecycleBinding {
	/** The extension the factory result carried the handlers for. */
	readonly extension: Extension;
	readonly handlers: ExtensionLifecycleHandlers;
}

/**
 * A factory-result `workers` declaration retained from an extension factory
 * result (memory-seam Task 5 — the curator contract) — paired with the
 * resolved `Extension` like the other bindings; boot merges the workers into
 * the extension's bus registration (timers + wake fan-out are host-owned).
 */
export interface ExtensionWorkerBinding {
	/** The extension the factory result carried the workers for. */
	readonly extension: Extension;
	readonly workers: readonly ExtensionWorker[];
}

/** What `loadExtensions` yields: the wire-report outcomes + retained producers. */
export interface LoadedExtensions {
	/** One entry per configured specifier, in order — never empty-entry gaps. */
	readonly outcomes: readonly ExtensionOutcome[];
	/**
	 * Provider contributors from factory results (provider plugins Task 1):
	 * one `{name, providers, health?}` entry per loaded extension whose
	 * result carried `providers` — the name is the slug identity. Boot
	 * concatenates these AFTER its `options.extensions` seam into
	 * `collectProviders`. A result with only a health producer (the §5
	 * memory aggregation's input) contributes none — that producer is
	 * retained below, inert for the provider surface.
	 */
	readonly providerContributors: readonly ProviderContributor[];
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
	 * `runSettled` handlers from factory results (memory-seam Task 3), one
	 * per loaded extension that carried one; quarantined extensions
	 * contribute none. Boot registers each on the event bus under the
	 * extension's final name.
	 */
	readonly runSettledBindings: readonly ExtensionRunSettledBinding[];
	/**
	 * Lifecycle handlers from factory results (memory-seam Task 4), one per
	 * loaded extension that carried ANY of the five fields; quarantined
	 * extensions contribute none. Boot merges these with the runSettled
	 * bindings per extension name and registers the result on the bus.
	 */
	readonly lifecycleBindings: readonly ExtensionLifecycleBinding[];
	/**
	 * `workers` declarations from factory results (memory-seam Task 5), one
	 * per loaded extension that carried one; quarantined extensions
	 * contribute none. Boot merges them into the bus registration.
	 */
	readonly workerBindings: readonly ExtensionWorkerBinding[];
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
	/**
	 * The pi-durable `Extension` to install. ABSENT for provider-only
	 * contributors (a factory result carrying `providers` with no
	 * `extension` — identified by `name` instead).
	 */
	readonly extension?: Extension;
	/**
	 * The provider-only contributor's declared name — its collision-record
	 * identity, sanitized to the slug like every extension name. Present
	 * only when the factory result carried `providers` without an
	 * `extension`; an extension-carrying result's identity is always the
	 * extension's own name.
	 */
	readonly name?: string;
	/** Present only when resolution came from a factory result carrying one. */
	readonly health?: () => HealthStatus;
	/** Present only when the factory result carried one (the memory wiring's submit). */
	readonly submit?: ExtensionSubmit;
	/** Present only when the factory result carried one (memory-seam Task 3). */
	readonly runSettled?: ExtensionRunSettledHandler;
	/** Present only when the factory result carried any of them (memory-seam Task 4). */
	readonly lifecycle?: ExtensionLifecycleHandlers;
	/** Present only when the factory result carried one (memory-seam Task 5). */
	readonly workers?: readonly ExtensionWorker[];
	/** Provider contributions (provider plugins Task 1), validated fail-loud. */
	readonly providers?: readonly ProviderContribution[];
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
 * The lifecycle event names a worker's `wakeOn` may declare (memory-seam
 * Task 5): `harnessShutdown` is excluded — workers stop BEFORE the shutdown
 * handlers run (spec §3 shutdown ordering), so waking on it is meaningless.
 */
const WAKE_EVENTS = new Set([
	"conversationCreated",
	"conversationForked",
	"conversationArchived",
	"conversationIdle",
]);

/**
 * Validate a factory result's `workers` declaration (memory-seam Task 5,
 * the curator contract). Absent → undefined (no workers). Present but
 * malformed → throw; the loader quarantines the extension with the thrown
 * message (fail-loud: an extension that THINKS it declared a curator must
 * not silently lose it). Validation order per worker: name, duplicate,
 * run, every, wakeOn, at-least-one-trigger.
 */
function validateWorkers(value: unknown): readonly ExtensionWorker[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(
			"extension factory returned a workers field that is not an array",
		);
	}
	const seen = new Set<string>();
	for (const entry of value) {
		const worker = entry as {
			name?: unknown;
			every?: unknown;
			wakeOn?: unknown;
			run?: unknown;
		} | null;
		const name = worker?.name;
		if (typeof name !== "string" || name.length === 0) {
			throw new Error("extension factory returned a worker without a name");
		}
		if (seen.has(name)) {
			throw new Error(
				`extension factory returned a worker with a duplicate worker name "${name}"`,
			);
		}
		seen.add(name);
		if (typeof worker?.run !== "function") {
			throw new Error(
				`extension factory returned a worker whose worker "${name}" has a run field that is not a function`,
			);
		}
		const every = worker?.every as { ms?: unknown } | undefined;
		if (
			every !== undefined &&
			!(typeof every?.ms === "number" && every.ms > 0)
		) {
			throw new Error(
				`extension factory returned a worker whose worker "${name}" has every.ms <= 0`,
			);
		}
		if (
			worker?.wakeOn !== undefined &&
			(!Array.isArray(worker.wakeOn) ||
				worker.wakeOn.some(
					(event) => typeof event !== "string" || !WAKE_EVENTS.has(event),
				))
		) {
			throw new Error(
				`extension factory returned a worker whose worker "${name}" has an invalid wakeOn entry`,
			);
		}
		if (every === undefined && worker?.wakeOn === undefined) {
			throw new Error(
				"extension factory returned a worker that declares a worker with neither every nor wakeOn",
			);
		}
	}
	return value as readonly ExtensionWorker[];
}

/**
 * Validate a factory result's `providers` declaration (provider plugins
 * Task 1). Absent → undefined (no contributions). Present but malformed →
 * throw; the loader quarantines the extension with the thrown message
 * (fail-loud: a plugin that THINKS it contributed a provider must not
 * silently lose it). Each entry must be a `ProviderContribution` — an
 * object whose `provider` carries a string `id`, the key the collector
 * merges by and the §5 ownership records read.
 */
function validateProviders(
	value: unknown,
): readonly ProviderContribution[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(
			"extension factory returned a providers field that is not an array",
		);
	}
	for (const entry of value) {
		const provider = (entry as { provider?: unknown } | null)?.provider;
		if (
			typeof provider !== "object" ||
			provider === null ||
			typeof (provider as { id?: unknown }).id !== "string"
		) {
			throw new Error(
				"extension factory returned a providers entry whose provider.id is missing or not a string",
			);
		}
	}
	return value as readonly ProviderContribution[];
}

/**
 * Call an unknown-typed factory and validate the `{ extension, health?,
 * submit? }` result. A `health`/`submit` field that
 * is present but not the expected shape is a contract violation — thrown,
 * so the loader quarantines the extension (fail-loud: a package that THINKS
 * it reports health or owns a submit boundary must not read as healthy or
 * lose submissions from a broken capability).
 *
 * The factory result may be a Promise (provider plugins read their scoped
 * settings store inside the factory) — awaited before validation. A result
 * carrying `providers` with NO `extension` is a valid provider-only
 * contributor (named by its `name` field); a result with neither is not
 * this contract form at all (returns undefined, falling through to the
 * next resolution candidate).
 */
async function resolvedFromFactory(
	factory: unknown,
	hostContext: unknown,
): Promise<ResolvedExtension | undefined> {
	if (typeof factory !== "function") return undefined;
	// Arity gate: the host context goes ONLY to factories that declare the
	// arity-1 signature (factory.length > 0). A length-0 factory with a
	// defaulted first parameter (createMemory(backend = new Backend()),
	// createApprovals(options = {})) consumes its first argument as a real
	// dependency — passing the host unconditionally landed it in that slot
	// and broke the extension at runtime (memory: every submit 500ed on
	// `bindRecallSource is not a function`). Extra arguments are inert only
	// for factories that read none; `length` is how the contract declares it.
	const result =
		factory.length > 0
			? (factory as (host?: unknown) => unknown)(hostContext)
			: (factory as () => unknown)();
	// Provider plugins may resolve asynchronously; `await` passes a
	// synchronous result through unchanged.
	const awaited = await result;
	if (typeof awaited !== "object" || awaited === null) return undefined;
	const candidate = awaited as {
		extension?: unknown;
		name?: unknown;
		providers?: unknown;
		health?: unknown;
		submit?: unknown;
		runSettled?: unknown;
		conversationCreated?: unknown;
		conversationForked?: unknown;
		conversationArchived?: unknown;
		conversationIdle?: unknown;
		harnessShutdown?: unknown;
		interactionKinds?: unknown;
		ambientKinds?: unknown;
	};
	const providers = validateProviders(candidate.providers);
	const extension = isExtension(candidate.extension)
		? candidate.extension
		: undefined;
	if (extension === undefined) {
		// Provider-only contributor: valid only when `providers` is present;
		// otherwise this factory result is not the contract form (fall
		// through to the next resolution candidate). The contributor's name
		// is its collision-record identity — without one there is nothing to
		// attribute providers or health to, which is a contract violation.
		if (providers === undefined) return undefined;
		if (typeof candidate.name !== "string" || candidate.name.length === 0) {
			throw new Error(
				"extension factory returned a provider-only result without a name",
			);
		}
	}
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
		candidate.runSettled !== undefined &&
		typeof candidate.runSettled !== "function"
	) {
		throw new Error(
			"extension factory returned a runSettled field that is not a function",
		);
	}
	// The five lifecycle fields (memory-seam Task 4) validate identically:
	// present-but-not-a-function is a contract violation — the extension
	// THINKS it listens to lifecycle events and must not silently miss them.
	const lifecycle = {} as Record<string, unknown>;
	let anyLifecycle = false;
	for (const field of LIFECYCLE_FIELDS) {
		const value = candidate[field];
		if (value === undefined) continue;
		if (typeof value !== "function") {
			throw new Error(
				`extension factory returned a ${field} field that is not a function`,
			);
		}
		lifecycle[field] = value;
		anyLifecycle = true;
	}
	const kindsProblem =
		validateKinds(candidate.interactionKinds) ??
		validateKinds(candidate.ambientKinds);
	if (kindsProblem !== null) throw new Error(kindsProblem);
	const workers = validateWorkers(
		(candidate as { workers?: unknown }).workers,
	);
	return {
		// Identity: the extension when one was carried, else the
		// provider-only contributor's validated `name`.
		...(extension !== undefined
			? { extension }
			: { name: candidate.name as string }),
		...(candidate.health === undefined
			? {}
			: { health: candidate.health as () => HealthStatus }),
		...(candidate.submit === undefined
			? {}
			: { submit: candidate.submit as ExtensionSubmit }),
		...(candidate.runSettled === undefined
			? {}
			: { runSettled: candidate.runSettled as ExtensionRunSettledHandler }),
		...(anyLifecycle
			? {
					// SAFETY: every value under `lifecycle` passed `typeof === "function"`
					// against its LIFECYCLE_FIELDS key above, so the object matches
					// ExtensionLifecycleHandlers key-for-key and value-for-value.
					lifecycle: lifecycle as unknown as ExtensionLifecycleHandlers,
				}
			: {}),
		...(candidate.interactionKinds === undefined
			? {}
			: { interactionKinds: candidate.interactionKinds as readonly string[] }),
		...(candidate.ambientKinds === undefined
			? {}
			: { ambientKinds: candidate.ambientKinds as readonly string[] }),
		...(workers === undefined ? {} : { workers }),
		...(providers === undefined ? {} : { providers }),
	};
}

/**
 * Resolve one imported module to the extension the loader installs, per the
 * contract order documented on this module, retaining a factory-result §3
 * health producer when one was carried. Async: the factory result may be a
 * Promise (settings-reading provider plugins).
 */
export async function resolveExtension(
	module: ExtensionModule,
	hostContext: unknown = undefined,
): Promise<ResolvedExtension | undefined> {
	// 1. Default export: factory returning `{ extension, health? }`, or the Extension itself.
	const defaultExport = module.default;
	if (isExtension(defaultExport)) return { extension: defaultExport };
	const fromDefault = await resolvedFromFactory(defaultExport, hostContext);
	if (fromDefault !== undefined) return fromDefault;

	// 2. Named real-package factories (bridge for the pre-contract packages).
	// A package whose factory result carries extra capabilities (approvals,
	// future insight/seam fields) resolves fine: only health and submit are
	// validated and retained; everything else is the extension's own business.
	const fromMemory = await resolvedFromFactory(module.createMemory, hostContext);
	if (fromMemory !== undefined) return fromMemory;
	const fromApprovals = await resolvedFromFactory(
		module.createApprovals,
		hostContext,
	);
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
 * Scan the installed registry snapshot for tool names registered by more
 * than one extension, and `console.warn` each collision (Task 7, spec
 * slice 4): pi-durable resolves tools by NAME (`resolveAgent` composes a
 * name→tool map in install order, so the LAST registration wins and the
 * earlier one is shadowed silently). The scan changes nothing — last-wins
 * is pi-durable's behavior — it only makes the shadowing visible at boot,
 * which is the surface a deployer needs to notice a co-installed
 * replacement extension (the slice-4 replacement contract is "do not
 * co-install", so any collision here is a configuration mistake).
 */
function warnToolNameCollisions(registry: Registry): void {
	const byName = new Map<string, { extension: string }[]>();
	for (const { extension, tool } of registry.snapshot().tools()) {
		const owners = byName.get(tool.name) ?? [];
		owners.push({ extension: extension.name });
		byName.set(tool.name, owners);
	}
	for (const [toolName, owners] of byName) {
		if (owners.length < 2) continue;
		const names = owners.map((owner) => owner.extension).join(", ");
		console.warn(
			`sigrun: duplicate tool name "${toolName}" registered by extensions ` +
				`[${names}]; the last-listed registration wins (pi-durable resolves ` +
				`tool names last-selected-wins) — do not co-install extensions ` +
				`that register the same tool name`,
		);
	}
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
const providerContributors: ProviderContributor[] = [];
const healthProducers: ExtensionHealthProducer[] = [];
const submitBindings: ExtensionSubmitBinding[] = [];
const runSettledBindings: ExtensionRunSettledBinding[] = [];
const lifecycleBindings: ExtensionLifecycleBinding[] = [];
const workerBindings: ExtensionWorkerBinding[] = [];
// Slug → declared name, for collision rejection at load (this boot's
// loaded set only — quarantined extensions never claim a slug).
const slugs = new Map<string, string>();
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
			// the extension name and kinds it declares are only known from its
			// RESULT. The loader therefore invokes the host factory TWICE with
			// the SAME instance: once pre-resolution with placeholder identity
			// ("", no kinds) so the factory body has a host to capture, and once
			// post-resolution with the real name + kinds — boot's factory
			// re-keys the SAME host object IN PLACE (SeamHost.rekey), so the
			// instance the factory captured becomes the final host and its
			// write gate sees the declared kinds from then on.
			let host: unknown;
			if (options.hostContextFactory !== undefined) {
				host = options.hostContextFactory("", {});
			}
			const resolved = await resolveExtension(module, host);
			if (resolved === undefined) {
				throw new Error(
					`does not satisfy the sigrun extension-package contract ` +
					`(expected a default-export factory returning { extension })`,
				);
			}
				// Task 3 — the slug IS the extension identity from here down: ONE
				// sanitization point, computed from the DECLARED name at load and
				// applied before the seam host is re-keyed and before the registry
				// install — every downstream surface (registry key, seam-host
				// identity, interaction/ambient records, worker names, health
				// correlation) sees the slug, never the declared name. Rejections
				// ride the LOAD (Review Focus 2): an empty slug or a collision
				// quarantines HERE naming the declared name(s), never the first
				// store use mid-run.
				const declared =
					resolved.extension !== undefined
						? resolved.extension.name
						: resolved.name;
				if (declared === undefined) {
					// Unreachable by construction (provider-only results validate
					// `name`; every other form carries an `extension`) — but the
					// identity rule fails loud rather than slugifying `undefined`.
					throw new Error(
						"factory result carried neither an extension nor a contributor name",
					);
				}
				const slug = slugifyName(declared);
				if (slug === "") {
					throw new Error(
						`extension name "${declared}" sanitizes to an empty slug ` +
							"(nothing survives [a-z0-9_-] folding); refusing to load",
					);
				}
				const collides = slugs.get(slug);
				if (collides !== undefined) {
					throw new Error(
						`slug collision: extension "${declared}" sanitizes to ` +
						`"${slug}", already claimed by "${collides}" — extension ` +
						"identities must be unique after sanitization",
					);
				}
				// Rename at the ONE point: a shallow copy with the slug as `name`
				// (the Extension contract is readonly; the declared object is
				// never mutated). Every binding below pairs with THIS object so
				// boot's identity correlation (health/submit/memory-owner
				// matching) stays exact.
				const extension: Extension | undefined =
					resolved.extension === undefined
						? undefined
						: { ...resolved.extension, name: slug };
				// The post-resolution call re-keys the captured host instance in
				// place with the slug + declared kinds (boot's
				// hostContextFactory; see src/harness/boot.ts). No second host is
				// ever created — a rebuilt instance would orphan every inbound
				// handler the factory registered on the host it captured.
				if (options.hostContextFactory !== undefined) {
					const kinds: DeclaredKinds = {
						...(resolved.interactionKinds === undefined
						? {}
						: { interaction: resolved.interactionKinds }),
						...(resolved.ambientKinds === undefined
						? {}
						: { ambient: resolved.ambientKinds }),
					};
					options.hostContextFactory(slug, kinds);
				}
				if (extension !== undefined) {
					registry.install(extension);
				}
				// Only a LOADED extension or contributor claims its slug — a
				// later stage's quarantine (never loaded) leaves the slug free
				// for the next boot's specifier list.
				slugs.set(slug, declared);
				outcomes.push({ name: slug, status: "ok" });
				if (extension !== undefined && resolved.health !== undefined) {
					healthProducers.push({
						extension,
						health: resolved.health,
					});
				}
				if (extension !== undefined && resolved.submit !== undefined) {
					submitBindings.push({
						extension,
					submit: resolved.submit,
					});
				}
				if (extension !== undefined && resolved.runSettled !== undefined) {
					runSettledBindings.push({
						extension,
					runSettled: resolved.runSettled,
					});
				}
				if (extension !== undefined && resolved.lifecycle !== undefined) {
					lifecycleBindings.push({
						extension,
					handlers: resolved.lifecycle,
					});
				}
				if (extension !== undefined && resolved.workers !== undefined) {
					workerBindings.push({
						extension,
					workers: resolved.workers,
					});
				}
				if (resolved.providers !== undefined) {
					providerContributors.push({
						name: slug,
						providers: resolved.providers,
						...(resolved.health === undefined
							? {}
							: { health: resolved.health }),
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
	// After all installs: surface tool-name collisions across extensions
	// (last-wins is pi-durable's resolution — unchanged, only warned).
	warnToolNameCollisions(registry);
	return {
		outcomes,
		providerContributors,
		healthProducers,
		submitBindings,
		runSettledBindings,
		lifecycleBindings,
		workerBindings,
	};
}
