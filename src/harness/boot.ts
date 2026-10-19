/**
 * Harness bootstrap: open one durable Session over SQLite, ready for use.
 *
 * `openHarness` composes the pieces every later task needs — file-backed
 * storage at `config.storagePath`, an empty registry holding the built-in
 * task definitions, and the merged provider catalog (`collectProviders`) —
 * and returns them together. `Harness.root(context)` (called by the host,
 * not here) creates or resumes the reserved root conversation.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	Harness,
	type HarnessSettings,
	type ModelRef,
	type Registry,
	type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Env, SigrunConfig } from "../config.js";
import { wireActivity } from "./activity.js";
import { EventBus, type ExtensionEventHandlers, type WorkerStatus } from "./event-bus.js";
import type { HealthProducer, HealthStatus } from "./health.js";
import { loadExtensions, type ExtensionOutcome, type ExtensionSubmit, type ResolvedExtensionInput } from "./loader.js";
import { createAutoNamer, type AutoNamer } from "./naming.js";
import { AuthStore } from "./auth.js";
import { MEMORY_SECTION_KEY, noopMemoryExtension } from "./memory-default.js";
import {
	createSeamHost,
	type DeclaredKinds,
	type SeamHost,
} from "./seam-host.js";
import { contextFilesExtension } from "./sections/context-files.js";
import { modelGuidanceExtension } from "./sections/model-guidance.js";
import { skillsExtension } from "../skills/index.js";
import { codingToolsExtension, searchToolsExtension } from "./tools.js";
import {
	collectProviders,
	createProviderMergeSink,
	type ProviderCollision,
	type ProviderContributor,
	type ReadinessTracker,
} from "./providers/index.js";
import type {
	ContributedWebuiBundle,
	WebuiBundleCollision,
} from "../server/static.js";
import {
	bootRefresh,
	DEFAULT_REFRESH_TIMEOUT_MS,
} from "./providers/refresh.js";
import { startProviderRefresh } from "./providers/scheduler.js";
import { fileModelsStore } from "./providers/models-store.js";
import { packagesDirOf } from "./packages.js";
import { createRegistry } from "./registry.js";
import { defaultSettingsDir, SettingsStore } from "./settings.js";
import {
	ensureStoreRoots,
	resolveStoreRoots,
	sharedExtensionStores,
	type StoreRoots,
} from "./stores.js";
import {
	createWorkspaceService,
	defaultWorkspacePrefs,
	toHarnessEnv,
	type EnvBuilder,
} from "./workspace.js";

/** The idle sweep cadence (spec §2: ONE host-owned 1s interval). */
const IDLE_SWEEP_MS = 1_000;

/**
 * The prompt-section keys the core surfaces own (system-prompt Task 3).
 * The registry itself permits duplicate section keys across extensions
 * (last-writer-wins at render), so a loaded extension could silently
 * replace a core surface — boot asserts ownership instead (below).
 */
export const RESERVED_CORE_SECTION_KEYS = [
	"identity",
	"persona",
	"workspace-instructions",
	"skills",
	"tool-guidance",
	"execution-guidance",
] as const;

/**
 * Reserved key → the one core extension that may own it. Anything else
 * owning a reserved key fails boot loud (the walk after the guidance
 * install below).
 */
export const RESERVED_CORE_SECTION_OWNERS: Readonly<Record<string, string>> = {
	identity: "sigrun.context-files",
	persona: "sigrun.context-files",
	"workspace-instructions": "sigrun.context-files",
	skills: "sigrun.skills",
	"tool-guidance": "sigrun.model-guidance",
	"execution-guidance": "sigrun.model-guidance",
};

/** A live harness plus the application-owned registry it reads. */
export interface OpenedHarness {
	readonly harness: Harness;
	/**
	 * The durable storage handle the harness was opened over — the same
	 * instance the Session owns and closes on `harness.close()`. Exposed so
	 * the server's conversation listing scans ALL durable conversations
	 * (the harness itself has no enumeration): `scanConversations` reads
	 * committed state directly, so conversations created by other processes
	 * or before a restart list. Callers must not close it — the harness's
	 * close owns that.
	 */
	readonly storage: Storage;
	readonly registry: Registry;
	/** The merged `Models` store generation dispatches through. */
	readonly models: Models;
	/** Boot default model (env/file config wins over contributor defaults). */
	readonly defaultModel: ModelRef;
	/** Provider-merge collisions; the sink `GET /v1/meta`'s `collisions.providers` reads. */
	readonly providerCollisions: readonly ProviderCollision[];
	/**
	 * The extension-contributed webui-bundle registry (build-and-webui
	 * Task 6): the loader's flat collection folded into one entry per NAME
	 * — last-registered-wins on collision, mirroring the provider merge.
	 * `createServer`'s NAME-selector resolution reads it (`serve.ts`
	 * threads it as the third parameter); an empty registry is the
	 * no-contributor deploy.
	 */
	readonly webuiBundles: readonly ContributedWebuiBundle[];
	/**
	 * Webui-bundle NAME collisions (build-and-webui Task 6): the sink
	 * `GET /v1/meta`'s `collisions.webui` reads — the exact mirror of
	 * `providerCollisions` (warned at merge time, never silent).
	 */
	readonly webuiBundleCollisions: readonly WebuiBundleCollision[];
	/**
	 * The workspace `env` builder passed into `HarnessOptions.env` — what
	 * pi-durable invokes per tool call. Exposed because the §5 file and upload
	 * endpoints (Task 9) resolve the conversation env the same way the harness
	 * does; prompt sections instead receive env via `PromptInput.env`.
	 */
	readonly envBuilder: EnvBuilder;
	/**
	 * Extension-load outcomes (spec §3 quarantined-never-aborts): one entry
	 * per configured extension, `"ok"` or `"quarantined"` with the error.
	 * `GET /v1/meta` (Task 9) renders this as `extensions[].status`.
	 */
	readonly extensionOutcomes: readonly ExtensionOutcome[];
	/**
	 * §3 health producers from provider contributors (Task 9e): the meta
	 * route aggregates them into the §5 `health.providers` field — any
	 * `"degraded"` degrades the surface; empty is `"ok"` (the degenerate
	 * env provider reports ok by absence).
	 */
	readonly providerHealth: readonly HealthProducer[];
	/**
	 * Provider id → owning contributor name (Task 6), straight from the
	 * collector's ownership map. Env-degenerate providers have NO entry —
	 * the discriminator `GET /v1/auth/check` uses to pick which readiness
	 * derivation applies per provider.
	 */
	readonly providerOwnership: ReadonlyMap<string, string>;
	/**
	 * Provider id → the owning contributor's readiness tracker (provider
	 * plugins Task 6), straight from the collector's tracker registry.
	 * `GET /v1/auth/check` consults these FIRST — the three-state vocabulary
	 * (`not_configured` | `degraded` | `ready`) — before falling back to
	 * the legacy producer (contributor-owned, tracker-less) and
	 * env-presence (degenerate) mappings.
	 */
	readonly providerReadiness: ReadonlyMap<string, ReadinessTracker>;
	/**
	 * The environment the provider collector resolved (Task 6): the boot env
	 * with the default model restated from config (both env var spellings —
	 * `SIGRUN_DEFAULT_MODEL` and the deprecated `SIGRUN_MODEL` alias, which
	 * the collector also reads). The §5 auth-check route reads
	 * `OPENAI_API_KEY` presence from it for env-degenerate providers — the
	 * hermetic seam that keeps the route off `process.env`.
	 */
	readonly providerEnv: Env;
	/**
	 * The auth store (ruling 6) backing the env-driven degenerate provider's
	 * credential resolution: `<config-dir>/auth.json`, created 0o600 when
	 * written. The §5 auth-check route reads key PRESENCE from it (never
	 * key material).
	 */
	readonly auth: AuthStore;
	/**
	 * The settings store (Task 8a): the file-backed store the `/v1/settings`
	 * endpoints read and PATCH through. Booted here so a malformed settings
	 * file fails loud at boot exactly like a bad `SIGRUN_*` value (the
	 * store's read validates); the harness consumes the LIVE getter-backed
	 * `HarnessSettings` (per-resolution reads — a PATCH lands on the next
	 * submission without a restart).
	 */
	readonly settings: SettingsStore;
	/**
	 * The packages dir (`<config-dir>/packages`) the loader resolved
	 * extension specifiers against — where `syncPackages` installs the
	 * settings file's `packages` declarations. Exposed for the §5 meta
	 * surface and for tests.
	 */
	readonly packagesDir: string;
	/**
	 * The loaded memory extension's §3 producer (Task 9e), when its factory
	 * result carried one; `undefined` for the no-op memory default, a
	 * quarantined memory extension, or a producer-less memory extension —
	 * memory health is then `"ok"` (quarantines already surface via
	 * `extensionOutcomes`; no double-report).
	 */
	readonly memoryHealth: (() => HealthStatus) | undefined;
	/**
	 * The loaded memory extension's factory-result submit pass-through
	 * (Task 26a), identity-matched to the memory-surface owner exactly like
	 * `memoryHealth`. The §5 submissions route submits through it when
	 * present — the memory wiring's submit binds the conversation as the
	 * memory_recall source at the submit boundary (degenerate.js) — and
	 * submits directly when `undefined` (the no-op memory default, a
	 * quarantined memory extension, or a submit-less memory extension).
	 */
	readonly memorySubmit: ExtensionSubmit | undefined;
	/**
	 * Extension name -> seam host (the interaction/ambient handles the
	 * loader handed each factory). Quarantined extensions have no entry;
	 * extensions that took no host context neither. The server's seam
	 * routes read the inventory from here; the /v1/meta route renders the
	 * declared kinds.
	 */
	readonly seamHosts: ReadonlyMap<string, SeamHost>;
	/** The kinds each loaded extension declared, keyed by extension name. */
	readonly seamKinds: ReadonlyMap<string, DeclaredKinds>;
	/**
	 * The memory-seam event bus (Tasks 2-4): opened on the booted harness
	 * BEFORE `resume()` (recovery settles are observed), with each loaded
	 * extension's `runSettled` + lifecycle handlers registered under its
	 * final name, and the host-owned idle sweep running. Delivery is
	 * boot-scheduled: every commit schedules a debounced drain on the next
	 * macrotask. The shutdown path (`src/index.ts`) runs
	 * `eventBus.shutdownSequence()` between `app.close()` and
	 * `harness.close()`; a failed-session teardown closes the bus through
	 * boot's `subscribeClose` wiring. Task 5 stops idle workers before it.
	 */
	readonly eventBus: EventBus;
	/**
	 * The idle-worker projection (memory-seam Task 5) for `GET /v1/meta`:
	 * extension name → per-worker `{name, lastRunAt?, lastError?}` — a live
	 * function (statuses change over the process lifetime), re-derived per
	 * request like the §3 health producers.
	 */
	readonly workerStatuses: () => ReadonlyMap<string, readonly WorkerStatus[]>;
	/**
	 * The activity clock (UI refresh A1): what `touchActivity` stamps
	 * `lastActivityAt` from. Defaults to the real clock; overridable so
	 * tests pin the instant.
	 */
	readonly now: () => Date;
	/**
	 * The auto-namer (UI refresh A2): registered on the bus as the
	 * `sigrun:auto-name` extension, after every loaded extension. Exposed
	 * so tests await `idle()` (production never does — naming is a
	 * background side lane that must never delay a run).
	 */
	readonly autoNamer: AutoNamer;
	/**
	 * The boot refresh (provider plugins Task 4): the in-flight (or done)
	 * deadline-bounded catalog refresh started right after
	 * `collectProviders`. Boot NEVER awaits it — it runs concurrently with
	 * `Harness.open` and listen — and it never rejects (timeout/failure
	 * warned inside). Exposed so tests await completion and shutdown MAY
	 * join it if still in flight.
	 */
	readonly bootRefresh: Promise<void>;
	/**
	 * Stop the interval refresh scheduler (provider plugins Task 5): the
	 * host-owned cadence re-running `models.refresh()` over every dynamic
	 * provider, started at boot when the resolved
	 * `server.providers.refreshIntervalMinutes` (env
	 * `SIGRUN_PROVIDER_REFRESH_MINUTES`, default 15) is greater than zero.
	 * A no-op when the scheduler never started (interval 0). The deploy
	 * shutdown path (`src/serve.ts`) calls this BEFORE `harness.close()`;
	 * the timer is unref()ed either way, so it never holds the process.
	 */
	readonly stopProviderRefresh: () => void;
}

/** Optional `openHarness` inputs beyond the parsed config. */
export interface OpenHarnessOptions {
	/**
	 * PROVIDER contributors (Task 2 seam) — NOT the extension package list.
	 * These feed the Models collector; they are distinct from the deployed
	 * extension *packages* loaded from `config.extensions` by the loader
	 * (Task 5.5), whose own factory-result contributors are collected at
	 * load and concatenated AFTER this seam (options first — a test seam
	 * contributor never gets shadowed by a loaded one). (Renaming this field
	 * to `providerContributors` is a queued cleanup to end the collision with
	 * `config.extensions`.)
	 */
	readonly extensions?: readonly ProviderContributor[];
	/** Environment the provider collector reads; defaults to `process.env`. */
	readonly env?: Env;
	/**
	 * Harness settings (pi-durable `HarnessSettings`). The compaction policy
	 * defaults to `config.compaction` (Task 8's `SIGRUN_COMPACTION_*` tuning);
	 * every field a caller sets here wins over the config value. The four
	 * file-backed fields (steeringMode/followUpMode/retry/stream) resolve per
	 * access — caller-set first, then the settings FILE's live getter (Task 8a):
	 * the file is the deployment default, this seam the test override, and an
	 * unset field here keeps the harness reading the file's CURRENT value (a
	 * PATCH becomes effective on the next admission without a restart).
	 * Pass `settings: {}` (or only `compaction`) to keep the file in charge of
	 * the queue modes while pinning compaction.
	 */
	readonly settings?: HarnessSettings;
	/**
	 * Extension package specifiers to load, overriding `config.extensions` —
	 * the hermetic-test seam for the loader (specifiers resolve to local
	 * fixture packages, not the deploy-time package list).
	 */
	readonly extensionSpecifiers?: readonly string[];
	/**
	 * Pre-resolved extension load entries (the deploy-time boot flow):
	 * `syncPackages`'s output — absolute `file://` entries or specifiers —
	 * consumed verbatim by the loader. Takes precedence over
	 * `extensionSpecifiers`; the sync has already failed loud on sync
	 * errors by the time these exist.
	 */
	readonly extensionEntries?: readonly ResolvedExtensionInput[];
	/**
	 * The settings store's directory (Task 8a), default
	 * `$SIGRUN_CONFIG_DIR`/`~/.config/sigrun` — the hermetic-test seam for
	 * the file-backed settings store (`/v1/settings` round-trips a tmp file).
	 */
	readonly settingsDir?: string;
	/**
	 * The packages dir the loader resolves extension specifiers against
	 * (the settings-file `packages` install root), default
	 * `<settingsDir>/packages`. The hermetic-test seam for packages-dir
	 * resolution (a tmp dir with a fixture package installed).
	 */
	readonly packagesDir?: string;
	/**
	 * The memory-seam event-bus tuning (Task 4's test seam): the resolved
	 * `config.memorySeam` knobs (Task 6's `SIGRUN_*` env / settings-file
	 * chain) are the defaults; a caller-set field here wins over config
	 * (the hermetic-test seam — tests pass small values to exercise the
	 * idle/abandon paths quickly).
	 */
	readonly eventBus?: {
		readonly idleThresholdMs?: number;
		readonly idleSweepMs?: number;
		/**
		 * The worker deadline (memory-seam Task 5), default
		 * `config.memorySeam.workerDeadlineMs`. Tests pass a small value to
		 * exercise the abandon path.
		 */
		readonly workerDeadlineMs?: number;
	};
	/**
	 * The activity clock (UI refresh A1), default `() => new Date()` — the
	 * seam `lastActivityAt` stamps come from, overridable so tests pin time.
	 */
	readonly now?: () => Date;
}

/**
 * Open (or reopen) the durable harness at `config.storagePath`.
 *
 * Storage is Node's built-in `node:sqlite` through pi-durable's adapter —
 * one process owns the file. The provider catalog merges extension
 * contributions plus the env-driven degenerate OpenAI-compat provider into
 * one `Models` store *before* `Harness.open()`, per the spec §3 boot order.
 * Generation against a model no contributor serves fails loud upstream
 * (`no_model`); there is never a silent fallback. Task scheduling is enabled
 * (`resume()` is idempotent and throws only after close). Extension packages
 * (spec §4.1 deploy-time list) load and install BEFORE `Harness.open` per
 * the spec §3 boot order; a failing extension is quarantined (logged +
 * reported in `extensionOutcomes`), never an abort. When no loaded extension
 * provides a `long-term-memory` section, the no-op memory default installs
 * so a bare core still renders the stable placeholder surface. §3 health
 * producers are retained at boot — contributor producers on
 * `providerHealth`, the memory extension's producer on `memoryHealth` — for
 * the §5 meta `health` aggregation (Task 9e), a pure synchronous derivation
 * over this state; the memory extension's factory-result submit pass-through
 * is likewise retained on `memorySubmit` (Task 26a), identity-matched to the
 * memory-surface owner, for the §5 submissions route.
 */
export async function openHarness(
	config: SigrunConfig,
	options: OpenHarnessOptions = {},
): Promise<OpenedHarness> {
	// The boot env, read once through the one seam (tests inject a fake;
	// the deploy passes nothing and gets `process.env`). Two consumers:
	// store-root resolution immediately below, and the provider
	// collector further down (`providerEnv`).
	const env = options.env ?? process.env;
	// Store-root lifecycle (spec §6): every durable root except cache
	// exists before anything touches disk — storage, the registry's
	// first install, extension packages — so a fresh deploy (or a PVC
	// mount missing a subpath) fails HERE, loudly, naming the root it
	// could not create, rather than deep inside sqlite or npm. The cache
	// root is NOT ensured at boot (Review Focus 5: a wiped `emptyDir`
	// must never break boot; cache consumers repair per call through
	// `ensureCacheDir`). The ONE resolved roots object threads on from
	// here: the extension-stores handle (the seam host's `stores`) is
	// built from it below — never re-resolved from env.
	//
	// Task 6: config owns the data/cache/state resolution — it folded the
	// `SIGRUN_*_DIR` envs over the file's `server.*Dir` over the resolver
	// chain ONCE, and `SigrunConfig` carries the result — so boot takes
	// those three from the config (resolution-once; a hand-built config
	// stays authoritative over a stale injected `env`). Only the CONFIG
	// root still resolves here from env: `SIGRUN_CONFIG_DIR` keeps its
	// own meaning (the settings file's own location) and is deliberately
	// not a `SigrunConfig` field. The stores layer stays env-param pure —
	// this is the one place the two worlds meet.
	const roots: StoreRoots = {
		...resolveStoreRoots(env),
		dataDir: config.dataDir,
		cacheDir: config.cacheDir,
		stateDir: config.stateDir,
	};
	await ensureStoreRoots(roots);
	const storage = await openNodeSqliteStorage(config.storagePath);
	const registry = createRegistry();
	// Context-file sections (SOUL.md persona, AGENTS.md instructions), the
	// skills convention, and the core tool surface (plan Task 1: coding
	// tools read/write/edit/bash + search tools find/grep/ls) are all
	// core-owned surfaces (spec §3): every conversation gets them, so they
	// install before `Harness.open` reads the registry — never through the
	// extension loader, never quarantined. install() publishes at once and
	// replaces any same-name extension in place.
	registry.install(contextFilesExtension);
	registry.install(skillsExtension);
	registry.install(codingToolsExtension);
	registry.install(searchToolsExtension);
	// Extension packages load before `Harness.open` reads the registry
	// (spec §3 boot order). Failures quarantine and boot continues. §3
	// factory-result producers are retained alongside the outcomes (Task 9e);
	// factory-result submit pass-throughs likewise (Task 26a).
	// The packages dir: the deployment-installed extension root the
	// loader resolves against FIRST (the settings file's `packages`
	// declarations install here — see src/harness/packages.ts).
	const packagesDir =
		options.packagesDir ?? packagesDirOf(options.settingsDir ?? defaultSettingsDir());
	// The seam host's lazy harness binding: factories run before
	// `Harness.open` (spec §3 boot order), so the host resolves the harness
	// through a promise that boot resolves right after the open. A seam
	// call from a factory body would wait for it (deadlock: factories run
	// synchronously inside loadExtensions) — the honest shape is: factories
	// STASH the host; tool execute/hooks use it later, post-open.
	// One shared deferred: every waiter joins the SAME promise, so the
	// single boot assignment releases them all. A call after the bind
	// resolves immediately (the promise is already settled).
	let release!: (harness: Harness) => void;
	const harnessPromise = new Promise<Harness>((resolve) => {
		release = resolve;
	});
	const bindHarness = (harness: Harness): void => release(harness);
	const harnessOf = (): Promise<Harness> => harnessPromise;
	// The boot-shared store trio (Task 5): one SecretsStore + one
	// ExtensionSettingsStore over the roots resolved at the top of boot;
	// each seam host scopes it to its extension's slug (cheap, no I/O —
	// the cache dir materializes lazily on first `paths.cache` access).
	const sharedStores = sharedExtensionStores(roots);
	const seamHosts = new Map<string, SeamHost>();
	const seamKinds = new Map<string, DeclaredKinds>();
	const {
		outcomes: extensionOutcomes,
		healthProducers: extensionHealth,
		submitBindings: extensionSubmits,
		runSettledBindings,
		lifecycleBindings,
		workerBindings,
		providerContributors,
		webuiBundles: extensionWebuiBundles,
	} = await loadExtensions(
		options.extensionEntries ?? options.extensionSpecifiers ?? config.extensions,
		registry,
		{
			packagesDir,
			hostContextFactory: (extensionName, kinds, priorHost) => {
				// Two-phase, revised for the provisional identity (provider
				// plugins Task 9 P1): the loader's PRE-import call passes the
				// slug derived from the load specifier (a factory-time settings
				// read — sigrun-pareto's `baseUrl` override — resolves the real
				// package's file), and the post-resolution call hands the SAME
				// instance back as `priorHost`. The re-key below therefore always
				// mutates the instance the factory captured — never a second
				// instance (review M2: a rebuilt host would orphan every inbound
				// handler registered on the captured one), even when the declared
				// name differs from the specifier-derived provisional.
				const host =
					(priorHost as SeamHost | undefined) ??
					createSeamHost({ name: extensionName }, kinds, {
						bindHarness,
						harness: harnessOf,
					}, sharedStores);
				host.rekey({ name: extensionName }, kinds);
				// File under the final name only, and only once the load
				// resolved: the PRE-import call must NOT file (its identity is
				// provisional; a quarantined load would leak a placeholder
				// entry), so the maps gain exactly one entry per resolving
				// extension.
				if (priorHost !== undefined) {
					seamHosts.set(extensionName, host);
					seamKinds.set(extensionName, kinds);
				}
				return host;
			},
		},
	);
	// The contributed-bundle registry (build-and-webui Task 6): the loader's
	// flat, slug-attributed collection folded into one entry per NAME.
	// Collision semantics mirror the provider merge EXACTLY —
	// last-registered-wins with a console.warn and a retained record
	// (`webuiBundleCollisions`, the sink `/v1/meta`'s `collisions.webui`
	// reads) — a co-installed replacement bundle is a configuration choice
	// the deployer must be able to SEE, never a silent shadowing.
	const webuiBundleRegistry = new Map<string, ContributedWebuiBundle>();
	const webuiBundleCollisions: WebuiBundleCollision[] = [];
	for (const bundle of extensionWebuiBundles) {
		const previous = webuiBundleRegistry.get(bundle.name);
		if (previous !== undefined) {
			webuiBundleCollisions.push({
				kind: "webui-bundle",
				name: bundle.name,
				previous: previous.extension,
				contributor: bundle.extension,
			});
			console.warn(
					`webui bundle collision: extension "${bundle.extension}" replaces ` +
					`"${previous.extension}" bundle "${bundle.name}" (last-registered-wins)`,
			);
		}
		webuiBundleRegistry.set(bundle.name, bundle);
	}
	const webuiBundles = [...webuiBundleRegistry.values()];
	// The memory-surface owner: the installed extension whose sections
	// include the long-term-memory key. None → the no-op default installs
	// (the zero-extensions guarantee); a quarantined memory extension also
	// leaves the surface to the no-op default.
	const memoryOwner = registry
		.snapshot()
		.sections()
		.find((entry) => entry.section.key === MEMORY_SECTION_KEY)?.extension;
	if (memoryOwner === undefined) {
		registry.install(noopMemoryExtension);
	}
	// Per-model guidance installs LAST (system-prompt Task 3): after
	// `loadExtensions` and the memory section, so its two sections appear
	// and disappear with the matched model as trailing patch rows instead
	// of re-emitting the whole prompt on a mid-conversation model swap.
	registry.install(modelGuidanceExtension);
	// The reserved-core-section assertion (Task 3), walked AFTER
	// `loadExtensions` and the guidance install: any non-core extension
	// owning a reserved key — including one that last-writer-wins REPLACED
	// a core section, which `sections.set` makes the snapshot owner — fails
	// boot loud, naming the extension and the key. Prompt-section shape is
	// core-owned surface (spec §3); a silent takeover is not a valid
	// configuration.
	for (const entry of registry.snapshot().sections()) {
		const expectedOwner = RESERVED_CORE_SECTION_OWNERS[entry.section.key];
		if (expectedOwner !== undefined && entry.extension.name !== expectedOwner) {
			throw new Error(
				`extension "${entry.extension.name}" declares reserved core section "${entry.section.key}"`,
			);
		}
	}
	// §5 memory health (Task 9e): the memory extension's retained §3 producer
	// — identity-matched against the INSTALLED extension, so a same-name
	// reinstall cannot mis-attribute a producer. No match → undefined →
	// "ok" (no-op default, quarantined, or producer-less memory extension).
	const memoryHealth = extensionHealth.find(
		(producer) => producer.extension === memoryOwner,
	)?.health;
	// §5 memory submit (Task 26a): the memory extension's retained submit
	// pass-through — the same identity-matching as memoryHealth. No match →
	// undefined → the server submits directly.
	const memorySubmit = extensionSubmits.find(
		(binding) => binding.extension === memoryOwner,
	)?.submit;
	const sink = createProviderMergeSink();
	// `config.models` is the already-validated default-model resolution
	// (loadConfig refuses to boot without env or file); restating it for
	// the collector under BOTH env spellings keeps a hand-built config
	// authoritative over a stale or absent runtime env var — the collector
	// reads SIGRUN_DEFAULT_MODEL first, then the deprecated SIGRUN_MODEL.
	const effectiveEnv = {
		...env,
		SIGRUN_DEFAULT_MODEL: `${config.models.provider}/${config.models.modelId}`,
		SIGRUN_MODEL: `${config.models.provider}/${config.models.modelId}`,
	};
	// The auth store (ruling 6) — the same config dir the settings store
	// uses. Passed to the collector so the degenerate provider resolves
	// credentials from `auth.json` before the OPENAI_API_KEY fallback.
	const authStore = new AuthStore({ dir: options.settingsDir });
	// The file-backed models store (Task 3): refreshed provider catalogs
	// persist under `<dataDir>/models/` and restore at the next boot's
	// offline init — the data root is ensured above, so the store never
	// mkdirs outside a sanctioned root.
	const modelsStore = fileModelsStore(config.dataDir);
	const {
		models,
		defaultModel,
		healthProducers: providerHealth,
		providerOwnership,
		readinessTrackers: providerReadiness,
	} = collectProviders(
		[...(options.extensions ?? []), ...providerContributors],
		effectiveEnv,
		sink,
		{
			auth: authStore,
			baseUrl: config.defaultProviderBaseUrl,
			modelsStore,
		},
	);
	// The boot refresh (Task 4, spec refresh policy 1): one network-allowed
	// refresh of every dynamic provider, started HERE and never awaited on
	// the boot path — it runs concurrently with `Harness.open` and listen.
	// The deadline bounds a wedged upstream; timeout/failure only warns
	// (never blocks boot). The tracked promise rides on the returned handle.
	const bootRefreshDone = bootRefresh(models, {
		timeoutMs: DEFAULT_REFRESH_TIMEOUT_MS,
	});
	// The interval refresh scheduler (Task 5, refresh policy 2): the cadence
	// keeping the catalogs current after the boot refresh. Started only
	// when the resolved interval is greater than zero (0 = the designed
	// disable, no timer); the timer is unref()ed inside, and `stop()` rides
	// on the returned handle for the deploy shutdown path.
	const stopProviderRefresh =
		config.providers.refreshIntervalMinutes > 0
			? startProviderRefresh(models, {
					intervalMinutes: config.providers.refreshIntervalMinutes,
				}).stop
			: (): void => {};
	// The static workspace service (spec §4.5): every tool call's ExecutionEnv
	// resolves through it, so a future resolver swap changes this wiring's
	// inputs and nothing downstream.
	const workspaceService = createWorkspaceService();
	const workspacePrefs = defaultWorkspacePrefs(config.workspace.path);
	const envBuilder = toHarnessEnv(workspaceService, workspacePrefs);
	// The settings store (Task 8a): file-backed, live. `harnessSettings()` is
	// the getter-backed `HarnessSettings` pi-durable re-resolves per
	// submission — absent = every default. A malformed file throws HERE, at
	// boot, exactly like a bad `SIGRUN_*` value (loadConfig's posture).
	const settingsStore = new SettingsStore({ dir: options.settingsDir });
	const fileSettings = settingsStore.harnessSettings();
	const callerSettings = options.settings;
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			env: envBuilder,
			// Context-management policy (Task 8): config's `SIGRUN_COMPACTION_*`
			// tuning, with any caller-set field winning over it. Upstream merges
			// the result over `DEFAULT_COMPACTION_POLICY` per field. Task 8a: the
			// four file-backed keys resolve PER ACCESS through getters — caller
			// seam first (test override over the file), then the file's LIVE
			// getter. pi-durable re-resolves `settings` at every boundary, so a
			// file PATCH becomes effective on the next admission without a
			// restart. NEVER spread the getters into this object: a spread
			// snapshots the file's boot-time values, silently freezing the
			// queue modes and clobbering the caller seam (the round-1 defects).
			// `extensions`/`toolExecution` have no file backing — plain passthrough.
			settings: {
				get steeringMode() {
					return callerSettings?.steeringMode ?? fileSettings.steeringMode;
				},
				get followUpMode() {
					return callerSettings?.followUpMode ?? fileSettings.followUpMode;
				},
				get retry() {
					return callerSettings?.retry ?? fileSettings.retry;
				},
				get stream() {
					return callerSettings?.stream ?? fileSettings.stream;
				},
				extensions: callerSettings?.extensions,
				toolExecution: callerSettings?.toolExecution,
				compaction: {
					...config.compaction,
					...callerSettings?.compaction,
				},
			},
		},
		BACKGROUND_CONTEXT,
	);
	// The seam hosts' lazy binding resolves here: every seam call issued
	// after boot completes finds the harness immediately; one issued from a
	// post-open async factory path waits on this same promise.
	bindHarness(harness);
	// The memory-seam event bus (Tasks 2-4): subscribe BEFORE `resume()` so
	// recovery settles (faulted/orphaned submissions the scheduler drains)
	// are observed like any other commit. Extension handlers register under
	// their final resolved names — the loader retained the bindings paired
	// with the installed extensions, and registerExtension REPLACES a
	// same-name entry, so the runSettled + lifecycle bindings MERGE here into
	// one object per extension. The idle sweep rides the same open (the bus
	// owns the 1s interval); the bounds come from `config.memorySeam`
	// (Task 6's `SIGRUN_*` knobs), with the caller's eventBus seam winning
	// per-field (the hermetic-test override).
	const memorySeam = config.memorySeam;
	const hookDeadlineMs = memorySeam.hookDeadlineMs;
	const eventBus = EventBus.open(harness, {
		queueMax: memorySeam.queueMax,
		hookDeadlineMs,
		idleThresholdMs: options.eventBus?.idleThresholdMs ?? memorySeam.idleThresholdMs,
		idleSweepMs: options.eventBus?.idleSweepMs ?? IDLE_SWEEP_MS,
		workerDeadlineMs: options.eventBus?.workerDeadlineMs ?? memorySeam.workerDeadlineMs,
	});
	// Activity stamping (UI refresh A1): every settled run stamps its
	// conversation's `lastActivityAt` (the admission-side stamp lives in the
	// submissions route). Registered directly after the bus opens — host-owned
	// machinery, ahead of every extension registration (install order = run
	// order). The bus's close stops delivery; the unsubscribe is unused.
	const now = options.now ?? (() => new Date());
	wireActivity(eventBus, harness, now);
	const handlersByName = new Map<string, ExtensionEventHandlers>();
	for (const binding of runSettledBindings) {
		handlersByName.set(binding.extension.name, {
			...handlersByName.get(binding.extension.name),
			runSettled: binding.runSettled,
		});
	}
	for (const binding of lifecycleBindings) {
		handlersByName.set(binding.extension.name, {
			...handlersByName.get(binding.extension.name),
			...binding.handlers,
		});
	}
	// Task 5: workers merge into the same per-extension registration (the
	// bus owns their timers + wake fan-out from that point).
	for (const binding of workerBindings) {
		handlersByName.set(binding.extension.name, {
			...handlersByName.get(binding.extension.name),
			workers: binding.workers,
		});
	}
	for (const [name, handlers] of handlersByName) {
		eventBus.registerExtension(name, handlers);
	}
	// Auto-naming (UI refresh A2): one background one-shot completion per
	// first-settled answered run writes `SessionMeta.autoName`. Host-owned
	// machinery registered AFTER every extension (install order = run order
	// — naming never delays an extension's observation), never over a user
	// name, never for task-owned conversations, `namingModel: false` opts
	// out, and its failures never touch the run.
	const autoNamer = createAutoNamer({
		harness,
		models,
		readSettings: () => settingsStore.read(),
		defaultModel,
		isTaskOwned: async (id) =>
			(await storage.conversation(id, BACKGROUND_CONTEXT))?.owner !== undefined,
	});
	eventBus.registerExtension("sigrun:auto-name", {
		runSettled: autoNamer.runSettled,
	});
	// Delivery scheduling: the bus itself stays passive (Task 2's
	// contract — `drain()` is the only pump); boot owns when drains run.
	// Every commit (bus events or not) schedules one debounced drain on
	// the next macrotask — unref'd so a bare boot never holds the process
	// open, and a no-op once the queue is found empty. Events enqueued
	// while a drain is already pumping are picked up by that same loop.
	let drainTimer: ReturnType<typeof setTimeout> | undefined;
	harness.subscribeCommits(() => {
		if (drainTimer !== undefined) return;
		drainTimer = setTimeout(() => {
			drainTimer = undefined;
			void eventBus.drain(hookDeadlineMs, BACKGROUND_CONTEXT);
		});
		drainTimer.unref?.();
	});
	// A failed Session closes itself (the upstream contract): the bus's
	// sweep + subscription must not outlive it. shutdownSequence (the
	// ordered path src/index.ts runs) closes the bus first, making this a
	// no-op on the normal path.
	harness.subscribeClose(() => eventBus.close());
	harness.resume();
	return {
		harness,
		storage,
		registry,
		models,
		defaultModel,
		providerCollisions: sink.collisions,
		webuiBundles,
		webuiBundleCollisions,
		envBuilder,
		extensionOutcomes,
		providerHealth,
		providerOwnership,
		providerReadiness,
		providerEnv: effectiveEnv,
		auth: authStore,
		memoryHealth,
		memorySubmit,
		settings: settingsStore,
		packagesDir,
		seamHosts,
		seamKinds,
		eventBus,
		workerStatuses: () => eventBus.workerStatuses(),
		now,
		autoNamer,
		bootRefresh: bootRefreshDone,
		stopProviderRefresh,
	};
}
