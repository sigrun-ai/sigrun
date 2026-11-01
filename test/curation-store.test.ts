import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { curationDir, learnedSkillsDir } from "../src/curation/paths.js";
import { SkillStore } from "../src/curation/store.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

let clock = 0;
async function setup(userExists: () => boolean = () => true) {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-skill-store-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const userArea = join(dir, "users", "alice");
	const store = new SkillStore({
		userArea,
		user: "alice",
		now: () => new Date(Date.parse("2026-10-31T00:00:00.000Z") + ++clock * 1000),
		nameTakenElsewhere: async () => undefined,
		userExists,
	});
	return { dir, userArea, store };
}

function content(name = "acme-deploy", description = "Deploy acme") {
	return `---\nname: ${name}\ndescription: ${description}\n---\n# Deploy\n\nDeploy the acme way.\n`;
}

async function create(store: SkillStore, name = "acme-deploy", text = content(name)) {
	return store.apply(name, { kind: "create", content: text }, { actor: "curator" });
}

describe("SkillStore", () => {
	test("create writes SKILL.md and a feed entry with actor", async () => {
		const { userArea, store } = await setup();
		const entry = await store.apply(
			"acme-deploy",
			{ kind: "create", content: content() },
			{ actor: "curator", reviewId: "review-1", conversationId: 42 },
		);
		expect(await readFile(join(learnedSkillsDir(userArea), "acme-deploy", "SKILL.md"), "utf8"))
			.toBe(content());
		expect(entry).toMatchObject({
			actor: "curator",
			action: "create",
			skill: "acme-deploy",
			reviewId: "review-1",
			conversationId: 42,
		});
		expect(typeof entry.after).toBe("string");
		expect(entry.before).toBeUndefined();
		expect(await store.feed(1)).toEqual([entry]);
		expect(await store.list()).toEqual([expect.objectContaining({
			name: "acme-deploy",
			description: "Deploy acme",
			archived: false,
			pinned: false,
			bytes: content().length,
			createdAt: expect.any(String),
		})]);
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
		const restored = await store.apply("acme-deploy", { kind: "restore" }, { actor: "user" }).catch(() => undefined);
		expect(restored).toBeUndefined();
		await store.apply("acme-deploy", { kind: "archive" }, { actor: "user" });
		const restore = await store.apply("acme-deploy", { kind: "restore" }, { actor: "user" });
		await store.undo([restore.id]);
		expect((await store.list())[0]).toMatchObject({ archived: true });
		await expect(store.view("acme-deploy")).rejects.toThrow();
	});

	test("undo of a create archives the skill (restorable)", async () => {
		const { store } = await setup();
		const created = await store.apply(
			"acme-deploy",
			{ kind: "create", content: content() },
			{ actor: "curator", reviewId: "review-create-1" },
		);
		expect(created.before).toBeUndefined();
		// Undoing the create: the skill leaves the learned root (archived,
		// never deleted) and the undo entry lands in the feed.
		const undone = await store.undo([created.id]);
		expect(undone).toHaveLength(1);
		expect(undone[0]?.action).toBe("undo");
		const listed = await store.list();
		expect(listed.find((row) => row.name === "acme-deploy")?.archived).toBe(true);
		// And it is itself undoable: restore brings the skill back.
		const redo = await store.undo([undone[0]!.id]);
		expect(redo).toHaveLength(1);
		const again = await store.list();
		expect(again.find((row) => row.name === "acme-deploy")?.archived).toBe(false);
	});

	test("undo saves current first and is itself undoable", async () => {
		const { store } = await setup();
		await create(store);
		const changed = await store.apply("acme-deploy", { kind: "patch", old: "Deploy acme", new: "Deploy acme safely" }, { actor: "agent" });
		const undone = await store.undo([changed.id]);
		expect(undone).toHaveLength(1);
		expect(undone[0].action).toBe("undo");
		expect(undone[0].before).not.toBe(changed.after);
		expect(undone[0].after).not.toBe(changed.after);
		expect(await store.view("acme-deploy")).toBe(content());
		const redone = await store.undo(undone.map((entry) => entry.id));
		expect(await store.view("acme-deploy")).toContain("Deploy acme safely");
		expect(redone[0]).toMatchObject({ action: "undo" });
	});

	test("retention keeps 10 versions and 500 feed entries", async () => {
		const { userArea, store } = await setup();
		await create(store);
		for (let i = 0; i < 510; i++) {
			await store.apply("acme-deploy", {
				kind: "patch",
				old: i === 0 ? "Deploy acme" : `Deploy acme safely ${i - 1}`,
				new: `Deploy acme safely ${i}`,
			}, { actor: "agent" });
		}
		expect(await readdir(join(curationDir(userArea), "versions", "acme-deploy"))).toHaveLength(10);
		expect(await store.feed(600)).toHaveLength(500);
	});

	test("concurrent applies for one user serialize", async () => {
		const { store } = await setup();
		await create(store);
		const [first, second] = await Promise.all([
			store.apply("acme-deploy", { kind: "patch", old: "Deploy acme", new: "Deploy acme safely" }, { actor: "agent" }),
			store.apply("acme-deploy", { kind: "write_file", file: "templates/deploy.txt", content: "safe deploy" }, { actor: "agent" }),
		]);
		const feed = await store.feed(10);
		expect(feed.map((entry) => entry.id)).toEqual([second.id, first.id, expect.any(String)]);
		expect(Number(second.after!.slice(1))).toBeGreaterThan(Number(first.after!.slice(1)));
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
		await expect(create(store)).rejects.toThrow("user removed");
		await expect(stat(userArea)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("pins and feed pagination are durable", async () => {
		const { userArea, store } = await setup();
		const first = await create(store);
		const second = await store.apply("acme-deploy", { kind: "patch", old: "Deploy acme", new: "Deploy acme safely" }, { actor: "user" });
		expect(await store.feed(1)).toEqual([second]);
		expect(await store.feed(10, second.id)).toEqual([first]);
		await store.pin("acme-deploy", true);
		expect((await store.list())[0]).toMatchObject({ pinned: true });
		const reopened = new SkillStore({
			userArea,
			user: "alice",
			now: () => new Date(),
			nameTakenElsewhere: async () => undefined,
			userExists: () => true,
		});
		expect((await reopened.list())[0]).toMatchObject({ pinned: true });
	});
});
