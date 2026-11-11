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
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	Harness,
	type AgentChange,
	type ConversationStreamOptions,
	type HarnessSettings,
	type ModelRef,
	type Registry,
	type SetTimer,
	type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DECISION_TIMEOUT_ENV, effectiveMethods, parseModelSpec, type Env, type SigrunConfig } from "../config.js";
import { requiresProxyVouch } from "../server/auth/proxy-only.js";
import { wireActivity } from "./activity.js";
import {
	snapshotBeforeDurableUpgrade,
	snapshotBeforeMigration,
	writeDurableVersionMarker,
} from "./migration-snapshot.js";
import type { JobRuntimeDeps } from "../jobs/fire.js";
import { createScheduleTask } from "../jobs/task.js";
import { createJobsService, jobWireOf, type JobsService } from "../jobs/index.js";
import { reconcileJobs } from "../jobs/reconcile.js";
import { markRestartLimitedJob } from "../jobs/restart-limit.js";
import { createDurableReports } from "./reports.js";
import { registerJobObservers } from "../jobs/observe.js";
import { sweepOrphanedRuns } from "../jobs/sweep.js";
import { JobDoc, JobRunDoc, listRevisions } from "../jobs/docs.js";
import type { JobSpec } from "@sigrun/shared/jobs";
import { EventBus, type ExtensionEventHandlers, type WorkerStatus } from "./event-bus.js";
import type { HealthProducer, HealthStatus } from "./health.js";
import {
	loadExtensions,
	type ExtensionChannelBinding,
	type ExtensionCommandBinding,
	type ExtensionGatewayBinding,
	type ExtensionNoticeActionBinding,
	type ExtensionNotifierBinding,
	type ExtensionOutcome,
	type LoginProviderBinding,
	type ExtensionRouteBinding,
	type ExtensionSurfaceBinding,
	type ExtensionSettingsSectionBinding,
	type ResolvedExtensionInput,
} from "./loader.js";
import { createAutoNamer, type AutoNamer } from "./naming.js";
import { AuthStore, DEFAULT_AUTH_KEY } from "./auth.js";
import {
	openIdentityStores,
	ensureSetupCode,
	type IdentityStores,
} from "./identity/index.js";
import { MEMORY_SECTION_KEY, noopMemoryExtension } from "./memory-default.js";
import {
	createSeamHost,
	type DeclaredKinds,
	type SeamHost,
} from "./seam-host.js";
import {
	buildPublishedHookRegistry,
	type PublishedHookRegistry,
} from "./published-hooks.js";
import {
	buildDecisionRegistry,
	type DecisionRegistry,
} from "./decisions.js";
import {
	buildEmbeddingRegistry,
	type EmbeddingRegistry,
} from "./embeddings.js";
import { createLocality, type Locality } from "./locality.js";
import { createEffectiveSettings, type EffectiveSettings } from "../settings/effective.js";
import { coreSchema } from "../settings/core-schema.js";
import {
	migrateLocalModels,
	type LocalityMigrationResult,
} from "../server/locality-migration.js";
import {
	buildDecisionEvaluateTool,
	createDecisionsExtension,
} from "./decision-tool.js";
import type { HostBridge } from "../server/host-bridge.js";
import { contextFilesExtension } from "./sections/context-files.js";
import { createJobStateExtension } from "./sections/job-state.js";
import { modelGuidanceExtension } from "./sections/model-guidance.js";
import { createSkillsExtension, scanFsRoot } from "../skills/index.js";
import { SLASH_COMMANDS } from "../server/commands.js";
import type { CommandExpansion } from "../commands/expand.js";
import { packagePromptRootsOf } from "../commands/templates.js";
import { blocksToolsExtension } from "./blocks/tools.js";
import { createCodingToolsExtension, searchToolsExtension } from "./tools.js";
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
import { EventHub } from "../server/events/hub.js";
import { providerAuthStatus, storeAgentChange } from "../server/helpers.js";
import {
	bootRefresh,
	DEFAULT_REFRESH_TIMEOUT_MS,
	refreshProvider,
} from "./providers/refresh.js";
/**
 * The default per-request stream deadline (curator-eval hardening): the
 * OpenAI SDK waits up to 10 minutes for response HEADERS by default, and
 * a request that never reaches the provider never gets headers — the
 * generation task wedges in phase=request. Five minutes covers long
 * first tokens on slow providers (observed 40-60s on the eval models;
 * reasoning models can run far longer once streaming) because the SDK's
 * timer clears at headers arrival, not stream end.
 */
export const DEFAULT_STREAM_TIMEOUT_MS = 300_000;

/**
 * The boot `stream` getter's merge, factored out for the harness-open
 * test: caller seam over file over the default `timeoutMs`, field-wise.
 * Returns `undefined` when nothing is set (the honest empty shape).
 */
export function mergeStreamSettings(
	caller: ConversationStreamOptions | undefined,
	file: ConversationStreamOptions | undefined,
): ConversationStreamOptions | undefined {
	const merged = {
		...(caller ?? file),
		...(caller === undefined && file?.timeoutMs === undefined
			? { timeoutMs: DEFAULT_STREAM_TIMEOUT_MS }
			: {}),
	};
	return Object.keys(merged).length > 0 ? merged : undefined;
}
import { startProviderRefresh } from "./providers/scheduler.js";
import { fileModelsStore } from "./providers/models-store.js";
import { packagesDirOf, selfPackageRoot } from "./packages.js";
import { resolveHelper } from "../sandbox/helper.js";
import { launchInJail } from "../sandbox/launch.js";
import { buildUserPolicy, defaultModuleTrees } from "../sandbox/policy.js";
import { validateGrantPath } from "../sandbox/grants.js";
import { lookupOsAccount } from "../sandbox/os-account.js";
import { agentEnv } from "./agent-env.js";
import { UserServices } from "./user-services.js";
import { resolveWorkerEntry, sandboxLauncher, WorkerPool } from "../sandbox/pool.js";
import { IsolationState } from "../sandbox/isolation.js";
import { probeOsUsers, type OsUsersAvailability } from "../sandbox/availability.js";
import { createAdmissionGuard } from "./identity/users.js";
import { sweepAccountLinks } from "./identity/link-sweep.js";
import { effectiveOwner as resolveEffectiveOwner } from "./identity/primary-admin.js";
import { SessionMetaDoc } from "../server/session-meta.js";
import { learnedSkillsDir, userRepoSpec } from "../curation/paths.js";
import { SkillStore } from "../curation/store.js";
import { OverlayStore } from "../curation/overlays.js";
import { UsageCounters } from "../curation/usage.js";
import { GitHistory } from "../history/git.js";
import {
	workspaceHistoryFor,
	workspaceRepoSpec,
} from "../history/workspace-history.js";
import { migrateUserCuration } from "../curation/migrate.js";
import { buildCurationRegistry, type CurationRegistry } from "../curation/targets.js";
import { createCurationHost } from "../curation/host.js";
import {
	createCurationToolFeed,
	wrapExtensionCurationTools,
} from "../curation/wrap.js";
import { createCurationGateExtension, CURATION_GATE_EXTENSION } from "../curation/gate.js";
import {
	probeIsolation,
	runHelperProbe,
	selfTestHelper,
	type IsolationAvailability,
} from "../sandbox/availability.js";
import {
	resolveBuiltins,
	type ResolvedBuiltins,
} from "./builtins.js";
import { createRegistry } from "./registry.js";
import {
	isUserEntryName,
	rewriteSelection,
	sweepUserSelections,
	UserToolRegistry,
} from "./user-tools.js";
import { defaultSettingsDir, SettingsStore } from "./settings.js";
import { readManagedKeys } from "../settings/managed.js";
import {
	resolveRefreshMinutes,
	snapshotRestartKeys,
} from "../settings/pending.js";
import {
	ensureStoreRoots,
	resolveStoreRoots,
	sharedExtensionStores,
	userExtensionStores,
	type SharedExtensionStores,
	type StoreRoots,
} from "./stores.js";
import {
	createWorkspaceService,
	defaultWorkspacePrefs,
	toHarnessEnv,
	type EnvBuilder,
	type WorkspaceService,
} from "./workspace.js";

/** The idle sweep cadence (spec §2: ONE host-owned 1s interval). */
const IDLE_SWEEP_MS = 1_000;

/**
 * The prompt-section keys the core surfaces own live in
 * `./reserved-sections.ts` (spec §6.5 R11): the loader reads them for the
 * load-time quarantine — an extension declaring one fails its LOAD,
 * never this boot — and this module re-exports the constant for existing
 * importers.
 */
export { RESERVED_CORE_SECTION_KEYS } from "./reserved-sections.js";

/**
 * Reserved key → the one core extension that may own it. The loader's
 * quarantine already rejects any loaded extension declaring a reserved
 * key, so the post-install walk below (which reads THIS map) is a
 * CORE-ONLY assertion — it can fire only on a core bug (a core extension
 * replaced by or mis-registered under another name).
 */
export const RESERVED_CORE_SECTION_OWNERS: Readonly<Record<string, string>> = {
	identity: "sigrun.context-files",
	persona: "sigrun.context-files",
	"workspace-instructions": "sigrun.context-files",
	skills: "sigrun.skills",
	"tool-guidance": "sigrun.model-guidance",
	"execution-guidance": "sigrun.model-guidance",
	"job-state": "sigrun.job-state",
};

/** A live harness plus the application-owned registry it reads. */
export interface OpenedHarness {
	readonly harness: Harness;
	/** The one boot-time execution-jail availability decision. */
	readonly isolation: IsolationAvailability;
	/** The live isolation mode/latch used by env resolution and /v1/meta. */
	readonly isolationState: IsolationState;
	/** The independent, opt-in OS uid/gid-switch probe result. */
	readonly osUsers: OsUsersAvailability;
	/** The shared per-user workers, stopped before the harness seal. */
	readonly sandboxPool: WorkerPool;
	readonly userServices: UserServices;
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
	/** Per-user tool publications and the loader-declared slug set (M2). */
	readonly userTools: UserToolRegistry;
	/** Selection edits applied during owner writes (shared with server ops). */
	readonly rewriteUserSelection: (
		tx: import("@earendil-works/pi-durable").Tx,
		conversationId: import("@earendil-works/pi-durable").ConversationId,
		from: string | undefined,
		to: string | undefined,
	) => Promise<void>;
	/** The boot sweep's durable conversation count (zero on a no-op boot). */
	readonly userToolSweep: { readonly scanned: number; readonly changed: number };
	/** The merged `Models` store generation dispatches through. */
	readonly models: Models;
	/** Boot default model (env/file config wins over contributor defaults). */
	readonly defaultModel: ModelRef;
	/** The acting user's served default, with a one-warning-per-value fallback. */
	readonly defaultModelFor: (user: string | undefined) => Promise<ModelRef>;
	/**
	 * The union of every loaded extension's validated `interactiveTools`
	 * (ask-user Task 3, spec §6): the tool names core hides in every
	 * non-interactive run — job run conversations (`jobs/fire.ts`),
	 * curator runs (`curation/runs.ts`), and the create-with-job op
	 * (`server/conversation-ops.ts`). An empty set is the
	 * no-interactive-extension deploy (every caller no-ops).
	 */
	readonly interactiveTools: ReadonlySet<string>;
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
	/** Validated external identity providers, qualified as `login:<slug>:<id>`. */
	readonly loginProviders: readonly LoginProviderBinding[];
	/**
	 * The built-in extensions that did not load this boot (Task 2):
	 * `replaced` entries render on `/v1/extensions` as
	 * `{builtin: true, replacedBy}` rows (disabled built-ins are absent
	 * entirely, per ruling 6). The route maps these names to the
	 * resolved slug form (the loader's own sanitization) so the row key
	 * matches what the loaded set would have used.
	 */
	readonly builtinSkipped: ResolvedBuiltins["skipped"];
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
	 * The identity stores (core hardening W1 Task 2): the user
	 * directory (`<configDir>/users.json`), the token digests
	 * (`<configDir>/api-tokens.json`), the invite digests
	 * (`<stateDir>/invites.json`), and the cache root the setup code
	 * lives under — every file 0600 + atomic, mtime-reloaded per access
	 * so the CLI's writes land live. The auth pipeline and routes
	 * (Tasks 3-6) consume exactly this bundle.
	 */
	readonly identity: IdentityStores;
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
	 * The decision registry (warden Task 6): every loaded extension's
	 * validated `decisionProviders` folded into ONE registry —
	 * `evaluate`/`list`/`providers`/`resolvedDefault`/`collisions`,
	 * credentials resolved per call (auth.json over the ambient env),
	 * `evaluate` never throws. The host bridge delegates its
	 * `decisions` surface to it; empty = the no-declarer deploy.
	 */
	readonly decisions: DecisionRegistry;
	/**
	 * The embedding registry: loaded declarations folded into one live
	 * surface; settings and credentials resolve per call.
	 */
	readonly embeddings: EmbeddingRegistry;
	/** The one live locality answer (settings split Plan 2 Task 2). */
	readonly locality: Locality;
	/** The per-user effective settings resolver (settings split Plan 2 Task 4). */
	readonly effective: EffectiveSettings;
	/** The boot migration's result; createServer posts the one notice. */
	readonly localityMigration: LocalityMigrationResult;
	/**
	 * The pending-restart boot snapshot (UI-blocks U4, spec §13.2): every
	 * restart key's stored value at boot, taken once after the settings
	 * load validates and before listen. The `/v1/settings` response's
	 * `pendingRestart` diffs the fresh file against THIS — a reverted
	 * key leaves the pending list without a restart.
	 */
	readonly settingsBootSnapshot: ReadonlyMap<string, string>;
	/** The deployment-managed top-level settings keys, read fresh per call. */
	readonly managedSettings: () => readonly string[];
	/**
	 * Publish one `settings.changed` event (U4 §13.2): the server-side
	 * fan-out seam — the hub publication (/v1/events) and the extension
	 * `onSettingsChanged` fan-out (deadline-bounded, errors logged).
	 * Wired in boot AFTER the hub and bus exist; the late-bound sink list
	 * exists so the settings store's onWrite observer can reference it
	 * before that. Also assignable onto ServerContext by createServer.
	 */
	publishSettingsChanged(
		scope: "server" | { extension: string },
		keys: readonly string[],
		user?: string,
	): void;
	/**
	 * The boot-shared extension store trio (core hardening W3 Task 7,
	 * spec §7.7): the `/v1/extensions` settings/secrets routes ride its
	 * slug-addressed admin surface — the SAME `secrets.json` sections and
	 * `settings/<slug>.json` files every scoped handle reads, so an API
	 * write is visible to the extension with no restart.
	 */
	readonly extensionStores: SharedExtensionStores;
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
	 * Bind the server-provided host bridge (W5 Task 5, spec §9.5/§9.7):
	 * `createServer` calls this once its `ServerContext` exists, setting
	 * the ONE bridge on every seam host — each host's
	 * `conversations`/`users`/`access`/`identity` members then run the
	 * server's shared conversation ops (src/server/conversation-ops.ts —
	 * the same code paths as the HTTP routes). Calls issued before the
	 * binding wait on the host side (the lazy seam discipline), so a
	 * host.conversations call from a factory body never resolves before
	 * the server exists.
	 */
	readonly bindHostBridge: (bridge: HostBridge) => void;
	/**
	 * Declare that a server WILL bind the host bridge (polish A1, spec
	 * §5.2): fans `SeamHost.expectBridge` out to every seam host.
	 * `createServer` calls this SYNCHRONOUSLY on entry (before its first
	 * await), so a rig that starts a server needs no open option and its
	 * pre-bind calls keep waiting; `serve`/`webui/e2e` also pass
	 * `expectHostBridge: true` at open for the same pre-bind window.
	 * Without this expectation a bridge-backed member call rejects
	 * immediately with `HostBridgeUnavailableError`. Idempotent.
	 */
	readonly expectHostBridge: () => void;
	/**
	 * HTTP routes the loaded extensions declared (core hardening W5
	 * Task 2, spec §9.2): one binding per extension whose factory result
	 * carried `routes`, slug-attributed — `createServer` mounts each at
	 * `/v1/ext/<slug>/<path>` (src/server/routes/extension-routes.ts)
	 * and `GET /v1/extensions` inventories the entries. Quarantined
	 * extensions contribute nothing.
	 */
	readonly extensionRoutes: readonly ExtensionRouteBinding[];
	/**
	 * Slash commands the loaded extensions declared (core hardening W5
	 * Task 3, spec §9.3): one binding per extension whose factory result
	 * carried `commands`, slug-attributed — `createServer`'s catalog
	 * build (`buildCommandCatalog`) merges them with the core table for
	 * `GET /v1/commands`, the `/v1/meta` collision record, and the
	 * write-gated invoke route. Quarantined extensions contribute
	 * nothing.
	 */
	readonly extensionCommands: readonly ExtensionCommandBinding[];
	/**
	 * Notifier transports the loaded extensions declared (core hardening
	 * W5 Task 6, spec §9.6): one binding per extension whose factory result
	 * carried `notifiers`, slug-attributed — `createServer`'s notifications
	 * surface (src/server/notifications.ts) turns hub events into
	 * per-recipient `NotificationEvent`s and delivers them to every
	 * collected notifier (best-effort, deadline-bounded). Quarantined
	 * extensions contribute nothing.
	 */
	readonly notifierBindings: readonly ExtensionNotifierBinding[];
	/**
	 * Declared notice-action handlers (notices Task 3): one binding per
	 * extension whose factory result carried `noticeActions` — the notices
	 * service's handler registry and declared-handler post gate.
	 * Quarantined extensions contribute nothing.
	 */
	readonly noticeActionBindings: readonly ExtensionNoticeActionBinding[];
	/**
	 * Channel adapters the loaded extensions declared (gateway C1, spec
	 * §7): one binding per extension whose factory result carried
	 * `channels`, slug-attributed — the gateway engine's start context
	 * reads its flat channel set from these and `GET /v1/extensions`
	 * inventories the ids. Channel ids are unique across every loaded
	 * extension (the loader quarantines the later colliding loader);
	 * quarantined extensions contribute nothing.
	 */
	readonly channelBindings: readonly ExtensionChannelBinding[];
	/**
	 * The loaded gateway engine (gateway C2, spec §8.0): the FIRST
	 * declarer's `{extension, engine}` binding, or `undefined` when no
	 * engine loaded (core ships none). `startGateway` (src/server/gateway.ts)
	 * consumes it; the meta route keys `health.gateway` on its presence;
	 * a later declarer quarantined at load (the one-engine rule).
	 */
	readonly gatewayEngine: ExtensionGatewayBinding | undefined;
	/**
	 * Surfaces the loaded extensions declared (UI-blocks U3 Task 1, spec
	 * §7.1): one binding per extension whose factory result carried
	 * `surfaces`, slug-attributed — Task 2's `SurfaceService` renders
	 * them at `/v1/ext/<slug>/surfaces/…`, and `GET /v1/extensions`
	 * inventories the rows. Quarantined extensions contribute nothing.
	 */
	readonly extensionSurfaces: readonly ExtensionSurfaceBinding[];
	/**
	 * Settings sections the loaded extensions declared (UI-blocks U4
	 * Task 3, spec §13.3), slug-attributed — `createServer` adapts them
	 * to settings-placement surfaces
	 * (`src/server/surfaces/settings-surfaces.ts`) and appends them to
	 * the surface service's bindings. Quarantined extensions contribute
	 * nothing.
	 */
	readonly extensionSettingsSections: readonly ExtensionSettingsSectionBinding[];
	/** Schema-declared settings and generated forms, in load order. */
	readonly extensionSettingsDeclarations: readonly import("./loader.js").ExtensionSettingsDeclaration[];
	/**
	 * Skill directories contributed by loaded packages (core hardening W5
	 * Task 4, spec §9.4): the loader's `skillRoots` collection — one
	 * `{extension, dir}` per contributed dir, in load order. Boot threads
	 * this into the skills section's package-roots option (live: the
	 * section renders per request).
	 */
	readonly skillRoots: readonly { extension: string; dir: string }[];
	/**
	 * The curation-target registry (curator P7): every loaded
	 * extension's `curationTargets` declaration, qualified
	 * (`<slug>:<name>`) and attributed. `isCurationTool` is the A8
	 * wrapping feed (`skill_manage` + every listed target tool); an
	 * empty registry is the no-declarer deploy (core ships none).
	 */
	readonly curation: CurationRegistry;
	/**
	 * The per-user curation wiring (tabs+skills Task 9): boot's lazy,
	 * cached `{store, overlays, usage, history}` per EXISTING user — the
	 * core/skills view's own-root writes go through it (the extension-
	 * facing `curationHost` projection narrows the stores' shapes; the
	 * server needs the full ones). Same `curationOf` the host closes
	 * over, so stores/history are shared, never duplicated.
	 */
	readonly curationOf: (
		user: string | undefined,
	) =>
		| { store: SkillStore; overlays: OverlayStore; usage: UsageCounters; history: GitHistory }
		| undefined;
	/**
	 * The workspace ROOT selection (tabs+skills Task 10's rules 1–4):
	 * the core/skills view's `workspaceRoot(user)` dep — the same
	 * selection the workspace history resolves through.
	 */
	readonly workspaceRootOf: (owner: string | undefined) => string | undefined;
	/**
	 * The per-user WORKSPACE skills history (tabs+skills Task 10): the
	 * second repo — `<workspace>/skills` under git, resolved through the
	 * workspace service's root selection (rules 1–4) and cached per
	 * (user, workspace path). Undefined when the selection refuses
	 * (multi-user without isolation, osUser unavailable, an invalid
	 * stored path) — a settled run then catches up nothing.
	 */
	readonly history: {
		readonly workspace: (user: string) => GitHistory | undefined;
	};
	/**
	 * The curation host (curator P6, A9): the `host.curation` surface —
	 * the run producers (fork review, digest, maintain) and the read
	 * APIs over the per-user stores, the curation registry and the
	 * durable records. ONE object per boot; the host bridge and every
	 * seam host expose the SAME instance.
	 */
	readonly curationHost: import("../extension.js").SigrunCurationHost;
	/**
	 * The published-hook registry's listing (knowledge C7): one row per
	 * OWNED hook name — `{name, provider, shadowed}` — for `/v1/meta`'s
	 * publishedHooks projection. Empty when nothing published (the
	 * no-declarer deploy). Boot-owned; reads the registry built right
	 * after `loadExtensions`.
	 */
	readonly publishedHooks: () => readonly {
		name: string;
		provider: string;
		shadowed: readonly string[];
	}[];
	/**
	 * The command-expansion handle (Task 2c): the skills + template root
	 * sets and the reserved command-name set, all read LIVE. The submit
	 * op (src/server/conversation-ops.ts) and the job prompt actions
	 * (src/jobs/fire.ts) expand `/skill:name` and template inputs through
	 * it at admission; `GET /v1/commands` builds its `kind: "expand"`
	 * entries from the same roots.
	 */
	readonly commandExpansion: CommandExpansion;
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
	 * The host event hub (W3 Task 4, spec §7.4): the single fan-out point
	 * `GET /v1/events` subscribes to. Fed by the event bus's
	 * commit-derived host events (conversations/runs/interactions/ambient)
	 * and the provider refresh paths' readiness diffs
	 * (`providers.changed`).
	 */
	readonly events: EventHub;
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
	 * The jobs service (W4 Task 3, spec §8): the record-family surface
	 * (list/get/runs/revisions, createApi/updateApi/deleteApi, runNow,
	 * reconcile) over the same harness/storage the boot owns. Task 4's
	 * routes consume it; the ownership participant's jobs transfer runs
	 * through it.
	 */
	readonly jobs: JobsService;
	/** The process-local durable report counts and post-open park drain (D5). */
	readonly reports: ReturnType<typeof createDurableReports>;
	/**
	 * The in-process job-run outcome counts (W4 Task 4, §6.9): outcome →
	 * count for `sigrun_job_runs_total{outcome}` — counted from run-record
	 * commits in THIS process (reset on restart, by design; the durable
	 * history lives in the run records). Re-derived live per read.
	 */
	readonly jobRunTotals: () => ReadonlyMap<string, number>;
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
	 * One bounded single-provider refresh (core hardening W3 Task 6,
	 * spec §7.6), boot-wired with the SAME readiness observation as the
	 * boot and interval refreshes (a flipped provider publishes
	 * `providers.changed`). The provider ROUTES call this — `POST
	 * /v1/providers/:id/refresh` and the credential write paths — so a
	 * route-triggered refresh behaves exactly like every other refresh
	 * path. Never rejects; failures warn and the catalog holds its
	 * last-known state.
	 */
	readonly refreshProvider: (providerId: string) => Promise<void>;
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
	/** Hermetic seam replacing the real helper/platform probe; still called once. */
	readonly isolationProbe?: typeof probeIsolation;
	/** Hermetic seam for the optional OS-account capability probe. */
	readonly osUsersProbe?: typeof probeOsUsers;
	/** Test/deployment launcher seam; defaults to the native helper. */
	readonly sandboxLauncher?: import("../sandbox/pool.js").Launcher;
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
	/** The bind host used for effective auth defaults (serve passes its host). */
	readonly listenHost?: string;
	/**
	 * The identity stores injection seam (core hardening W1 Task 3):
	 * when present it WINS over `openIdentityStores(roots)` — tests seed
	 * a claimed directory (the pipeline's unclaimed gate would 403 every
	 * route) without writing under the resolved config root. Boot passes
	 * nothing.
	 */
	readonly identity?: IdentityStores;
	/**
	 * Harness settings (pi-durable `HarnessSettings`). The compaction policy
	 * defaults to `config.compaction` (Task 8's `SIGRUN_COMPACTION_*` tuning,
	 * env over file); `modelOverrides` additionally falls back to the boot
	 * file's map when config carries none (D9). Every field a caller sets
	 * here wins over both. The four file-backed fields
	 * (steeringMode/followUpMode/retry/stream) resolve per access —
	 * caller-set first, then the settings FILE's live getter (Task 8a): the
	 * file is the deployment default, this seam the test override, and an
	 * unset field here keeps the harness reading the file's CURRENT value (a
	 * PATCH becomes effective on the next admission without a restart).
	 * Pass `settings: {}` (or only `compaction`) to keep the file in charge of
	 * the queue modes while pinning compaction.
	 */
	readonly settings?: HarnessSettings;
	/**
	 * Built-in extensions: codemode, MCP, tool search and OAuth load by
	 * default from core's own node_modules, BEFORE the
	 * configured list, governed by the settings file's
	 * `builtinExtensions` toggles. `false` skips them entirely — the
	 * hermetic-test seam for suites asserting exact extension outcomes
	 * over fixture-only loads (and the pre-Task-2 boot shape).
	 */
	readonly builtins?: boolean;
	/**
	 * Test-only additional built-in load specifiers (fixtures), resolved
	 * like the real built-ins through core's own tree and reported
	 * `builtin: true` — the quarantine path's exerciser without breaking
	 * the shipped packages.
	 */
	readonly extraBuiltins?: readonly string[];
	/** Test-only core built-in resolver override (unresolvable-package quarantine). */
	readonly builtinResolver?: (
		specifier: string,
		fallback: (specifier: string) => ResolvedExtensionInput,
	) => ResolvedExtensionInput;
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
		 * The queue bound (durable run-settled tests override to exercise
		 * overflow). Default `config.memorySeam.queueMax`.
		 */
		readonly queueMax?: number;
		/**
		 * The hook deadline (durable run-settled tests override to exercise
		 * blocking handlers). Default `config.memorySeam.hookDeadlineMs`.
		 */
		readonly hookDeadlineMs?: number;
		/**
		 * The worker deadline (memory-seam Task 5), default
		 * `config.memorySeam.workerDeadlineMs`. Tests pass a small value to
		 * exercise the abandon path.
		 */
		readonly workerDeadlineMs?: number;
		/**
		 * The shutdown live-run settle wait (gateway §8.13 / engine Task 12),
		 * default 10 s. The admin-restart durability test pins a small value:
		 * its restart flush budget is macro-task scale, while the default
		 * wait deliberately outlastes real streaming runs.
		 */
		readonly shutdownSettleWaitMs?: number;
	};
	/**
	 * The activity clock (UI refresh A1), default `() => new Date()` — the
	 * seam `lastActivityAt` stamps come from, overridable so tests pin time.
	 * Jobs Task 2: the SAME seam feeds `HarnessOptions.now` (the harness
	 * clock `runtime.sleepUntil`/`runtime.now()` read), so a test that pins
	 * `now` pins BOTH the activity stamps and the schedule task's durable
	 * waits (the jobs tests step the clock instead of waiting 60s).
	 */
	readonly now?: () => Date;
	/**
	 * The harness timer seam (pi-durable 1.4.0 `HarnessOptions.setTimer`),
	 * passed straight to `Harness.open`. A sleeping task wakes from ONE
	 * foreground timer armed for `until - now`, so a fake `now` alone
	 * cannot wake it — the jobs tests inject `createFakeClock`'s `setTimer`
	 * next to `now`. Production leaves this unset (pi-durable's
	 * `nativeTimer`).
	 */
	readonly setTimer?: SetTimer;
	/**
	 * Observe pi-durable failure reports (D5). Composed with the boot's own
	 * logging/counting; observer failures are contained.
	 */
	readonly onReport?: (report: import("@earendil-works/pi-durable").Report) => void;
	/**
	 * A server WILL bind the host bridge in this process (polish A1, spec
	 * §5.2), default `false`. While `false`, a bridge-backed `host.*`
	 * member call on an unbound seam host rejects immediately with
	 * `HostBridgeUnavailableError` (the in-process-rig/serverless-embed
	 * fail-fast). While `true`, pre-bind calls keep the bounded 60s wait
	 * for the bind. `createServer` sets the same expectation synchronously
	 * on entry, so rigs that start a server need NOT pass this — only
	 * `serve`/`webui/e2e` (which bind shortly after open) do.
	 */
	readonly expectHostBridge?: boolean;
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
 * over this state.
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
	const coreRoot = selfPackageRoot();
	const isolation = await (options.isolationProbe ?? probeIsolation)({
		platform: process.platform,
		helper: coreRoot === undefined ? undefined : resolveHelper(env, coreRoot),
		runProbe: runHelperProbe,
		selfTest: selfTestHelper,
	});
	console.log(
		`sandbox isolation: ${isolation.available ? `available (Landlock ABI ${isolation.abi})` : `unavailable (${isolation.reason ?? "unknown reason"})`}`,
	);
	if (coreRoot === undefined) throw new Error("sandbox worker entry requires the sigrun package root");
	const workerEntry = resolveWorkerEntry(coreRoot);
	const helper = isolation.helper;
	const osUsers: OsUsersAvailability = !config.isolation.osUsers
		? { available: false, status: "off" }
		: options.osUsersProbe !== undefined
			? await options.osUsersProbe(helper ?? "")
			: helper === undefined || !isolation.available
				? { available: false, status: "osUsers requires CAP_SETUID" }
				: await probeOsUsers(helper);
	const sandboxPool = new WorkerPool({
		launcher: options.sandboxLauncher ?? ((policy) => {
			if (helper === undefined) throw new Error("sandbox helper not found");
			return sandboxLauncher(helper, workerEntry)(policy);
		}),
		idleMinutes: () => settingsStore?.read().server?.isolation?.workerIdleMinutes ?? config.isolation.workerIdleMinutes,
		log: (line) => console.warn(line),
		workerEntry,
	});
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
	// The identity stores (W1 Task 2) ride the same resolved roots: no
	// I/O here (each file materializes on its first write), so this is
	// pure construction over paths boot already owns.
	const identity = options.identity ?? openIdentityStores(roots);
	// The account-link sweep (username-derivation Task 8): once at boot,
	// before serving — dangling links are removed, proxy-source crash
	// orphans are logged with their repair command (never auto-repaired:
	// the original proxy username is not derivable from the key).
	// BEST-EFFORT posture: a sweep failure (e.g. a corrupt accounts.json)
	// must not crash-loop a serving deployment; the stores' own readers
	// still fail loud on the request paths if the file is truly corrupt.
	try {
		const linkSweep = await sweepAccountLinks(
			identity.users,
			identity.accounts,
		);
		if (linkSweep.removedDangling > 0) {
			console.log(
				`identity: removed ${linkSweep.removedDangling} dangling account link(s)`,
			);
		}
		for (const orphan of linkSweep.orphans) {
			console.log(
				`identity: proxy user "${orphan}" has no proxy link; repair with: sigrun user link ${orphan} --proxy <username>`,
			);
		}
	} catch (error) {
		console.warn(
			`identity: account-link sweep failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	// The caller-supplied host wins (serving spec §1: `serve()` resolves
	// the ONE effective host — options.host → SIGRUN_LISTEN_HOST →
	// DEFAULT_LISTEN_HOST — and passes it here). The env read below is
	// NOT a second source on the serve path (the option is always set
	// there); it remains for direct `openHarness` callers that never
	// bind a listener (tests) and must derive the same auth posture.
	const listenHost = options.listenHost ?? env.SIGRUN_LISTEN_HOST ?? "0.0.0.0";
	const methods = effectiveMethods(config.auth, listenHost);
	const isolationState = new IsolationState({
		mode: config.isolation.mode,
		availability: isolation,
		userCount: () => identity.users.list().length,
		log: (line) => console.warn(line),
	});
	// These refusals happen during openHarness, before createServer/listen.
	if (identity.users.list().length >= 2 && methods.length === 0) {
		throw new Error(
			"multi-user requires authentication: configure SIGRUN_AUTH=token or SIGRUN_AUTH=proxy, or remove users until only one remains",
		);
	}
	if (
		(isolationState.active() || config.isolation.mode === "always") &&
		methods.includes("proxy") &&
		config.auth.proxy.secretHeader === undefined
	) {
		throw new Error(
			"isolation with proxy authentication requires server.auth.proxy.secretHeader; configure a shared-secret header or disable isolation",
		);
	}
	// The half-configured shared secret: a secretHeader with no secret makes
	// the pipeline skip the secret check, so any peer in trustedProxies could
	// vouch for any user from the identity headers alone — while the guard
	// above (and the admission guard) read the header as "secured". Refuse
	// to serve instead of running open. Enforced here (server boot), not in
	// loadConfig, so CLI subcommands run from a shell without the server's
	// env still work.
	if (
		methods.includes("proxy") &&
		config.auth.proxy.secretHeader !== undefined &&
		config.auth.proxy.secret === undefined
	) {
		throw new Error(
			"server.auth.proxy.secretHeader is set but SIGRUN_PROXY_SECRET is empty — " +
				"without the shared secret any peer in trustedProxies could vouch for any user; " +
				"set SIGRUN_PROXY_SECRET or remove secretHeader",
		);
	}
	identity.users.configureAdmission({
		firstWorkspace: config.workspace.path,
		admit: createAdmissionGuard({
			isolation,
			mode: config.isolation.mode,
			methods,
			proxySecretHeader: config.auth.proxy.secretHeader,
		}),
	});
	isolationState.active();
	// The unclaimed onboarding posture (W1 Task 4, spec §5.8): every
	// unclaimed boot (re)ensures the setup code under the pod-local cache
	// root and logs it ONCE — the retrieval flow is `kubectl logs … | grep
	// "setup code"` or `kubectl exec … cat <cacheDir>/setup-code` (the file
	// is 0600 + atomic, and the cache root is never a backup section).
	// `SIGRUN_SETUP_CODE` pins the value instead (the k8s Secret shape).
	// Claimed boots (every identity-seeded test, every post-onboarding
	// deploy) write nothing. A proxy-only non-loopback boot writes and
	// logs NOTHING either (C2): account creation there is vouch-only, so
	// a setup code would be an unvouched account-creation path.
	if (!identity.users.isClaimed() && !requiresProxyVouch(methods, listenHost)) {
		// `identity.cacheDir`, not `roots.cacheDir`: the claim route reads
		// `readSetupCode(identity.cacheDir)`, and an injected identity
		// bundle (the test seam) may root elsewhere than the resolved
		// roots — write where the reader reads.
		const code = await ensureSetupCode(identity.cacheDir, env);
		console.log(`sigrun setup code: ${code}`);
	}
	const managedPaths = {
		roots,
		storagePath: config.storagePath,
		coreRoot,
		userAreas: (user: string) => join(roots.dataDir, "users", user),
	};
	// Curation seal revalidation (tabs/skills Task 8): stored workspace or
	// grant paths that fail TODAY's validator (e.g. a pre-seal record whose
	// workspace is the bare user area, which contains curation/) are
	// refused per use by buildUserPolicy, silently stripping the agent's
	// tools. Boot names every such record loudly with its repair (Task 14
	// documents PATCH /v1/users/<u> {"workspace": "<userArea>/workspace"}).
	for (const record of identity.users.list()) {
		if (record.workspace !== undefined) {
			const result = validateGrantPath(record.workspace, {
				managed: managedPaths,
				user: record.user,
			});
			if (!result.ok) {
				console.warn(
					`identity: user "${record.user}" workspace ${record.workspace}: ${result.reason} (agent tools unavailable until repaired; re-point to ${managedPaths.userAreas(record.user)}/workspace)`,
				);
			}
		}
		for (const grant of record.grants ?? []) {
			const result = validateGrantPath(grant.path, {
				managed: managedPaths,
				user: record.user,
				...(grant.inheritedFrom === undefined
					? {}
					: { inheritedFrom: grant.inheritedFrom }),
			});
			if (!result.ok) {
				console.warn(
					`identity: user "${record.user}" grant ${grant.path}: ${result.reason} (grant refused until repaired)`,
				);
			}
		}
	}
	const userServices = new UserServices({
		launch: (policy, command, args, serviceEnv) => {
			if (helper === undefined) throw new Error("sandbox helper not found");
			return launchInJail(helper, policy, command, args, serviceEnv);
		},
		policyFor: (user) => {
			const record = identity.users.get(user);
			if (record === undefined) return { reason: `unknown user "${user}"` };
			let osAccount: ReturnType<typeof lookupOsAccount>;
			if (record.osUser !== undefined) {
				if (!osUsers.available) return { reason: "osUser requires CAP_SETUID" };
				try { osAccount = lookupOsAccount(record.osUser); } catch { return { reason: `OS account not found: ${record.osUser}` }; }
				if (osAccount === undefined) return { reason: `OS account not found: ${record.osUser}` };
			}
			const built = buildUserPolicy(record, {
				managed: managedPaths,
				nodeBinDir: process.execPath,
				moduleTrees: defaultModuleTrees(coreRoot),
				...(osAccount === undefined ? {} : { osAccount }),
			});
			if (!built.ok) return { reason: built.reason };
			if (!isolationState.active()) {
				const serviceEnv = agentEnv(env);
				delete serviceEnv.SSH_AUTH_SOCK;
				serviceEnv.HOME = built.policy.home;
				serviceEnv.TMPDIR = built.policy.tmp;
				serviceEnv.USER = user;
				return { ...built.policy, env: serviceEnv };
			}
			return built.policy;
		},
		isolationActive: () => isolationState.active(),
		now: () => Date.now(),
		managed: managedPaths,
	});
	const storage = await (async () => {
		// D4: preserve the last schema the previous release can read BEFORE
		// openNodeSqliteStorage applies its one-way durable migration. The
		// injected clock keeps snapshots deterministic in tests; a needed
		// snapshot failure aborts boot here, before any migration write.
		const schemaSnapshot = await snapshotBeforeMigration(config.storagePath, {
			env,
			now: options.now ?? (() => new Date()),
			log: (line) => console.log(line),
		});
		// D4 (1.5.0 upgrade): a store last written by an older pi-durable
		// minor gets its own snapshot — skipped when the schema guard above
		// already wrote one this boot. The version marker is written only
		// AFTER a successful open, so it never claims a version the store
		// has not actually been opened by.
		if (schemaSnapshot === undefined) {
			await snapshotBeforeDurableUpgrade(config.storagePath, {
				env,
				now: options.now ?? (() => new Date()),
				log: (line) => console.log(line),
			});
		}
		const opened = await openNodeSqliteStorage(config.storagePath);
		try {
			await writeDurableVersionMarker(config.storagePath);
		} catch (error) {
			// A failed stamp must not leak the open storage handle.
			await opened.close(BACKGROUND_CONTEXT).catch(() => {});
			throw error;
		}
		return opened;
	})();
	const registry = createRegistry();
	// Late-filled by the loader: factories publish through the same registry
	// instance, and selection rewrites read the declared set LIVE.
	const perUserSlugs: string[] = [];
	const userTools = new UserToolRegistry(registry, () => perUserSlugs);
	// The skills convention's package roots (W5 Task 4, spec §9.4): a LATE
	// array — the extension packages that contribute skill dirs load BELOW
	// (after this install), and the section renders per REQUEST, so the
	// closure below observes whatever the loader collected without the
	// install order changing (core sections lead the prompt).
	const collectedSkillRoots: { extension: string; dir: string }[] = [];
	// The template roots (Task 2c): the SAME late-fill shape as the skill
	// roots — the loader runs below, and both the `/v1/commands` route and
	// each expansion read the collections LIVE, so the late fill is
	// visible from the next read on.
	const collectedTemplateRoots: { extension: string; dir: string }[] = [];
	// The settings store the live cap reads. Declared further down (the
	// file-backed store needs `options.settingsDir` only); the closure
	// reads it at RENDER time, long after the assignment — the skills cap
	// is a live setting (`skills.sectionMaxBytes`, default 4KB).
	let skillsSettings: { read(): { skills?: { sectionMaxBytes?: number } } } | undefined;
	// The job-state section resolves its services only when a job run renders;
	// both are constructed after the core registry installs.
	let workspaceService: WorkspaceService | undefined;
	let jobs: JobsService | undefined;
	// Context-file sections (SOUL.md persona, AGENTS.md instructions), the
	// skills convention, and the core tool surface (plan Task 1: coding
	// tools read/write/edit/bash + search tools find/grep/ls) are all
	// core-owned surfaces (spec §3): every conversation gets them, so they
	// install before `Harness.open` reads the registry — never through the
	// extension loader, never quarantined. install() publishes at once and
	// replaces any same-name extension in place. The skills extension is
	// BUILT here (W5 Task 4): three discovery roots — workspace (env), the
	// user dir `<configDir>/skills/`, and the package roots the loader
	// collects — with workspace > user > packages precedence and the live
	// per-render cap.
	// The skills options the EXPANSION paths share (Task 2c): the same
	// three-root shape the section renders with — `/skill:name` and the
	// `/` menu must see the same skills the section does (plus the hidden
	// ones, which `listSkills` includes by design).
	const skillsOptions = {
		userDir: join(roots.configDir, "skills"),
		// Curator A9 (P6): the canonical workspace ROOT for overlay keys —
		// the configured default workspace (a conversation with a
		// sub-cwd still matches the root-keyed overlay; the accessor
		// stays live for the config's sake).
		workspaceRoot: (): string => config.workspace.path,
		// Curator A3 (P2): the conversation owner's learned root —
		// `<dataDir>/users/<owner>/skills`, undefined for ownerless
		// conversations. Discovery resolves the owner per render.
		learnedRoot: (owner: string | undefined): string | undefined =>
			owner === undefined
				? undefined
				: learnedSkillsDir(managedPaths.userAreas(owner)),
		packageRoots: (): readonly { extension: string; dir: string }[] =>
			collectedSkillRoots,
		sectionMaxBytes: (): number =>
			skillsSettings?.read().skills?.sectionMaxBytes ?? 4096,
	};
	// Curator A6 (P3/P4): the per-user curation wiring — one skill store,
	// one overlay store and one usage counter set per EXISTING user,
	// created lazily on first use and cached. `userExists` is the LIVE
	// directory read (a removed user's factories stop resolving), and
	// `nameTakenElsewhere` scans the host-side roots the harness owns
	// (the user dir and the collected package roots; a conversation's
	// workspace can only be checked through its env, which the store
	// cannot see — the create-refusal there is the A4 store's own).
	const skillStores = new Map<string, SkillStore>();
	const overlayStores = new Map<string, OverlayStore>();
	const usageCounters = new Map<string, UsageCounters>();
	const curationHistories = new Map<string, GitHistory>();
	// Per-user migration promise (review I3): store/overlay mutations
	// await it via their `ready` seam, so a write during a pending
	// migration lands as its OWN commit after the import — never
	// swallowed by the migration's discard.
	const migrations = new Map<string, Promise<void>>();
	const gitHomeDir = join(roots.stateDir, "git-home");
	const curationOf = (user: string | undefined) => {
		if (user === undefined) return undefined;
		// Curator A10: cache-FIRST resolution — a store set captured before
		// a user's deletion stays resolvable, so its own `userExists` gate
		// fails every later op with "user removed" (the A4/A5 fail-closed
		// property: an in-flight run's late write never recreates the
		// roots). A never-seen user still needs the live directory read.
		if (
			skillStores.get(user) === undefined &&
			identity.users.get(user) === undefined
		) {
			return undefined;
		}
		const userArea = managedPaths.userAreas(user);
		let history = curationHistories.get(user);
		if (history === undefined) {
			history = new GitHistory(userRepoSpec(userArea), {
				gitHome: gitHomeDir,
				now: () => clockNow(),
				log: (line) => console.warn(`curation history (${user}): ${line}`),
			});
			curationHistories.set(user, history);
		}
		// Migration (tabs+skills Task 9): the boot sweep below covers the
		// directory users boot saw; a user created AFTER boot migrates on
		// this first construction. Never-in-a-render: curationOf is the
		// store factory, not a render path.
		if (!migrations.has(user)) {
			// Once per process: the settled promise STAYS in the map. The
			// "nothing" branch writes the marker itself (review C1), so the
			// on-disk state guards restarts; the in-process map guards
			// within one boot. Only a FAILURE re-arms (the next curationOf
			// retries).
			const migration = migrateUserCuration(userArea, history).then(
				() => undefined,
				(error) => {
					console.warn(`curation migration (${user}) failed: ${String(error)}`);
					migrations.delete(user);
				},
			);
			migrations.set(user, migration);
		}
		const ready = async (): Promise<void> => {
			await migrations.get(user);
		};
		let store = skillStores.get(user);
		if (store === undefined) {
			store = new SkillStore({
				userArea,
				user,
				now: () => clockNow(),
				nameTakenElsewhere: async (name: string): Promise<string | undefined> => {
					for (const skill of scanFsRoot(join(roots.configDir, "skills"), "user dir")) {
						if (skill.name === name) return "user dir";
					}
					for (const root of collectedSkillRoots) {
						if (scanFsRoot(root.dir, "package").some((skill) => skill.name === name)) return root.extension;
					}
					return undefined;
				},
				userExists: () => identity.users.get(user) !== undefined,
				history,
				ready,
			});
			skillStores.set(user, store);
		}
		let overlays = overlayStores.get(user);
		if (overlays === undefined) {
			overlays = new OverlayStore({
				userArea,
				user,
				userExists: () => identity.users.get(user) !== undefined,
				history,
				ready,
			});
			overlayStores.set(user, overlays);
		}
		let usage = usageCounters.get(user);
		if (usage === undefined) {
			usage = new UsageCounters({
				userArea,
				user,
				now: () => clockNow(),
				// The A4 gate, but silent: the cached counters outlive the user
				// (cache-first resolution), and telemetry is void-and-forget —
				// a removed user's flush drops instead of recreating the
				// deleted curation directory (deletion's fail-closed claim).
				userExists: () => identity.users.get(user) !== undefined,
			});
			usageCounters.set(user, usage);
		}
		return { store, overlays, usage, history };
	};
	// Workspace skills history (tabs+skills Task 10): the SECOND repo per
	// user — `<workspace>/skills` under git, caught up on settle. Cached
	// per (user, workspace path): a changed path is a new instance on the
	// same gitDir, so one log follows the user across workspace moves.
	const workspaceHistories = new Map<string, GitHistory>();
	const workspaceHistoryOf = (user: string): GitHistory | undefined => {
		const workspace = workspaceService?.workspaceRoot(user);
		return workspaceHistoryFor(user, workspace, {
			cache: workspaceHistories,
			create: (resolved) => {
				const history = new GitHistory(workspaceRepoSpec(managedPaths.userAreas(user), resolved), {
					gitHome: gitHomeDir,
					now: () => clockNow(),
					log: (line) => console.warn(`workspace history (${user}): ${line}`),
				});
				// Task 12 race fix: settle the repo AT CONSTRUCTION, not on
				// first use. Two concurrent first-uses (the view's catch-up +
				// a write) each run prepare()'s init before either's commit:
				// the later init lands between the earlier init and ITS
				// commit — status reads an empty index, and the write lands
				// with no commit. An eager empty catchUp (no-op on an
				// existing repo, the import commit on a fresh one) makes
				// every later use see a settled repo. Awaited BEFORE the
				// instance returns so no first use can interleave with the
				// init. Fail-soft like everything here: errors warn, never
				// throw.
				void (async () => {
					try {
						// settle(), never a catch-up: an init that COMMITTED
						// would absorb a racing first edit under the init
						// summary (the 2026-11-03 core/skills failure).
						await history.settle();
					} catch (error) {
						console.warn(`workspace history (${user}) init failed: ${String(error)}`);
					}
				})();
				return history;
			},
		});
	};
	// Curation history migration (tabs+skills Task 9): every directory
	// user boot sees imports once. Users created after boot migrate on
	// their first curationOf (the migratedUsers seam above).
	for (const record of identity.users.list()) {
		curationOf(record.user);
	}
	const curationSkillsOptions = {
		...skillsOptions,
		skillStore: (user: string | undefined) => curationOf(user)?.store,
		overlays: (owner: string | undefined) => curationOf(owner)?.overlays,
		usage: (owner: string | undefined) => curationOf(owner)?.usage,
	};
	// Curator A6 (P4): the read tool counts learned-root reads through the
	// same per-user wiring (load_skill and /skill: count through the
	// skills options above).
	const codingWithUsage = createCodingToolsExtension({
		countersOf: (owner: string | undefined) => curationOf(owner)?.usage,
		learnedRootOf: (owner: string | undefined) =>
			owner === undefined
				? undefined
				: learnedSkillsDir(managedPaths.userAreas(owner)),
	});
	const templateOptions = {
		userDir: join(roots.configDir, "prompts"),
		packageRoots: (): readonly { extension: string; dir: string }[] =>
			collectedTemplateRoots,
	};
	// The command-expansion handle (Task 2c): everything `expandInput`
	// needs — the two root sets plus the reserved command-name set (core
	// table + every extension command; a template colliding with any of
	// these never expands). Read LIVE per expansion.
	const commandExpansion: CommandExpansion = {
		skills: skillsOptions,
		templates: templateOptions,
		commandNames: (): ReadonlySet<string> => {
			const names = new Set<string>(SLASH_COMMANDS.keys());
			for (const binding of commandBindings) {
				for (const contribution of binding.commands) {
					names.add(contribution.name);
				}
			}
			return names;
		},
	};
	registry.install(contextFilesExtension);
	// Escalations A2: the core-owned job-state prompt section names the run's
	// state folder (WorkspaceService.jobsRoot, A1); deps late-bind like
	// skillsSettings — services are created further down.
	registry.install(
		createJobStateExtension({
			jobsRoot: (owner) => workspaceService?.jobsRoot(owner),
			job: async (id) => await jobs?.get(id),
		}),
	);
	// Curator A8 (P9): the wrap feed — the mutable set of curation tool
	// names, seeded with the core set and grown by the loader as each
	// extension's curationTargets validate. The skills extension's
	// install below wraps through it (its OWN tools: `skill_manage`);
	// the loader wraps every extension-declared target tool at its
	// install. `isCurationTool` on the built registry (A7) stays the
	// read-side API — the feed is only the write-side wrap oracle.
	const curationFeed = createCurationToolFeed();
	// Curator A6: the skills extension carries the curation wiring
	// (skill_manage + usage counting), and the coding tools count
	// learned-root reads — the same extension NAMES as before, so
	// nothing downstream observes the swap. A8: the install WRAPS the
	// curation tools (skill_manage's registration carries the hint
	// interception; load_skill and the section are untouched).
	registry.install(
		wrapExtensionCurationTools(
			createSkillsExtension(curationSkillsOptions),
			curationFeed,
		),
	);
	registry.install(codingWithUsage);
	registry.install(searchToolsExtension);
	// The chat-blocks tools (UI-blocks U5 Task 1, spec §8.1): every agent
	// can show and update interactive block surfaces in chat — the same
	// core-owned slot as the coding/search tools, never quarantined.
	registry.install(blocksToolsExtension);
	// The decision tool (warden Task 7): installed HERE with an empty
	// tool list — the placeholder holding the core `sigrun.decisions`
	// name — because the decision declarations are only known AFTER the
	// loader runs. Once the registry is built (below), boot RE-INSTALLS
	// the extension with `decision_evaluate` when the registry lists ≥ 1
	// decision model (`registry.install` replaces a same-name extension
	// in place); a no-provider boot keeps the placeholder and the tool
	// is never offered.
	registry.install(createDecisionsExtension());
	// Extension packages load before `Harness.open` reads the registry
	// (spec §3 boot order). Failures quarantine and boot continues. §3
	// factory-result producers are retained alongside the outcomes (Task 9e).
	// The packages dir: the deployment-installed extension root the
	// loader resolves against FIRST (the settings file's `packages`
	// declarations install here — see src/harness/packages.ts).
	const packagesDir =
		options.packagesDir ?? packagesDirOf(options.settingsDir ?? defaultSettingsDir());
	// Built-in extensions ship with core. Resolution needs the settings FILE (the
	// `builtinExtensions` toggles live there), so the store is constructed
	// HERE — before the loader — and the one instance threads on to the
	// rest of boot (its `harnessSettings()` call below stays the single
	// construction). The onWrite observer (U4 §13.2) fires `settingsStore`
	// writes' change events through a boot-owned sink assigned below (the
	// hub does not exist yet here — a late-bound closure keeps the store
	// constructor pure while every committed write still publishes).
	const settingsChangedSinks: Array<(scope: "server" | { extension: string }, keys: readonly string[]) => void> = [];
	const settingsStore = new SettingsStore({
		dir: options.settingsDir,
		onWrite: (keys) => {
			for (const sink of settingsChangedSinks) sink("server", keys);
		},
	});
	// Eager validation (the fail-loud boot posture, matching the
	// `harnessSettings()` contract below): a malformed settings file
	// throws HERE even when the caller seam overrides every field.
	const bootSettings = settingsStore.read();
	// The pending-restart boot snapshot (U4 §13.2): taken ONCE, after the
	// settings load validates and before anything else reads it — the
	// diff base `GET /v1/settings`'s `pendingRestart` reports. Pre-listen
	// by construction: openHarness returns before serve listens.
	const settingsBootSnapshot = snapshotRestartKeys(bootSettings);
	const builtinsEnabled = options.builtins !== false;
	// Skipped entirely (no resolution, no log lines) when the caller
	// turns built-ins off.
	// The configured side, normalized to ResolvedExtensionInput (the
	// loader accepts both forms, but the combined input array must be
	// homogeneous): a plain string becomes `{ entry: spec }`.
	const configuredInputs: readonly ResolvedExtensionInput[] = (
		options.extensionEntries ??
		options.extensionSpecifiers ??
		config.extensions
	).map((specifier) =>
		typeof specifier === "string" ? { entry: specifier } : specifier,
	);
	const builtins: ResolvedBuiltins = builtinsEnabled
		? resolveBuiltins(
			bootSettings,
			configuredInputs,
			options.extraBuiltins ?? [],
			options.builtinResolver,
		)
		: { load: [], skipped: [], configured: configuredInputs };
	// The loader input: built-ins FIRST (pi parity — the replacement rule
	// already removed any built-in a configured entry claims), marked
	// `builtin: true` so their outcomes carry the flag to /v1/extensions,
	// then the configured entries verbatim. The hermetic test seams
	// (`extensionSpecifiers`/`extensionEntries`) still load — but with
	// built-ins skipped entirely when `options.builtins === false`, the
	// exact-shape outcome assertions' escape hatch.
	const loaderInputs: readonly ResolvedExtensionInput[] = builtinsEnabled
			? [
					...builtins.load.map(
						(entry): ResolvedExtensionInput => ({
							...entry,
							builtin: true,
							// Built-ins resolve from core's own tree, NEVER the
							// packages dir (ruling 2): the marker tells the loader
							// to skip the packages-dir-first resolution step.
							coreResolved: true,
						}),
					),
					...builtins.configured,
				]
			: configuredInputs;
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
	// The published-hook registry slot (knowledge C7): the deferred MUST
	// exist before `loadExtensions` runs — seam hosts are built inside the
	// loader's hostContextFactory and close over this slot. Boot builds
	// the registry from the loader's declarations right after
	// `loadExtensions` returns and resolves the deferred; a
	// `host.publishedHooks.call` issued during loading waits on it
	// (the harnessPromise pattern), a `get` before then reads
	// `undefined`.
	let publishRegistryReady!: () => void;
	const publishedHooksReady = new Promise<void>((resolve) => {
		publishRegistryReady = resolve;
	});
	const publishedHooksSlot: {
		registry: PublishedHookRegistry | undefined;
	} = { registry: undefined };
	// The decision-registry slot (warden Task 6): the SAME deferred
	// discipline as the published-hook slot above — seam hosts are built
	// inside the loader's hostContextFactory (before the registry can
	// exist) and close over this slot. Boot builds the registry from the
	// loader's declarations right after `loadExtensions` returns and
	// resolves the deferred; a `host.decisions.evaluate` issued from a
	// factory body waits on it.
	let decisionRegistryReady!: () => void;
	const decisionsReady = new Promise<void>((resolve) => {
		decisionRegistryReady = resolve;
	});
	const decisionsSlot: {
		registry: DecisionRegistry | undefined;
	} = { registry: undefined };
	// Settings split Plan 2 Task 2: the ONE locality answer, live per call
	// on every kind — chat models resolve through the collector's ownership
	// map (last-registered wins), env-driven ids fall to the "core"
	// pseudo-slug, and the non-chat registries answer for their own ids.
	// The deferred slot mirrors the decision-registry one above: seam
	// hosts and factory-time gate calls resolve through the live slot.
	// `locality` (the OpenedHarness field below) is the LIVE ref itself.
	let localitySlot: Locality | undefined;
	const localityRef: Locality = {
		isLocalExtension(slug: string): boolean {
			return localitySlot?.isLocalExtension(slug) ?? false;
		},
		isLocalModel(kind: "chat" | "decision" | "embedding", model: string): boolean {
			return localitySlot?.isLocalModel(kind, model) ?? false;
		},
	};
	// The default model's provider id, as the credential readers below need
	// it: `PUT /v1/providers/:id/credential` redirects a Save for THAT id to
	// the magic `"default"` auth.json key, so the readers must look there
	// too, or a Save the UI reports as succeeded stays invisible (a silent,
	// permanent `not_configured`). `config.models` is loadConfig's already-
	// validated resolution and the collector resolves the same value below
	// (boot restates it into `effectiveEnv`, which wins over any contributor
	// proposal) — read from here rather than the later `defaultModel`
	// binding so a factory-body `host.decisions.evaluate` (which may run
	// once `decisionsReady` resolves, before that assignment) cannot hit a
	// temporal-dead-zone reference.
	const defaultChatProviderId = config.models.provider;
	// The boot-shared store trio (Task 5): one SecretsStore + one
	// ExtensionSettingsStore over the roots resolved at the top of boot;
	// each seam host scopes it to its extension's slug (cheap, no I/O —
	// the cache dir materializes lazily on first `paths.cache` access).
	// The boot env feeds the admin surface's env-secret listing (the
	// `SIGRUN_EXT_<SLUG>_` fallbacks — never written down, listed only).
	const sharedStores = sharedExtensionStores(roots, env, identity.users);
	const seamHosts = new Map<string, SeamHost>();
	const seamKinds = new Map<string, DeclaredKinds>();
	const {
		outcomes: extensionOutcomes,
		healthProducers: extensionHealth,
		runSettledBindings,
		settingsChangedBindings,
		lifecycleBindings,
		workerBindings,
		curationBindings,
		noticeActionBindings,
		publishedHookDeclarations,
		decisionProviderDeclarations,
		embeddingProviderDeclarations,
		userServices: userServiceBindings,
		providerContributors,
		loginProviders,
		webuiBundles: extensionWebuiBundles,
		skillRoots: extensionSkillRoots,
		jobBindings,
		interactiveTools: loadedInteractiveTools,
		routeBindings,
		commandBindings,
		notifierBindings,
		channelBindings,
		gatewayEngine,
		surfaces: surfaceBindings,
		settingsSections: settingsSectionBindings,
		settingsDeclarations: extensionSettingsDeclarations,
		perUserSlugs: loadedPerUserSlugs,
	} = await loadExtensions(
		loaderInputs,
		registry,
		{
			packagesDir,
			// Curator A8 (P9): the wrap feed — the loader grows it with each
			// validated target tool and wraps those tools at their install.
			curationFeed,
			hostContextFactory: (extensionName, kinds, priorHost, settingsSlug) => {
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
					}, sharedStores, {
						declared: (slug) => perUserSlugs.includes(slug),
						set: (slug, user, tools) => userTools.set(slug, user, tools),
					}, userServices, {
						publishedHooks: { current: publishedHooksSlot, ready: publishedHooksReady },
						decisions: { current: decisionsSlot, ready: decisionsReady },
						locality: localityRef,
					}, undefined, settingsSlug);
				if (priorHost !== undefined) host.rekey({ name: extensionName }, kinds);
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
			onQuarantine: (slug) => {
				userTools.removeSlug(slug);
				return userServices.quarantine(slug);
			},
		},
	);
	perUserSlugs.push(...loadedPerUserSlugs);
	// Loading is complete: declarations are now read under the final slug,
	// and any later declare call is a factory-window violation.
	for (const host of seamHosts.values()) host.sealSettings();
	// Fail-fast vs wait (polish A1, spec §5.2): the caller declared a
	// server WILL bind the host bridge — mark every loaded seam host so
	// pre-bind calls keep the bounded wait instead of rejecting at once.
	// `createServer` repeats this on entry (idempotent) for rigs that
	// never passed the option.
	if (options.expectHostBridge === true) {
		for (const host of seamHosts.values()) host.expectBridge();
	}
	// The curation-target registry (curator P7): the loader's validated,
	// slug-attributed bindings folded into the ONE registry — the A8
	// wrapping feed (isCurationTool) and the A9 host.curation surface
	// read it. An empty fold is the no-declarer deploy.
	const curation = buildCurationRegistry(curationBindings);
	// The published-hook registry (knowledge C7): built from the loader's
	// collected declarations the moment `loadExtensions` returns, then the
	// deferred resolves — a `host.publishedHooks.call` issued from a
	// factory body (still in flight) proceeds from here. `actingUser`
	// reads through the harness deferred: a call whose conversation
	// identity resolves during the load window waits for `Harness.open`
	// exactly like the other bridged members. Load order between caller
	// and provider never matters — lookup is at call time.
	publishedHooksSlot.registry = buildPublishedHookRegistry(
		publishedHookDeclarations,
		{
			actingUser: async (id) => {
				const h = await harnessPromise;
				return (await h.snapshot(SessionMetaDoc, id, BACKGROUND_CONTEXT))
					?.owner;
			},
			deadlineMs: config.publishedHookDeadlineMs,
			warn: (message) => console.warn(message),
		},
	);
	// The decision registry (warden Task 6): built from the loader's
	// collected declarations the moment `loadExtensions` returns (the
	// published-hook pattern above), then the deferred resolves — a
	// `host.decisions.evaluate` issued from a factory body (still in
	// flight) proceeds from here. The credential resolves PER CALL:
	// `auth.json[id].apiKey` (a live read, so a key written through the
	// providers route applies without a restart) wins over the ambient
	// `credentialEnv` with the auth bridge's `""`-means-unset rule. The
	// magic `"default"` key applies ONLY when this id IS the default
	// model's provider — that is exactly where `PUT
	// /v1/providers/:id/credential` writes it (the route redirects the
	// default provider's Save to `"default"`), so without this fallback a
	// Save the UI reports as succeeded would stay invisible here. The
	// settings read is live too: `decisionModel` and
	// `server.decisions.timeoutMs` apply without a restart.
	// Settings split Task 2 order: the slot is declared before the
	// resolver's owner closures so they can reference either registry.
	let embeddingsSlot: EmbeddingRegistry | undefined;
	const ownerOfLocal = (
		kind: "chat" | "decision" | "embedding",
		providerId: string,
		modelId?: string,
	): string | undefined => {
		if (kind === "chat") {
			// Live, not a boot snapshot: a refresh can add a model without
			// rebooting, and an unserved id is never local.
			if (modelId === undefined || models.getModel(providerId, modelId) === undefined) {
				return undefined;
			}
			return providerOwnership.get(providerId) ?? "core";
		}
		const registry = kind === "decision" ? decisionsSlot.registry : embeddingsSlot;
		return registry?.providers().find((row) => row.id === providerId)?.extension;
	};
	localitySlot = createLocality({
		localProviders: () => settingsStore.read().localProviders ?? [],
		ownerOf: ownerOfLocal,
	});
	decisionsSlot.registry = buildDecisionRegistry(decisionProviderDeclarations, {
		locality: localityRef,
		credential: (id, credentialEnv) => {
			const stored = authStore.read()[id]?.apiKey;
			if (stored !== undefined) return stored;
			// The route's `"default"` write, for the id it applies to.
			if (id === defaultChatProviderId) {
				const fromDefault = authStore.read()[DEFAULT_AUTH_KEY]?.apiKey;
				if (fromDefault !== undefined) return fromDefault;
			}
			return credentialEnv === undefined
				? undefined
				: env[credentialEnv]?.trim() || undefined;
		},
		readSettings: () => settingsStore.read(),
		effectiveModel: async (user) => await effective.value("decisionModel", user) as string | undefined,
		timeoutCapMs: config.decisions.timeoutMs,
		// The env tier of the timeout knob: env always wins over a live
		// file edit (the config's env-over-file precedence, per call).
		...(env[DECISION_TIMEOUT_ENV] === undefined || env[DECISION_TIMEOUT_ENV] === ""
			? {}
			: { timeoutMs: config.decisions.timeoutMs }),
		now: () => Date.now(),
		warn: (message) => console.warn(message),
	});
	// The embedding registry reads live settings on every call (locality
	// now comes from the one resolver, not a per-model list). Credentials
	// are local auth.json reads over the ambient env, as for decisions —
	// including the same magic-`"default"` fallback for the default model's
	// provider id (the key `PUT /v1/providers/:id/credential` writes there).
	const embeddings = buildEmbeddingRegistry(embeddingProviderDeclarations, {
		settings: () => {
			const settings = settingsStore.read();
			return {
				embeddingModel: settings.embeddingModel,
				timeoutCapMs: settings.server?.embeddings?.timeoutMs ?? 30_000,
			};
		},
		locality: localityRef,
		effectiveModel: async (user) => await effective.value("embeddingModel", user) as string | undefined,
		credential: async (id, credentialEnv) => {
			const stored = authStore.read()[id]?.apiKey;
			if (stored !== undefined) return stored;
			if (id === defaultChatProviderId) {
				const fromDefault = authStore.read()[DEFAULT_AUTH_KEY]?.apiKey;
				if (fromDefault !== undefined) return fromDefault;
			}
			return credentialEnv === undefined
				? undefined
				: env[credentialEnv]?.trim() || undefined;
		},
		warn: (message) => console.warn(message),
	});
	embeddingsSlot = embeddings;
	decisionRegistryReady();
	// Warden Task 7: the late fill — swap the placeholder extension for
	// the tool-bearing one when any decision model exists at boot.
	if (decisionsSlot.registry !== undefined && decisionsSlot.registry.list().length > 0) {
		registry.install(
			createDecisionsExtension([
				buildDecisionEvaluateTool({
					decisions: decisionsSlot.registry,
					settings: settingsStore,
				}),
			]),
		);
	}
	publishRegistryReady();
	for (const binding of userServiceBindings) {
		userServices.register(binding.extension, binding.services, binding.packageDir);
	}
	// The late fill (W5 Task 4): the skills extension installed BEFORE the
	// loader ran, holding an empty package-roots array by reference — the
	// collected roots land HERE, and the section (which renders per request)
	// observes them from its next render on. Core sections still lead the
	// prompt; only the discovery content is late.
	collectedSkillRoots.push(...extensionSkillRoots);
	// The prompt-template package roots (Task 2c): derived from the loaded
	// entries' package roots — each package that ships a `prompts/`
	// directory becomes an attributed root (the loader has no fs coupling
	// by contract, so the derivation lives with the templates module).
	collectedTemplateRoots.push(
		...packagePromptRootsOf(
			loaderInputs
				.filter((input) => input.entry !== undefined)
				.map((input) => input.entry as string),
		),
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
	// The reserved-core-section assertion (Task 3; §6.5 R11 narrows it to a
	// CORE-ONLY guard), walked AFTER `loadExtensions` and the guidance
	// install: the loader already quarantines any loaded extension that
	// DECLARES a reserved key, so a mismatch here means a core extension
	// was replaced by or registered under the wrong name — a core bug,
	// failing boot loud naming the extension and the key. Prompt-section
	// shape is core-owned surface (spec §3); a silent takeover is not a
	// valid configuration.
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
	const providerContributions = [...(options.extensions ?? []), ...providerContributors];
	// A provider declared in ANY kind owns its namespace: do not silently
	// add the env-driven chat fallback when chat was deliberately disabled.
	const declaredProviderIds = new Set([
		...providerContributions.flatMap((contributor) =>
			(contributor.providers ?? []).map((contribution) => contribution.provider.id),
		),
		...decisionProviderDeclarations.map((declaration) => declaration.contribution.id),
		...embeddingProviderDeclarations.map((declaration) => declaration.contribution.id),
	]);
	const {
		models,
		defaultModel,
		healthProducers: providerHealth,
		providerOwnership,
		readinessTrackers: providerReadiness,
	} = collectProviders(
		providerContributions,
		effectiveEnv,
		sink,
		{
			auth: authStore,
			baseUrl: config.defaultProviderBaseUrl,
			modelsStore,
			declaredProviderIds,
		},
	);

	// One effective-settings resolver for every per-user model read. The
	// env-resolved boot default remains the system value for defaultModel.
	const effective = createEffectiveSettings({
		schema: coreSchema,
		system: (key: string) => {
			if (key === "defaultModel") return `${defaultModel.provider}/${defaultModel.modelId}`;
			return (settingsStore.read() as Record<string, unknown>)[key];
		},
		overrides: async (user: string) => {
			const stores = userExtensionStores(roots, identity.users, "core", user);
			return stores.settings.get();
		},
		directory: () => identity.users.list(),
	});
	// Invalid overrides never prevent a conversation from running. Each bad
	// value warns once per boot; later reads still fall back to the system model.
	const warnedDefaultOverrides = new Set<string>();
	const defaultModelFor = async (user: string | undefined): Promise<ModelRef> => {
		if (user === undefined) return defaultModel;
		const resolved = await effective.value("defaultModel", user);
		if (typeof resolved !== "string" || resolved === `${defaultModel.provider}/${defaultModel.modelId}`) {
			return defaultModel;
		}
		try {
			const candidate = parseModelSpec(resolved, "user defaultModel override");
			if (models.getModel(candidate.provider, candidate.modelId) !== undefined) return candidate;
		} catch {
			// The one warning below covers parse and served-catalog failures alike.
		}
		if (!warnedDefaultOverrides.has(resolved)) {
			warnedDefaultOverrides.add(resolved);
			console.warn(`user defaultModel override "${resolved}" is invalid or not currently served; using system default`);
		}
		return defaultModel;
	};

	// One-shot migration: the registry exists, so unknown models are
	// dropped by the owner lookup. Headless boots migrate HERE too; the
	// notice waits for createServer's notices service.
	const localityMigration = migrateLocalModels(
		settingsStore,
		(model) => {
			const slash = model.indexOf("/");
			if (slash <= 0) return undefined;
			const providerId = model.slice(0, slash);
			const modelId = model.slice(slash + 1);
			const provider = embeddings.providers().find((row) => row.id === providerId);
			// Unknown models never migrate. The per-model local:false veto
			// is intentionally NOT the gate: the admin explicitly listed
			// this model, so its extension's admin intent moves; the veto
			// still controls the serve-time refusal afterwards.
			return provider?.models.includes(modelId) ? provider.extension : undefined;
		},
	);
	// The jobs core extension (jobs Task 3, spec §8.1 "The executor"):
	// ONE registry install carrying the `sigrun.schedule` task, BEFORE
	// `Harness.open` reads the registry (the same slot as the other core
	// extensions). The task is a pure definition over the runtime deps —
	// the clock seam (options.now) and `config.timezone` (§8.2) — so it
	// installs here, before the open, and nothing else keyed on it. The
	// deps object is shared with `fireJob`'s run-now and the JobsService
	// below (one clock, one tz, one models store).
	const jobRuntimeDeps: JobRuntimeDeps = {
		// Resolve declared-job owners against the live directory at each use
		// (§6.5); no cache and no rewrite of the source's stored record.
		effectiveOwner: (owner) => resolveEffectiveOwner(identity.users.list(), owner),
		// SAFETY: harness + storage are assigned right after `Harness.open`
		// returns below (the open needs the task registered, so the deps
		// object is created first with placeholders). Every read — task
		// phases, fireJob, the JobsService — happens post-assignment.
		harness: undefined as unknown as Harness,
		storage: undefined as unknown as Storage,
		registry,
		models,
		defaultModel,
		defaultModelFor,
		now: () => clockNow().getTime(),
		defaultTz: config.timezone,
		// Task 2c: job prompts expand `/skill:name` and template commands
		// through the same roots the submit path uses (live reads, no
		// `typed` entry — there is no user turn to attribute).
		commandExpansion,
		envBuilder: undefined as unknown as EnvBuilder,
		// Ask-user Task 3: job fires hide interactive tools (assigned with
		// the rest of the late-bound deps after the load completes).
		// SAFETY: the placeholder is assigned below, before any fireJob
		// caller can run (the same late-binding pattern as `harness`/
		// `storage`/`envBuilder` on this deps object).
		interactiveTools: undefined as unknown as ReadonlySet<string>,
		// Gateway C7: a deliver-carrying fire warns once per run when no
		// engine loaded (core ships none — `gatewayEngine` is undefined
		// unless an extension declared one).
		gatewayLoaded: gatewayEngine !== undefined,
		// Jobs quiet runs Task 3: the turn-limit fallback reads the
		// settings store LIVE per fire (a PATCH reaches the next fire).
		jobDefaults: () => settingsStore.read().jobDefaults,
		rewriteUserSelection: (tx, conversationId, from, to) =>
			rewriteSelection(tx, conversationId, from, to, perUserSlugs),
	};
	registry.install({
		name: "sigrun.jobs",
		tasks: [createScheduleTask(jobRuntimeDeps)],
	});
	// Curator A8 (P6 gate): the hooks-only curator-run gate — installed
	// in the registry but NEVER in the host default selection (the
	// settings getter below filters it like a per-user entry): only A9's
	// producer selects it, in the internal run conversations it creates.
	registry.install(createCurationGateExtension());
	// The host event hub (W3 Task 4, spec §7.4): ONE per opened harness.
	// The event bus's commit-derived events subscribe below (after the bus
	// opens); the provider refresh paths observe readiness here — each
	// completed refresh re-derives the per-provider readiness through the
	// shared `providerAuthStatus` derivation and publishes one
	// `providers.changed` per provider whose status moved.
	const events = new EventHub();
	// SAFETY: `providerAuthStatus` reads ONLY the five readiness inputs
	// (providerReadiness/providerOwnership/providerHealth/auth/providerEnv)
	// — all boot-complete at this point; the cast supplies the unrelated
	// OpenedHarness fields as `unknown` placeholders nothing here reads.
	const provisionalOpened = {
		providerReadiness,
		providerOwnership,
		providerHealth,
		auth: authStore,
		providerEnv: effectiveEnv,
	} as unknown as OpenedHarness;
	const producersByName = new Map(
		providerHealth.map((producer) => [producer.name, producer]),
	);
	const snapshotReadiness = (): ReadonlyMap<string, string> => {
		const snapshot = new Map<string, string>();
		for (const { id } of models.getProviders()) {
			snapshot.set(
				id,
				providerAuthStatus(provisionalOpened, id, producersByName).status,
			);
		}
		return snapshot;
	};
	let lastReadiness: ReadonlyMap<string, string> | undefined;
	const observeReadiness = (snapshot: ReadonlyMap<string, string>): void => {
		const prior = lastReadiness;
		lastReadiness = snapshot;
		if (prior === undefined) return; // the first snapshot only baselines
		for (const [provider, status] of snapshot) {
			if (prior.get(provider) === status) continue;
			events.publish({ type: "providers.changed", provider, status });
		}
		for (const provider of prior.keys()) {
			if (snapshot.has(provider)) continue;
			// A provider that vanished from the catalog degrades out.
			events.publish({
				type: "providers.changed",
				provider,
				status: "not_ready",
			});
		}
	};
	// The boot refresh (Task 4, spec refresh policy 1): one network-allowed
	// refresh of every dynamic provider, started HERE and never awaited on
	// the boot path — it runs concurrently with `Harness.open` and listen.
	// The deadline bounds a wedged upstream; timeout/failure only warns
	// (never blocks boot). The tracked promise rides on the returned handle.
	const bootRefreshDone = bootRefresh(models, {
		timeoutMs: DEFAULT_REFRESH_TIMEOUT_MS,
		onReadinessChange: observeReadiness,
		snapshotReadiness,
	});
	// Per-model compaction overrides (D9): after the boot refresh the
	// catalog is as complete as boot gets, so an override key matching no
	// known model is almost always a typo (or a stale chain name). Warn
	// once per unmatched key — never an error: catalogs move and an
	// unmatched override is simply inert. pi-durable's own key composition
	// is `${provider}/${modelId}`, so a chain-shaped model id yields a
	// doubled prefix (e.g. "bifrost/bifrost/<chain>").
	void bootRefreshDone.then(() => {
		const overrides =
			config.compaction.modelOverrides ??
			bootSettings.server?.compaction?.modelOverrides;
		if (overrides === undefined) return;
		const known = new Set(
			models.getModels().map((model) => `${model.provider}/${model.id}`),
		);
		for (const key of Object.keys(overrides)) {
			if (!known.has(key)) {
				console.warn(`compaction override "${key}" matches no known model`);
			}
		}
	});
	// The boot-wired single-provider refresh (W3 Task 6): the route
	// surface's refresh — the same bound policy `resolveServedModelRefreshing`
	// runs on a miss, with the same readiness observation so a provider a
	// credential write flips publishes `providers.changed` like every
	// other refresh path does.
	const refreshOneProvider = (providerId: string): Promise<void> =>
		refreshProvider(models, providerId, {
			onReadinessChange: observeReadiness,
			snapshotReadiness,
		});
	// The interval refresh scheduler (Task 5, refresh policy 2): the cadence
	// keeping the catalogs current after the boot refresh. Started only
	// when the resolved interval is greater than zero (0 = the designed
	// disable, no timer); the timer is unref()ed inside, and `stop()` rides
	// on the returned handle for the deploy shutdown path.
	// The interval refresh scheduler (with the U4 §13.1 re-arm): the
	// cadence is a LIVE setting — a committed write to
	// `server.providers.refreshIntervalMinutes` re-arms the timer at the
	// NEW interval (stop + start; `0` disables, no timer). The re-arm
	// resolves env over the fresh file value exactly like boot does, so
	// an env-pinned cadence (`SIGRUN_PROVIDER_REFRESH_MINUTES`) stays
	// authoritative across re-arms.
	const armProviderRefresh = (): (() => void) => {
		const minutes = resolveRefreshMinutes(env, settingsStore);
		if (!(minutes > 0)) return (): void => {};
		return startProviderRefresh(models, {
			intervalMinutes: minutes,
			onReadinessChange: observeReadiness,
			snapshotReadiness,
		}).stop;
	};
	let stopProviderRefresh = armProviderRefresh();
	// SAFETY: `stopProviderRefresh` is `let`-bound for the re-arm swap;
	// the shutdown handle the deploy path calls stays this function (it
	// always stops whatever arm is current).
	const stopCurrentProviderRefresh = (): void => {
		stopProviderRefresh();
	};
	// Every tool/file/upload/job env resolves through this one decision seam.
	workspaceService = createWorkspaceService({
		isolation: isolationState,
		osUsers,
		pool: sandboxPool,
		directory: identity.users,
		managed: managedPaths,
		defaultWorkspacePath: config.workspace.path,
		ownerOf: async (conversationId, read, ctx) =>
			(await read.snapshot(SessionMetaDoc, conversationId, ctx))?.owner,
	});
	const workspacePrefs = defaultWorkspacePrefs(config.workspace.path);
	const envBuilder = toHarnessEnv(workspaceService, workspacePrefs);
	// The job runtime's env-builder binding resolves here (the placeholder
	// the pre-open deps object needed): job-prompt expansion reads the
	// conversation workspace through the SAME seam tool calls use.
	jobRuntimeDeps.envBuilder = envBuilder;
	// The settings store (Task 8a): file-backed, live. `harnessSettings()` is
	// the getter-backed `HarnessSettings` pi-durable re-resolves per
	// submission — absent = every default. A malformed file throws HERE, at
	// boot, exactly like a bad `SIGRUN_*` value (loadConfig's posture).
	// The skills extension's live cap reads the store constructed above
	// (the closure built at the top resolves it per render —
	// `skills.sectionMaxBytes`, default 4KB).
	skillsSettings = settingsStore;
	const fileSettings = settingsStore.harnessSettings();
	const callerSettings = options.settings;
	// The ONE boot clock (options.now ?? real): the activity stamper AND
	// the harness clock share it (the schedule task's `sleepUntil`
	// deadlines live on the harness clock; pinning the seam pins both —
	// the jobs tests' time-injection lever).
	const clockNow = options.now ?? (() => new Date());
	// D5: reports may arrive inside Harness.open. The collector logs/counts
	// synchronously (no durable follow-up work from a report survives 1.5.0).
	const reports = createDurableReports({
		log: (line) => console.error(line),
		onReport: options.onReport,
	});
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			env: envBuilder,
			now: () => clockNow().getTime(),
			setTimer: options.setTimer,
			onReport: reports.onReport,
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
			// Compaction (D9): ONLY `modelOverrides` comes from the file here —
			// it has no env spelling, so this adds a file tier without touching
			// the four env-backed knobs' precedence (env over file, resolved by
			// loadConfig). serve already folds the file into config; the
			// conditional spread keeps a config-resolved map authoritative and
			// covers direct `openHarness` boots. Read ONCE (boot-time), so a
			// PATCH is restart-pending exactly like the other compaction keys.
			// Order: caller seam > config (env over file) > this file fallback.
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
					// The stream-request default (curator-eval hardening): a
					// model request with no explicit timeout can wedge forever —
					// the OpenAI SDK's `timeout` is a headers-arrival deadline and
					// defaults to 10 minutes, but a request that never reaches the
					// provider (undici socket-pool class) never gets headers to
					// time out against, so pi-durable's generation task sits in
					// phase=request indefinitely. `mergeStreamSettings` bounds
					// every request with a default `timeoutMs`; the caller seam
					// and the file each override field-wise.
					return mergeStreamSettings(
						callerSettings?.stream,
						fileSettings.stream,
					);
				},
				get extensions() {
					// Per-user entries are core-computed from SessionMeta.owner,
					// never part of a host default — including an operator-supplied
					// caller list (controller ruling: filter BOTH sources). The
					// curator-run gate (A8) is filtered the same way: it is selected
					// ONLY in the internal run conversations A9's producer creates.
					const selected = callerSettings?.extensions ?? registry.snapshot().installed();
					return selected.filter(
						(entry) =>
							!isUserEntryName(entry.name) &&
							entry.name !== CURATION_GATE_EXTENSION,
					);
				},
				toolExecution: callerSettings?.toolExecution,
				// pi-durable 1.5.0: restart-limited tasks END instead of parking
				// (no file backing — caller seam and default only, like
				// toolExecution). The battery pins it to make crash outcomes
				// deterministic.
				restartLimit: callerSettings?.restartLimit,
				compaction: {
					...config.compaction,
					...(config.compaction.modelOverrides === undefined &&
					bootSettings.server?.compaction?.modelOverrides !== undefined
						? { modelOverrides: bootSettings.server.compaction.modelOverrides }
						: {}),
					...callerSettings?.compaction,
				},
			},
		},
		BACKGROUND_CONTEXT,
	);
	// M2 boot sweep: add each conversation owner's declared entries to every
	// default-edited selection. Exact arrays are never widened. Runs before
	// resume and is idempotent; late tool installs still resolve by name.
	const userToolSweep = await sweepUserSelections(
		harness,
		storage,
		perUserSlugs,
	);
	console.log(
		`user tools: boot sweep scanned ${userToolSweep.scanned} conversation(s), changed ${userToolSweep.changed}`,
	);
	// The seam hosts' lazy binding resolves here: every seam call issued
	// after boot completes finds the harness immediately; one issued from a
	// post-open async factory path waits on this same promise.
	bindHarness(harness);
	// The job runtime deps' harness/storage binding resolves the same way
	// (the placeholders the pre-open install needed): the harness exists
	// from here on, and every job read — task phases, fireJob, the
	// JobsService — happens after this point.
	jobRuntimeDeps.harness = harness;
	jobRuntimeDeps.storage = storage;
	jobRuntimeDeps.interactiveTools = new Set(loadedInteractiveTools);
	// pi-durable 1.5.0 removed task_parked/retryTask (the parked-job drain
	// existed for that pair); Task 4 wires the replacement recovery surface.
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
	const hookDeadlineMs = options.eventBus?.hookDeadlineMs ?? memorySeam.hookDeadlineMs;
	const eventBus = EventBus.open(harness, {
		queueMax: options.eventBus?.queueMax ?? memorySeam.queueMax,
		hookDeadlineMs,
		idleThresholdMs: options.eventBus?.idleThresholdMs ?? memorySeam.idleThresholdMs,
		idleSweepMs: options.eventBus?.idleSweepMs ?? IDLE_SWEEP_MS,
		workerDeadlineMs: options.eventBus?.workerDeadlineMs ?? memorySeam.workerDeadlineMs,
		shutdownSettleWaitMs: options.eventBus?.shutdownSettleWaitMs,
		// W3 Task 4: the hub's subscription is installed at open —
		// synchronous, no-blocking-work (the SSE route's filtering side
		// lane does its own async work). Exposed so the bus's open() can
		// wire it before any commit lands.
		onHostEvent: (event) => events.publish(event),
	});
	// The settings-changed publication (U4 §13.2): ONE seam fanning a
	// committed settings write out to (a) the hub — /v1/events delivers
	// `settings.changed` to admins — and (b) every extension's
	// `onSettingsChanged` through the bus's bounded fan-out (rejections
	// logged, never propagated: §13.2's the-write-still-succeeds rule).
	// The scheduler re-arm rides the same seam: a write touching
	// `server.providers.refreshIntervalMinutes` (a LIVE key, §13.1) stops
	// and re-arms the interval timer at the fresh cadence.
	const publishSettingsChanged = (
		scope: "server" | { extension: string },
		keys: readonly string[],
		user?: string,
	): void => {
		events.publish({ type: "settings.changed", scope, keys: [...keys] });
		if (
			keys.includes("server.providers.refreshIntervalMinutes") ||
			keys.includes("server.providers") ||
			keys.includes("server")
		) {
			stopProviderRefresh();
			stopProviderRefresh = armProviderRefresh();
		}
		if (user !== undefined && typeof scope !== "string") {
			userServices.settingsChanged(scope.extension, user);
		}
		void eventBus.emitSettingsChanged(keys, user);
	};
	settingsChangedSinks.push(publishSettingsChanged);
	// Activity stamping (UI refresh A1): every settled run stamps its
	// conversation's `lastActivityAt` (the admission-side stamp lives in the
	// submissions route). Registered directly after the bus opens — host-owned
	// machinery, ahead of every extension registration (install order = run
	// order). The bus's close stops delivery; the unsubscribe is unused.
	const now = clockNow;
	wireActivity(eventBus, harness, now);
	// Curator A9 (P6): the ONE curation host — the `host.curation`
	// surface over the per-user stores (curationOf), the curation
	// registry, the jobs records and the run driver. The server's host
	// bridge and every seam host expose the SAME instance (the bridge
	// carries it; the seam hosts delegate). The digest producer's
	// default agent is the create op's own store-default change (what
	// every server-created conversation starts from): the structural
	// `{settings, registry, providerEnv}` subset `storeAgentChange`
	// reads, closed over the LIVE references so a settings PATCH
	// reaches later digests without a restart.
	// SAFETY: the cast — `storeAgentChange` reads exactly these three
	// members (settings.read, registry.snapshot, providerEnv) and
	// nothing else of OpenedHarness; the live closure satisfies them.
	const curationHost = createCurationHost({
		harness,
		registry,
		storage,
		curation,
		defaultModel,
		defaultModelFor,
		interactiveTools: new Set(loadedInteractiveTools),
		stores: curationOf,
		skillsOptions: {
			userDir: join(roots.configDir, "skills"),
			packageRoots: (): readonly { extension: string; dir: string }[] =>
				collectedSkillRoots,
		},
		defaultAgent: (): AgentChange =>
			storeAgentChange(
				{
					settings: { read: () => settingsStore.read() },
					registry,
					providerEnv: effectiveEnv,
				} as unknown as Parameters<typeof storeAgentChange>[0],
				defaultModel,
			),
	});
	const handlersByName = new Map<string, ExtensionEventHandlers>();
	for (const binding of runSettledBindings) {
		handlersByName.set(binding.extension.name, {
			...handlersByName.get(binding.extension.name),
			runSettled: binding.runSettled,
		});
	}
	// UI-blocks U4 §13.2: the settings-change hook merges into the same
	// per-extension registration (the fan-out below invokes it).
	for (const binding of settingsChangedBindings) {
		handlersByName.set(binding.extension.name, {
			...handlersByName.get(binding.extension.name),
			onSettingsChanged: binding.onSettingsChanged,
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
		isTaskOwned: async (id) =>
			(await storage.conversation(id, BACKGROUND_CONTEXT))?.owner !== undefined,
	});
	eventBus.registerExtension("sigrun:auto-name", {
		runSettled: autoNamer.runSettled,
	});
	// The jobs run-status observers (W4 Task 3, §8.1): the runSettled
	// handler registered as `sigrun:jobs` (after every loaded extension,
	// like the auto-namer — a job observation never delays an extension's)
	// + the taskSettled host-event listener (task-action runs). Registered
	// BEFORE `resume()` so recovery settles are observed; the unsubscribe
	// rides the bus's own close (host machinery, booted with the bus).
	registerJobObservers({
		harness,
		storage,
		runtime: jobRuntimeDeps,
		settings: () => settingsStore.read(),
		eventBus,
	});
	// Delivery scheduling: the bus itself stays passive (Task 2's
	// contract — `drain()` is the only pump); boot owns when drains run.
	// Every commit (bus events or not) schedules one debounced drain on
	// the next macrotask — unref'd so a bare boot never holds the process
	// open, and a no-op once the queue is found empty. Events enqueued
	// while a drain is already pumping are picked up by that same loop.
	let drainTimer: ReturnType<typeof setTimeout> | undefined;
	harness.observeCommits({
		advance: () => {
			try {
				if (drainTimer !== undefined) return;
				drainTimer = setTimeout(() => {
					drainTimer = undefined;
					void eventBus.drain(hookDeadlineMs, BACKGROUND_CONTEXT);
				});
				drainTimer.unref?.();
			} catch (error) {
				console.error("boot: commit observer failed", error);
			}
		},
		end: (end) => {
			if (end.kind === "ended") return;
			if (end.kind === "failed" && end.error instanceof Error && end.error.message === "session closed") return;
			console.error("boot: commit observation failed", end.kind === "failed" ? end.error : end);
		},
	});
	// A failed Session closes itself (the upstream contract): the bus's
	// sweep + subscription must not outlive it. shutdownSequence (the
	// ordered path src/index.ts runs) closes the bus first, making this a
	// no-op on the normal path.
	harness.subscribeClose(() => eventBus.close());
	// Queue terminal runs left above the durable marker ahead of live events,
	// so replay handlers are entered before resumed-run events. Replay enqueues
	// without committing, so it needs this explicit pump; a failure freezes
	// marker saves in the bus (replayUndelivered's own catch) and the next boot
	// retries the tail.
	try {
		await eventBus.replayUndelivered(storage, BACKGROUND_CONTEXT);
	} catch (error) {
		eventBus.markReplayFailed();
		console.error(
			"boot: run-event replay failed; delivery marker saves are frozen until the next boot",
			error,
		);
	}
	void eventBus.drain(hookDeadlineMs, BACKGROUND_CONTEXT);
	// The jobs service (W4 Task 3): the declared sources are read LIVE
	// per reconcile — the settings store re-reads (a file edit lands on
	// the next reconcile) and the loader's job bindings snapshot at boot
	// (an extension's declaration is its boot-time declaration).
	const fileJobs = (): readonly JobSpec[] => settingsStore.read().jobs ?? [];
	const jobsSources = () => ({ file: fileJobs(), extensions: jobBindings });
	const jobEffectiveOwner = (owner: string | undefined): string | undefined =>
		resolveEffectiveOwner(identity.users.list(), owner);
	// The root conversation — the schedule tasks' owner (spec §8.1).
	// `Harness.root` is idempotent (creates with `agent` on first call,
	// returns the reserved root thereafter), so the server's own
	// root-ensure later sees the same conversation. Reconciliation needs
	// it BEFORE creating any executor.
	const rootConversation = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: defaultModel },
	});
	const rootConversationId = rootConversation.id as number;
	// The `job.changed` publication (W4 Task 4, §7.4/§8.4): the jobs
	// service's onChange hook (fired from its `sigrun.job` commit
	// subscription — every record change, any writer) publishes the
	// changed job's wire row through the hub WITHOUT `access` (the SSE
	// stream computes accessOf per principal and adds it; a hidden job's
	// event is withheld entirely). The read runs on a microtask side lane
	// (the commit-listener contract is no-blocking-work); a RETIRED record
	// (the delete path) is served from its newest revision so clients
	// still get the nudge to refetch.
	const publishJobChanged = async (jobId: string): Promise<void> => {
		try {
			const record = await harness.snapshot(
				JobDoc,
				jobId,
				BACKGROUND_CONTEXT,
			);
			if (record !== undefined) {
				// The hub's copy is ACCESS-NEUTRAL by contract (the wire's
				// `Omit<JobWire, "access">`): `jobWireOf`'s row carries the
				// service's neutral placeholder, so it is STRIPPED here — the
				// SSE stream computes `accessOf` per principal and adds it. A
				// future in-process hub subscriber must never read a fabricated
				// access off the hub's copy.
				const { access: _dropped, ...row } = jobWireOf(
					jobId,
					record,
					jobEffectiveOwner(record.owner),
				);
				events.publish({
					type: "job.changed",
					job: row,
				});
				return;
			}
			const [newest] = await listRevisions(
				storage,
				jobId,
				BACKGROUND_CONTEXT,
			);
			if (newest === undefined) return;
			// Resolve once: the primary admin can move between the two reads
			// (a live directory), so a single snapshot keeps the row
			// self-consistent.
			const effectiveOwner = jobEffectiveOwner(newest.owner);
			events.publish({
				type: "job.changed",
				job: {
					id: jobId,
					name: newest.spec.name,
					source: newest.source,
					...(effectiveOwner === undefined ? {} : { owner: effectiveOwner }),
					...(newest.sharing === undefined ? {} : { sharing: newest.sharing }),
					schedule: newest.spec.schedule,
					action: newest.spec.action,
					enabled: newest.enabled,
					// The retired row's status is gone with the record; the
					// nudge only needs identity + definition (clients refetch).
					state: "disabled",
					version: newest.version,
				},
			});
		} catch (error) {
			console.error("jobs: job.changed publication failed:", error);
		}
	};
	// The in-process job-run outcome counter (W4 Task 4, §6.9): counted
	// from `sigrun.job.run` document commits in THIS process — reset on
	// restart by design (the durable history lives in the run records;
	// the counter feeds `sigrun_job_runs_total{outcome}`). A creation
	// write of an already-settled run (the overlap skip, the catch-up
	// skip) counts once at creation; a `running` run counts at its settle;
	// prune retirements (tagged `kind === "retire"`) never count.
	const jobRunTotals = new Map<string, number>();
	harness.observeCommits({
		advance: (publication) => {
			try {
				for (const change of publication.changes) {
					if (change.type !== "document") continue;
					if (change.kind !== "change") continue;
					if (change.record.kind !== JobRunDoc.definition.kind) continue;
					const outcome = (change.value as { outcome?: unknown })?.outcome;
					if (typeof outcome !== "string" || outcome === "running") continue;
					jobRunTotals.set(outcome, (jobRunTotals.get(outcome) ?? 0) + 1);
				}
			} catch (error) {
				console.error("boot: commit observer failed", error);
			}
		},
		end: (end) => {
			if (end.kind === "ended") return;
			if (end.kind === "failed" && end.error instanceof Error && end.error.message === "session closed") return;
			console.error("boot: commit observation failed", end.kind === "failed" ? end.error : end);
		},
	});
	jobs = createJobsService({
		harness,
		storage,
		runtime: jobRuntimeDeps,
		effectiveOwner: jobEffectiveOwner,
		rootId: rootConversationId,
		sources: jobsSources,
		jobsRoot: (owner) => workspaceService?.jobsRoot(owner),
		settings: () => settingsStore.read(),
		onChange: (jobId) => {
			void publishJobChanged(jobId);
		},
	});
	// Reconcile BEFORE resume: the scheduler is still disabled, so the
	// executor creations/aborts land durably and only then start running
	// (the spec §8.3 boot order — "reconcile after resume()" — holds in
	// effect: resume is the very next line). Awaiting a reconcile AFTER
	// resume would delay openHarness's return past the scheduler's first
	// drain microtask, racing post-boot registry installs against
	// recovered-task agent resolution (the battery's hook-refire driver
	// installs its hook extension right after boot — the recovered
	// generation must resolve its agent AFTER that install).
	await reconcileJobs(
		{
			harness,
			storage,
			runtime: jobRuntimeDeps,
			rootId: rootConversationId,
			sources: jobsSources,
			jobsRoot: (owner) => workspaceService?.jobsRoot(owner),
		},
		BACKGROUND_CONTEXT,
	);
	// Settle crash-orphaned fires while scheduling is still suspended.
	// settleJobRun supplies the run/lastRun/jobOutcome writes; a settled
	// slot is never retried. Known ordering limitation: startNotifications
	// subscribes only after openHarness returns, so boot-time job.failed
	// notifications are not delivered. The conversation's jobOutcome and
	// the Jobs view's Failed-prefixed row remain the user-visible surfaces.
	await sweepOrphanedRuns({
		harness,
		storage,
		settings: () => settingsStore.read(),
		now: () => clockNow().getTime(),
	}, BACKGROUND_CONTEXT);
	// The deleted-owner warning (§8.3): a declared job whose `owner` names
	// a user no longer in the directory runs OWNERLESS until its source is
	// edited (household-write by the §5.9 rule) — surfaced at boot, never
	// silently. Only checked on a claimed directory (an unclaimed boot
	// has no users to check against).
	if (identity.users.isClaimed()) {
		const known = new Set(identity.users.list().map((user) => user.user));
		for (const spec of [...fileJobs(), ...jobBindings.flatMap((binding) => binding.jobs)]) {
			if (spec.owner === undefined || known.has(spec.owner)) continue;
			console.warn(
				`jobs: declared job "${spec.name}" names owner "${spec.owner}" who is not in the user directory — it runs ownerless until its source is edited`,
			);
		}
	}
	// D2 restart-limit recovery: reports that arrived DURING
	// Harness.open sat queued in the collector. Register the live
	// listener now (drains the backlog via setImmediate, then every
	// later restart-limited report flows straight to it); the listener
	// owns all Harness reads/commits — the collector never calls the
	// Harness from inside onReport.
	reports.onRestartLimited((task) => {
		void markRestartLimitedJob(harness, task, BACKGROUND_CONTEXT).catch(
			(error: unknown) => {
				console.error("jobs: restart-limited listener failed:", error);
			},
		);
	});
	harness.resume();
	return {
		harness,
		isolation,
		isolationState,
		osUsers,
		sandboxPool,
		userServices,
		storage,
		registry,
		userTools,
		rewriteUserSelection: (tx, conversationId, from, to) =>
			rewriteSelection(tx, conversationId, from, to, perUserSlugs),
		userToolSweep,
		models,
		jobs,
		reports,
		jobRunTotals: () => jobRunTotals,
		defaultModel,
		defaultModelFor,
		interactiveTools: new Set(loadedInteractiveTools),
		providerCollisions: sink.collisions,
		webuiBundles,
		webuiBundleCollisions,
		envBuilder,
		extensionOutcomes,
		loginProviders,
		builtinSkipped: builtinsEnabled ? builtins.skipped : [],
		providerHealth,
		providerOwnership,
		providerReadiness,
		providerEnv: effectiveEnv,
		auth: authStore,
		identity,
		memoryHealth,
		settings: settingsStore,
		decisions: decisionsSlot.registry as DecisionRegistry,
		embeddings,
		locality: localityRef,
		effective,
		localityMigration,
		extensionStores: sharedStores,
		packagesDir,
		seamHosts,
		seamKinds,
		bindHostBridge: (bridge: HostBridge): void => {
			for (const host of seamHosts.values()) host.bindBridge(bridge);
		},
		expectHostBridge: (): void => {
			for (const host of seamHosts.values()) host.expectBridge();
		},
		extensionRoutes: routeBindings,
		extensionCommands: commandBindings,
		noticeActionBindings,
		extensionSurfaces: surfaceBindings,
		extensionSettingsSections: settingsSectionBindings,
		extensionSettingsDeclarations,
		notifierBindings,
		channelBindings,
		gatewayEngine,
		skillRoots: extensionSkillRoots,
		curation,
		curationHost,
		curationOf,
		publishedHooks: () => publishedHooksSlot.registry?.listing() ?? [],
		workspaceRootOf: (owner) => workspaceService?.workspaceRoot(owner),
		history: { workspace: workspaceHistoryOf },
		commandExpansion,
		eventBus,
		events,
		workerStatuses: () => eventBus.workerStatuses(),
		now,
		autoNamer,
		bootRefresh: bootRefreshDone,
		refreshProvider: refreshOneProvider,
		stopProviderRefresh: stopCurrentProviderRefresh,
		settingsBootSnapshot,
		managedSettings: () => readManagedKeys(roots.configDir),
		publishSettingsChanged,
	};
}
