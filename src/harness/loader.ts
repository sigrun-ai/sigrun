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
 * 9e retains it for the §5 meta `health.memory` aggregation). A factory
 * result may also carry a `providers` array (`ProviderContribution[]`,
 * provider plugins Task 1): boot feeds every loaded contributor into
 * `collectProviders` after the `options.extensions` seam — and a result
 * carrying `providers` with NO `extension` is a valid PROVIDER-ONLY
 * contributor (the model-plugin shape: no pi-durable surface, identified
 * by its `name` field). A result may likewise carry a `webuiBundles`
 * array (`{name, dir}[]`, build-and-webui Task 6): the loader validates it
 * fail-loud, anchors each `dir` at the extension module's URL, and
 * collects the entries attributed to the slug for boot's
 * contributed-bundle registry — the same contributor-only form applies (a
 * `webuiBundles` result with no `extension` needs a `name`). Factories may
 * return a Promise (the plugins read their scoped settings store inside the
 * factory); the loader awaits the result. Packages that predate the settled
 * contract export a named `extension` directly, so the loader resolves,
 * in order:
 *
 * 1. the default export, if it is a factory returning `{ extension,
 *    health? }` or is itself an `Extension` (named `name`) — the supported
 *    form,
 * 2. a named `extension` export (DEPRECATED bridge — one warning per
 *    load). The pre-contract `createMemory` named-factory bridge was
 *    deleted in release-0.1 (its last consumer, the memory package, now
 *    exports the factory as default).
 *
 * A factory result still carrying a `submit` pass-through (the retired
 * pre-seam memory wiring) is IGNORED with one warning — never
 * quarantined, so pre-seam packages keep loading.
 *
 * A factory MAY declare an arity-1 signature: the loader then passes the
 * host context (src/harness/seam-host.ts — the interaction/ambient seam
 * handles plus the scoped extension-stores handle `stores` (spec §5:
 * get/set on the extension's OWN secrets section and settings file, and
 * its own raw data/cache/state paths; src/harness/stores.ts). The host
 * is passed only to factories with `factory.length > 0` — a length-0
 * factory may carry a defaulted first parameter that would consume the
 * host as a real dependency — and the factory-result
 * `interactionKinds`/`ambientKinds` string arrays declare which seam
 * kinds/keys the extension writes — validated fail-loud here and
 * consumed by the seam host's write gate and the /v1/meta inventory.
 * Only factory results can carry a health producer or kind declarations
 * (the direct-`Extension` forms have no factory result to read one from).
 * A `health` field that is present but not the expected shape, or kinds
 * that are not string arrays, is a contract violation — quarantined,
 * never silently ignored.
 * A `providers` entry whose `provider` has no string `id` is the same class
 * of violation (a plugin that THINKS it contributed a provider must not
 * silently lose it).
 *
 * The contract is DOCUMENTED as one types-only type surface (W5 Task 1,
 * spec §9.1): `src/extension.ts`, shipped as the `@sigrun/sigrun/extension`
 * subpath (types-only — a runtime import of it fails loud by design).
 * This loader's validated candidate shape is DERIVED from that contract
 * (`CandidateFactoryResult` — reading a key the contract does not declare
 * is a compile error here), and `LoaderReadKeys` compiles only while every
 * factory-result key the loader reads is a key of `SigrunExtensionResult`.
 * The implementation and the contract cannot drift silently.
 */

import type { Extension, Registry } from "@earendil-works/pi-durable";
import type {
	ChannelContribution,
	ExtensionCommandContribution,
	ExtensionRouteContribution,
	ExtensionRunSettledHandler,
	ExtensionWorker,
	GatewayEngine,
	LoginProviderContribution,
	NotifierContribution,
	ProviderContribution,
	SettingsSectionDef,
	SigrunExtensionResult,
	SigrunLifecycleHandlers,
	SurfaceDef,
	SurfacesContribution,
	WebuiBundleContribution,
} from "../extension.js";
import { ICON_NAMES } from "@sigrun/shared/blocks";
import type { JobSpec } from "@sigrun/shared/jobs";
import { validateJobSpec } from "../jobs/spec.js";
import { validateTree } from "../blocks/validate.js";
import type { HealthStatus } from "./health.js";
import type { ProviderContributor } from "./providers/index.js";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeclaredKinds } from "./seam-host.js";
import {
	HOST_RUNTIME_MODULES,
	hostModuleVersion,
	readPackageAssetsDir,
	readPackageName,
	readPackageVersion,
	resolveExtensionEntry,
} from "./packages.js";
import {
	RESERVED_CORE_SECTION_KEYS,
	RESERVED_EXTENSION_SLUGS,
} from "./reserved-sections.js";
import { slugifyName } from "./stores.js";
import type { ContributedWebuiBundle } from "../server/static.js";

/** One loaded extension's boot outcome, for `GET /v1/meta` `extensions[]`. */
export interface ExtensionOutcome {
	/** The extension's slug identity on success; the specifier on quarantine. */
	readonly name: string;
	readonly status: "ok" | "quarantined";
	/** The failure message; present only when `status === "quarantined"`. */
	readonly error?: string;
	/**
	 * The loaded package's manifest version (spec §7.7), read from the
	 * entry's `package.json` via `readPackageVersion`; absent when the
	 * entry carries no readable manifest (a bare fixture entry) or the
	 * load quarantined before a module resolved.
	 */
	readonly version?: string;
	/**
	 * The channel ids this extension contributes (gateway C1, spec §7):
	 * present only on `ok` outcomes of extensions whose factory result
	 * carried `channels`; `/v1/extensions` renders it verbatim.
	 */
	readonly channels?: readonly string[];
	/**
	 * Built-in extensions (Task 2): `true` marks a core-shipped built-in
	 * (the boot prepends its resolved entries with this flag); ABSENT on
	 * configured extensions. `/v1/extensions` renders it verbatim.
	 */
	readonly builtin?: boolean;
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

/**
 * A factory-result `runSettled` handler retained from an extension factory
 * result (memory-seam Task 3) — paired with the resolved `Extension` like
 * the health binding, so boot registers it on the event bus under the
 * extension's final name.
 */
export interface ExtensionRunSettledBinding {
	/** The extension the factory result carried the handler for. */
	readonly extension: Extension;
	readonly runSettled: ExtensionRunSettledHandler;
}

/**
 * A factory-result `onSettingsChanged` handler (UI-blocks U4, spec
 * §13.2) — paired with the resolved `Extension` like the runSettled
 * binding, so boot fans the handler out under the extension's final
 * name after every committed settings write.
 */
export interface ExtensionSettingsChangedBinding {
	/** The extension the factory result carried the handler for. */
	readonly extension: Extension;
	readonly onSettingsChanged: ExtensionSettingsChangedHandler;
}

/** The public contract's settings-change hook (src/extension.ts owns the doc). */
export type ExtensionSettingsChangedHandler = NonNullable<
	SigrunExtensionResult["onSettingsChanged"]
>;

/**
 * The lifecycle handler fields a factory result may carry (memory-seam
 * Task 4; `userDeleted` — W1 Task 4). The PUBLIC contract's group type
 * (`SigrunLifecycleHandlers`, src/extension.ts) — one declaration, no
 * drift; boot's merge into the event bus's registration shape is the
 * checked bridge.
 */
export type ExtensionLifecycleHandlers = SigrunLifecycleHandlers;

/**
 * Routes retained from one extension factory result (core hardening W5
 * Task 2, spec §9.2), attributed to the extension slug — boot threads
 * the list to `OpenedHarness.extensionRoutes` for the server's
 * `/v1/ext/<slug>/<path>` mount and the `/v1/extensions` inventory.
 */
export interface ExtensionRouteBinding {
	/** The slug identity (the mount prefix and the inventory key). */
	readonly extension: string;
	readonly routes: readonly ExtensionRouteContribution[];
}

/**
 * Slash commands retained from one extension factory result (core
 * hardening W5 Task 3, spec §9.3), attributed to the extension slug —
 * boot threads the list to `OpenedHarness.extensionCommands` for the
 * server's catalog merge (`buildCommandCatalog`) and the write-gated
 * invoke route.
 */
export interface ExtensionCommandBinding {
	/** The slug identity (the merged catalog entry's `extension` field). */
	readonly extension: string;
	readonly commands: readonly ExtensionCommandContribution[];
}

/**
 * Notifier transports retained from one extension factory result (core
 * hardening W5 Task 6, spec §9.6), attributed to the extension slug —
 * boot threads the list to `OpenedHarness.notifierBindings` for the
 * server's notifications surface (src/server/notifications.ts), which
 * delivers one `NotificationEvent` per recipient to every collected
 * notifier.
 */
export interface ExtensionNotifierBinding {
	/** The slug identity (the delivery label's attribution). */
	readonly extension: string;
	readonly notifiers: readonly NotifierContribution[];
}

/**
 * Channel adapters retained from one extension factory result (gateway
 * C1, spec §7), attributed to the extension slug — boot threads the
 * list to `OpenedHarness.channelBindings` for the gateway engine's
 * `start` context and the `/v1/extensions` inventory. A channel-id
 * collision across extensions quarantines the later loader BEFORE this
 * binding is collected (chat bindings are keyed by channel id — never
 * last-wins); quarantined extensions contribute none.
 */
export interface ExtensionChannelBinding {
	/** The slug identity (the engine's `channels[].extension` attribution). */
	readonly extension: string;
	readonly channels: readonly ChannelContribution[];
}

/**
 * The gateway engine retained from one extension factory result (gateway
 * C2, spec §8.0), paired with the extension slug — boot threads it to
 * `OpenedHarness.gatewayEngine` for `startGateway` and the meta route's
 * `health.gateway` presence. ONE per boot (the one-engine rule in the
 * load loop); quarantined extensions contribute none.
 */
export interface ExtensionGatewayBinding {
	/** The slug identity (which extension owns the engine). */
	readonly extension: string;
	readonly engine: GatewayEngine;
}

/**
 * Surfaces retained from one extension factory result (UI-blocks U3
 * Task 1, spec §7.1), attributed to the extension slug — views and
 * panels FLATTENED in declaration order (views first). Boot threads
 * the list to `OpenedHarness.extensionSurfaces` for the service (Task
 * 2) and the `/v1/extensions` inventory rows.
 */
export interface ExtensionSurfaceBinding {
	/** The slug identity (`/v1/ext/<slug>/surfaces/…`). */
	readonly extension: string;
	/** The validated view + panel defs, in declaration order. */
	readonly defs: readonly SurfaceDef<"view" | "panel">[];
	/**
	 * The package's declared `sigrun.assets` directory (spec §11.1),
	 * resolved absolute against the package root at load; `undefined`
	 * when the manifest declares none (every asset request 404s).
	 */
	readonly assetsDir?: string;
}

/**
 * Settings sections retained from one extension factory result
 * (UI-blocks U4 Task 3, spec §13.3), slug-attributed like the surface
 * binding. `createServer` adapts each to a settings-placement surface
 * (`src/server/surfaces/settings-surfaces.ts`) and appends it to the
 * surface service's binding list, so core and extension sections serve
 * from ONE route family (`/v1/ext/<slug>/surfaces/<id>`).
 */
export interface ExtensionSettingsSectionBinding {
	/** The slug identity. */
	readonly extension: string;
	readonly defs: readonly SettingsSectionDef[];
}

/** Every lifecycle field name, in validation order (mirrors the contract doc). */
const LIFECYCLE_FIELDS = [
	"conversationCreated",
	"conversationForked",
	"conversationArchived",
	"conversationIdle",
	"interactionSettled",
	"harnessShutdown",
	"userDeleted",
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

/** One validated login provider, attributed with its core-qualified id. */
export interface LoginProviderBinding {
	readonly provider: string;
	readonly contribution: LoginProviderContribution;
}

/** What `loadExtensions` yields: the wire-report outcomes + retained producers. */
export interface LoadedExtensions {
	/** Slugs whose loaded factory result declared `perUserTools: true`. */
	readonly perUserSlugs: readonly string[];
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
	/** Login providers, in load order. Quarantined extensions contribute none. */
	readonly loginProviders: readonly LoginProviderBinding[];
	/**
	 * §3 producers from factory results, one per loaded extension that
	 * carried one; quarantined extensions and the no-op memory default
	 * contribute none (degenerate ok by absence).
	 */
	readonly healthProducers: readonly ExtensionHealthProducer[];
	/**
	 * `runSettled` handlers from factory results (memory-seam Task 3), one
	 * per loaded extension that carried one; quarantined extensions
	 * contribute none. Boot registers each on the event bus under the
	 * extension's final name.
	 */
	readonly runSettledBindings: readonly ExtensionRunSettledBinding[];
	/**
	 * `onSettingsChanged` handlers from factory results (UI-blocks U4,
	 * §13.2), one per loaded extension that carried one; quarantined
	 * extensions contribute none. Boot fans them out after every
	 * committed settings write.
	 */
	readonly settingsChangedBindings: readonly ExtensionSettingsChangedBinding[];
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
	/**
	 * Declared jobs from factory results (jobs §8.3 — the `extension`
	 * source), one entry per loaded extension whose result carried `jobs`;
	 * quarantined extensions contribute none. Boot reconciliation folds
	 * these into job records under `ext:<slug>:<name>` ids.
	 */
	readonly jobBindings: readonly { extension: string; jobs: readonly JobSpec[] }[];
	/**
	 * HTTP routes from factory results (core hardening W5 Task 2), one
	 * entry per loaded extension whose result carried `routes`; the
	 * server mounts each at `/v1/ext/<slug>/<path>`. Quarantined
	 * extensions contribute none.
	 */
	readonly routeBindings: readonly ExtensionRouteBinding[];
	/**
	 * Slash commands from factory results (core hardening W5 Task 3), one
	 * entry per loaded extension whose result carried `commands`; the
	 * server's `buildCommandCatalog` merges them with the core table
	 * (core names reserved, ext-vs-ext last-registered-wins). Quarantined
	 * extensions contribute none.
	 */
	readonly commandBindings: readonly ExtensionCommandBinding[];
	/**
	 * Notifier transports from factory results (core hardening W5 Task 6,
	 * spec §9.6), one entry per loaded extension whose result carried
	 * `notifiers`; the server's notifications surface delivers one
	 * `NotificationEvent` per recipient to every collected notifier
	 * (best-effort, deadline-bounded). Quarantined extensions contribute
	 * none.
	 */
	readonly notifierBindings: readonly ExtensionNotifierBinding[];
	/**
	 * Channel adapters from factory results (gateway C1, spec §7): one
	 * `{extension, channels}` entry per loaded extension whose result
	 * carried `channels`, slug-attributed — the gateway engine's start
	 * context reads the flat channel set from these and `/v1/extensions`
	 * inventories the ids. Channel ids are unique across every loaded
	 * extension (the loader quarantines the later colliding loader);
	 * quarantined extensions contribute none.
	 */
	readonly channelBindings: readonly ExtensionChannelBinding[];
	/**
	 * The gateway engine from a factory result (gateway C2, spec §8.0):
	 * the FIRST loaded declarer's binding — `{extension, engine}` — or
	 * `undefined` when no engine loaded. A later declarer quarantines
	 * (the one-engine rule: an engine supervises the whole channel set,
	 * never last-wins). `startGateway` consumes it; the meta route's
	 * `health.gateway` presence keys on it.
	 */
	readonly gatewayEngine: ExtensionGatewayBinding | undefined;
	/**
	 * Declared surfaces from factory results (UI-blocks U3 Task 1,
	 * spec §7.1), one entry per loaded extension whose result carried
	 * `surfaces` — the FLATTENED validated defs attributed to the slug
	 * (the service in Task 2 renders them; `/v1/extensions` inventories
	 * them). Quarantined extensions contribute none.
	 */
	readonly surfaces: readonly ExtensionSurfaceBinding[];
	/**
	 * Settings sections from factory results (UI-blocks U4 Task 3,
	 * spec §13.3), slug-attributed — the server adapts them to
	 * settings-placement surfaces (`settings-surfaces.ts`) and appends
	 * them to the surface service's bindings. Quarantined extensions
	 * contribute none.
	 */
	readonly settingsSections: readonly ExtensionSettingsSectionBinding[];
	/**
	 * Webui-bundle contributions from factory results (build-and-webui
	 * Task 6), one entry per contributed bundle across every loaded
	 * extension — each `{name, dir, extension}` with `dir` resolved against
	 * the contributing module's URL (the loader's attribution; the factory
	 * contributes `{name, dir}` only). Boot folds this flat list into the
	 * name-keyed registry (last-registered-wins + the collision sink) that
 `createServer`'s NAME-selector resolution reads. Quarantined
	 * extensions contribute none.
	 */
	readonly webuiBundles: readonly ContributedWebuiBundle[];
	/**
	 * Skill directories from loaded packages (core hardening W5 Task 4,
	 * spec §9.4), in load order — skills-only resolutions, entry-bearing
	 * packages' manifest skills, and factory-result `skills` fields — each
	 * `{extension, dir}` attributed to the extension slug. Boot threads
	 * this into the skills section's package-roots option; quarantined
	 * packages contribute none.
	 */
	readonly skillRoots: readonly { extension: string; dir: string }[];
}

/** Minimal module shape the contract resolution reads. */
interface ExtensionModule {
	readonly default?: unknown;
	readonly extension?: unknown;
}

/**
 * What `resolveExtension` yields: the `Extension` plus the optional §3
 * health producer a factory result carried alongside it. Only factory
 * results can carry one; the direct-`Extension` forms resolve without.
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
	/** The factory declared `host.tools.setUserTools` (multi-user M2). */
	readonly perUserTools?: boolean;
	/**
	 * Set when the factory result carried a `submit` pass-through — the
	 * RETIRED pre-seam memory wiring (§6.7). The submit itself is ignored;
	 * the flag drives the loader's one-time retirement warning. Never
	 * quarantines: old packages keep loading.
	 */
	readonly retiredSubmit?: true;
	/**
	 * Which NAMED-EXPORT bridge resolved this module (§6.7 deprecation):
	 * `"extension"` (the named `extension` export; the pre-contract
	 * `createMemory` bridge was deleted in release-0.1 — packages must
	 * export the factory as default). Absent for the supported
	 * default-export forms. Drives the deprecation warning; behavior is
	 * otherwise unchanged.
	 */
	readonly resolvedVia?: "extension";
	/** Present only when the factory result carried one (memory-seam Task 3). */
	readonly runSettled?: ExtensionRunSettledHandler;
	/** Present only when the factory result carried one (UI-blocks U4 §13.2). */
	readonly onSettingsChanged?: ExtensionSettingsChangedHandler;
	/** Present only when the factory result carried any of them (memory-seam Task 4). */
	readonly lifecycle?: ExtensionLifecycleHandlers;
	/** Present only when the factory result carried one (memory-seam Task 5). */
	readonly workers?: readonly ExtensionWorker[];
	/** Provider contributions (provider plugins Task 1), validated fail-loud. */
	readonly providers?: readonly ProviderContribution[];
	/** Login providers (multi-user M3b), validated fail-loud. */
	readonly loginProviders?: readonly LoginProviderContribution[];
	/**
	 * Webui-bundle contributions (build-and-webui Task 6), validated
	 * fail-loud — the public `WebuiBundleContribution` shape
	 * (`{name, dir}`); the loader resolves each `dir` against the extension
	 * module's URL when collecting.
	 */
	readonly webuiBundles?: readonly WebuiBundleContribution[];
	/**
	 * Declared jobs (jobs §8.3 — the `extension` source), validated
	 * fail-loud with `validateJobSpec` (a malformed entry quarantines).
	 */
	readonly jobs?: readonly JobSpec[];
	/**
	 * HTTP routes (core hardening W5 Task 2, spec §9.2), validated
	 * fail-loud — a malformed entry quarantines the extension before any
	 * route mounts.
	 */
	routes?: readonly ExtensionRouteContribution[];
	/**
	 * Slash commands (core hardening W5 Task 3, spec §9.3), validated
	 * fail-loud — a malformed entry quarantines the extension before any
	 * command reaches the merged catalog.
	 */
	commands?: readonly ExtensionCommandContribution[];
	/**
	 * Skill directories (core hardening W5 Task 4, spec §9.4), validated
	 * fail-loud — absolute EXISTING directories; a malformed or nonexistent
	 * entry quarantines (a package that THINKS it contributed skills must
	 * not silently lose them).
	 */
	skills?: readonly string[];
	/**
	 * Notifier transports (core hardening W5 Task 6, spec §9.6), validated
	 * fail-loud — a malformed entry quarantines the extension before any
	 * event reaches a transport.
	 */
	notifiers?: readonly NotifierContribution[];
	/**
	 * Channel adapters (gateway C1, spec §7), validated fail-loud —
	 * including the cross-extension channel-id uniqueness the load loop
	 * enforces before any binding is collected.
	 */
	channels?: readonly ChannelContribution[];
	/**
	 * The gateway engine (gateway C2, spec §8.0), validated fail-loud.
	 * Absent when the result carried no engine.
	 */
	gateway?: GatewayEngine;
	/**
	 * Declared surfaces (UI-blocks U3 Task 1, spec §7.1) — the
	 * FLATTENED validated view + panel defs (views then panels,
	 * declaration order); a malformed declaration quarantines the
	 * extension before any surface mounts.
	 */
	surfaces?: readonly SurfaceDef<"view" | "panel">[];
	/**
	 * Settings sections (UI-blocks U4 Task 3, spec §13.3) — the validated
	 * `surfaces.settings` list; a malformed declaration quarantines the
	 * extension before any section mounts.
	 */
	settingsSections?: readonly SettingsSectionDef[];
	/** Declared interaction kinds / ambient surface keys (both optional). */
	readonly interactionKinds?: readonly string[];
	readonly ambientKinds?: readonly string[];
}

/**
 * Every factory-result key the loader reads (the full list, one place).
 * Every key is a declared field of the public contract
 * (`SigrunExtensionResult`, src/extension.ts) — the assertion below
 * fails the compile the moment one drifts.
 */
type LoaderReadKeys =
	| "extension"
	| "name"
	| "providers"
	| "loginProviders"
	| "webuiBundles"
	| "health"
	| "runSettled"
	| "conversationCreated"
	| "conversationForked"
	| "conversationArchived"
	| "conversationIdle"
	| "interactionSettled"
	| "harnessShutdown"
	| "userDeleted"
	| "onSettingsChanged"
	| "interactionKinds"
	| "ambientKinds"
	| "workers"
	| "jobs"
	| "routes"
	| "commands"
	| "skills"
	| "notifiers"
	| "channels"
	| "gateway"
	| "surfaces"
	| "perUserTools";

/**
 * The drift assertion (W5 Task 1): compiles only while EVERY key the
 * loader reads is a DECLARED key of the public contract. The check is
 * `K extends keyof T` — `keyof` includes optional properties, so a
 * field MISSING from `SigrunExtensionResult` fails here (a weaker
 * `{ [K]?: unknown }` constraint would let an absent optional key
 * through). On drift this resolves to a type whose only key names the
 * problem; `CandidateFactoryResult` (keyed by the result) then loses
 * every loader read and the compile fails loudly.
 */
type AssertContractKeys<T, K extends string> = K extends keyof T
	? T
	: {
			readonly "CONTRACT DRIFT — declare the missing factory-result field on SigrunExtensionResult (src/extension.ts)": never;
		};

/**
 * The unvalidated factory result as `resolvedFromFactory` reads it:
 * every public-contract field as `unknown` (validated below), plus the
 * RETIRED `submit` pass-through (§6.7 — read for the one-time warning,
 * never part of the documented contract). Keyed by the asserted
 * contract shape: a read of a key the contract does not declare is a
 * compile error at the read site.
 */
type CandidateFactoryResult = Partial<
	Record<keyof AssertContractKeys<SigrunExtensionResult, LoaderReadKeys>, unknown>
> & {
	readonly submit?: unknown;
};

/**
 * The reserved-key membership probe (spec §6.5 R11): a `Set` because the
 * `as const` tuple's `includes` narrows its parameter to the literal
 * union, which a section's `string` key can never satisfy.
 */
const RESERVED_SECTION_KEY_SET: ReadonlySet<string> = new Set(
	RESERVED_CORE_SECTION_KEYS,
);

/** Reserved store-root directory names may not become extension identities. */
const RESERVED_EXTENSION_SLUG_SET: ReadonlySet<string> = new Set(
	RESERVED_EXTENSION_SLUGS,
);

/** A structural check for "looks like a pi-durable Extension". */
function isExtension(value: unknown): value is Extension {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Extension).name === "string"
	);
}

/** Whether `dir` is an EXISTING directory (never throws). */
function existingDirectory(dir: string): boolean {
	try {
		return statSync(dir).isDirectory();
	} catch {
		return false;
	}
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
	"interactionSettled",
]);

/**
 * The `every` retirement message (ruling 12, jobs Task 3): jobs are the
 * only time-based scheduler — an extension that needs a timer declares a
 * job with a `task` action (spec §8.1a).
 */
const EVERY_RETIRED = "workers.every was retired — declare a job with a task action";

/**
 * Validate a factory result's `workers` declaration (memory-seam Task 5,
 * the curator contract, post-`every`-retirement). Absent → undefined (no
 * workers). Present but malformed → throw; the loader quarantines the
 * extension with the thrown message (fail-loud: an extension that THINKS
 * it declared a curator must not silently lose it). Validation order per
 * worker: name, duplicate, run, every-retired, wakeOn,
 * wakeOn-required-non-empty.
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
		// Ruling 12: `every` is RETIRED — a worker carrying it quarantines
		// with the retirement message (jobs are the only timer).
		if (worker?.every !== undefined) {
			throw new Error(EVERY_RETIRED);
		}
		if (
			worker?.wakeOn === undefined ||
			!Array.isArray(worker.wakeOn) ||
			worker.wakeOn.length === 0 ||
			worker.wakeOn.some(
				(event) => typeof event !== "string" || !WAKE_EVENTS.has(event),
			)
		) {
			if (worker?.wakeOn !== undefined && Array.isArray(worker.wakeOn) && worker.wakeOn.length === 0) {
				throw new Error(
					`extension factory returned a worker whose worker "${name}" has an empty wakeOn (declare at least one wake event)`,
				);
			}
			if (worker?.wakeOn === undefined) {
				throw new Error(
					"extension factory returned a worker that declares a worker with neither every nor wakeOn",
				);
			}
			throw new Error(
				`extension factory returned a worker whose worker "${name}" has an invalid wakeOn entry`,
			);
		}
	}
	return value as readonly ExtensionWorker[];
}

/**
 * Validate a factory result's `jobs` declaration (jobs §8.3 — the
 * `extension` source). Absent → undefined (no jobs). Present but
 * malformed → throw; the loader quarantines the extension with the
 * thrown message (fail-loud: an extension that THINKS it declared a job
 * must not silently lose it). Each entry is a full `validateJobSpec` run
 * (the §8.2 grammar), and duplicate names within one extension are
 * rejected (they would collide on the `ext:<slug>:<name>` id).
 */
function validateJobs(value: unknown): readonly JobSpec[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(
			"extension factory returned a jobs field that is not an array",
		);
	}
	const seen = new Set<string>();
	const specs: JobSpec[] = [];
	for (const entry of value) {
		const result = validateJobSpec(entry);
		if (!result.ok) {
			throw new Error(
				`extension factory returned a job whose ${result.field} ${result.message}`,
			);
		}
		if (seen.has(result.spec.name)) {
			throw new Error(
				`extension factory returned a duplicate job name "${result.spec.name}"`,
			);
		}
		seen.add(result.spec.name);
		specs.push(result.spec);
	}
	return specs;
}

/**
 * The icon-name membership probe (spec §10.2): the closed set from
 * `@sigrun/shared/blocks` — a `Set` so `unknown`-typed field values can
 * be tested without a cast.
 */
const ICON_NAME_SET: ReadonlySet<string> = new Set(ICON_NAMES);

/** The refreshMs floor (spec §7.1): channels refetch no faster than 5 s. */
const MIN_REFRESH_MS = 5000;

/**
 * The `settings` placement's field-name walk (UI-blocks U4 Task 3):
 * every field of a settings form must be a TOP-LEVEL key of the
 * extension's settings object (spec §13.3 — the form binds to
 * `settings/<slug>.json`; a dotted or nested name would write a shape
 * the verbatim settings routes cannot show).
 */
function* walkFormFields(root: unknown): Generator<{ name?: unknown; item?: unknown }> {
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (Array.isArray(node)) {
			stack.push(...node);
			continue;
		}
		if (typeof node !== "object" || node === null) continue;
		const record = node as Record<string, unknown>;
		for (const key of ["children", "fields", "root", "main", "sidebar", "detail"]) {
			if (record[key] !== undefined) stack.push(record[key]);
		}
		if (record.block !== undefined) stack.push(record.block);
		if (record.item !== undefined) stack.push(record.item);
		if (typeof record.name === "string" && typeof record.type === "string") {
			yield record as { name?: unknown; item?: unknown };
		}
	}
}

/**
 * Validate a factory result's `surfaces.settings` list (UI-blocks U4
 * Task 3, spec §13.3). Each entry: non-empty string `id`, `title`,
 * `icon` (optional, in the closed set), `form` a Tree validating
 * against the `settings` placement with a root `form` block, every
 * field name a TOP-LEVEL key (no dots), optional `secrets` entries
 * `{key, label, help?}`, and `admin` a boolean when present. The
 * `save` handler name is core-owned (the adapter's), so `onSubmit`
 * names outside `{save, submit}` are rejected (an extension thinking
 * it owns its save handler would silently never fire).
 */
function validateSettingsSections(
	value: unknown,
): readonly SettingsSectionDef[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(
			"extension factory returned a surfaces.settings field that is not an array",
		);
	}
	const defs: SettingsSectionDef[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		const def = entry as
			| {
					id?: unknown;
					title?: unknown;
					icon?: unknown;
					form?: unknown;
					secrets?: unknown;
					admin?: unknown;
				  }
			| null;
		if (typeof def?.id !== "string" || def.id.length === 0) {
			throw new Error(
				"extension factory returned a settings section whose id is missing or not a non-empty string",
			);
		}
		if (seen.has(def.id)) {
			throw new Error(
				`extension factory returned a duplicate settings section id "${def.id}"`,
			);
		}
		seen.add(def.id);
		if (typeof def?.title !== "string" || def.title.length === 0) {
			throw new Error(
				`extension factory returned a settings section "${def.id}" whose title is missing or not a non-empty string`,
			);
		}
		if (
			def?.icon !== undefined &&
			(typeof def.icon !== "string" || !ICON_NAME_SET.has(def.icon))
		) {
			throw new Error(
				`extension factory returned a settings section "${def.id}" with unknown icon "${String(def?.icon)}"`,
			);
		}
		if (def?.admin !== undefined && typeof def.admin !== "boolean") {
			throw new Error(
				`extension factory returned a settings section "${def.id}" whose admin is not a boolean`,
			);
		}
		if (def?.secrets !== undefined) {
			if (!Array.isArray(def.secrets)) {
				throw new Error(
					`extension factory returned a settings section "${def.id}" whose secrets is not an array`,
				);
			}
			for (const secret of def.secrets) {
				const entry2 = secret as { key?: unknown; label?: unknown; help?: unknown } | null;
				if (typeof entry2?.key !== "string" || entry2.key.length === 0) {
					throw new Error(
						`extension factory returned a settings section "${def.id}" whose secrets entry is missing a key`,
					);
				}
				if (typeof entry2?.label !== "string" || entry2.label.length === 0) {
					throw new Error(
						`extension factory returned a settings section "${def.id}" whose secrets entry "${String(entry2?.key)}" is missing a label`,
					);
				}
				if (entry2?.help !== undefined && typeof entry2.help !== "string") {
					throw new Error(
						`extension factory returned a settings section "${def.id}" whose secrets entry "${entry2.key}" carries a non-string help`,
					);
				}
			}
		}
		if (typeof def?.form !== "object" || def.form === null) {
			throw new Error(
				`extension factory returned a settings section "${def.id}" whose form is missing or not a Tree`,
			);
		}
		const validation = validateTree(def.form, {
			placement: "settings",
			handlers: new Set(["save", "submit"]),
		});
		if (!validation.ok) {
			throw new Error(
				`extension factory returned a settings section "${def.id}" whose form is invalid: ` +
					validation.errors.map((err) => `${err.path}: ${err.message}`).join("; "),
			);
		}
		for (const field of walkFormFields(validation.tree.root)) {
			if (typeof field.name !== "string" || field.name.length === 0) continue;
			if (field.name.includes(".") || field.name.includes("/")) {
				throw new Error(
					`extension factory returned a settings section "${def.id}" whose field "${field.name}" is not a top-level settings key (no dots or slashes)`,
				);
			}
		}
		defs.push(entry as SettingsSectionDef);
	}
	return defs;
}

/**
 * Validate a factory result's `surfaces` declaration (UI-blocks U3
 * Task 1, spec §7.1/§15). Absent → undefined (no surfaces). Present
 * but malformed → throw with ONE message per problem; the loader
 * quarantines the extension with the thrown message (fail-loud: an
 * extension that THINKS it declared a surface must not silently lose
 * it — the providers/health class). Per def: non-empty string `id`
 * (unique across BOTH lists — one namespace), string `title`, `icon`
 * in the closed set, `placement` exactly `view` (in `views`) or
 * `panel` (in `panels`), `sharedData` a boolean, `actions` an object
 * whose every handler is a function (message names the action),
 * `refreshMs ≥ 5000` when present, `data()` a function when
 * `refreshMs` is set (a data refetch would otherwise re-run `render`,
 * §7.1), `render` a function — plus the `settings` list (§13.3, U4
 * Task 3), validated by `validateSettingsSections`. Returns the
 * FLATTENED defs (views then panels, declaration order) and the
 * settings sections, attributed to the slug at collection.
 */
function validateSurfaces(
	value: unknown,
):
	| {
			readonly defs: readonly SurfaceDef<"view" | "panel">[];
			readonly settings?: readonly SettingsSectionDef[];
		  }
	| undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error(
			"extension factory returned a surfaces field that is not an object",
		);
	}
	// §13.3 settings sections (UI-blocks U4 Task 3): validated with the
	// settings placement; a malformed list quarantines like every other
	// malformed surfaces member.
	const settings = validateSettingsSections(
		(value as Record<string, unknown>).settings,
	);
	const defs: SurfaceDef<"view" | "panel">[] = [];
	const seen = new Set<string>(settings?.map((def) => def.id) ?? []);
	for (const list of ["views", "panels"] as const) {
		const entries = (value as Record<string, unknown>)[list];
		if (entries === undefined) continue;
		if (!Array.isArray(entries)) {
			throw new Error(
				`extension factory returned a surfaces.${list} field that is not an array`,
			);
		}
		const expected = list === "views" ? "view" : "panel";
		for (const entry of entries) {
			const def = entry as
				| {
						id?: unknown;
						title?: unknown;
						icon?: unknown;
						placement?: unknown;
						sharedData?: unknown;
						refreshMs?: unknown;
						instanceKey?: unknown;
						render?: unknown;
						data?: unknown;
						actions?: unknown;
					  }
				| null;
			if (typeof def?.id !== "string" || def.id.length === 0) {
				throw new Error(
					"extension factory returned a surface whose id is missing or not a non-empty string",
				);
			}
			if (seen.has(def.id)) {
				throw new Error(
					`extension factory returned a duplicate surface id "${def.id}"`,
			);
			}
			seen.add(def.id);
			if (typeof def?.title !== "string" || def.title.length === 0) {
				throw new Error(
					`extension factory returned a surface "${def.id}" whose title is missing or not a non-empty string`,
			);
			}
			if (typeof def?.icon !== "string" || !ICON_NAME_SET.has(def.icon)) {
				throw new Error(
					`extension factory returned a surface "${def.id}" with unknown icon "${String(def?.icon)}"`,
			);
			}
			if (def?.placement !== expected) {
				throw new Error(
					`extension factory returned a surface "${def.id}" whose placement must be "${expected}" in surfaces.${list}`,
			);
			}
			if (def?.instanceKey !== undefined && typeof def.instanceKey !== "function") {
				throw new Error(
					`extension factory returned a surface "${def.id}" whose instanceKey is not a function`,
				);
			}
			if (
				def?.sharedData !== undefined &&
				typeof def.sharedData !== "boolean"
			) {
				throw new Error(
					`extension factory returned a surface "${def.id}" whose sharedData is not a boolean`,
				);
			}
			if (def?.actions !== undefined) {
				if (
					typeof def.actions !== "object" ||
					def.actions === null ||
					Array.isArray(def.actions)
				) {
					throw new Error(
						`extension factory returned a surface "${def.id}" whose actions is not an object`,
					);
				}
				for (const [action, handler] of Object.entries(def.actions)) {
					if (typeof handler !== "function") {
						throw new Error(
							`extension factory returned a surface "${def.id}" whose action "${action}" handler is not a function`,
						);
					}
				}
			}
			if (typeof def?.render !== "function") {
				throw new Error(
					`extension factory returned a surface "${def.id}" whose render is not a function`,
			);
			}
			if (def?.data !== undefined && typeof def.data !== "function") {
				throw new Error(
					`extension factory returned a surface "${def.id}" whose data is not a function`,
			);
			}
			if (def?.refreshMs !== undefined) {
			if (
					typeof def.refreshMs !== "number" ||
					!Number.isInteger(def.refreshMs) ||
					def.refreshMs < MIN_REFRESH_MS
			) {
					throw new Error(
						`extension factory returned a surface "${def.id}" declaring refreshMs ${String(def.refreshMs)} (minimum ${MIN_REFRESH_MS})`,
				);
			}
			if (def?.data === undefined) {
					throw new Error(
						`extension factory returned a surface "${def.id}" declaring refreshMs without data()`,
				);
			}
		}
			defs.push(entry as SurfaceDef<"view" | "panel">);
		}
	}
	return { defs, ...(settings === undefined ? {} : { settings }) };
}
const ROUTE_METHODS: ReadonlySet<string> = new Set([
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
]);
const ROUTE_AUTHS: ReadonlySet<string> = new Set(["user", "admin", "public"]);

/**
 * The route-path prefixes reserved for core under `/v1/ext/<slug>/`
 * (spec §7.2): `surfaces/` and `assets/` are the extension-surface
 * and asset mounts — an extension route there would shadow them, so
 * declaring one quarantines at load, naming the route.
 */
const RESERVED_ROUTE_PREFIXES = ["surfaces/", "assets/"] as const;

/**
 * Validate a factory result's `routes` declaration (core hardening W5
 * Task 2, spec §9.2). Absent → undefined (no routes). Present but
 * malformed → throw; the loader quarantines the extension with the
 * thrown message (fail-loud: an extension that THINKS it mounted a
 * webhook must not silently lose it). Per entry: `method` in the five
 * verbs, `path` a non-empty RELATIVE string (no leading `/`, no `..` —
 * nothing may escape the `/v1/ext/<slug>/` mount, and never under a
 * RESERVED core prefix — §7.2), `auth` one of the three values,
 * `bodyLimit` a positive integer when present, and `handler` a
 * function.
 */
function validateRoutes(
	value: unknown,
): readonly ExtensionRouteContribution[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(
			"extension factory returned a routes field that is not an array",
		);
	}
	for (const entry of value) {
		const route = entry as
			| {
						method?: unknown;
					path?: unknown;
					auth?: unknown;
					bodyLimit?: unknown;
					handler?: unknown;
			  }
			| null;
		const describe = () =>
			`route "${typeof route?.path === "string" ? route.path : String(route?.path)}"`;
		if (typeof route?.method !== "string" || !ROUTE_METHODS.has(route.method)) {
			throw new Error(
				`extension factory returned a ${describe()} whose method is not one of GET, POST, PUT, PATCH, DELETE`,
			);
		}
		if (
			typeof route?.path !== "string" ||
			route.path === "" ||
			route.path.startsWith("/") ||
			route.path.includes("..")
		) {
			throw new Error(
				`extension factory returned a route whose path must be a non-empty relative string (no leading "/", no "..")`,
			);
		}
		// Reserved core prefixes (spec §7.2): surfaces/ and assets/ belong
		// to core under this slug's mount — quarantine naming the route.
		const path: unknown = route?.path;
		if (
			typeof path === "string" &&
			RESERVED_ROUTE_PREFIXES.some((prefix) => path.startsWith(prefix))
		) {
			throw new Error(
				`extension factory returned a ${describe()} whose path starts with a reserved core prefix (surfaces/ and assets/ belong to core under /v1/ext/<slug>/)`,
			);
		}
		if (typeof route?.auth !== "string" || !ROUTE_AUTHS.has(route.auth)) {
			throw new Error(
				`extension factory returned a ${describe()} whose auth is not one of user, admin, public`,
			);
		}
		if (
			route?.bodyLimit !== undefined &&
			(typeof route.bodyLimit !== "number" ||
				!Number.isInteger(route.bodyLimit) ||
				route.bodyLimit <= 0)
		) {
			throw new Error(
				`extension factory returned a ${describe()} whose bodyLimit is not a positive integer`,
			);
		}
		if (typeof route?.handler !== "function") {
			throw new Error(
				`extension factory returned a ${describe()} whose handler is not a function`,
			);
		}
	}
	return value as readonly ExtensionRouteContribution[];
}

/**
 * The extension command NAME grammar (spec §9.3): `^[a-z][a-z0-9-]*$` —
 * the same shape as every other extension-declared name (workers,
 * bundles), so the composer's `/` menu renders one spelling of a name.
 */
const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Validate a factory result's `commands` declaration (core hardening W5
 * Task 3, spec §9.3). Absent → undefined (no commands). Present but
 * malformed → throw; the loader quarantines the extension with the
 * thrown message (fail-loud: an extension that THINKS it declared a
 * command must not silently lose it — the providers/health class). Per
 * entry: `name` matching the grammar, `description` a string, optional
 * `args` a string, and `run` a function. Core-name collisions are NOT a
 * validation failure — the catalog builder drops those with a warning
 * (they are a deployment choice, not a broken declaration).
 */
function validateCommands(
	value: unknown,
): readonly ExtensionCommandContribution[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(
			"extension factory returned a commands field that is not an array",
		);
	}
	for (const entry of value) {
		const command = entry as
			| {
						name?: unknown;
					description?: unknown;
					args?: unknown;
					run?: unknown;
				}
			| null;
		const describe = () =>
			`command "${typeof command?.name === "string" ? command.name : String(command?.name)}"`;
		if (typeof command?.name !== "string" || !COMMAND_NAME.test(command.name)) {
			throw new Error(
				`extension factory returned a ${describe()} whose name does not match ^[a-z][a-z0-9-]*$`,
			);
		}
		if (typeof command?.description !== "string") {
			throw new Error(
				`extension factory returned a ${describe()} whose description is missing or not a string`,
			);
		}
		if (command?.args !== undefined && typeof command.args !== "string") {
			throw new Error(
				`extension factory returned a ${describe()} whose args is not a string`,
			);
		}
		if (typeof command?.run !== "function") {
			throw new Error(
				`extension factory returned a ${describe()} whose run is not a function`,
			);
		}
	}
	return value as readonly ExtensionCommandContribution[];
}

/**
 * Validate a factory result's `notifiers` declaration (core hardening W5
 * Task 6, spec §9.6). Absent → undefined (no contributions). Present but
 * malformed → throw; the loader quarantines the extension with the thrown
 * message (fail-loud: an extension that THINKS it declared a transport
 * must not silently lose it — the providers/health class). Per entry: a
 * non-empty `name` and a `notify` function.
 */
function validateNotifiers(
	value: unknown,
): readonly NotifierContribution[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(
			"extension factory returned a notifiers field that is not an array",
		);
	}
	for (const entry of value) {
		const notifier = entry as { name?: unknown; notify?: unknown } | null;
		const describe = () =>
			`notifier "${typeof notifier?.name === "string" ? notifier.name : String(notifier?.name)}"`;
		if (typeof notifier?.name !== "string" || notifier.name.length === 0) {
			throw new Error(
				`extension factory returned a ${describe()} whose name is missing or empty`,
			);
		}
		if (typeof notifier?.notify !== "function") {
			throw new Error(
				`extension factory returned a ${describe()} whose notify is not a function`,
			);
		}
	}
	return value as readonly NotifierContribution[];
}

/**
 * The channel-id grammar (gateway C1, spec §7): `^[a-z][a-z0-9-]*$` —
 * the same shape as every other extension-declared name (commands,
 * workers, bundles), and the key the gateway engine's chat bindings are
 * addressed by (why a collision quarantines instead of last-wins).
 */
const CHANNEL_ID = /^[a-z][a-z0-9-]*$/;

/** The `chatTypes` vocabulary of a `capabilities` declaration (spec §7). */
const CHANNEL_CHAT_TYPES: ReadonlySet<string> = new Set([
	"dm",
	"group",
	"thread",
]);

/** The `capabilities.format` vocabulary (spec §7). */
const CHANNEL_FORMATS: ReadonlySet<string> = new Set([
	"plain",
	"markdown",
	"native",
]);

/**
 * Validate a factory result's `channels` declaration (gateway C1, spec
 * §7). Absent → undefined (no contributions). Present but malformed →
 * throw; the loader quarantines the extension with the thrown message
 * (fail-loud: an adapter that THINKS it declared a channel must not
 * silently lose it — the providers/health class). Per entry: `id` matching
 * the grammar, `label` a non-empty string, `capabilities` an object with
 * `chatTypes` a non-empty array over the vocabulary, `maxMessageLength` a
 * positive integer, `format` one of the three values, the optional
 * `edit.minIntervalMs`/`typing.intervalMs`/`buttons.max` positive
 * integers, `configured`/`start`/`send` functions, the optional members
 * functions when present, and `format` REQUIRED when
 * `capabilities.format` is `"native"` (native markup has no default
 * renderer). Duplicate ids within one result reject — they would collide
 * on the engine's channel-id key exactly like a cross-extension pair.
 */
function validateChannels(
	value: unknown,
): readonly ChannelContribution[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(
			"extension factory returned a channels field that is not an array",
		);
	}
	const seen = new Set<string>();
	for (const entry of value) {
		const channel = entry as
			| {
						id?: unknown;
					label?: unknown;
					capabilities?: unknown;
					configured?: unknown;
					start?: unknown;
					send?: unknown;
					stop?: unknown;
					edit?: unknown;
					delete?: unknown;
					typing?: unknown;
					setCommands?: unknown;
					format?: unknown;
					classifyError?: unknown;
			  }
			| null;
		const describe = () =>
			`channel "${typeof channel?.id === "string" ? channel.id : String(channel?.id)}"`;
		if (
			typeof channel?.id !== "string" ||
			!CHANNEL_ID.test(channel.id)
		) {
			throw new Error(
				`extension factory returned a ${describe()} whose id does not match ^[a-z][a-z0-9-]*$`,
			);
		}
		if (seen.has(channel.id)) {
			throw new Error(
				`extension factory returned a duplicate channel id "${channel.id}" within one result`,
			);
		}
		seen.add(channel.id);
		if (typeof channel?.label !== "string" || channel.label.length === 0) {
			throw new Error(
				`extension factory returned a ${describe()} whose label is missing or empty`,
			);
		}
		const capabilities = channel?.capabilities as
			| {
						chatTypes?: unknown;
					maxMessageLength?: unknown;
					format?: unknown;
					edit?: { minIntervalMs?: unknown } | null;
					buttons?: { max?: unknown } | null;
					typing?: { intervalMs?: unknown } | null;
			  }
			| null;
		if (typeof capabilities !== "object" || capabilities === null) {
			throw new Error(
				`extension factory returned a ${describe()} whose capabilities is missing or not an object`,
			);
		}
		if (
			!Array.isArray(capabilities.chatTypes) ||
			capabilities.chatTypes.length === 0 ||
			capabilities.chatTypes.some(
					(type) =>
						typeof type !== "string" || !CHANNEL_CHAT_TYPES.has(type),
				)
		) {
			throw new Error(
				`extension factory returned a ${describe()} whose capabilities.chatTypes is not a non-empty array over dm, group, thread`,
			);
		}
		if (
			typeof capabilities.maxMessageLength !== "number" ||
			!Number.isInteger(capabilities.maxMessageLength) ||
			capabilities.maxMessageLength <= 0
		) {
			throw new Error(
				`extension factory returned a ${describe()} whose capabilities.maxMessageLength is not a positive integer`,
			);
		}
		if (
			typeof capabilities.format !== "string" ||
			!CHANNEL_FORMATS.has(capabilities.format)
		) {
			throw new Error(
				`extension factory returned a ${describe()} whose capabilities.format is not one of plain, markdown, native`,
			);
		}
		// The optional numeric members: positive integers when present.
		if (
			capabilities.edit !== undefined &&
			(typeof capabilities.edit?.minIntervalMs !== "number" ||
				!Number.isInteger(capabilities.edit.minIntervalMs) ||
				capabilities.edit.minIntervalMs <= 0)
		) {
			throw new Error(
				`extension factory returned a ${describe()} whose capabilities.edit.minIntervalMs is not a positive integer`,
			);
		}
		if (
			capabilities.buttons !== undefined &&
			(typeof capabilities.buttons?.max !== "number" ||
				!Number.isInteger(capabilities.buttons.max) ||
				capabilities.buttons.max <= 0)
		) {
			throw new Error(
				`extension factory returned a ${describe()} whose capabilities.buttons.max is not a positive integer`,
			);
		}
		if (
			capabilities.typing !== undefined &&
			(typeof capabilities.typing?.intervalMs !== "number" ||
				!Number.isInteger(capabilities.typing.intervalMs) ||
				capabilities.typing.intervalMs <= 0)
		) {
			throw new Error(
				`extension factory returned a ${describe()} whose capabilities.typing.intervalMs is not a positive integer`,
			);
		}
		if (typeof channel?.configured !== "function") {
			throw new Error(
				`extension factory returned a ${describe()} whose configured is not a function`,
			);
		}
		if (typeof channel?.start !== "function") {
			throw new Error(
				`extension factory returned a ${describe()} whose start is not a function`,
			);
		}
		if (typeof channel?.send !== "function") {
			throw new Error(
				`extension factory returned a ${describe()} whose send is not a function`,
			);
		}
		for (const field of [
			"stop",
			"edit",
			"delete",
			"typing",
			"setCommands",
			"format",
			"classifyError",
		] as const) {
			if (channel[field] !== undefined && typeof channel[field] !== "function") {
				throw new Error(
					`extension factory returned a ${describe()} whose ${field} is not a function`,
				);
			}
		}
		if (capabilities.format === "native" && channel?.format === undefined) {
			throw new Error(
				`extension factory returned a ${describe()} without a format function while its capabilities.format is "native"`,
			);
		}
	}
	return value as readonly ChannelContribution[];
}

/**
 * Validate a factory result's `gateway` declaration (gateway C2, spec
 * §8.0). Absent → undefined (no engine). Present but malformed → throw;
 * the loader quarantines the extension with the thrown message
 * (fail-loud: an extension that THINKS it declared the engine must not
 * silently lose it — the providers/health class). An object whose
 * `start`/`stopIntake`/`stop`/`health` are all functions is the shape; a
 * result carrying BOTH `gateway` and the `health` field is a contract
 * violation (an engine reports health through `gateway.health()` — the
 * `health` field is the provider-contributor surface and would
 * double-report), thrown with the documented message.
 */
function validateGateway(
	value: unknown,
	healthPresent: boolean,
): GatewayEngine | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null) {
		throw new Error(
			"extension factory returned a gateway field that is not an object",
		);
	}
	const engine = value as {
		start?: unknown;
		stopIntake?: unknown;
		stop?: unknown;
		health?: unknown;
	};
	for (const field of ["start", "stopIntake", "stop", "health"] as const) {
		if (typeof engine[field] !== "function") {
			throw new Error(
				`extension factory returned a gateway whose ${field} is not a function`,
			);
		}
	}
	if (healthPresent) {
		throw new Error(
			"a gateway engine reports health through gateway.health(), not the health field",
		);
	}
	return value as GatewayEngine;
}

/**
 * Validate a factory result's `skills` declaration (core hardening W5
 * Task 4, spec §9.4). Absent → undefined (no contributions). Present but
 * malformed → throw; the loader quarantines the extension with the thrown
 * message (fail-loud: an extension that THINKS it contributed skills must
 * not silently lose them — the providers/health class). Per entry: an
 * absolute path naming an EXISTING directory.
 */
function validateSkills(value: unknown): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(
			"extension factory returned a skills field that is not an array",
		);
	}
	for (const entry of value) {
		if (typeof entry !== "string" || entry.length === 0) {
			throw new Error(
				"extension factory returned a skills entry that is not a non-empty string",
			);
		}
		if (!isAbsolute(entry)) {
			throw new Error(
				`extension factory returned a skills entry that is not an absolute directory: ${entry}`,
			);
		}
		if (!existingDirectory(entry)) {
			throw new Error(
				`extension factory returned a skills entry that is not an existing directory: ${entry}`,
			);
		}
	}
	return value as readonly string[];
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
 * The contributed-bundle NAME grammar (spec §4.1: `^[a-z][a-z0-9_-]*$` —
 * a selector value matching it is a contributed-bundle NAME). Kept in
 * sync with `BUNDLE_NAME` in src/server/static.ts by the spec grammar,
 * not a shared import: this module must not pull the server's runtime
 * graph (the loader has no fs/server coupling by contract).
 */
const WEBUI_BUNDLE_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * Validate a factory result's `webuiBundles` declaration (build-and-webui
 * Task 6). Absent → undefined (no contributions). Present but malformed →
 * throw; the loader quarantines the extension with the thrown message
 * (fail-loud: an extension that THINKS it contributed a bundle must not
 * silently lose it — the providers/health/submit class). Each entry must
 * be a `{name, dir}` object whose `name` matches the contributed-bundle
 * grammar and whose `dir` is a non-empty string; extra fields are inert.
 */
function validateWebuiBundles(
	value: unknown,
): readonly WebuiBundleContribution[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(
			"extension factory returned a webuiBundles field that is not an array",
		);
	}
	for (const entry of value) {
		const bundle = entry as { name?: unknown; dir?: unknown } | null;
		if (
			typeof bundle?.name !== "string" ||
			!WEBUI_BUNDLE_NAME.test(bundle.name)
		) {
			throw new Error(
				"extension factory returned a webuiBundles entry whose name is missing or does not match ^[a-z][a-z0-9_-]*$",
			);
		}
		if (typeof bundle?.dir !== "string" || bundle.dir.length === 0) {
			throw new Error(
				`extension factory returned a webuiBundles entry "${bundle?.name}" whose dir is missing or not a non-empty string`,
		);
		}
	}
	return value as readonly { name: string; dir: string }[];
}

/**
 * The host modules whose version must match the host EXACTLY (spec
 * §6.4 R6): an extension's `Extension`/tool objects flow into the HOST's
 * pi-durable registry under structural typing — a different pi-durable
 * is the classic silent-breakage trap (identity never matches, hooks
 * never fire), so any difference at all quarantines. `@sigrun/sigrun`
 * joins that tier for the same reason the spec makes it a peer dependency
 * (§14.1): `@sigrun/sigrun/blocks` must emit the SERVER's block-set
 * version, and a different sigrun can only ever emit a different one —
 * any difference at all quarantines. Every other host module only shares
 * the major (a minor/patch difference warns).
 */
const EXACT_HOST_MODULES: ReadonlySet<string> = new Set([
	"@earendil-works/pi-durable",
	"@sigrun/sigrun",
]);

/** The major segment of a semver-ish version string (`"1.2.0"` → `"1"`). */
function majorSegment(version: string): string {
	return version.split(".")[0] ?? version;
}

/**
 * The nearest `package.json` at or above `dir` (bounded walk) — the
 * manifest owning a resolved module ENTRY file. `undefined` at the walk
 * bound or filesystem root.
 */
function nearestManifest(dir: string): string | undefined {
	let current = dir;
	for (let hops = 0; hops < 6; hops++) {
		const candidate = join(current, "package.json");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

/**
 * The nearest `node_modules/<name>/package.json` walking up from `dir` —
 * the package-directory form of Node's own lookup (which copy of `<name>`
 * a module at `dir` resolves). Bounded like every walk here; `undefined`
 * when no ancestor tree carries the package.
 */
function nearestModuleManifest(dir: string, name: string): string | undefined {
	let current = dir;
	for (let hops = 0; hops < 10; hops++) {
		const candidate = join(current, "node_modules", ...name.split("/"), "package.json");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

/**
 * The version of one host runtime module as an extension's tree resolves
 * it, anchored at the extension ENTRY's directory — the exact resolution
 * the extension's own bare imports use (a nested `node_modules` copy
 * counts, and so does the host's copy when the walk finds nothing
 * nearer). `undefined` when the extension's tree resolves no copy at
 * all: the extension does not depend on the module, and the guard
 * skips it.
 *
 * Two resolution forms, in order: `<name>/package.json` (explicit, and
 * the only form for manifest-less trees), falling back to the module
 * ENTRY + nearest manifest above it — some host modules' exports maps
 * (pi-ai, typebox) do not expose the `./package.json` subpath, which
 * `require.resolve("<name>/package.json")"` reports as
 * ERR_PACKAGE_PATH_NOT_EXPORTED even though the package itself resolves
 * fine; without the fallback those modules would be invisible to the
 * guard, the exact R6 blind spot it exists to close.
 */
function moduleVersionFrom(moduleDir: string, name: string): string | undefined {
	// Node's ESM loader realpaths the referrer before resolving ITS bare
	// imports (preserveSymlinks is off by default) — anchor the walk at the
	// realpath'd dir so the tree examined is the tree the extension's own
	// imports resolve from, not the symlink path that named it (a `file:`
	// dir install symlinks node_modules/<pkg> → the checkout).
	let anchor = moduleDir;
	try {
		anchor = realpathSync(moduleDir);
	} catch {
		// Not realpath-able — the literal dir is the best anchor available.
	}
	const req = createRequire(join(anchor, "package.json"));
	let manifestPath: string | undefined;
	try {
		manifestPath = req.resolve(`${name}/package.json`);
	} catch {
		// No package.json subpath from here — either the exports map gates
		// it or the tree carries no copy: the fallbacks below decide.
	}
	if (manifestPath === undefined) {
		try {
			manifestPath = nearestManifest(dirname(req.resolve(name)));
		} catch {
			// The entry itself is not require-resolvable — pi-ai's exports
			// map carries ONLY `import`/`types` conditions, so createRequire
			// cannot resolve the package AT ALL even though extensions
			// import it fine. Fall back to the node_modules DIRECTORY walk
			// (the package-dir form of Node's lookup); without it pi-ai skew
			// would be invisible to the guard — the exact R6 blind spot.
			manifestPath = nearestModuleManifest(anchor, name);
		}
	}
	if (manifestPath === undefined) return undefined;
	try {
		const parsed = JSON.parse(
			readFileSync(manifestPath, "utf8"),
		) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The host-module version guard (spec §6.4 R6, core-hardening Task 5):
 * every host runtime module the extension's tree RESOLVES must agree
 * with the copy the host runs — `@earendil-works/pi-durable` EXACTLY
 * (else quarantine), the others in the major (a minor/patch difference
 * warns, a major difference quarantines). Runs at LOAD, immediately
 * after the import and before anything is keyed, collected, or
 * installed: a skewing extension quarantines with this message and
 * leaves no trace in the registry, the seam hosts, or any binding.
 *
 * @param moduleDir the extension ENTRY's directory (the tree its bare
 * imports resolve from — `extensionModuleDir` above).
 * @throws the quarantine message on a disallowed difference.
 */
function checkHostModules(moduleDir: string): void {
	for (const name of HOST_RUNTIME_MODULES) {
		const extVersion = moduleVersionFrom(moduleDir, name);
		if (extVersion === undefined) continue; // not a dependency of this extension
		const hostVersion = hostModuleVersion(name);
		if (hostVersion === undefined) continue; // no host copy to compare against
		if (extVersion === hostVersion) continue;
		if (
			EXACT_HOST_MODULES.has(name) ||
			majorSegment(extVersion) !== majorSegment(hostVersion)
		) {
			throw new Error(
				`host module skew: ${name} resolves to ${extVersion} from ${moduleDir}, host runs ${hostVersion}`,
			);
		}
		console.warn(
			`host module minor skew: ${name} resolves to ${extVersion} from ${moduleDir}, ` +
				`host runs ${hostVersion} (same major, allowed)`,
		);
	}
}

/**
 * The extension module's DIRECTORY — the anchor a contributed bundle's
 * relative `dir` resolves against (build-and-webui Task 6: an
 * npm-installed extension's bundle lives in its own package, so the dir
 * anchors where the MODULE loaded from, never the process cwd). Path-shaped
 * specifiers (file:// URLs, POSIX absolutes — the packages-dir and
 * pre-resolved flows) derive directly; bare specifiers resolve through
 * the loader's own require anchor (the same mechanism
 * `resolveExtensionEntry`'s fallback uses). `undefined` when nothing
 * path-shaped derives — a contributed `dir` then passes through unchanged
 * (absolute dirs always do; `resolve` keeps them verbatim).
 */
function extensionModuleDir(loaded: string): string | undefined {
	let path: string | undefined;
	if (loaded.startsWith("file://")) {
		try {
			path = fileURLToPath(loaded);
		} catch {
			return undefined;
		}
	} else if (loaded.startsWith("/")) {
		path = loaded;
	} else {
		try {
			const resolved = createRequire(import.meta.url).resolve(loaded);
			path = resolved.startsWith("file://")
				? fileURLToPath(resolved)
				: resolved;
		} catch {
			return undefined;
		}
	}
	return path === undefined ? undefined : dirname(path);
}

/**
 * Call an unknown-typed factory and validate the `{ extension, health? }`
 * result. A `health` field that is present but not the expected shape is a
 * contract violation — thrown, so the loader quarantines the extension
 * (fail-loud: a package that THINKS it reports health must not read as
 * healthy). A `submit` field is IGNORED with a flag (§6.7: the
 * pass-through is retired; the loader warns, never quarantines — old
 * packages keep loading).
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
	// defaulted first parameter (createMemory(backend = new Backend()))
	// consumes its first argument as a real dependency — passing the host
	// unconditionally landed it in that slot and broke the extension at
	// runtime (memory: every submit 500ed on `bindRecallSource is not a
	// function`). Extra arguments are inert only for factories that read
	// none; `length` is how the contract declares it.
	const result =
		factory.length > 0
			? (factory as (host?: unknown) => unknown)(hostContext)
			: (factory as () => unknown)();
	// Provider plugins may resolve asynchronously; `await` passes a
	// synchronous result through unchanged.
	const awaited = await result;
	if (typeof awaited !== "object" || awaited === null) return undefined;
	// The candidate is keyed by the PUBLIC contract (CandidateFactoryResult):
	// reading a field the contract does not declare is a compile error here,
	// and the `LoaderReadKeys` assertion (above ResolvedExtension) pins the
	// full read list to the contract's keys.
	const candidate = awaited as CandidateFactoryResult;
	if (
		candidate.perUserTools !== undefined &&
		typeof candidate.perUserTools !== "boolean"
	) {
		throw new Error("extension factory returned a perUserTools field that is not a boolean");
	}
	const providers = validateProviders(candidate.providers);
	const loginProviders = validateLoginProviders(candidate.loginProviders);
	const webuiBundles = validateWebuiBundles(candidate.webuiBundles);
	const jobs = validateJobs(candidate.jobs);
	const routes = validateRoutes(candidate.routes);
	const commands = validateCommands(candidate.commands);
	const skills = validateSkills(candidate.skills);
	const notifiers = validateNotifiers(candidate.notifiers);
	const channels = validateChannels(candidate.channels);
	// The engine (gateway C2): validated against the health-field conflict
	// rule too — a result carrying both quarantines with the documented
	// message (an engine reports health through gateway.health()).
	const gateway = validateGateway(candidate.gateway, candidate.health !== undefined);
	const surfaces = validateSurfaces(candidate.surfaces);
	const extension = isExtension(candidate.extension)
		? candidate.extension
		: undefined;
	if (extension === undefined) {
		// Contributor-only result: valid when ANY contribution field is
		// present (`providers`, `webuiBundles`, `channels`); otherwise this
		// factory result is not the contract form (fall through to the next
		// resolution candidate). The contributor's name is its
		// collision-record identity — without one there is nothing to
		// attribute the contributions to, which is a contract violation.
		if (
			providers === undefined &&
			loginProviders === undefined &&
			webuiBundles === undefined &&
			channels === undefined
		) {
			return undefined;
		}
		if (typeof candidate.name !== "string" || candidate.name.length === 0) {
			throw new Error(
				"extension factory returned a contributor-only result without a name",
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
	// The settings-change hook (U4 §13.2): present-but-not-a-function is
	// the same contract violation class as the lifecycle fields — an
	// extension that THINKS it observes settings changes must not
	// silently miss them.
	const onSettingsChanged = candidate.onSettingsChanged;
	if (onSettingsChanged !== undefined && typeof onSettingsChanged !== "function") {
		throw new Error(
			"extension factory returned an onSettingsChanged field that is not a function",
		);
	}
	// `workers` is a contract key — the candidate read needs no cast.
	const workers = validateWorkers(candidate.workers);
	return {
		...(candidate.perUserTools === undefined
			? {}
			: { perUserTools: candidate.perUserTools }),
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
			: { retiredSubmit: true as const }),
		...(candidate.runSettled === undefined
			? {}
			: { runSettled: candidate.runSettled as ExtensionRunSettledHandler }),
		...(onSettingsChanged === undefined
			? {}
			: {
					// SAFETY: the typeof-function check above is the validation —
				// the cast supplies the contract's parameter type only.
					onSettingsChanged: onSettingsChanged as ExtensionSettingsChangedHandler,
				}),
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
		...(loginProviders === undefined ? {} : { loginProviders }),
		...(webuiBundles === undefined ? {} : { webuiBundles }),
		...(jobs === undefined ? {} : { jobs }),
		...(routes === undefined ? {} : { routes }),
		...(commands === undefined ? {} : { commands }),
		...(skills === undefined ? {} : { skills }),
		...(notifiers === undefined ? {} : { notifiers }),
		...(channels === undefined ? {} : { channels }),
		...(gateway === undefined ? {} : { gateway }),
		...(surfaces === undefined ? {} : { surfaces: surfaces.defs }),
		...(surfaces?.settings === undefined
			? {}
			: { settingsSections: surfaces.settings }),
	};
}

/** Validate and retain login providers; all-or-nothing for one extension. */
function validateLoginProviders(
	value: unknown,
): readonly LoginProviderContribution[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error("extension factory returned a loginProviders field that is not an array");
	}
	const ids = new Set<string>();
	for (const candidate of value) {
		if (typeof candidate !== "object" || candidate === null) {
			throw new Error("extension factory returned a loginProviders entry that is not an object");
		}
		const entry = candidate as Partial<LoginProviderContribution>;
		if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(entry.id)) {
			throw new Error("extension factory returned a loginProviders entry with an invalid id");
		}
		if (ids.has(entry.id)) {
			throw new Error(`extension factory returned duplicate login provider id "${entry.id}"`);
		}
		ids.add(entry.id);
		if (typeof entry.label !== "string") {
			throw new Error("extension factory returned a loginProviders entry whose label is not a string");
		}
		if (entry.icon !== undefined && typeof entry.icon !== "string") {
			throw new Error("extension factory returned a loginProviders entry whose icon is not a string");
		}
		if (typeof entry.begin !== "function" || typeof entry.complete !== "function") {
			throw new Error("extension factory returned a loginProviders entry whose begin/complete is not a function");
		}
	}
	return value as LoginProviderContribution[];
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
	// 1. Default export: factory returning `{ extension, health? }`, or the
	//    Extension itself — the supported forms.
	const defaultExport = module.default;
	if (isExtension(defaultExport)) return { extension: defaultExport };
	const fromDefault = await resolvedFromFactory(defaultExport, hostContext);
	if (fromDefault !== undefined) return fromDefault;

	// 2. Named `extension` export (DEPRECATED bridge for the pre-contract
	// packages — one warning per load at the caller). The pre-contract
	// `createMemory` named-factory bridge was deleted in release-0.1; its
	// last consumer exports the factory as default now.
	if (isExtension(module.extension)) {
		return { extension: module.extension, resolvedVia: "extension" };
	}

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
	 * Host-context factory (the interaction/ambient seam): invoked TWICE
	 * per resolving extension. The PRE-import call passes the PROVISIONAL
	 * identity — the slug derived from the load specifier
	 * (`provisionalSlugFor` below; `""` when nothing derives) — so a
	 * factory that reads scoped settings during its body (e.g.
	 * sigrun-pareto's `baseUrl` override) resolves the real package's
	 * settings file, not the pre-fix `settings/.json` placeholder scope.
	 * The post-resolution call passes the extension's declared slug +
	 * kinds AND the instance the first call returned as `priorHost`, so
	 * the host is re-keyed IN PLACE (a second instance would orphan every
	 * inbound handler the factory registered on the instance it
	 * captured). Omitted (or a factory that ignores the argument) = the
	 * extension uses no seam.
	 */
	readonly hostContextFactory?: (
		extensionName: string,
		kinds: DeclaredKinds,
		/** The pre-import call's instance — present on the post-resolution call only. */
		priorHost?: unknown,
	) => unknown;
}

/** One pre-resolved extension load (the boot flow's sync output). */
export interface ResolvedExtensionInput {
	/** Optional display name (the source specifier; drives quarantine names). */
	readonly name?: string;
	/**
	 * The module entry: an absolute `file://` URL or any import() specifier.
	 * ABSENT for a skills-only resolution (W5 Task 4): the package declared
	 * skill dirs and no loadable entry, so nothing is imported — `skills`
	 * carries the dirs and the outcome records `ok`.
	 */
	readonly entry?: string;
	/** Manifest skill dirs (existing directories), resolved by the sync. */
	readonly skills?: readonly string[];
	/**
	 * Built-in marker (Task 2): the boot's built-in resolution sets this on
	 * the entries it prepends; the outcome carries it through to
	 * `/v1/extensions`. Configured entries never set it.
	 */
	readonly builtin?: boolean;
	/**
	 * Core-tree resolution marker (Task 2, ruling 2): built-ins resolve
	 * through core's OWN node_modules, NEVER the packages dir — when set,
	 * the loader imports `entry` verbatim, skipping the packages-dir-first
	 * resolution step (a user-installed package must never shadow a
	 * built-in; replacement works by NAME, not path shadowing).
	 */
	readonly coreResolved?: boolean;
	/**
	 * The package's own DIRECTORY (Task 2): built-in resolution anchors
	 * the loader's manifest version read at the package ROOT, not the
	 * entry's directory (an entry in `dist/` would otherwise read no
	 * manifest and the outcome would lack `version`).
	 */
	readonly packageDir?: string;
}

/**
 * The PROVISIONAL host identity for the pre-import factory call
 * (provider plugins Task 9, review P1): the slug derived from the LOAD
 * SPECIFIER — the package's own manifest name when the entry is
 * path-shaped (packages-dir installs, git checkouts, dev checkouts:
 * the nearest `package.json` at or above the entry, never read across
 * a `node_modules` boundary — the packages root's own manifest is not
 * an extension's identity), else the specifier's name part
 * (`slugifyName` folds scoped names and `@version`s; an `npm:` install
 * prefix is stripped). `""` when nothing survives (the pre-fix
 * placeholder shape — an absent settings file reads as `{}` either
 * way, but `""` never invents a wrong-but-plausible scope).
 *
 * Why a provisional at all: a factory that reads scoped settings
 * DURING its body (sigrun-pareto's `baseUrl` override) runs BEFORE the
 * declared name is known; with the `""` placeholder its read hit
 * `settings/.json` and the override was silently inert. Pre-keying on
 * the specifier-derived slug makes the factory-time read resolve the
 * real package's file whenever the extension's declared name matches
 * its package name — the documented requirement for provider plugins
 * that read settings at factory time. A mismatching declared name
 * still re-keys to the declared slug after resolution; only its
 * factory-time settings reads saw the provisional scope.
 */
function provisionalSlugFor(loaded: string): string {
	let absolute: string | undefined;
	if (loaded.startsWith("file://")) {
		try {
			absolute = fileURLToPath(loaded);
		} catch {
			// Not a usable file URL — fall through to the specifier form.
		}
	} else if (
		loaded.startsWith("/") ||
		loaded.startsWith("./") ||
		loaded.startsWith("../")
	) {
		absolute = resolve(loaded);
	}
	if (absolute !== undefined) {
		// Bounded walk from the entry itself (a directory entry carries
		// its manifest at the top) up its ancestors.
		let dir = absolute;
		for (let hops = 0; hops < 6; hops++) {
			if (basename(dir) === "node_modules") return "";
			const name = readPackageName(dir);
			if (name !== undefined) {
				const slug = slugifyName(name);
				if (slug !== "") return slug;
			}
			const parent = dirname(dir);
			if (parent === dir) return "";
			dir = parent;
		}
		return "";
	}
	return slugifyName(loaded.replace(/^npm:/, ""));
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
// deploys). Each becomes {entry, label, skills} — label drives the warning
// name exactly as specifiers did; an ABSENT entry with skills is the
// skills-only resolution (§9.4).
const entries = specifiers.map((spec) =>
typeof spec === "string"
? { name: undefined as string | undefined, entry: spec, skills: undefined as readonly string[] | undefined, builtin: undefined as boolean | undefined, coreResolved: undefined as boolean | undefined, packageDir: undefined as string | undefined }
: { name: spec.name, entry: spec.entry, skills: spec.skills, builtin: spec.builtin, coreResolved: spec.coreResolved, packageDir: spec.packageDir },
);
const outcomes: ExtensionOutcome[] = [];
const perUserSlugs: string[] = [];
const providerContributors: ProviderContributor[] = [];
const webuiBundles: ContributedWebuiBundle[] = [];
const healthProducers: ExtensionHealthProducer[] = [];
const runSettledBindings: ExtensionRunSettledBinding[] = [];
const settingsChangedBindings: ExtensionSettingsChangedBinding[] = [];
const lifecycleBindings: ExtensionLifecycleBinding[] = [];
const workerBindings: ExtensionWorkerBinding[] = [];
// Jobs Task 3: declared jobs, attributed to the extension slug (the
// `ext:<slug>:<name>` id's namespace).
const jobBindings: { extension: string; jobs: readonly JobSpec[] }[] = [];
// HTTP routes (W5 Task 2), attributed to the slug like the job bindings.
const routeBindings: ExtensionRouteBinding[] = [];
// Slash commands (W5 Task 3), attributed the same way.
const commandBindings: ExtensionCommandBinding[] = [];
// Notifier transports (W5 Task 6, spec §9.6), attributed the same way —
// the server's notifications surface delivers to every collected entry.
const notifierBindings: ExtensionNotifierBinding[] = [];
// Channel adapters (gateway C1, spec §7), attributed the same way — the
// gateway engine's start context and the /v1/extensions inventory read
// them. Collected only for LOADED extensions (a colliding adapter never
// reaches here — the channelIds check below throws first).
const channelBindings: ExtensionChannelBinding[] = [];
// Login providers (multi-user M3b): flat, slug-qualified, in load order.
const loginProviders: LoginProviderBinding[] = [];
// The gateway engine (gateway C2, spec §8.0): the ONE-engine rule — the
// first loaded declarer wins; a later result declaring `gateway`
// quarantines naming the first slug (an engine owns supervision over the
// whole channel set, so a shadowing engine would inherit another
// engine's bindings — the same never-last-wins reasoning as channel ids).
let gatewayEngine: ExtensionGatewayBinding | undefined;
// Surfaces (U3 Task 1): the flattened validated defs, slug-attributed.
const surfaceBindings: ExtensionSurfaceBinding[] = [];
// Settings sections (U4 Task 3, spec §13.3): validated, slug-attributed.
const settingsSectionBindings: ExtensionSettingsSectionBinding[] = [];
// Skill roots (W5 Task 4, spec §9.4): every skill dir a loaded package
// contributed — skills-only resolutions, entry-bearing packages' manifest
// skills, and factory-result `skills` fields — in load order, attributed
// to the extension slug. Boot threads this to the skills section's
// package-roots option.
const skillRoots: { extension: string; dir: string }[] = [];
// Slug → declared name, for collision rejection at load (this boot's
// loaded set only — quarantined extensions never claim a slug).
const slugs = new Map<string, string>();
// Channel id → slug (gateway C1): the same claimed-only-by-LOADED pattern
// as `slugs`. Chat bindings are keyed by channel id, so a shadowing
// adapter would inherit another adapter's chats — the collision
// quarantines the later loader instead of last-wins (deliberately unlike
// commands and bundles). Checked BEFORE `registry.install` so a colliding
// extension leaves no registry entry, no slug claim, and no binding.
const channelIds = new Map<string, string>();
for (const { name: label, entry, skills, builtin, coreResolved, packageDir } of entries) {
const display = label ?? entry ?? "skills-only";
				try {
				// Skills-only resolution (§9.4): the package declared skill dirs and
				// has NO loadable entry — nothing is imported. The outcome records
				// `ok` under the slug of the package name; the dirs (validated as
				// existing directories — the sync filtered, a violation here is a
				// contract break) append to skillRoots. Inside the per-entry try so
				// a bad declaration QUARANTINES instead of aborting the boot.
				if (entry === undefined) {
					if (skills === undefined || skills.length === 0) {
						throw new Error(
							"a pre-resolved input carried neither an entry nor skill directories",
						);
					}
					const skillsOnlyName = label ?? "skills-only";
					const slug = slugifyName(skillsOnlyName);
					if (slug === "") {
						throw new Error(
								`skills-only package name "${skillsOnlyName}" sanitizes to an empty slug (nothing survives [a-z0-9_-] folding); refusing to load`,
						);
					}
					for (const dir of skills) {
						if (!existingDirectory(dir)) {
							throw new Error(
									`skills: contributed directory ${dir} does not exist (or is not a directory)`,
							);
						}
					}
					// All-or-nothing (the quarantined-contributions invariant): the
					// dirs append only once every one validated.
					for (const dir of skills) {
						skillRoots.push({ extension: slug, dir });
					}
					outcomes.push({ name: slug, status: "ok" });
					continue;
				}
						// Pre-resolved entries (the boot flow) import verbatim;
						// raw specifiers (the test seam) resolve through the
						// packages dir first, then bare import resolution.
						const loaded =
								coreResolved === true
										? entry
										: label !== undefined
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
						// A resolved entry ending in `.ts` is rejected BEFORE the import
						// (build-and-webui Task 3, BREAKING): the built server ships no
						// loader — a `.ts` entry is a from-source artifact whose behavior
						// depends on the host node's type-stripping flags (newer node
						// loads it, older node crashes with ERR_UNKNOWN_FILE_EXTENSION).
						// Sources must ship a BUILT entry; the quarantine names it.
						if (/\.ts$/.test(loaded)) {
							throw new Error(
								`the resolved entry is a TypeScript source (${loaded}) — build the package and ship its built entry (dist/index.js); the built server loads JavaScript`,
							);
						}
			const module = (await import(loaded)) as ExtensionModule;
			// Host-module version guard (spec §6.4 R6): the module tree the
			// extension's bare imports resolve from must agree with the copy
			// the host runs — checked immediately after the import, BEFORE any
			// host keying or contract resolution, so a skewing extension leaves
			// no trace (no seam host, no bindings, no registry entry). A throw
			// here rides the existing per-extension try (quarantine, boot
			// continues) exactly like the reserved-section check below.
			const moduleDir = extensionModuleDir(loaded);
			if (moduleDir !== undefined) checkHostModules(moduleDir);
			// Two-phase host: the factory receives the host at CALL time, but
			// the extension name and kinds it declares are only known from its
			// RESULT. The loader therefore invokes the host factory TWICE with
			// the SAME instance: once PRE-import with the PROVISIONAL identity
			// (the slug derived from the load specifier — `provisionalSlugFor`;
			// "" when nothing derives) so a factory that reads scoped settings
			// during its body resolves the real package's store (provider
			// plugins Task 9 P1 — the pre-fix "" placeholder made sigrun-pareto's
			// `baseUrl` override silently inert), and once post-resolution with
			// the declared name + kinds PLUS the captured instance — boot's
			// factory re-keys that SAME host object IN PLACE (SeamHost.rekey),
			// so the instance the factory captured becomes the final host and
			// its write gate sees the declared kinds from then on. The
			// provisional normally EQUALS the resolved slug (extension name ==
			// package name); when it differs the re-key still corrects the
			// scope — only factory-time settings reads of such an extension
			// saw the provisional scope (documented: read scoped settings at
			// factory time only when the plugin name matches its package name).
			let host: unknown;
			if (options.hostContextFactory !== undefined) {
				host = options.hostContextFactory(provisionalSlugFor(loaded), {});
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
				// The `core` slug is RESERVED (UI-blocks U4 Task 3, spec §13.4):
				// core's own settings sections serve under it, so an extension
				// claiming the slug would shadow them (and every other
				// core-served `/v1/ext/core/` surface).
				if (slug === "core") {
					throw new Error(
						`extension name "${declared}" sanitizes to the reserved slug "core" ` +
						"(core's own settings sections use it); refusing to load",
					);
				}
				// Multi-user M1: core-owned store-root directories are not available
				// as extension identities. Check after the slug is final, before
				// any contribution is collected (the same load-time quarantine as
				// the reserved section-key check below).
				if (RESERVED_EXTENSION_SLUG_SET.has(slug)) {
					throw new Error(`reserved extension slug "${slug}"`);
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
				// Reserved core section keys (spec §6.5 R11): a section under one
				// of them is a LOAD-TIME quarantine, checked HERE — after the slug
				// is final and BEFORE anything is collected. The registry would
				// otherwise accept the duplicate (sections are last-writer-wins
				// across extensions), silently replacing a core surface; the
				// existing catch quarantines with this message instead, leaving
				// nothing installed (no registry entry), no post-resolution host
				// re-key (boot's seamHosts never files the entry), and no
				// provider/health/submit/runSettled/lifecycle/worker/webui
				// binding collected. Boot's post-install walk over
				// RESERVED_CORE_SECTION_OWNERS stays as a core-only assertion.
				const reservedSectionKey = extension?.sections?.find((section) =>
					RESERVED_SECTION_KEY_SET.has(section.key),
				)?.key;
				if (reservedSectionKey !== undefined) {
					throw new Error(
						`extension "${slug}" declares reserved core section "${reservedSectionKey}"`,
					);
				}
				// Skill contributions (W5 Task 4), validated HERE — before the
				// install/outcome, so a bad declaration quarantines with nothing
				// installed and exactly one outcome (the same point as every
				// other fail-loud contract check). The factory-result dirs were
				// already validated at read time (validateSkills, all-or-nothing);
				// the MANIFEST dirs (the sync's resolution, existing by
				// construction) are re-checked because a hand-built pre-resolved
				// input skips the sync.
				const contributed = [...(resolved.skills ?? []), ...(skills ?? [])];
				for (const dir of contributed) {
					if (!existingDirectory(dir)) {
						throw new Error(
							`skills: contributed directory ${dir} does not exist (or is not a directory)`,
						);
					}
				}
				// The post-resolution call re-keys the captured host instance in
				// place with the slug + declared kinds (boot's
				// hostContextFactory; see src/harness/boot.ts) — the instance is
				// handed back explicitly as `priorHost`, so even a provisional ≠
				// resolved mismatch re-keys the SAME instance. No second host is
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
					options.hostContextFactory(slug, kinds, host);
				}
				if (resolved.channels !== undefined) {
					for (const channel of resolved.channels) {
						const owner = channelIds.get(channel.id);
						if (owner !== undefined) {
							throw new Error(
								`channel "${channel.id}" is already contributed by "${owner}" — ` +
								"channel ids must be unique across extensions (chat bindings are keyed by id)",
							);
						}
					}
				}
				// The one-engine rule (gateway C2): checked BEFORE the registry
				// install, exactly like the channel-id collision — a second engine
				// leaves no registry entry, no slug claim, and no binding. First
				// loaded wins.
				if (resolved.gateway !== undefined) {
					if (gatewayEngine !== undefined) {
						throw new Error(
							`gateway engine already declared by "${gatewayEngine.extension}"`,
						);
					}
					gatewayEngine = { extension: slug, engine: resolved.gateway };
				}
				if (extension !== undefined) {
					registry.install(extension);
				}
				if (resolved.perUserTools === true) perUserSlugs.push(slug);
				// Only a LOADED extension or contributor claims its slug — a
				// later stage's quarantine (never loaded) leaves the slug free
				// for the next boot's specifier list.
				slugs.set(slug, declared);
				// ...and its channel ids (the same claimed-only-by-loaded rule).
				if (resolved.channels !== undefined) {
					for (const channel of resolved.channels) {
						channelIds.set(channel.id, slug);
					}
				}
				// The manifest version for the §7.7 inventory: read off the
				// module's own directory (a bare entry with no manifest stays
				// versionless — the field is optional by design).
				const versionDir = packageDir ?? extensionModuleDir(loaded);
				const version =
						versionDir === undefined ? undefined : readPackageVersion(versionDir);
				outcomes.push({
					name: slug,
					status: "ok",
					...(version === undefined ? {} : { version }),
					...(builtin === true ? { builtin: true } : {}),
					...(resolved.channels === undefined
						? {}
						: { channels: resolved.channels.map((channel) => channel.id) }),
				});
				if (extension !== undefined && resolved.health !== undefined) {
					healthProducers.push({
						extension,
						health: resolved.health,
					});
				}
			// §6.7 retirements, warned ONCE at load (never quarantined): a
			// result resolved through the named-export bridge, and a result still
			// carrying the retired submit pass-through. Both keep loading —
			// the pre-contract `createMemory` named-factory bridge was deleted
			// in release-0.1 (its last consumer exports default now), and the
			// submit is simply ignored (the memory seam owns capture now).
			if (resolved.resolvedVia !== undefined) {
				console.warn(
					`extension ${display}: named-export factory "${resolved.resolvedVia}" is deprecated — export it as default`,
				);
			}
			if (resolved.retiredSubmit === true) {
				console.warn(
					`extension "${slug}": the submit pass-through was retired; ignoring`,
				);
			}
				if (extension !== undefined && resolved.runSettled !== undefined) {
					runSettledBindings.push({
						extension,
						runSettled: resolved.runSettled,
					});
				}
				if (
					extension !== undefined &&
					resolved.onSettingsChanged !== undefined
				) {
					settingsChangedBindings.push({
						extension,
						onSettingsChanged: resolved.onSettingsChanged,
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
				if (resolved.jobs !== undefined) {
					jobBindings.push({ extension: slug, jobs: resolved.jobs });
				}
				if (resolved.routes !== undefined) {
					routeBindings.push({ extension: slug, routes: resolved.routes });
				}
				if (resolved.commands !== undefined) {
					commandBindings.push({ extension: slug, commands: resolved.commands });
				}
				if (resolved.notifiers !== undefined) {
					notifierBindings.push({ extension: slug, notifiers: resolved.notifiers });
				}
				if (resolved.channels !== undefined) {
					channelBindings.push({ extension: slug, channels: resolved.channels });
				}
			if (resolved.surfaces !== undefined) {
				// The §11.1 assets dir: the package manifest's `sigrun.assets`
				// relative to the package root (the same anchor the version
				// read below uses); absent or undeclared → `undefined` and
				// every asset request 404s.
				const assetsRoot = packageDir ?? extensionModuleDir(loaded);
				const declaredAssets =
					assetsRoot === undefined
						? undefined
						: readPackageAssetsDir(assetsRoot);
				surfaceBindings.push({
					extension: slug,
					defs: resolved.surfaces,
					...(declaredAssets === undefined ? {} : { assetsDir: declaredAssets }),
				});
			}
			if (resolved.settingsSections !== undefined) {
				settingsSectionBindings.push({
					extension: slug,
					defs: resolved.settingsSections,
				});
			}
			if (resolved.loginProviders !== undefined) {
				for (const contribution of resolved.loginProviders) {
					loginProviders.push({
						provider: `login:${slug}:${contribution.id}`,
						contribution,
					});
				}
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
			// Webui-bundle contributions (build-and-webui Task 6): each entry
			// is attributed to the extension slug and its `dir` anchored at
			// the MODULE's directory — resolved HERE, the one point the module
			// URL is known (an npm-installed extension's bundle lives in its
			// own package, never the server cwd). Absolute dirs pass through
			// `resolve` verbatim; the server owns the index.html check at
			// serve time (the loader has no fs coupling by contract).
			if (resolved.webuiBundles !== undefined) {
				const moduleDir = extensionModuleDir(loaded);
				for (const entry of resolved.webuiBundles) {
					webuiBundles.push({
						name: entry.name,
						dir:
							moduleDir === undefined || isAbsolute(entry.dir)
								? entry.dir
								: resolve(moduleDir, entry.dir),
						extension: slug,
					});
				}
			}
			// Skill contributions (W5 Task 4): the validated combined list
			// (factory-result + manifest dirs — validated above, before the
			// install), attributed to the extension slug, in load order.
			for (const dir of contributed) {
				skillRoots.push({ extension: slug, dir });
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
				...(builtin === true ? { builtin: true } : {}),
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
		perUserSlugs,
		providerContributors,
		loginProviders,
		webuiBundles,
		skillRoots,
		healthProducers,
		runSettledBindings,
		settingsChangedBindings,
		lifecycleBindings,
		workerBindings,
		jobBindings,
		routeBindings,
		commandBindings,
		notifierBindings,
		channelBindings,
		gatewayEngine,
		surfaces: surfaceBindings,
		settingsSections: settingsSectionBindings,
	};
}
