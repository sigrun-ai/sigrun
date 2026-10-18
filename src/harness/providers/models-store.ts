/**
 * The file-backed pi-ai `ModelsStore` (provider plugins Task 3).
 *
 * Dynamic providers (`refreshModels`) publish their catalogs through the
 * store `createModels` was built with; pi-ai writes every publication via
 * `write` and restores it via `read` at the next boot's offline init. This
 * implementation persists one JSON file per provider under
 * `<dir>/models/<sanitized-provider-id>.json`, so a restart serves the
 * last known catalog without network access.
 *
 * Poison resistance: a catalog file that fails to parse (or parses without
 * a `models` array) is logged — the path, never the content — deleted, and
 * reported as absent. A poisoned catalog degrades to "fetch it again",
 * never a boot crash.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";

/** Characters a flattened provider id keeps; everything else becomes `_`. */
const SAFE_FILENAME = /[^A-Za-z0-9-]/g;

/** Monotonic scratch-file counter: concurrent writes never share a tmp name. */
let scratchCounter = 0;

/**
 * Flatten a provider id into a safe filename component. Dots are NOT in the
 * safe set, so no flattened id can form `.`, `..`, or a hidden file, and a
 * `/`-shaped id (e.g. `acme/gw`) stays inside the models dir as `acme_gw`.
 * Flattening is many-to-one: provider ids differing only in unsafe
 * characters share a file — sigrun provider ids are slugs, so this never
 * happens in practice, and the collision costs one re-fetch, not data loss.
 */
function flattenProviderId(providerId: string): string {
	const flat = providerId.replace(SAFE_FILENAME, "_");
	return flat.length > 0 ? flat : "_";
}

/** Is a parsed catalog file shaped like a `ModelsStoreEntry`? */
function isEntryShape(parsed: unknown): parsed is ModelsStoreEntry {
	return (
		typeof parsed === "object" &&
		parsed !== null &&
		Array.isArray((parsed as { models?: unknown }).models)
	);
}

/**
 * Build a `ModelsStore` rooted at `dir`: one JSON file per provider under
 * `<dir>/models/`.
 *
 * Writes are atomic — the serialized entry lands in a uniquely named
 * `<file>.<pid>-<n>.tmp` first, then `rename` swaps it in — so a crash
 * mid-write can never leave a half-written catalog, and failed writes
 * unlink their scratch file. The `AbortSignal` parameters of pi-ai's store
 * contract are accepted but unused: operations are tiny local-file writes
 * and reads, not cancellable network work.
 */
export function fileModelsStore(dir: string): ModelsStore {
	const modelsDir = join(dir, "models");
	const providerPath = (providerId: string): string =>
		join(modelsDir, `${flattenProviderId(providerId)}.json`);

	/** Warn (path, never content), delete the poisoned file, report absent. */
	const discardCorrupt = async (path: string, why: string): Promise<void> => {
		console.warn(
			`models-store: corrupt catalog file ${path} (${why}); deleting — it will be re-fetched`,
		);
		await rm(path, { force: true });
	};

	return {
		read: async (providerId) => {
			const path = providerPath(providerId);
			let raw: string;
			try {
				raw = await readFile(path, "utf8");
			} catch (error) {
				if (
					typeof error === "object" &&
					error !== null &&
					(error as { code?: string }).code === "ENOENT"
				) {
					return undefined;
				}
				throw error;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				await discardCorrupt(path, "not valid JSON");
				return undefined;
			}
			if (!isEntryShape(parsed)) {
				await discardCorrupt(path, "models must be an array");
				return undefined;
			}
			return parsed;
		},
		write: async (providerId, entry) => {
			await mkdir(modelsDir, { recursive: true });
			const path = providerPath(providerId);
			const scratch = `${path}.${process.pid}-${scratchCounter++}.tmp`;
			try {
				await writeFile(scratch, JSON.stringify(entry), "utf8");
				await rename(scratch, path);
			} catch (error) {
				await rm(scratch, { force: true });
				throw error;
			}
		},
		delete: async (providerId) => {
			await rm(providerPath(providerId), { force: true });
		},
	};
}
