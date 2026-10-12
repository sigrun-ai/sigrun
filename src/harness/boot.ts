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
import type { HealthProducer, HealthStatus } from "./health.js";
import { loadExtensions, type ExtensionOutcome, type ExtensionSubmit } from "./loader.js";
import { MEMORY_SECTION_KEY, noopMemoryExtension } from "./memory-default.js";
import { contextFilesExtension } from "./sections/context-files.js";
import { skillsExtension } from "../skills/index.js";
import { codingToolsExtension, searchToolsExtension } from "./tools.js";
import {
	collectProviders,
	createProviderMergeSink,
	type ProviderCollision,
	type ProviderContributor,
} from "./providers/index.js";
import { createRegistry } from "./registry.js";
import { SettingsStore } from "./settings.js";
import {
	createWorkspaceService,
	defaultWorkspacePrefs,
	toHarnessEnv,
	type EnvBuilder,
} from "./workspace.js";

/** A live harness plus the application-owned registry it reads. */
export interface OpenedHarness {
	readonly harness: Harness;
	readonly registry: Registry;
	/** The merged `Models` store generation dispatches through. */
	readonly models: Models;
	/** Boot default model (`SIGRUN_MODEL` wins over contributor defaults). */
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
	 * with `SIGRUN_MODEL` restated from config. The §5 auth-check route reads
	 * `OPENAI_API_KEY` presence from it for env-degenerate providers — the
	 * hermetic seam that keeps the route off `process.env`.
	 */
	readonly providerEnv: Env;
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
	 * The settings store's directory (Task 8a), default
	 * `$SIGRUN_CONFIG_DIR`/`~/.config/sigrun` — the hermetic-test seam for
	 * the file-backed settings store (`/v1/settings` round-trips a tmp file).
	 */
	readonly settingsDir?: string;
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
	const {
		outcomes: extensionOutcomes,
		healthProducers: extensionHealth,
		submitBindings: extensionSubmits,
	} = await loadExtensions(
		options.extensionSpecifiers ?? config.extensions,
		registry,
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
	// `config.models` is the already-validated parse of SIGRUN_MODEL (loadConfig
	// refuses to boot without it); restating it for the collector keeps a
	// hand-built config authoritative over a stale or absent runtime env var.
	const effectiveEnv = {
		...env,
		SIGRUN_MODEL: `${config.models.provider}/${config.models.modelId}`,
	};
	const { models, defaultModel, healthProducers: providerHealth, providerOwnership } =
		collectProviders(options.extensions ?? [], effectiveEnv, sink);
	// The static workspace service (spec §4.5): every tool call's ExecutionEnv
	// resolves through it, so the the-work-fabric-scrubbed swap changes this wiring's inputs and
	// nothing downstream.
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
		memoryHealth,
		memorySubmit,
		settings: settingsStore,
	};
}
