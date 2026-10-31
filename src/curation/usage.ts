/**
 * Usage telemetry (curator P4, spec §6.4): per-user counters of how the
 * owner's skills are USED — `load_skill` calls, `/skill:` expansions
 * and core `read`-tool reads inside the learned root. The curator's
 * ranking input (what to keep, what to archive: a skill nobody loads is
 * a candidate; a `load_skill`-heavy, `read`-light skill is healthy).
 *
 * Storage: `curationDir/usage.json`, one `{skill: {load, expand, read,
 * lastUsed}}` record per skill, written at most once per 10 s per user
 * (the data is advisory — no reason to hammer the disk on every load).
 * `bump` accumulates in memory; `flush` merges the pending bumps over
 * the file's current contents and writes, so a fresh process (a restart,
 * a second server) keeps counting from what was flushed.
 *
 * Known gap (documented): `bash cat` of a learned file does NOT count —
 * the shell path never sees a skill-shaped read. Only the three
 * model-facing seams bump.
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { curationDir } from "./paths.js";

/** What happened to a skill (the three counting seams). */
export type UsageKind = "load" | "expand" | "read";

/** One skill's counters as flushed (and re-read on the next process). */
export interface UsageRecord {
	load?: number;
	expand?: number;
	read?: number;
	lastUsed: string;
}

/** One skill's pending bumps since the last successful flush. */
interface Pending {
	load: number;
	expand: number;
	read: number;
	lastUsed: string;
}

/** What a `UsageCounters` needs: the user's area and user. */
export interface UsageCountersOptions {
	/** The owner's user area: `<dataDir>/users/<user>`. */
	readonly userArea: string;
	readonly user: string;
	/** The clock (tests pin/advance the instant; default is the real one). */
	readonly now?: () => Date;
}

/** The flush interval: writes at most once per 10 s per user. */
const FLUSH_INTERVAL_MS = 10_000;

const KINDS: readonly UsageKind[] = ["load", "expand", "read"];

/**
 * The per-user usage counters. `bump` is in-memory bookkeeping; `flush`
 * persists to `curationDir/usage.json`, a no-op inside the 10 s window
 * since the last successful write. The counting seams bump and flush
 * opportunistically (the throttle keeps it cheap); a process exit loses
 * at most the last window's advisory data — accepted.
 */
export class UsageCounters {
	private readonly options: UsageCountersOptions;
	/** Bumps since the last successful flush (per skill). */
	private readonly pending = new Map<string, Pending>();
	/** The last flushed state, as far as this instance knows. */
	private flushed: { [skill: string]: UsageRecord } = {};

	private lastFlush: number | undefined;

	constructor(options: UsageCountersOptions) {
		this.options = options;
	}

	/** Count one use of one skill. */
	bump(skill: string, kind: UsageKind): void {
		const at = this.now().toISOString();
		const current = this.pending.get(skill);
		const next: Pending =
			current === undefined
				? { load: 0, expand: 0, read: 0, lastUsed: at }
				: { ...current, lastUsed: at };
		next[kind] += 1;
		this.pending.set(skill, next);
	}

	/** The skill's most recent use, ISO 8601; `undefined` when never. */
	lastUsed(skill: string): string | undefined {
		void this.options.user;
		const pending = this.pending.get(skill);
		if (pending !== undefined) return pending.lastUsed;
		return this.flushed[skill]?.lastUsed;
	}

	/**
	 * Persist the pending bumps, merged over the file's CURRENT contents
	 * (a concurrent or earlier process's counts survive). A no-op inside
	 * the 10 s window since the last successful write.
	 */
	async flush(): Promise<void> {
		const at = this.now().getTime();
		if (
			this.lastFlush !== undefined &&
			at - this.lastFlush < FLUSH_INTERVAL_MS
		) {
			return;
		}
		const disk = await this.readDisk();
		const merged: { [skill: string]: UsageRecord } = { ...disk };
		for (const [skill, bumps] of this.pending) {
			const previous = disk[skill];
			const record: UsageRecord = { ...(previous ?? {}) };
			for (const kind of KINDS) {
				if (bumps[kind] > 0) {
					record[kind] = (previous?.[kind] ?? 0) + bumps[kind];
				}
			}
			record.lastUsed = bumps.lastUsed;
			merged[skill] = record;
		}
		const path = join(curationDir(this.options.userArea), "usage.json");
		await mkdir(join(path, ".."), { recursive: true });
		const temp = `${path}.${randomUUID()}.tmp`;
		await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`);
		await rename(temp, path);
		this.pending.clear();
		this.flushed = merged;
		this.lastFlush = at;
	}

	private now(): Date {
		return this.options.now?.() ?? new Date();
	}

	/** Read the file's current contents; `{}` when absent or unreadable. */
	private async readDisk(): Promise<{ [skill: string]: UsageRecord }> {
		try {
			const text = await readFile(
				join(curationDir(this.options.userArea), "usage.json"),
				"utf8",
			);
			const parsed = JSON.parse(text) as { [skill: string]: UsageRecord };
			return parsed;
		} catch {
			return {};
		}
	}
}
