/**
 * The per-user notice store (notices spec §3/§5): one `notices.json` per
 * user area, `createdAt`-stamped, written atomically under a module-level
 * per-`userArea` mutex, re-validated on every load.
 *
 * Driven directly (the unit shape): no service, no HTTP — the store's
 * caps, keyed replace, owner scoping and change-event ordering are the
 * whole subject. Temp-dir fixtures; every user area is its own directory
 * so the module-level mutex key never collides between tests.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { UserNotice, UserNoticeInput } from "@sigrun/shared/notices";
import { NoticeStore, type NoticeChange } from "../src/notices/store.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The directory record stamp the fixtures carry. */
const STAMP = 1_700_000_000_000;

/** The pinned instant every fixture clock starts from. */
const EPOCH = Date.parse("2026-11-03T00:00:00.000Z");

interface Fixture {
	readonly dir: string;
	readonly userArea: string;
	readonly file: string;
	readonly store: NoticeStore;
	readonly changes: NoticeChange[];
	readonly logs: string[];
	/** The fixture's clock: one second per call, shared by every store over this area. */
	readonly now: () => Date;
}

/**
 * One user area with a store over it. `userCreatedAt` and `now` are
 * pinned so the stamp check and the newest-first order are exact; each
 * fixture owns its own clock, so the absolute instants a test asserts do
 * not depend on the tests before it.
 */
async function setup(
	options: {
		user?: string;
		userCreatedAt?: number;
		onChange?: (change: NoticeChange) => void;
	} = {},
): Promise<Fixture> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-notices-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
	const user = options.user ?? "alice";
	const userArea = join(dir, "users", user);
	await mkdir(userArea, { recursive: true });
	const changes: NoticeChange[] = [];
	const logs: string[] = [];
	let ticks = 0;
	const now = (): Date => new Date(EPOCH + ++ticks * 1000);
	const store: NoticeStore = new NoticeStore({
		userArea,
		user,
		userCreatedAt: () => options.userCreatedAt ?? STAMP,
		now,
		onChange: (change) => {
			changes.push(change);
			options.onChange?.(change);
		},
		log: (line) => logs.push(line),
	});
	return {
		dir,
		userArea,
		file: join(userArea, "notices.json"),
		store,
		changes,
		logs,
		now,
	};
}

/** A notice input aimed at alice; the caller overrides what it needs. */
function input(overrides: Partial<UserNoticeInput> = {}): UserNoticeInput {
	return { user: "alice", title: "A notice", ...overrides };
}

/** The ids in the file as written, in file (oldest-first) order. */
async function fileIds(file: string): Promise<string[]> {
	const parsed = JSON.parse(await readFile(file, "utf8")) as {
		notices: Array<{ id: string }>;
	};
	return parsed.notices.map((notice) => notice.id);
}

/** Post `count` notices from `owner`, titled `<prefix><n>`. */
async function postMany(
	store: NoticeStore,
	owner: string,
	count: number,
	prefix = "n",
): Promise<UserNotice[]> {
	const posted: UserNotice[] = [];
	for (let index = 0; index < count; index += 1) {
		posted.push(await store.post(owner, input({ title: `${prefix}${index}` })));
	}
	return posted;
}

describe("NoticeStore", () => {
	test("post then list newest first", async () => {
		const { store, file } = await setup();
		const first = await store.post("acme-notes", input({ title: "First" }));
		const second = await store.post("acme-notes", input({ title: "Second" }));

		const listed = await store.list();
		expect(listed.map((notice) => notice.id)).toEqual([second.id, first.id]);
		expect(listed.map((notice) => notice.title)).toEqual(["Second", "First"]);

		// The record carries the three core-assigned extras.
		expect(first.owner).toBe("acme-notes");
		expect(first.at).toBe("2026-11-03T00:00:01.000Z");
		expect(first.user).toBe("alice");
		expect(first.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);

		// The file is the versioned envelope, oldest first.
		const envelope = JSON.parse(await readFile(file, "utf8")) as {
			v: number;
			userCreatedAt: number;
			notices: UserNotice[];
		};
		expect(envelope.v).toBe(1);
		expect(envelope.userCreatedAt).toBe(STAMP);
		expect(envelope.notices.map((notice) => notice.id)).toEqual([
			first.id,
			second.id,
		]);
		expect(await store.get(second.id)).toEqual(second);
		expect(
			await store.get("00000000-0000-4000-8000-000000000000"),
		).toBeUndefined();
	});

	test("replace mints a new id; the old id dismisses nothing", async () => {
		const { store, changes } = await setup();
		const original = await store.post(
			"acme-notes",
			input({ key: "review:7", title: "Learned: deploy" }),
		);
		changes.length = 0;

		const replacement = await store.post(
			"acme-notes",
			input({ key: "review:7", title: "Learned: deploy (updated)" }),
		);

		expect(replacement.id).not.toBe(original.id);
		expect(await store.get(original.id)).toBeUndefined();
		expect((await store.get(replacement.id))?.title).toBe(
			"Learned: deploy (updated)",
		);
		// One replace is two events in order: the cleared old id, then the
		// posted new one (spec §4).
		expect(changes).toEqual([
			{ user: "alice", ids: [original.id], change: "cleared" },
			{ user: "alice", ids: [replacement.id], change: "posted" },
		]);

		// A stale click on the replaced notice dismisses nothing.
		expect(await store.dismiss(original.id)).toBe(false);
		expect(await store.list()).toHaveLength(1);
	});

	test("replace may move conversationId", async () => {
		const { store } = await setup();
		await store.post(
			"acme-notes",
			input({ key: "review:7", title: "Learned", conversationId: 3 }),
		);
		const moved = await store.post(
			"acme-notes",
			input({ key: "review:7", title: "Learned", conversationId: 9 }),
		);

		expect(moved.conversationId).toBe(9);
		const listed = await store.list();
		expect(listed).toHaveLength(1);
		expect(listed[0].conversationId).toBe(9);

		// The old conversation no longer holds it; the new one does.
		expect(await store.clearConversation(3)).toEqual([]);
		expect(await store.clearConversation(9)).toEqual([moved.id]);
	});

	test("11th notice from one extension evicts its oldest", async () => {
		const { store, changes } = await setup();
		const other = await store.post("acme-other", input({ title: "Other" }));
		const posted = await postMany(store, "acme-notes", 10);
		changes.length = 0;

		const eleventh = await store.post(
			"acme-notes",
			input({ title: "Eleventh" }),
		);

		const listed = await store.list();
		// The other extension's notice is untouched: 10 from acme-notes + 1.
		expect(listed).toHaveLength(11);
		expect(listed.filter((notice) => notice.owner === "acme-notes")).toHaveLength(10);
		expect(await store.get(posted[0].id)).toBeUndefined();
		expect(await store.get(other.id)).toEqual(other);
		expect(listed.map((notice) => notice.id)).toContain(eleventh.id);
		// The eviction is its own cleared event, before the posted one.
		expect(changes).toEqual([
			{ user: "alice", ids: [posted[0].id], change: "cleared" },
			{ user: "alice", ids: [eleventh.id], change: "posted" },
		]);
	});

	test("51st overall evicts the user's oldest, across extensions", async () => {
		const { store, changes } = await setup();
		const first = await postMany(store, "acme-one", 10, "a");
		await postMany(store, "acme-two", 10, "b");
		await postMany(store, "acme-three", 10, "c");
		await postMany(store, "acme-four", 10, "d");
		await postMany(store, "acme-five", 10, "e");
		expect(await store.list()).toHaveLength(50);
		changes.length = 0;

		// A sixth extension is well under its own cap: only the per-user
		// cap fires, and it drops the oldest notice of ANY extension.
		const extra = await store.post("acme-six", input({ title: "Fresh" }));

		const listed = await store.list();
		expect(listed).toHaveLength(50);
		expect(await store.get(first[0].id)).toBeUndefined();
		expect(listed.map((notice) => notice.id)).toContain(extra.id);
		expect(changes).toEqual([
			{ user: "alice", ids: [first[0].id], change: "cleared" },
			{ user: "alice", ids: [extra.id], change: "posted" },
		]);
	});

	test("eviction frees the key", async () => {
		const { store, changes } = await setup();
		const keyed: UserNotice[] = [];
		for (let index = 0; index < 10; index += 1) {
			keyed.push(
				await store.post(
					"acme-notes",
					input({ key: `k${index}`, title: `Keyed ${index}` }),
				),
			);
		}

		// The 11th pushes the k0 notice out, which frees "k0".
		await store.post("acme-notes", input({ title: "Unkeyed" }));
		expect(await store.get(keyed[0].id)).toBeUndefined();
		changes.length = 0;

		const again = await store.post(
			"acme-notes",
			input({ key: "k0", title: "Back again" }),
		);

		// A fresh notice, not a replace of the evicted one: the evicted id
		// is never named again.
		expect(again.id).not.toBe(keyed[0].id);
		expect(again.key).toBe("k0");
		expect((await store.get(again.id))?.title).toBe("Back again");
		expect(changes.flatMap((change) => change.ids)).not.toContain(
			keyed[0].id,
		);
		expect(changes.at(-1)).toEqual({
			user: "alice",
			ids: [again.id],
			change: "posted",
		});
	});

	test("dismissAll returns every id in one change", async () => {
		const { store, changes } = await setup();
		const posted = await postMany(store, "acme-notes", 3);
		changes.length = 0;

		const dismissed = await store.dismissAll();

		// Newest first, the same order `list()` answers in.
		expect(dismissed).toEqual([...posted].reverse().map((notice) => notice.id));
		expect(changes).toEqual([
			{ user: "alice", ids: dismissed, change: "cleared" },
		]);
		expect(await store.list()).toEqual([]);

		// Nothing left: a second clear is a no-op with no event.
		changes.length = 0;
		expect(await store.dismissAll()).toEqual([]);
		expect(changes).toEqual([]);
	});

	test("clearConversation leaves app-wide and other conversations' notices", async () => {
		const { store, changes } = await setup();
		const here = await store.post(
			"acme-notes",
			input({ title: "Here", conversationId: 7 }),
		);
		const elsewhere = await store.post(
			"acme-notes",
			input({ title: "Elsewhere", conversationId: 8 }),
		);
		const appWide = await store.post("acme-notes", input({ title: "App-wide" }));
		changes.length = 0;

		const cleared = await store.clearConversation(7);

		expect(cleared).toEqual([here.id]);
		expect(changes).toEqual([
			{ user: "alice", ids: [here.id], change: "cleared" },
		]);
		const listed = await store.list();
		expect(listed.map((notice) => notice.id)).toEqual([
			appWide.id,
			elsewhere.id,
		]);
	});

	test("a stamp mismatch discards the file", async () => {
		const first = await setup();
		await first.store.post("acme-notes", input({ title: "Stale" }));

		// The same user area, re-read under a different directory stamp (a
		// deleted and re-created username): the file's contents are void.
		const changes: NoticeChange[] = [];
		const logs: string[] = [];
		const reopened = new NoticeStore({
			userArea: first.userArea,
			user: "alice",
			userCreatedAt: () => STAMP + 1,
			now: () => new Date(EPOCH),
			onChange: (change) => changes.push(change),
			log: (line) => logs.push(line),
		});

		expect(await reopened.list()).toEqual([]);
		// Logged once, not once per read.
		expect(await reopened.list()).toEqual([]);
		expect(logs.filter((line) => line.includes("stamp"))).toHaveLength(1);
		expect(await reopened.dismissAll()).toEqual([]);
		expect(changes).toEqual([]);

		// A post after the discard writes the new stamp and starts clean.
		const fresh = await reopened.post("acme-notes", input({ title: "Fresh" }));
		const envelope = JSON.parse(await readFile(first.file, "utf8")) as {
			userCreatedAt: number;
			notices: UserNotice[];
		};
		expect(envelope.userCreatedAt).toBe(STAMP + 1);
		expect(envelope.notices.map((notice) => notice.id)).toEqual([fresh.id]);
	});

	test("a corrupt entry is dropped and logged, the rest load", async () => {
		const { userArea, file } = await setup();
		const good: UserNotice = {
			id: "11111111-1111-4111-8111-111111111111",
			owner: "acme-notes",
			at: "2026-11-01T00:00:00.000Z",
			user: "alice",
			title: "Good one",
		};
		const alsoGood: UserNotice = {
			id: "22222222-2222-4222-8222-222222222222",
			owner: "acme-other",
			at: "2026-11-02T00:00:00.000Z",
			user: "alice",
			title: "Good two",
			body: "With a body",
		};
		const badEntries: unknown[] = [
			// Not an object at all.
			"nonsense",
			// A valid shape but a non-UUID id.
			{ ...good, id: "not-a-uuid", title: "Bad id" },
			// A valid shape but an unparseable `at`.
			{ ...good, at: "yesterday", title: "Bad at" },
			// Parseable but not the shape `toISOString` writes (second
			// precision, no milliseconds): still a foreign writer's file.
			{ ...good, at: "2026-11-01T00:00:00Z", title: "Unoffset at" },
			// A valid shape but a non-slug owner.
			{ ...good, owner: "Acme Notes!", title: "Bad owner" },
			// A shape failure the shared validator catches.
			{ ...good, title: "", id: "33333333-3333-4333-8333-333333333333" },
		];
		await mkdir(dirname(file), { recursive: true });
		await writeFile(
			file,
			`${JSON.stringify({ v: 1, userCreatedAt: STAMP, notices: [good, ...badEntries, alsoGood] }, null, "\t")}\n`,
		);

		const logs: string[] = [];
		const store = new NoticeStore({
			userArea,
			user: "alice",
			userCreatedAt: () => STAMP,
			now: () => new Date(EPOCH),
			onChange: () => undefined,
			log: (line) => logs.push(line),
		});

		const listed = await store.list();
		expect(listed.map((notice) => notice.title)).toEqual([
			"Good two",
			"Good one",
		]);
		expect(logs.filter((line) => line.includes("dropped"))).toHaveLength(
			badEntries.length,
		);

		// The next write persists the surviving set only.
		await store.post("acme-notes", input({ title: "New" }));
		const ids = await fileIds(file);
		expect(ids).toContain(good.id);
		expect(ids).toContain(alsoGood.id);
		expect(ids).toHaveLength(3);
	});

	test("a stored notice whose extension action names an undeclared handler still loads", async () => {
		const { userArea, file } = await setup();
		const notice: UserNotice = {
			id: "44444444-4444-4444-8444-444444444444",
			owner: "acme-notes",
			at: "2026-11-01T00:00:00.000Z",
			user: "alice",
			title: "Learned: deploy",
			actions: [
				{ id: "undo", label: "Undo", kind: "extension", name: "undoReview" },
			],
		};
		await mkdir(dirname(file), { recursive: true });
		await writeFile(
			file,
			`${JSON.stringify({ v: 1, userCreatedAt: STAMP, notices: [notice] })}\n`,
		);

		// The extension that declared `undoReview` is gone (disabled,
		// quarantined, replaced) — spec §3: the notice stays dismissible.
		const store = new NoticeStore({
			userArea,
			user: "alice",
			userCreatedAt: () => STAMP,
			now: () => new Date(EPOCH),
			onChange: () => undefined,
			log: () => undefined,
		});

		const listed = await store.list();
		expect(listed).toHaveLength(1);
		expect(listed[0].actions?.[0]).toMatchObject({
			kind: "extension",
			name: "undoReview",
		});
		expect(await store.dismiss(listed[0].id)).toBe(true);
	});

	test("onChange fires after the write (a reader inside onChange sees the new state)", async () => {
		const seen: Array<{
			change: string;
			eventIds: readonly string[];
			fileIds: string[];
		}> = [];
		let file = "";
		const fixture = await setup({
			onChange: (change) => {
				// A synchronous read of the file: it must already hold the new
				// state when the callback runs (and must exist at all — the
				// very first post creates it).
				const parsed = JSON.parse(readFileSync(file, "utf8")) as {
					notices: Array<{ id: string }>;
				};
				seen.push({
					change: change.change,
					eventIds: change.ids,
					fileIds: parsed.notices.map((notice) => notice.id),
				});
			},
		});
		file = fixture.file;
		const { store } = fixture;

		const notice = await store.post(
			"acme-notes",
			input({ key: "k", title: "Written" }),
		);

		expect(seen).toEqual([
			{ change: "posted", eventIds: [notice.id], fileIds: [notice.id] },
		]);

		// The same holds for a replace: BOTH events see the post-write file,
		// so the `cleared` event's own id is already gone from disk when it
		// fires (the client refetches, it never applies the id list alone).
		seen.length = 0;
		const replacement = await store.post(
			"acme-notes",
			input({ key: "k", title: "Replaced" }),
		);
		expect(seen).toEqual([
			{
				change: "cleared",
				eventIds: [notice.id],
				fileIds: [replacement.id],
			},
			{
				change: "posted",
				eventIds: [replacement.id],
				fileIds: [replacement.id],
			},
		]);
	});

	test("clearByKey and clearById are owner-scoped", async () => {
		const { store, changes, file } = await setup();
		const mine = await store.post(
			"acme-notes",
			input({ key: "review:7", title: "Mine" }),
		);
		const theirs = await store.post(
			"acme-other",
			input({ key: "review:7", title: "Theirs" }),
		);
		changes.length = 0;

		// Keys are scoped per extension: acme-other's "review:7" is a
		// different notice, and neither owner can clear the other's.
		expect(await store.clearByKey("acme-other", "absent")).toEqual([]);
		expect(await store.clearById("acme-notes", theirs.id)).toEqual([]);
		expect(changes).toEqual([]);

		expect(await store.clearByKey("acme-notes", "review:7")).toEqual([
			mine.id,
		]);
		expect(await store.get(theirs.id)).toEqual(theirs);
		expect(await store.clearById("acme-other", theirs.id)).toEqual([
			theirs.id,
		]);
		expect(await store.list()).toEqual([]);
		expect(await fileIds(file)).toEqual([]);
	});

	test("removeFile drops the file and every notice with it", async () => {
		const { store, file } = await setup();
		await postMany(store, "acme-notes", 2);

		await store.removeFile();

		expect(await store.list()).toEqual([]);
		await expect(readFile(file, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		// Idempotent: a second removal is a no-op.
		await store.removeFile();
	});

	test("concurrent posts serialize", async () => {
		const { store, file } = await setup();
		const owners = ["acme-notes", "acme-other"];

		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				store.post(
					owners[index % owners.length],
					input({ title: `Concurrent ${index}` }),
				),
			),
		);

		// No lost updates: every post landed exactly once, under both caps.
		const listed = await store.list();
		expect(listed).toHaveLength(20);
		expect(new Set(listed.map((notice) => notice.id)).size).toBe(20);
		expect(
			listed.filter((notice) => notice.owner === "acme-notes"),
		).toHaveLength(10);
		expect(
			listed.filter((notice) => notice.owner === "acme-other"),
		).toHaveLength(10);
		expect(await fileIds(file)).toHaveLength(20);
	});

	test("two store instances over one user area serialize on the module mutex", async () => {
		const { store, userArea, file, now } = await setup();
		const second = new NoticeStore({
			userArea,
			user: "alice",
			userCreatedAt: () => STAMP,
			now,
			onChange: () => undefined,
			log: () => undefined,
		});

		// A per-instance mutex would lose writes here (each instance's
		// read-modify-write would start from its own stale snapshot).
		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				(index % 2 === 0 ? store : second).post(
					"acme-notes",
					input({ title: `Split ${index}` }),
				),
			),
		);

		// The per-extension cap holds across both instances: 10 survive,
		// and the file agrees with the in-memory answer.
		expect(await store.list()).toHaveLength(10);
		expect(await second.list()).toHaveLength(10);
		expect(await fileIds(file)).toHaveLength(10);
	});
});
