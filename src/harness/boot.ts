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
import { loadExtensions, type ExtensionOutcome } from "./loader.js";
import { MEMORY_SECTION_KEY, noopMemoryExtension } from "./memory-default.js";
import { contextFilesExtension } from "./sections/context-files.js";
import { skillsExtension } from "../skills/index.js";
import {
	collectProviders,
	createProviderMergeSink,
	type ProviderCollision,
	type ProviderContributor,
} from "./providers/index.js";
import { createRegistry } from "./registry.js";
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
	 * Harness settings passthrough (pi-durable `HarnessSettings`), merged over
	 * upstream defaults. This is the compaction/retry policy seam: deploy code
	 * uses it for Task 8's tuned values, tests use it to force thresholds
	 * hermetically.
	 */
	readonly settings?: HarnessSettings;
	/**
	 * Extension package specifiers to load, overriding `config.extensions` —
	 * the hermetic-test seam for the loader (specifiers resolve to local
	 * fixture packages, not the deploy-time package list).
	 */
	readonly extensionSpecifiers?: readonly string[];
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
 * so a bare core still renders the stable placeholder surface.
 */
export async function openHarness(
	config: SigrunConfig,
	options: OpenHarnessOptions = {},
): Promise<OpenedHarness> {
	const storage = await openNodeSqliteStorage(config.storagePath);
	const registry = createRegistry();
	// Context-file sections (SOUL.md persona, AGENTS.md instructions) and the
	// skills convention (skills/ scan, skills section, load_skill) are both
	// core-owned surfaces (spec §3): every conversation gets them, so they
	// install before `Harness.open` reads the registry — never through the
	// extension loader, never quarantined. install() publishes at once and
	// replaces any same-name extension in place.
	registry.install(contextFilesExtension);
	registry.install(skillsExtension);
	// Extension packages load before `Harness.open` reads the registry
	// (spec §3 boot order). Failures quarantine and boot continues.
	const extensionOutcomes = await loadExtensions(
		options.extensionSpecifiers ?? config.extensions,
		registry,
	);
	// Zero-extension guarantee: when no loaded extension provides the
	// memory surface (a `long-term-memory` section), install the no-op
	// default so every conversation still renders the stable placeholder.
	const memoryProvided = registry
		.snapshot()
		.sections()
		.some((entry) => entry.section.key === MEMORY_SECTION_KEY);
	if (!memoryProvided) {
		registry.install(noopMemoryExtension);
	}
	const sink = createProviderMergeSink();
	const env = options.env ?? process.env;
	// `config.models` is the already-validated parse of SIGRUN_MODEL (loadConfig
	// refuses to boot without it); restating it for the collector keeps a
	// hand-built config authoritative over a stale or absent runtime env var.
	const effectiveEnv = {
		...env,
		SIGRUN_MODEL: `${config.models.provider}/${config.models.modelId}`,
	};
	const { models, defaultModel } = collectProviders(
		options.extensions ?? [],
		effectiveEnv,
		sink,
	);
	// The static workspace service (spec §4.5): every tool call's ExecutionEnv
	// resolves through it, so the the-work-fabric-scrubbed swap changes this wiring's inputs and
	// nothing downstream.
	const workspaceService = createWorkspaceService();
	const workspacePrefs = defaultWorkspacePrefs(config.workspace.path);
	const envBuilder = toHarnessEnv(workspaceService, workspacePrefs);
	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			env: envBuilder,
			...(options.settings === undefined ? {} : { settings: options.settings }),
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
	};
}
