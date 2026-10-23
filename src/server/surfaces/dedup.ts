/**
 * Action dedup (UI-blocks U3 Task 3, spec §6.1): the server invokes a
 * surface action handler at most once per `actionId` per surface
 * instance within a 10-minute window; a duplicate POST returns the
 * FIRST invocation's stored result (retries are safe). Entries are
 * keyed by actionId alone — actionIds are channel-generated UUIDs —
 * with the instance composite (`slugidkey`) stored on the entry so a
 * collision across instances is treated as a distinct action, not a
 * replay of another instance's result.
 *
 * Process-memory only, like the service's rev state (§7.3). Entries
 * expire lazily on read; a bounded sweep caps memory between reads.
 */

import type { ActionResponse } from "./service.js";

/** The dedup window (spec §6.1): 10 minutes. */
export const DEDUP_WINDOW_MS = 10 * 60 * 1000;

/** One recorded invocation: its instance and its stored result. */
interface DedupEntry {
	readonly composite: string;
	readonly result: ActionResponse;
	readonly expiresAt: number;
}

/** A same-instance duplicate hit: the first invocation's stored result. */
export interface DedupHit {
	readonly result: ActionResponse;
}

/**
 * The actionId → result table. `check` returns the stored result on a
 * same-instance duplicate (and `null` when a different instance already
 * holds the actionId — the caller treats that as a fresh action);
 * `record` stores the first result.
 */
export class ActionDedup {
	private readonly entries = new Map<string, DedupEntry>();
	private readonly clock: () => number;
	private sweepCounter = 0;

	constructor(clock?: () => number) {
		// Resolve Date.now at CALL time, not construction: a default
		// parameter (`clock = Date.now`) would capture the Date.now of
		// whichever fake-timer install was active at construction and
		// freeze this table to that install's clock.
		this.clock = clock ?? (() => Date.now());
	}

	/**
	 * Look one actionId up for one instance: the stored result on a
	 * duplicate, `undefined` when never seen, `null` when the actionId
	 * belongs to a different instance (treated as fresh by the caller).
	 */
	check(
		actionId: string,
		composite: string,
	): DedupHit | undefined | null {
		const entry = this.entries.get(actionId);
		if (entry === undefined) return undefined;
		if (entry.expiresAt <= this.clock()) {
			this.entries.delete(actionId);
			return undefined;
		}
		if (entry.composite !== composite) return null;
		return { result: entry.result };
	}

	/** Record the first result of one actionId for one instance. */
	record(actionId: string, composite: string, result: ActionResponse): void {
		this.entries.set(actionId, {
			composite,
			result,
			expiresAt: this.clock() + DEDUP_WINDOW_MS,
		});
		this.sweepCounter += 1;
		if (this.sweepCounter >= 64) {
			this.sweepCounter = 0;
			const now = this.clock();
			for (const [id, entry] of this.entries) {
				if (entry.expiresAt <= now) this.entries.delete(id);
			}
		}
	}
}
