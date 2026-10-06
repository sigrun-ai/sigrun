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
	type ModelRef,
	type Registry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Env, SigrunConfig } from "../config.js";
import {
	collectProviders,
	createProviderMergeSink,
	type ProviderCollision,
	type ProviderContributor,
} from "./providers/index.js";
import { createRegistry } from "./registry.js";

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
}

/** Optional `openHarness` inputs beyond the parsed config. */
export interface OpenHarnessOptions {
	/**
	 * Deploy-time extension list (spec §4.1). Provider contributors are
	 * collected before `Harness.open()`; extension *loading* from disk is
	 * later work, so the default empty list boots the env default provider.
	 */
	readonly extensions?: readonly ProviderContributor[];
	/** Environment the provider collector reads; defaults to `process.env`. */
	readonly env?: Env;
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
 * (`resume()` is idempotent and throws only after close).
 */
export async function openHarness(
	config: SigrunConfig,
	options: OpenHarnessOptions = {},
): Promise<OpenedHarness> {
	const storage = await openNodeSqliteStorage(config.storagePath);
	const registry = createRegistry();
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
	const harness = await Harness.open(
		storage,
		{ models, registry },
		BACKGROUND_CONTEXT,
	);
	harness.resume();
	return { harness, registry, models, defaultModel, providerCollisions: sink.collisions };
}
