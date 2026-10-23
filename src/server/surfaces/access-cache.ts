/**
 * The per-principal access cache (UI-blocks U3 Task 2, spec §6.5): the
 * server caches the access verdict of each render, keyed by
 * `(slug, id, key, principal.user)`, for 60 seconds. An action checks
 * the cached verdict first; a miss (expired or never rendered) is not
 * an allow — the caller re-renders for that principal and caches its
 * answer before deciding. One principal's entry never answers for
 * another (`principal.user` is part of the key).
 */

import type { SurfaceAccessLevel } from "../../extension.js";

/** The cache TTL (spec §6.5): 60 seconds. */
export const ACCESS_CACHE_TTL_MS = 60_000;

/** One cached verdict: the access level and its expiry (epoch ms). */
interface AccessEntry {
	readonly access: SurfaceAccessLevel;
	readonly expiresAt: number;
}

/** The cache store: composite-key → verdict, expiring lazily on read. */
export class AccessCache {
	private readonly entries = new Map<string, AccessEntry>();
	private readonly now: () => number;

	/** @param now the clock (tests inject a fake; production passes Date.now). */
	constructor(now: () => number = () => Date.now()) {
		this.now = now;
	}

	private static composite(
		slug: string,
		id: string,
		key: string,
		user: string | undefined,
	): string {
		// The unit separator keeps segments unambiguous (no escaping needed).
		return [slug, id, key, user ?? ""].join("\u0001");
	}

	/** The cached verdict for this principal, or undefined on a miss/expiry. */
	get(
		slug: string,
		id: string,
		key: string,
		user: string | undefined,
	): SurfaceAccessLevel | undefined {
		const composite = AccessCache.composite(slug, id, key, user);
		const entry = this.entries.get(composite);
		if (entry === undefined) return undefined;
		if (entry.expiresAt <= this.now()) {
			this.entries.delete(composite);
			return undefined;
		}
		return entry.access;
	}

	/** Cache one principal's verdict for the TTL. */
	set(
		slug: string,
		id: string,
		key: string,
		user: string | undefined,
		access: SurfaceAccessLevel,
	): void {
		this.entries.set(AccessCache.composite(slug, id, key, user), {
			access,
			expiresAt: this.now() + ACCESS_CACHE_TTL_MS,
		});
	}
}
