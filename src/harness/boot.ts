/**
 * Harness bootstrap: open one durable Session over SQLite, ready for use.
 *
 * `openHarness` composes the three pi-durable pieces every later task needs —
 * file-backed storage at `config.storagePath`, an empty registry holding the
 * built-in task definitions, and a `Harness` with task scheduling enabled —
 * and returns them together. `Harness.root(context)` (called by the host, not
 * here) creates or resumes the reserved root conversation.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	Harness,
	type Harness as HarnessType,
	type Registry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SigrunConfig } from "../config.js";
import { createRegistry } from "./registry.js";

/** A live harness plus the application-owned registry it reads. */
export interface OpenedHarness {
	readonly harness: HarnessType;
	readonly registry: Registry;
}

/**
 * Open (or reopen) the durable harness at `config.storagePath`.
 *
 * Storage is Node's built-in `node:sqlite` through pi-durable's adapter —
 * one process owns the file. The models collection is degenerate until the
 * env-driven provider lands (T-PROVIDER): generation would find no provider,
 * but open/resume/root/close never consult it. Task scheduling is enabled
 * (`resume()` is idempotent and throws only after close).
 */
export async function openHarness(config: SigrunConfig): Promise<OpenedHarness> {
	const storage = await openNodeSqliteStorage(config.storagePath);
	const registry = createRegistry();
	const harness = await Harness.open(
		storage,
		{ models: createModels(), registry },
		BACKGROUND_CONTEXT,
	);
	harness.resume();
	return { harness, registry };
}
