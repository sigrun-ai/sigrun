/**
 * SkillStore on the per-user git history (tabs+skills plan, Task 9).
 *
 * The store keeps its public methods and FeedEntry shape, but `id`,
 * `before` and `after` are commit SHAs in ONE per-user repo
 * (`userRepoSpec(userArea)`): every store operation is one commit with
 * the Sigrun-* trailers, the feed is the log, and undo is a path-restore
 * commit (never git revert).
 *
 * Temp-dir fixtures; the GitHistory module sets its own git env, so the
 * test process's git config is irrelevant.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { GitHistory } from "../src/history/git.js";
import { curationDir, learnedSkillsDir, userRepoSpec } from "../src/curation/paths.js";
import { SkillStore } from "../src/curation/store.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

let clock = 0;
async function setup(userExists: () => boolean = () => true) {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-skill-store-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
	const userArea = join(dir, "users", "alice");
	const history = new GitHistory(userRepoSpec(userArea), {
		gitHome: join(dir, "state", "git-home"),
		now: () => new Date(Date.parse("2026-10-31T00:00:00.000Z") + ++clock * 1000),
	});
	const store = new SkillStore({
		userArea,
		user: "alice",
		now: () => new Date(Date.parse("2026-10-31T00:00:00.000Z") + ++clock * 1000),
		nameTakenElsewhere: async () => undefined,
		userExists,
		history,
	});
	return { dir, userArea, store, history };
}

function content(name = "acme-deploy", description = "Deploy acme") {
	return `---\nname: ${name}\ndescription: ${description}\n---\n# Deploy\n\nDeploy the acme way.\n`;
}

async function create(store: SkillStore, name = "acme-deploy", text = content(name)) {
	return store.apply(name, { kind: "create", content: text }, { actor: "curator" });
}

describe("SkillStore", () => {
	test("create/patch/pin each make one commit with the right trailers", async () => {
		const { userArea, store, history } = await setup();
		const created = await store.apply(
			"acme-deploy",
			{ kind: "create", content: content() },
			{ actor: "curator", reviewId: "review-1", conversationId: 42 },
		);
		expect(await readFile(join(learnedSkillsDir(userArea), "acme-deploy", "SKILL.md"), "utf8"))
			.toBe(content());
		expect(created).toMatchObject({
			actor: "curator",
			action: "create",
			skill: "acme-deploy",
			reviewId: "review-1",
			conversationId: 42,
		});
		// A create has no `before` state; its id/after are the commit SHA.
		expect(created.before).toBeUndefined();
		expect(created.after).toBe(created.id);
		expect(created.id).toMatch(/^[0-9a-f]{40}$/);

		const patched = await store.apply(
			"acme-deploy",
			{ kind: "patch", old: "Deploy acme", new: "Deploy acme safely" },
			{ actor: "agent" },
		);
		expect(patched.before).toBe(created.id);
		expect(patched.after).toBe(patched.id);

		await store.pin("acme-deploy", true);

		// Three commits, newest-first, each with its trailers.
		const log = await history.log({ limit: 10 });
		expect(log).toHaveLength(3);
		expect(log[0]).toMatchObject({
			sha: (await store.feed(1))[0]!.id,
			actor: { kind: "user", user: "alice" },
			action: "pin",
			skill: "acme-deploy",
		});
		expect(log[1]).toMatchObject({
			sha: patched.id,
			actor: { kind: "agent" },
			action: "patch",
			skill: "acme-deploy",
		});
		expect(log[2]).toMatchObject({
			sha: created.id,
			actor: { kind: "curator" },
			action: "create",
			skill: "acme-deploy",
			reviewId: "review-1",
			conversationId: 42,
		});
	});

	test("feed pages by sha and maps actors; untrailered commits are skipped", async () => {
		const { userArea, store, history } = await setup();
		const first = await create(store);
		const second = await store.apply(
			"acme-deploy",
			{ kind: "patch", old: "Deploy acme", new: "Deploy acme safely" },
			{ actor: "user" },
		);
		// An outside catch-up commit has no action/skill trailers: it lands
		// in the log (action "change", skill "") but feed skips it. The
		// catch-up needs an actual dirty path to commit; drop one.
		const { writeFile, mkdir } = await import("node:fs/promises");
		await mkdir(join(userArea, "curation", "overlays", "user-dir"), { recursive: true });
		await writeFile(join(userArea, "curation", "overlays", "user-dir", `${"c".repeat(64)}.json`), "{}\n");
		await history.catchUp({ actor: { kind: "outside" }, summary: "outside changes" });
		const all = await store.feed(10);
		expect(all.map((entry) => entry.id)).toEqual([second.id, first.id]);
		expect(all[0]).toMatchObject({ actor: "user" });
		expect(all[1]).toMatchObject({ actor: "curator" });
		// Pagination is by sha cursor, strictly older than the cursor.
		const page1 = await store.feed(1);
		expect(page1).toHaveLength(1);
		expect(page1[0]).toMatchObject({ id: second.id, action: "patch", actor: "user" });
		const page2 = await store.feed(10, second.id);
		expect(page2).toHaveLength(1);
		expect(page2[0]).toMatchObject({ id: first.id, action: "create", actor: "curator" });
		expect(await store.feed(10, first.id)).toEqual([]);
		// The log DOES carry the catch-up, mapped to the change/"" shape.
		const log = await history.log({ limit: 10 });
		expect(log).toHaveLength(3);
		expect(log[0]).toMatchObject({
			actor: { kind: "outside" },
			action: undefined,
		});
	});

	test("undo restores the pre-review state of touched paths as one commit with Sigrun-Undoes", async () => {
		const { userArea, store, history } = await setup();
		await create(store);
		await store.pin("acme-deploy", true);
		// A two-commit review: a patch and the unpin.
		const patched = await store.apply(
			"acme-deploy",
			{ kind: "patch", old: "Deploy acme", new: "Deploy acme badly" },
			{ actor: "curator", reviewId: "review-2" },
		);
		const unpinned = await store.pin("acme-deploy", false, "review-2");
		// An interleaved outside catch-up on an unrelated path rides between.
		await mkdir(join(userArea, "curation", "overlays", "user-dir"), { recursive: true });
		await writeFile(
			join(userArea, "curation", "overlays", "user-dir", `${"b".repeat(64)}.json`),
			"{}\n",
		);
		await history.catchUp({ actor: { kind: "outside" }, summary: "outside changes" });

		const undone = await store.undo([patched.id, unpinned.id]);
		expect(undone).toHaveLength(1);
		expect(undone[0]).toMatchObject({ actor: "user", action: "undo", skill: "acme-deploy" });
		expect(undone[0]!.id).toMatch(/^[0-9a-f]{40}$/);
		// Both the patch AND the pin state are back to the pre-review state.
		expect(await store.view("acme-deploy")).toBe(content());
		expect((await store.list())[0]).toMatchObject({ pinned: true });
		// ONE undo commit, carrying Sigrun-Undoes naming the undone commits.
		const log = await history.log({ limit: 10 });
		expect(log[0]).toMatchObject({ sha: undone[0]!.id, undoes: [patched.id, unpinned.id].sort().join(",") });
		// The interleaved catch-up's path survived the restore.
		expect(await readFile(join(userArea, "curation", "overlays", "user-dir", `${"b".repeat(64)}.json`), "utf8")).toBe("{}\n");
	});

	test("undoing an undone review is a no-op", async () => {
		const { store } = await setup();
		await create(store);
		const patched = await store.apply(
			"acme-deploy",
			{ kind: "patch", old: "Deploy acme", new: "Deploy acme badly" },
			{ actor: "curator", reviewId: "review-3" },
		);
		const first = await store.undo([patched.id]);
		expect(first).toHaveLength(1);
		// The same review id is now on a commit's Sigrun-Undoes: no re-undo.
		expect(await store.undo([patched.id])).toEqual([]);
		expect(await store.view("acme-deploy")).toBe(content());
	});

	test("re-undo after an intervening change is a no-op and keeps the change", async () => {
		// C2: the guard is sha-based (Sigrun-Undoes names commit shas).
		// Undo the review, make an intervening change to the same skill,
		// undo the review AGAIN → [] and the intervening change survives
		// (an empty-diff accident or a reviewId-keyed guard would fail
		// this: the second undo would produce a real commit wiping the
		// intervening state, or re-apply the review).
		const { store, history } = await setup();
		await create(store);
		const patched = await store.apply(
			"acme-deploy",
			{ kind: "patch", old: "Deploy acme", new: "Deploy acme badly" },
			{ actor: "curator", reviewId: "review-4" },
		);
		expect(await store.undo([patched.id])).toHaveLength(1);
		// The intervening change.
		await store.apply(
			"acme-deploy",
			{ kind: "patch", old: "Deploy acme", new: "Deploy acme, intervened" },
			{ actor: "user" },
		);
		expect(await store.undo([patched.id])).toEqual([]);
		expect(await store.view("acme-deploy")).toContain("intervened");
		// And no second undo commit landed.
		expect((await history.log({ limit: 10 })).filter((commit) => commit.action === "undo")).toHaveLength(1);
	});

	test("undo of a patch-only review keeps a later pin (skill-scoped restore)", async () => {
		// C1(a): the undo restores the PATCHED paths, never a roots-wide
		// state.json — a pin that landed after the review survives.
		const { store } = await setup();
		await create(store);
		const patched = await store.apply(
			"acme-deploy",
			{ kind: "patch", old: "Deploy acme", new: "Deploy acme badly" },
			{ actor: "curator", reviewId: "review-5" },
		);
		await store.pin("acme-deploy", true);
		const undone = await store.undo([patched.id]);
		expect(undone).toHaveLength(1);
		expect(await store.view("acme-deploy")).toBe(content());
		expect((await store.list())[0]).toMatchObject({ pinned: true });
	});

	test("undo of one review leaves a second review's skill alone", async () => {
		// C1(b): skill-scoped restore — a different review's create under
		// the same roots is not clobbered.
		const { userArea, store } = await setup();
		await create(store, "acme-deploy");
		const patched = await store.apply(
			"acme-deploy",
			{ kind: "patch", old: "Deploy acme", new: "Deploy acme badly" },
			{ actor: "curator", reviewId: "review-6" },
		);
		await create(store, "acme-release", content("acme-release"));
		await store.undo([patched.id]);
		expect(await store.view("acme-deploy")).toBe(content());
		// The other skill is still live on disk and in the list.
		expect(await store.view("acme-release")).toBe(content("acme-release"));
		expect((await store.list()).map((row) => row.name).sort()).toEqual(["acme-deploy", "acme-release"]);
		void userArea;
	});

	test("undo of a create archives (state.json and archive dir both in the commit)", async () => {
		const { store, history } = await setup();
		const created = await store.apply(
			"acme-deploy",
			{ kind: "create", content: content() },
			{ actor: "curator", reviewId: "review-create-1" },
		);
		const undone = await store.undo([created.id]);
		expect(undone).toHaveLength(1);
		expect(undone[0]?.action).toBe("undo");
		const listed = await store.list();
		expect(listed.find((row) => row.name === "acme-deploy")?.archived).toBe(true);
		// The archive move AND the state.json flip are in the undo commit.
		const undo = (await history.log({ limit: 1 }))[0]!;
		expect(undo.paths).toContain("curation/state.json");
		expect(undo.paths.some((path) => path.startsWith("curation/archive/acme-deploy/"))).toBe(true);
		// The undo is itself undoable: the skill un-archives.
		const redo = await store.undo([undone[0]!.id]);
		expect(redo).toHaveLength(1);
		expect((await store.list()).find((row) => row.name === "acme-deploy")?.archived).toBe(false);
	});

	test("restoreVersion of an archived skill un-archives it in one commit", async () => {
		const { store, history } = await setup();
		const created = await create(store);
		const patched = await store.apply(
			"acme-deploy",
			{ kind: "patch", old: "Deploy acme", new: "Deploy acme safely" },
			{ actor: "agent" },
		);
		await store.pin("acme-deploy", true);
		// The restore target: the pin commit (the patch landed and the pin
		// is set; the archive is NOT yet).
		const pinned = (await store.feed(1))[0]!;
		await store.apply("acme-deploy", { kind: "archive" }, { actor: "user" });
		expect((await store.list())[0]).toMatchObject({ archived: true });

		const entry = await store.restoreVersion("acme-deploy", pinned.id, { actor: "user" });
		expect(entry).toMatchObject({
			actor: "user",
			action: "restore",
			skill: "acme-deploy",
			before: expect.stringMatching(/^[0-9a-f]{40}$/),
		});
		expect(entry.id).toBe(entry.after);
		// Files at the chosen commit AND un-archived AND still pinned, in one commit.
		expect(await store.view("acme-deploy")).toContain("Deploy acme safely");
		expect((await store.list())[0]).toMatchObject({ archived: false, pinned: true });
		const log = await history.log({ limit: 1 });
		expect(log[0]!.paths).toContain("curation/state.json");
		expect(log[0]!.paths.some((path) => path.startsWith("skills/acme-deploy/"))).toBe(true);
		void created;
		void patched;
	});

	test("name rule rejects hostile names without normalizing them", async () => {
		const { userArea, store } = await setup();
		for (const name of ["Deploy", "../x", "deploy ", "a".repeat(64)]) {
			await expect(create(store, name)).rejects.toThrow("invalid skill name");
		}
		await expect(create(store)).resolves.toMatchObject({ skill: "acme-deploy" });
		expect(await readdir(learnedSkillsDir(userArea))).toEqual(["acme-deploy"]);
	});

	test("name collision with any root refuses create", async () => {
		const { userArea, store } = await setup();
		const colliding = new SkillStore({
			userArea,
			user: "alice",
			now: () => new Date(),
			nameTakenElsewhere: async () => "user dir",
			userExists: () => true,
			history: new GitHistory(userRepoSpec(userArea), {
				gitHome: join(userArea, "..", "..", "state", "git-home"),
			}),
		});
		await expect(create(colliding)).rejects.toThrow(/user dir.*overlay/);
		await expect(store.feed(10)).resolves.toEqual([]);
	});

	test("frontmatter name must match the directory", async () => {
		const { store } = await setup();
		await expect(create(store, "acme-deploy", content("other-deploy")))
			.rejects.toThrow(/frontmatter name.*acme-deploy/);
		await expect(create(store, "acme-deploy", content("acme-deploy", "")))
			.rejects.toThrow(/description/);
	});

	test("patch requires a unique span and supports only safe support files", async () => {
		const { userArea, store } = await setup();
		await create(store);
		await expect(store.apply("acme-deploy", { kind: "patch", old: "acme", new: "acme2" }, { actor: "agent" }))
			.rejects.toThrow(/unique/);
		await store.apply("acme-deploy", { kind: "patch", old: "Deploy acme", new: "Deploy acme safely" }, { actor: "agent" });
		await store.apply("acme-deploy", { kind: "write_file", file: "references/runbook.md", content: "Safe runbook" }, { actor: "agent" });
		expect(await store.view("acme-deploy", "references/runbook.md")).toBe("Safe runbook");
		for (const file of ["notes.md", "/tmp/acme", "references/../../escape", "references/../escape"]) {
			await expect(store.apply("acme-deploy", { kind: "write_file", file, content: "bad" }, { actor: "agent" }))
				.rejects.toThrow(/support file/);
		}
		await expect(store.apply("acme-deploy", { kind: "remove_file", file: "assets/../../escape" }, { actor: "agent" }))
			.rejects.toThrow(/support file/);
		const link = join(learnedSkillsDir(userArea), "acme-deploy", "references", "linked.md");
		await symlink("/tmp/acme-target", link);
		await expect(store.apply("acme-deploy", { kind: "write_file", file: "references/linked.md", content: "bad" }, { actor: "agent" }))
			.rejects.toThrow(/symlink/);
		await rm(link);
		await mkdir(join(learnedSkillsDir(userArea), "acme-deploy", "references", "linked-dir"), { recursive: true });
		await symlink("/tmp", join(learnedSkillsDir(userArea), "acme-deploy", "references", "linked-dir", "x"));
		await expect(store.apply("acme-deploy", { kind: "write_file", file: "references/linked-dir/x/file", content: "bad" }, { actor: "agent" }))
			.rejects.toThrow(/symlink/);
	});

	test("archive never deletes; restore brings back", async () => {
		const { userArea, store } = await setup();
		await create(store);
		const archived = await store.apply("acme-deploy", { kind: "archive" }, { actor: "user" });
		expect(archived.action).toBe("archive");
		expect(await stat(join(curationDir(userArea), "archive", "acme-deploy"))).toBeTruthy();
		await expect(store.view("acme-deploy")).rejects.toThrow();
		expect((await store.list())[0]).toMatchObject({ archived: true });
		await store.apply("acme-deploy", { kind: "restore" }, { actor: "user" });
		expect(await store.view("acme-deploy")).toBe(content());
		expect((await store.list())[0]).toMatchObject({ archived: false });
	});

	test("undo restores archive and restore destinations", async () => {
		const { store } = await setup();
		await create(store);
		const archived = await store.apply("acme-deploy", { kind: "archive", absorbedInto: "acme-release" }, { actor: "user" });
		expect(archived.reason).toBe("acme-release");
		await store.undo([archived.id]);
		expect((await store.list())[0]).toMatchObject({ archived: false });
		expect(await store.view("acme-deploy")).toBe(content());
		await store.apply("acme-deploy", { kind: "patch", old: "Deploy acme", new: "Deploy acme safely" }, { actor: "agent" });
		expect(await store.view("acme-deploy")).toContain("safely");
		await store.apply("acme-deploy", { kind: "archive" }, { actor: "user" });
		const restore = await store.apply("acme-deploy", { kind: "restore" }, { actor: "user" });
		await store.undo([restore.id]);
		expect((await store.list())[0]).toMatchObject({ archived: true });
		await expect(store.view("acme-deploy")).rejects.toThrow();
	});

	test("undo saves current first and is itself undoable", async () => {
		const { store } = await setup();
		await create(store);
		const changed = await store.apply("acme-deploy", { kind: "patch", old: "Deploy acme", new: "Deploy acme safely" }, { actor: "agent" });
		const undone = await store.undo([changed.id]);
		expect(undone).toHaveLength(1);
		expect(undone[0].action).toBe("undo");
		expect(undone[0].before).toBe(changed.after);
		expect(undone[0].after).not.toBe(changed.after);
		expect(await store.view("acme-deploy")).toBe(content());
		const redone = await store.undo(undone.map((entry) => entry.id));
		expect(await store.view("acme-deploy")).toContain("Deploy acme safely");
		expect(redone[0]).toMatchObject({ action: "undo" });
	});

	test("concurrent applies for one user serialize", async () => {
		const { store, history } = await setup();
		await create(store);
		const [first, second] = await Promise.all([
			store.apply("acme-deploy", { kind: "patch", old: "Deploy acme", new: "Deploy acme safely" }, { actor: "agent" }),
			store.apply("acme-deploy", { kind: "write_file", file: "templates/deploy.txt", content: "safe deploy" }, { actor: "agent" }),
		]);
		// Serialized by the lock, but arrival order is racy: assert the
		// SET, both feed and log, one commit per apply.
		const feed = await store.feed(10);
		expect(new Set(feed.map((entry) => entry.id))).toEqual(new Set([second.id, first.id, feed[2]!.id]));
		expect(feed).toHaveLength(3);
		const log = await history.log({ limit: 10 });
		expect(log).toHaveLength(3);
		expect(new Set(log.map((commit) => commit.sha))).toEqual(new Set([first.id, second.id, log[2]!.sha]));
		expect(await store.view("acme-deploy")).toContain("Deploy acme safely");
		expect(await store.view("acme-deploy", "templates/deploy.txt")).toBe("safe deploy");
	});

	test("userExists false -> every op throws user removed and no directory is created", async () => {
		let exists = true;
		const { userArea, store } = await setup(() => exists);
		exists = false;
		await expect(store.list()).rejects.toThrow("user removed");
		await expect(store.view("acme-deploy")).rejects.toThrow("user removed");
		await expect(store.feed(10)).rejects.toThrow("user removed");
		await expect(store.pin("acme-deploy", true)).rejects.toThrow("user removed");
		await expect(store.undo([])).rejects.toThrow("user removed");
		await expect(store.restoreVersion("acme-deploy", "x".repeat(40), { actor: "user" })).rejects.toThrow("user removed");
		await expect(create(store)).rejects.toThrow("user removed");
		await expect(stat(userArea)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("pins and feed pagination are durable", async () => {
		const { userArea, store } = await setup();
		const first = await create(store);
		const second = await store.apply("acme-deploy", { kind: "patch", old: "Deploy acme", new: "Deploy acme safely" }, { actor: "user" });
		const page1 = await store.feed(1);
		expect(page1).toHaveLength(1);
		expect(page1[0]).toMatchObject({ id: second.id, before: first.id, after: second.id });
		const page2 = await store.feed(10, second.id);
		expect(page2).toHaveLength(1);
		expect(page2[0]).toMatchObject({ id: first.id, after: first.id });
		await store.pin("acme-deploy", true);
		expect((await store.list())[0]).toMatchObject({ pinned: true });
		const reopened = new SkillStore({
			userArea,
			user: "alice",
			now: () => new Date(),
			nameTakenElsewhere: async () => undefined,
			userExists: () => true,
			history: new GitHistory(userRepoSpec(userArea), {
				gitHome: join(userArea, "..", "..", "state", "git-home"),
			}),
		});
		expect((await reopened.list())[0]).toMatchObject({ pinned: true });
		expect(await reopened.feed(10)).toEqual(await store.feed(10));
	});
});
