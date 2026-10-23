/**
 * The surface watcher registry (UI-blocks U3 Task 4, spec §7.3): which
 * `/v1/events` stream is looking at which surface instance. An entry is
 * `(stream, user, slug, id, key, access)` where `access` is what the
 * principal's last fetch returned — the events route delivers
 * `surface.changed` ONLY to streams whose stored access is not `none`,
 * using the STORED access (an event never triggers a re-render per
 * watcher).
 *
 * Lifecycle: a surface render/data fetch carrying `X-Sigrun-Stream`
 * creates or refreshes the entry (`touch`); a stream close drops every
 * entry of that stream (`dropStream`); an entry expires 10 minutes
 * after its last fetch — channels make a `since` fetch every 5 minutes
 * while a surface is visible, so the keepalive costs nothing when
 * nothing changed.
 *
 * Memory-only, per process (matching the service's rev state): a
 * restart forgets watchers; reconnecting channels re-register via the
 * hello frame's new streamId plus a re-fetch of every visible surface.
 */

import type { SurfaceAccess } from "./service.js";

/** The watcher entry lifetime (spec §7.3): 10 minutes after the last fetch. */
export const WATCHER_TTL_MS = 10 * 60 * 1000;

/** One watcher entry. */
interface WatcherEntry {
	readonly stream: string;
	readonly user: string;
	readonly slug: string;
	readonly id: string;
	readonly key: string;
	readonly access: SurfaceAccess;
	/** The last fetch's time (the expiry base). */
	at: number;
}

/**
 * The registry. The clock resolves at CALL time (the access cache /
 * dedup / rate-limit rule: a fake-timer install mid-process must not
 * freeze entries at construction time).
 */
export class WatcherRegistry {
	/** Entries keyed `${stream} ${slug} ${id} ${key}` (\u0001-joined). */
	private readonly entries = new Map<string, WatcherEntry>();
	/** Stream → its composite keys (dropStream's index). */
	private readonly byStream = new Map<string, Set<string>>();

	/**
	 * Create or refresh one entry: a fetch by `user` on stream `stream`
	 * of instance `(slug, id, key)` resolved to `access` — INCLUDING
	 * `none` (stored, so the events route excludes it without a
	 * re-render; the fetch itself got the 404).
	 */
	touch(
		stream: string,
		user: string,
		slug: string,
		id: string,
		key: string,
		access: SurfaceAccess,
	): void {
		const composite = [stream, slug, id, key].join("");
		if (!this.entries.has(composite)) {
			let keys = this.byStream.get(stream);
			if (keys === undefined) {
				keys = new Set();
				this.byStream.set(stream, keys);
			}
			keys.add(composite);
		}
		this.entries.set(composite, {
			stream,
			user,
			slug,
			id,
			key,
			access,
			at: Date.now(),
		});
	}

	/** Drop every entry of one stream (its connection closed). */
	dropStream(stream: string): void {
		const keys = this.byStream.get(stream);
		if (keys === undefined) return;
		this.byStream.delete(stream);
		for (const composite of keys) this.entries.delete(composite);
	}

	/**
	 * The streams watching one instance, EXCLUDING entries whose stored
	 * access is `none` and entries older than the 10-minute TTL (lazy
	 * expiry: expired entries are dropped on the read that finds them).
	 */
	streamsFor(slug: string, id: string, key: string): string[] {
		const now = Date.now();
		const streams: string[] = [];
		for (const [composite, entry] of this.entries) {
			if (now - entry.at >= WATCHER_TTL_MS) {
				this.entries.delete(composite);
				const keys = this.byStream.get(entry.stream);
				keys?.delete(composite);
				if (keys !== undefined && keys.size === 0) {
					this.byStream.delete(entry.stream);
				}
				continue;
			}
			if (entry.access === "none") continue;
			if (entry.slug === slug && entry.id === id && entry.key === key) {
				streams.push(entry.stream);
			}
		}
		return streams;
	}
}
