/**
 * The per-user notice store (notices spec §3/§5): one `notices.json` per
 * user area, `createdAt`-stamped, written atomically, and never trusted
 * on the way back in.
 *
 * The store is the ONLY writer of the file, and it is deliberately
 * stateless: every operation reads the file under the module-level
 * per-`userArea` mutex, so two store instances (a restarted process, a
 * second server) sharing one area cannot lose each other's posts — the
 * mutex spans the whole read-modify-write, not just the rename. The file
 * itself is small (at most `NOTICE_LIMITS.perUser` entries), so the read
 * is cheaper than the bookkeeping a cache would need to stay honest.
 *
 * Two things the store enforces that the shared validator does not:
 *
 *  - the three core-assigned fields (`id`, `owner`, `at`) are checked
 *    here (UUID, extension slug, ISO instant) because
 *    `validateNoticeShape` deliberately rebuilds its answer from the
 *    input's validated fields only — a stored `id` is never its input;
 *  - the `userCreatedAt` stamp: a file written for a previous directory
 *    record of the same name (deleted and re-created) is discarded, the
 *    belt to the explicit removal on user deletion.
 *
 * Load re-validation uses `validateNoticeShape` and NOT
 * `validateNoticeInput`: a stored notice whose extension is disabled or
 * unloaded must stay dismissible (spec §3), so the declared-handler gate
 * belongs to the post path only.
 *
 * Change events are the service's `notice.changed` feed: every mutation
 * is ONE atomic write, and the `onChange` calls for it fire afterwards,
 * in the order the spec names — the cleared old notice, the evicted
 * notices, then the posted new one.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NOTICE_LIMITS, type UserNotice, type UserNoticeInput } from "@sigrun/shared/notices";
import { writeFileAtomic } from "../harness/stores.js";
import { validateNoticeShape } from "./validate.js";

/** One store's change notification (the service publishes it as `notice.changed`). */
export interface NoticeChange {
	/** The user whose file changed (always this store's user). */
	readonly user: string;
	/** The affected notices, newest first. */
	readonly ids: readonly string[];
	readonly change: "posted" | "cleared";
}

/** What a `NoticeStore` needs: its user area, its user, and its seams. */
export interface NoticeStoreOptions {
	/** The user's state directory; the file is `<userArea>/notices.json`. */
	readonly userArea: string;
	readonly user: string;
	/**
	 * The directory record's `createdAt` for this user, `undefined` when
	 * the directory has no record (a principal without a user). Stamped
	 * into the file and compared on every load.
	 */
	readonly userCreatedAt: () => number | undefined;
	/** The clock: `at` on every posted notice. */
	readonly now: () => Date;
	/** Called once per emitted change, after the write committed. */
	readonly onChange: (change: NoticeChange) => void;
	/** Diagnostics (a dropped entry, a discarded file). */
	readonly log: (line: string) => void;
}

/** The file format version; a different `v` reads as an empty file. */
const FILE_VERSION = 1;

/** The file's on-disk envelope. */
interface NoticeFile {
	readonly v: number;
	/** `null` when the directory has no record for the user. */
	readonly userCreatedAt: number | null;
	readonly notices: readonly unknown[];
}

/** A `randomUUID()` id: lowercase hex, version/variant nibbles unconstrained. */
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An extension slug (`slugifyName`'s alphabet, non-empty). */
const OWNER_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** The instant shape `Date#toISOString` writes. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * userArea → the tail of that area's mutation chain. Module-level, so
 * every `NoticeStore` over one area serializes against every other (the
 * brief's per-`userArea` mutex), not just against itself.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * Run `section` under the user area's mutex: it starts only after the
 * previous section settles (either way — a failed write must not wedge
 * the chain), and the next waiter sees this section's tail. The returned
 * promise carries `section`'s own settlement to its caller.
 */
function withUserAreaLock<T>(userArea: string, section: () => Promise<T>): Promise<T> {
	const tail = queues.get(userArea) ?? Promise.resolve();
	const run = tail.then(section, section);
	queues.set(
		userArea,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	return run;
}

/** One mutation's outcome: the caller's answer plus the new file, if any. */
interface Mutation<T> {
	readonly value: T;
	/** The new file contents; absent = nothing changed (no write, no events). */
	readonly notices?: readonly UserNotice[];
	/** The changes to emit, in order; only present with `notices`. */
	readonly changes?: readonly NoticeChange[];
}

/** A loaded entry: accepted, or rejected with the reason to log. */
type Loaded =
	| { ok: true; notice: UserNotice }
	| { ok: false; reason: string };

/**
 * The per-user notice store. Construct one per user; instances over one
 * `userArea` share the mutation chain and therefore see each other's
 * writes.
 */
export class NoticeStore {
	private readonly path: string;
	/** The stamp-mismatch line is logged once per instance, not per read. */
	private stampWarned = false;

	constructor(private readonly options: NoticeStoreOptions) {
		this.path = join(options.userArea, "notices.json");
	}

	/** This user's notices, newest first. */
	async list(): Promise<readonly UserNotice[]> {
		return newestFirst(await this.readFile());
	}

	/** One notice by id, or `undefined`. */
	async get(id: string): Promise<UserNotice | undefined> {
		const notices = await this.readFile();
		return notices.find((notice) => notice.id === id);
	}

	/**
	 * Post one notice from `owner`: a same-(owner, key) notice is replaced
	 * (the new notice mints a NEW id, so a stale click answers 404 rather
	 * than hitting newer content), then the caps evict, then the post is
	 * announced.
	 */
	async post(owner: string, input: UserNoticeInput): Promise<UserNotice> {
		return await this.mutate((notices) => {
			const working = [...notices];
			const changes: NoticeChange[] = [];

			// 1. A same-(owner, key) replace removes the old notice first.
			if (input.key !== undefined) {
				const index = working.findIndex(
					(notice) => notice.owner === owner && notice.key === input.key,
				);
				if (index !== -1) {
					const [replaced] = working.splice(index, 1);
					changes.push(this.change("cleared", [replaced.id]));
				}
			}

			// 2. The new notice is appended (`id`/`owner`/`at` win over any
			//    same-named input field — they are core-assigned). The instant
			//    is read INSIDE the lock, so the file order and the `at` order
			//    agree even when two posts race.
			const notice: UserNotice = {
				...input,
				id: randomUUID(),
				owner,
				at: this.options.now().toISOString(),
			};
			working.push(notice);

			// 3. The caps evict, oldest first: this owner's, then the user's
			//    across every extension. Both ride ONE cleared event.
			const evicted: string[] = [];
			while (
				working.filter((entry) => entry.owner === owner).length >
				NOTICE_LIMITS.perExtension
			) {
				const id = evictOldest(working, (entry) => entry.owner === owner);
				if (id !== undefined) evicted.push(id);
			}
			while (working.length > NOTICE_LIMITS.perUser) {
				const id = evictOldest(working, () => true);
				if (id !== undefined) evicted.push(id);
			}
			if (evicted.length > 0) changes.push(this.change("cleared", evicted));

			// 4. The post is announced last.
			changes.push(this.change("posted", [notice.id]));
			return { value: notice, notices: working, changes };
		});
	}

	/** Remove this owner's notice carrying `key`; returns the removed ids. */
	async clearByKey(owner: string, key: string): Promise<readonly string[]> {
		return await this.remove(
			(notice) => notice.owner === owner && notice.key === key,
		);
	}

	/** Remove this owner's notice by id (the extension's own clear). */
	async clearById(owner: string, id: string): Promise<readonly string[]> {
		return await this.remove((notice) => notice.owner === owner && notice.id === id);
	}

	/** The user dismisses one notice (any extension's); false when absent. */
	async dismiss(id: string): Promise<boolean> {
		const removed = await this.remove((notice) => notice.id === id);
		return removed.length > 0;
	}

	/** The user dismisses everything; returns every removed id. */
	async dismissAll(): Promise<readonly string[]> {
		return await this.remove(() => true);
	}

	/** Remove the notices tied to one conversation (app-wide ones stay). */
	async clearConversation(conversationId: number): Promise<readonly string[]> {
		return await this.remove((notice) => notice.conversationId === conversationId);
	}

	/**
	 * Remove the file outright (user deletion). No change event: the user
	 * the events would address is gone.
	 */
	async removeFile(): Promise<void> {
		await withUserAreaLock(this.options.userArea, async () => {
			await rm(this.path, { force: true });
		});
	}

	/**
	 * Remove every notice `predicate` accepts, as one write and one
	 * `cleared` change. Returns the removed ids, newest first; nothing
	 * matched = no write and no change.
	 */
	private async remove(
		predicate: (notice: UserNotice) => boolean,
	): Promise<readonly string[]> {
		return await this.mutate((notices) => {
			const removed = notices.filter(predicate);
			if (removed.length === 0) return { value: [] };
			const ids = newestFirst(removed).map((notice) => notice.id);
			return {
				value: ids,
				notices: notices.filter((notice) => !predicate(notice)),
				changes: [this.change("cleared", ids)],
			};
		});
	}

	/** Run one read-modify-write under the area's mutex, then emit. */
	private async mutate<T>(
		step: (notices: readonly UserNotice[]) => Mutation<T>,
	): Promise<T> {
		return await withUserAreaLock(this.options.userArea, async () => {
			const mutation = step(await this.readFile());
			if (mutation.notices !== undefined) {
				await this.writeFile(mutation.notices);
				for (const change of mutation.changes ?? []) this.options.onChange(change);
			}
			return mutation.value;
		});
	}

	/** One atomic write (stage + rename), one file. */
	private async writeFile(notices: readonly UserNotice[]): Promise<void> {
		const file: NoticeFile = {
			v: FILE_VERSION,
			userCreatedAt: this.options.userCreatedAt() ?? null,
			notices,
		};
		await mkdir(dirname(this.path), { recursive: true });
		// 0600: one user's messages, never shared state — the sandbox policy
		// keeps the agent out of the user area, this is the belt.
		await writeFileAtomic(this.path, `${JSON.stringify(file, null, "\t")}\n`, 0o600);
	}

	/**
	 * Read and re-validate the file. Every failure mode reads as an empty
	 * file (a missing one is simply empty) — the file is never trusted,
	 * and a notice system must not fail closed on its own storage.
	 */
	private async readFile(): Promise<readonly UserNotice[]> {
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			this.options.log(`notices: cannot read ${this.path}: ${String(error)}`);
			return [];
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			this.options.log(`notices: discarding ${this.path}: unparseable JSON (${String(error)})`);
			return [];
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed) ||
			(parsed as NoticeFile).v !== FILE_VERSION ||
			!Array.isArray((parsed as NoticeFile).notices)
		) {
			this.options.log(`notices: discarding ${this.path}: not a version ${FILE_VERSION} notice file`);
			return [];
		}
		const file = parsed as NoticeFile;

		// The stamp: a file written for a previous directory record of the
		// same name (a deleted and re-created username) is void.
		const stamped = file.userCreatedAt ?? null;
		const current = this.options.userCreatedAt() ?? null;
		if (stamped !== current) {
			if (!this.stampWarned) {
				this.stampWarned = true;
				this.options.log(
					`notices: discarding ${this.path}: stamped for directory record ${String(stamped)}, current is ${String(current)}`,
				);
			}
			return [];
		}

		const notices: UserNotice[] = [];
		for (const entry of file.notices) {
			const loaded = acceptEntry(entry);
			if (!loaded.ok) {
				this.options.log(`notices: dropped an entry in ${this.path}: ${loaded.reason}`);
				continue;
			}
			notices.push(loaded.notice);
		}
		return notices;
	}

	private change(change: NoticeChange["change"], ids: readonly string[]): NoticeChange {
		return { user: this.options.user, ids, change };
	}
}

/**
 * Accept one stored entry: the shared shape validation (no handler
 * check), then the three core-assigned fields the shared validator never
 * sees.
 */
function acceptEntry(entry: unknown): Loaded {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		return { ok: false, reason: "not an object" };
	}
	const record = entry as Record<string, unknown>;

	const shape = validateNoticeShape(record);
	if (!shape.ok) {
		return { ok: false, reason: `${shape.field}: ${shape.message}` };
	}

	const id = record.id;
	if (typeof id !== "string" || !ID_RE.test(id)) {
		return { ok: false, reason: "id: not a UUID" };
	}
	const owner = record.owner;
	if (typeof owner !== "string" || !OWNER_RE.test(owner)) {
		return { ok: false, reason: "owner: not an extension slug" };
	}
	const at = record.at;
	if (
		typeof at !== "string" ||
		!ISO_RE.test(at) ||
		!Number.isFinite(Date.parse(at))
	) {
		return { ok: false, reason: "at: not an ISO timestamp" };
	}

	return { ok: true, notice: { ...shape.value, id, owner, at } };
}

/** The notices newest first: by `at`, ties by file position (later = newer). */
function newestFirst(notices: readonly UserNotice[]): UserNotice[] {
	return notices
		.map((notice, index) => ({ notice, index }))
		.sort((left, right) => {
			const byAt = Date.parse(right.notice.at) - Date.parse(left.notice.at);
			return byAt !== 0 ? byAt : right.index - left.index;
		})
		.map((entry) => entry.notice);
}

/**
 * Remove the OLDEST notice `match` accepts, in place (earliest `at`; ties
 * keep the earliest file position), returning its id. `undefined` when
 * nothing matched.
 */
function evictOldest(
	notices: UserNotice[],
	match: (notice: UserNotice) => boolean,
): string | undefined {
	let index = -1;
	let oldest = Number.POSITIVE_INFINITY;
	for (let position = 0; position < notices.length; position += 1) {
		const notice = notices[position];
		if (!match(notice)) continue;
		const time = Date.parse(notice.at);
		if (time < oldest) {
			oldest = time;
			index = position;
		}
	}
	if (index === -1) return undefined;
	return notices.splice(index, 1)[0].id;
}
