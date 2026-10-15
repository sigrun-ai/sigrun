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
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Env, SigrunConfig } from "../config.js";
import { EventBus, type ExtensionEventHandlers } from "./event-bus.js";
import type { HealthProducer, HealthStatus } from "./health.js";
import { loadExtensions, type ExtensionOutcome, type ExtensionSubmit, type ResolvedExtensionInput } from "./loader.js";
import { AuthStore } from "./auth.js";
import { MEMORY_SECTION_KEY, noopMemoryExtension } from "./memory-default.js";
import {
	createSeamHost,
	type DeclaredKinds,
	type SeamHost,
} from "./seam-host.js";
import { contextFilesExtension } from "./sections/context-files.js";
import { skillsExtension } from "../skills/index.js";
import { codingToolsExtension, searchToolsExtension } from "./tools.js";
import {
	collectProviders,
	createProviderMergeSink,
	type ProviderCollision,
	type ProviderContributor,
} from "./providers/index.js";
import { packagesDirOf } from "./packages.js";
import { createRegistry } from "./registry.js";
import { defaultSettingsDir, SettingsStore } from "./settings.js";
import {
	createWorkspaceService,
	defaultWorkspacePrefs,
	toHarnessEnv,
	type EnvBuilder,
} from "./workspace.js";

/**
 * Memory-seam bus bounds (Task 6 lifts these into `SIGRUN_*` config
 * knobs: `SIGRUN_QUEUE_MAX`, `SIGRUN_HOOK_DEADLINE`,
 * `SIGRUN_IDLE_THRESHOLD`).
 */
const EVENT_QUEUE_MAX = 1_000;
const HOOK_DEADLINE_MS = 30_000;
/**
 * The idle threshold's temporary hardcoded default (spec §2: 10 minutes).
 * Task 6 replaces this with the `SIGRUN_IDLE_THRESHOLD` config knob —
 * thread the config value into `OpenHarnessOptions.eventBus.idleThresholdMs`.
 */
const IDLE_THRESHOLD_MS = 600_000;
/** The idle sweep cadence (spec §2: ONE host-owned 1s interval). */
const IDLE_SWEEP_MS = 1_000;

/** A live harness plus the application-owned registry it reads. */
export interface OpenedHarness {
	readonly harness: Harness;
	readonly registry: Registry;
	/** The merged `Models` store generation dispatches through. */
	readonly models: Models;
	/** Boot default model (env/file config wins over contributor defaults). */
	readonly defaultModel: ModelRef;
	/** Provider-merge collisions; the sink `GET /v1/meta` reads (Task 9). */
	readonly providerCollisions: readonly ProviderCollision[];
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
}

/** Optional `openHarness` inputs beyond the parsed config. */
export interface OpenHarnessOptions {
	/**
	 * PROVIDER contributors (Task 2 seam) — NOT the extension package list.
	 * These feed the Models collector; they are distinct from the deployed
	 * extension *packages* loaded from `config.extensions` by the loader
	 * (Task 5.5). (Renaming this field to `providerContributors` is a queued
	 * cleanup to end the collision with `config.extensions`.)
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
	 * The memory-seam event-bus tuning (Task 4's test seam; Task 6 threads
	 * the config knobs here): `idleThresholdMs` defaults to the hardcoded
	 * 600000ms (`SIGRUN_IDLE_THRESHOLD` arrives in Task 6) and
	 * `idleSweepMs` to the spec's 1s sweep. Passing `idleThresholdMs: 0`
	 * would fire idle on every sweep — tests always pass a real value.
	 */
	readonly eventBus?: {
		readonly idleThresholdMs?: number;
		readonly idleSweepMs?: number;
	};
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
	const seamHosts = new Map<string, SeamHost>();
	const seamKinds = new Map<string, DeclaredKinds>();
	const {
		outcomes: extensionOutcomes,
		healthProducers: extensionHealth,
		submitBindings: extensionSubmits,
		runSettledBindings,
		lifecycleBindings,
	} = await loadExtensions(
		options.extensionEntries ?? options.extensionSpecifiers ?? config.extensions,
		registry,
		{
			packagesDir,
			hostContextFactory: (extensionName, kinds) => {
				// Second call for an already-created host: re-key IN PLACE. The
				// instance the factory captured (stored under "" pre-resolution)
				// must be the final host (review M2) — never a second instance.
				// The first `??` arm (a host already filed under this extension's
				// own name) is reachable only on same-name re-install — an
				// out-of-contract path the registry permits but config should not.
				const host =
					seamHosts.get(extensionName) ??
					seamHosts.get("") ??
					createSeamHost({ name: extensionName }, kinds, {
						bindHarness,
						harness: harnessOf,
					});
				host.rekey({ name: extensionName }, kinds);
				// Both maps key by final name only: drop the "" placeholder
				// entries (asymmetric leftover — seamKinds kept one per load).
				seamHosts.delete("");
				seamKinds.delete("");
				seamHosts.set(extensionName, host);
				seamKinds.set(extensionName, kinds);
				return host;
			},
		},
	);
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
	const env = options.env ?? process.env;
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
	const { models, defaultModel, healthProducers: providerHealth, providerOwnership } =
		collectProviders(options.extensions ?? [], effectiveEnv, sink, {
			auth: authStore,
			baseUrl: config.defaultProviderBaseUrl,
		});
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
	// one object per extension. The idle sweep rides the same open (the
	// bus owns the 1s interval; `idleThresholdMs` is Task 6's config knob,
	// currently the hardcoded IDLE_THRESHOLD_MS).
	const eventBus = EventBus.open(harness, {
		queueMax: EVENT_QUEUE_MAX,
		hookDeadlineMs: HOOK_DEADLINE_MS,
		idleThresholdMs: options.eventBus?.idleThresholdMs ?? IDLE_THRESHOLD_MS,
		idleSweepMs: options.eventBus?.idleSweepMs ?? IDLE_SWEEP_MS,
	});
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
	for (const [name, handlers] of handlersByName) {
		eventBus.registerExtension(name, handlers);
	}
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
			void eventBus.drain(HOOK_DEADLINE_MS, BACKGROUND_CONTEXT);
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
		registry,
		models,
		defaultModel,
		providerCollisions: sink.collisions,
		envBuilder,
		extensionOutcomes,
		providerHealth,
		providerOwnership,
		providerEnv: effectiveEnv,
		auth: authStore,
		memoryHealth,
		memorySubmit,
		settings: settingsStore,
		packagesDir,
		seamHosts,
		seamKinds,
		eventBus,
	};
}
