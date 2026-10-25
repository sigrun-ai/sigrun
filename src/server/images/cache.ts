/**
 * The image proxy's on-disk LRU cache (UI-blocks U7 Task 3, spec §11.2):
 * entries live under `<cacheDir>/images/` (pod-local and outside backups,
 * like the other cache roots), keyed by `sha256(u)` plus the `as`
 * variant — NEVER the signed URL, whose signature changes on every
 * serve. Capacity is 256 MiB by default; eviction is least-recently-hit
 * first. Failures are never cached (callers `put` successful fetches
 * only).
 *
 * Layout: each entry is one file `<sha256(u)>.<variant>` beside ONE
 * `index.json` (the metadata table: type, size, added-at, last-hit,
 * pin). The index is written atomically on every mutation, so a re-open
 * (the same cache dir, a new process) serves the prior entries.
 *
 * Eviction never deletes a file currently being STREAMED or WRITTEN
 * (Review Focus 5): a `get` hit pins its entry until the returned
 * stream closes (or the caller's response finishes), and a `put` holds
 * its pin for the write's duration; the eviction pass skips pinned
 * entries and takes the next-oldest instead.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { SniffedImage } from "./sniff.js";

/** The images subdirectory under the cache root. */
export const IMAGES_CACHE_DIR = "images";
/** The default capacity: 256 MiB (spec §11.2). */
export const CACHE_CAPACITY_BYTES = 256 * 1024 * 1024;

/** The index's on-disk shape (one metadata row per entry file). */
interface IndexEntry {
	/** The sniffed content type (the file extension is the variant). */
	readonly type: SniffedImage;
	/** Byte size (the capacity accounting's unit). */
	readonly size: number;
	/** Epoch ms the entry was written (eviction tie-break). */
	readonly addedAt: number;
	/** Epoch ms of the last `get` hit (the LRU order). */
	lastHit: number;
	/** Open streams + in-flight writes (eviction skips pinned entries). */
	pins: number;
}

interface IndexFile {
	readonly entries: Record<string, { type: SniffedImage; size: number; addedAt: number; lastHit: number }>;
}

/** One cache hit: the type and a streaming reader over the file. */
export interface CacheHit {
	readonly type: SniffedImage;
	readonly stream: Readable;
}

/** The sha256-of-url + variant entry key (never the signed URL). */
function entryKey(u: string, variant: string): string {
	return `${createHash("sha256").update(u, "utf8").digest("hex")}.${variant}`;
}

/**
 * The `<cacheDir>/images/` LRU cache. Construct with the CACHE ROOT (the
 * `images/` child is created lazily on the first put / at open when the
 * index exists). `capacityBytes` is test-overridable; the default is the
 * spec's 256 MiB.
 */
export class ImageCache {
	private readonly dir: string;
	private readonly indexPath: string;
	private readonly capacityBytes: number;
	private readonly entries = new Map<string, IndexEntry>();
	private opened = false;
	private closed = false;

	constructor(
		cacheRoot: string,
		options?: { capacityBytes?: number },
	) {
		this.dir = join(cacheRoot, IMAGES_CACHE_DIR);
		this.indexPath = join(this.dir, "index.json");
		this.capacityBytes = options?.capacityBytes ?? CACHE_CAPACITY_BYTES;
	}

	/** Open: load the index (creating the dir lazily). Idempotent. */
	private async open(): Promise<void> {
		if (this.opened) return;
		this.opened = true;
		let raw: string;
		try {
			raw = await readFile(this.indexPath, "utf8");
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
			throw cause;
		}
		// A corrupt index is rebuilt EMPTY (the files on disk are then
		// orphaned until their names recur; a fresh fetch rewrites them).
		// The cache is a cache: losing it is never an error worth
		// refusing to boot over.
		let parsed: IndexFile;
		try {
			parsed = JSON.parse(raw) as IndexFile;
		} catch {
			return;
		}
		for (const [key, entry] of Object.entries(parsed.entries)) {
			this.entries.set(key, { ...entry, pins: 0 });
		}
	}

	/** One hit, or `undefined` on a miss. `now` stamps the LRU order. */
	async get(u: string, variant: string, now?: number): Promise<CacheHit | undefined> {
		await this.open();
		const key = entryKey(u, variant);
		const entry = this.entries.get(key);
		if (entry === undefined) return undefined;
		const file = join(this.dir, key);
		try {
			await stat(file);
		} catch {
			// The index names a file that isn't there (a hand-cleaned dir):
			// drop the row and miss.
			this.entries.delete(key);
			await this.persist();
			return undefined;
		}
		entry.lastHit = now ?? Date.now();
		entry.pins += 1;
		await this.persist();
		const stream = createReadStream(file);
		const unpin = (): void => {
			entry.pins -= 1;
		};
		stream.once("close", unpin);
		stream.once("error", unpin);
		return { type: entry.type, stream };
	}

	/**
	 * Store one fetched image. The write is staged and renamed (atomic:
	 * a concurrent `get` never reads a half-written file) and the entry
	 * is pinned for the write's duration — the eviction pass a same-key
	 * overwrite triggers can never remove the file mid-rename.
	 */
	async put(
		u: string,
		variant: string,
		type: SniffedImage,
		body: Buffer,
		now?: number,
	): Promise<void> {
		await this.open();
		if (this.closed) return;
		const key = entryKey(u, variant);
		const at = now ?? Date.now();
		const entry: IndexEntry = {
			type,
			size: body.byteLength,
			addedAt: at,
			lastHit: at,
			pins: 1,
		};
		this.entries.set(key, entry);
		await mkdir(this.dir, { recursive: true });
		const file = join(this.dir, key);
		const staged = `${file}.${randomUUID()}.tmp`;
		try {
			await writeFile(staged, body, { mode: 0o644 });
			await rename(staged, file);
		} catch (cause) {
			await rm(staged, { force: true }).catch(() => {});
			this.entries.delete(key);
			throw cause;
		} finally {
			entry.pins -= 1;
		}
		await this.evict();
		await this.persist();
	}

	/** Evict least-recently-hit entries until total size fits capacity. */
	private async evict(): Promise<void> {
		let total = 0;
		for (const entry of this.entries.values()) total += entry.size;
		if (total <= this.capacityBytes) return;
		const oldestFirst = [...this.entries.entries()].sort(
			(a, b) => a[1].lastHit - b[1].lastHit || a[1].addedAt - b[1].addedAt,
		);
		for (const [key, entry] of oldestFirst) {
			if (total <= this.capacityBytes) break;
			// Never delete a file a response is streaming or a put is
			// writing (Review Focus 5): skip it and take the next-oldest.
			if (entry.pins > 0) continue;
			this.entries.delete(key);
			total -= entry.size;
			await rm(join(this.dir, key), { force: true }).catch(() => {});
		}
	}

	/** Write the index (staged + renamed; the stores' discipline). */
	private async persist(): Promise<void> {
		if (this.closed) return;
		if (this.entries.size === 0) {
			// An empty table is written too — a re-open then starts empty
			// instead of resurrecting rows whose files are gone.
		}
		await mkdir(this.dir, { recursive: true });
		const file: IndexFile = {
			entries: Object.fromEntries(
				[...this.entries.entries()].map(([key, entry]) => [
					key,
					{
						type: entry.type,
						size: entry.size,
						addedAt: entry.addedAt,
						lastHit: entry.lastHit,
					},
				]),
			),
		};
		const staged = `${this.indexPath}.${randomUUID()}.tmp`;
		try {
			await writeFile(staged, `${JSON.stringify(file)}\n`, { mode: 0o644 });
			await chmod(staged, 0o644);
			await rename(staged, this.indexPath);
		} catch (cause) {
			await rm(staged, { force: true }).catch(() => {});
			throw cause;
		}
	}

	/** Flush the index; further `put`/`persist` calls no-op. */
	async close(): Promise<void> {
		if (this.closed) return;
		await this.persist();
		this.closed = true;
	}
}
