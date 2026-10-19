/**
 * The mtime-reloading JSON file helper behind every identity store
 * (core hardening W1 Task 2, spec §5.4 "Store semantics"): identity
 * files are small, mutated by whole-file read-modify-write, and shared
 * with the CLI — a SEPARATE process — so:
 *
 - reads are SYNCHRONOUS and reload whenever the file's
   `(mtimeMs, size)` fingerprint changes, checked per access (a CLI
   revoke or user add is honored live, no restart);
 - writes go through {@link writeFileAtomic} (temp file + rename, mode
   `0600`), so a concurrent reader sees the old complete file or the
   new complete file — never a half-written one (Review Focus 5).
 *
 * The read cache is module-wide and keyed by path: store instances on
 * the same path share one entry, validated against the file's CURRENT
 * stat per access, so a write through one instance is immediately
 * visible through another. Cross-process, the same stat check is the
 * contract (mtime granularity + size; a same-ms same-size clobber is
 * the accepted last-writer-wins at household scale).
 *
 * A malformed file (unparseable JSON, or a non-array where a record
 * array is expected) fails LOUD, naming the path — the
 * `readJsonObject` posture: never a silent reset of identity data.
 */

import { readFileSync, statSync } from "node:fs";
import { writeFileAtomic } from "../stores.js";

/** One cached parse plus the stat fingerprint it was read under. */
interface CacheEntry {
	readonly mtimeMs: number;
	readonly size: number;
	readonly value: unknown;
}

/**
 * path → the last parse and the stat it was read under. Module-wide
 * (never per-store): two store instances over one file are one cache.
 */
const cache = new Map<string, CacheEntry>();

/**
 * Read one JSON file, reloading when its stat fingerprint changed since
 * the last read of this path (checked on EVERY call). Absent file →
 * `fallback` (first use is not an error); the absent state is uncached
 * so the file's creation is seen by the very next read. Unparseable
 * JSON fails loud, naming the path (never a silent reset of identity
 * data).
 */
export function readJson<T>(path: string, fallback: T): T {
	let stat;
	try {
		stat = statSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			cache.delete(path);
			return fallback;
		}
		throw error;
	}
	const cached = cache.get(path);
	if (
		cached !== undefined &&
		cached.mtimeMs === stat.mtimeMs &&
		cached.size === stat.size
	) {
		return cached.value as T;
	}
	let value: T;
	try {
		value = JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		throw new Error(
			`sigrun: malformed JSON in ${path}: ${String(error)}`,
			{ cause: error },
		);
	}
	cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, value });
	return value;
}

/**
 * Read a record-array store file: absent → `[]`; anything but a JSON
 * array is a malformed store, loud with the path named.
 */
export function readRecords<T>(path: string): T[] {
	const value = readJson<unknown>(path, []);
	if (!Array.isArray(value)) {
		throw new Error(
			`sigrun: ${path} must contain a JSON array of records`,
		);
	}
	return value as T[];
}

/**
 * Write one JSON value the house way (tabs, trailing newline),
 * atomically, mode `0600` — identity files all carry credential
 * material (token hashes, emails, invite hashes). The path's cache
 * entry is invalidated (never eagerly re-statted): the next read
 * re-stats and sees the new file.
 */
export async function writeJson(
	path: string,
	value: unknown,
): Promise<void> {
	await writeFileAtomic(path, `${JSON.stringify(value, null, "\t")}\n`, 0o600);
	cache.delete(path);
}

/**
 * A per-store-instance FIFO mutex (the "store semantics" serialization
 * rule): every mutating method chains on one tail promise, so
 * concurrent calls run strictly one-at-a-time and each sees the prior
 * one's write — two concurrent redeems of one invite code yield
 * exactly one success. A rejected operation never poisons the tail.
 * Two instances over one path each serialize their OWN calls; across
 * instances (and processes) atomic rename keeps files whole, with
 * last-writer-wins the accepted resolution.
 */
export class MutationQueue {
	private tail: Promise<unknown> = Promise.resolve();

	/** Chain `op` on the tail; resolves/rejects with op's own outcome. */
	run<T>(op: () => T | Promise<T>): Promise<T> {
		const next = this.tail.then(op, op);
		this.tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}
