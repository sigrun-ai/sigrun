import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { GitHistory } from "../src/history/git.js";
import {
	historyDir,
	userRepoSpec,
} from "../src/curation/paths.js";
import { migrateUserCuration } from "../src/curation/migrate.js";

const execFileAsync = promisify(execFile);

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const SKILL = `---\nname: acme-deploy\ndescription: Deploy acme\n---\n# Deploy\n\nDeploy the acme way.\n`;

async function setup(): Promise<{
	dir: string;
	userArea: string;
	gitHome: string;
	history: GitHistory;
}> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-migrate-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
	const userArea = join(dir, "users", "alice");
	const gitHome = join(dir, "state", "git-home");
	const history = new GitHistory(userRepoSpec(userArea), { gitHome });
	return { dir, userArea, gitHome, history };
}

/** Raw git against the user repo (test-side read). */
async function git(userArea: string, args: string[]): Promise<string> {
	const spec = userRepoSpec(userArea);
	const { stdout } = await execFileAsync(
		"git",
		[
			`--git-dir=${spec.gitDir}`,
			`--work-tree=${spec.workTree}`,
			"-c",
			`safe.directory=${spec.workTree}`,
			...args,
		],
		{ env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
	);
	return stdout;
}

describe("userRepoSpec", () => {
	test("the repo layout and pathspec are the plan's exact shape", () => {
		const spec = userRepoSpec("/areas/alice");
		expect(spec.gitDir).toBe("/areas/curation/history/user.git".replace("/areas/", "/areas/alice/"));
		expect(spec.gitDir).toBe(join("/areas/alice", "curation", "history", "user.git"));
		expect(spec.workTree).toBe("/areas/alice");
		expect(spec.pathspec).toEqual([
			"skills",
			"curation/archive",
			"curation/overlays",
			"curation/state.json",
		]);
		expect(historyDir("/areas/alice")).toBe(
			join("/areas/alice", "curation", "history"),
		);
	});
});

describe("migrateUserCuration", () => {
	test("imports skills+archive+overlays+state as one commit and writes MIGRATED", async () => {
		const { userArea, history } = await setup();
		await mkdir(join(userArea, "skills", "acme-deploy"), { recursive: true });
		await writeFile(join(userArea, "skills", "acme-deploy", "SKILL.md"), SKILL);
		await mkdir(join(userArea, "curation", "archive", "acme-old"), { recursive: true });
		await writeFile(
			join(userArea, "curation", "archive", "acme-old", "SKILL.md"),
			SKILL.replace("acme-deploy", "acme-old"),
		);
		await mkdir(join(userArea, "curation", "overlays", "user-dir"), { recursive: true });
		await writeFile(
			join(userArea, "curation", "overlays", "user-dir", `${"a".repeat(64)}.json`),
			"{}\n",
		);
		await writeFile(
			join(userArea, "curation", "state.json"),
			'{"pins":{},"archived":["acme-old"],"createdAt":{}}\n',
		);
		// Legacy read-only artifacts: present but never staged.
		await writeFile(join(userArea, "curation", "feed.jsonl"), "{}\n");
		await mkdir(join(userArea, "curation", "versions", "acme-deploy", "v1"), {
			recursive: true,
		});
		await writeFile(
			join(userArea, "curation", "versions", "acme-deploy", "v1", "SKILL.md"),
			SKILL,
		);

		expect(await migrateUserCuration(userArea, history)).toBe("migrated");

		// MIGRATED is written last.
		await access(join(historyDir(userArea), "MIGRATED"));
		// ONE commit, authored by the outside actor, with the import summary.
		const count = await git(userArea, ["rev-list", "--count", "HEAD"]);
		expect(count.trim()).toBe("1");
		const show = await git(userArea, ["show", "--format=fuller", "--no-patch", "HEAD"]);
		expect(show).toContain("Imported from the curation store");
		expect(show).toMatch(/Author:\s+outside sigrun </);
		// The import staged the pathspec, never the legacy artifacts.
		const files = await git(userArea, ["ls-tree", "-r", "--name-only", "HEAD"]);
		expect(files).toContain("skills/acme-deploy/SKILL.md");
		expect(files).toContain("curation/archive/acme-old/SKILL.md");
		expect(files).toContain("curation/overlays/user-dir/");
		expect(files).toContain("curation/state.json");
		expect(files).not.toContain("feed.jsonl");
		expect(files).not.toContain("versions/");
		// The legacy artifacts are untouched on disk.
		expect(await readFile(join(userArea, "curation", "feed.jsonl"), "utf8")).toBe("{}\n");
	});

	test("a user with only skills/ (no archive, overlays or state) migrates", async () => {
		const { userArea, history } = await setup();
		await mkdir(join(userArea, "skills", "acme-deploy"), { recursive: true });
		await writeFile(join(userArea, "skills", "acme-deploy", "SKILL.md"), SKILL);
		expect(await migrateUserCuration(userArea, history)).toBe("migrated");
		await access(join(historyDir(userArea), "MIGRATED"));
		const files = await git(userArea, ["ls-tree", "-r", "--name-only", "HEAD"]);
		expect(files).toContain("skills/acme-deploy/SKILL.md");
	});

	test("a user with nothing to import returns nothing and writes no marker", async () => {
		const { userArea, history } = await setup();
		await mkdir(userArea, { recursive: true });
		expect(await migrateUserCuration(userArea, history)).toBe("nothing");
		await expect(
			access(join(historyDir(userArea), "MIGRATED")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("a partial repo without MIGRATED is redone", async () => {
		const { userArea, history } = await setup();
		await mkdir(join(userArea, "skills", "acme-deploy"), { recursive: true });
		await writeFile(join(userArea, "skills", "acme-deploy", "SKILL.md"), SKILL);
		// A partial repo: an initialized git dir with a bogus commit, no marker.
		const partial = join(historyDir(userArea), "user.git");
		await mkdir(partial, { recursive: true });
		await execFileAsync("git", [
			`--git-dir=${partial}`,
			`--work-tree=${userArea}`,
			"-c",
			`safe.directory=${userArea}`,
			"init",
			"--initial-branch=main",
		], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		await execFileAsync("git", [
			`--git-dir=${partial}`,
			`--work-tree=${userArea}`,
			"-c",
			`safe.directory=${userArea}`,
			"-c",
			"user.name=partial",
			"-c",
			"user.email=partial@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-m",
			"a partial import",
		], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		const before = await git(userArea, ["rev-parse", "HEAD"]);

		expect(await migrateUserCuration(userArea, history)).toBe("migrated");
		const count = await git(userArea, ["rev-list", "--count", "HEAD"]);
		expect(count.trim()).toBe("1");
		const after = await git(userArea, ["rev-parse", "HEAD"]);
		expect(after.trim()).not.toBe(before.trim());
		const show = await git(userArea, ["show", "--format=%s", "--no-patch", "HEAD"]);
		expect(show).toContain("Imported from the curation store");
		await access(join(historyDir(userArea), "MIGRATED"));
	});

	test("a store write concurrent with the migration is never swallowed", async () => {
		// I3: the discard + import are atomic under the repo lock. A
		// write racing the migration lands either before the discard
		// (content re-imported from disk) or after the import (its own
		// commit) — never lost.
		const { userArea, history } = await setup();
		await mkdir(join(userArea, "skills", "acme-deploy"), { recursive: true });
		await writeFile(join(userArea, "skills", "acme-deploy", "SKILL.md"), SKILL);
		const { SkillStore } = await import("../src/curation/store.js");
		const store = new SkillStore({
			userArea,
			user: "alice",
			now: () => new Date(),
			nameTakenElsewhere: async () => undefined,
			userExists: () => true,
			history,
		});
		const [result] = await Promise.all([
			migrateUserCuration(userArea, history),
			store.pin("acme-deploy", true),
		]);
		expect(result).toBe("migrated");
		// The pin landed: state.json on disk has it, and the log has the
		// pin commit (either re-imported or its own commit).
		const state = JSON.parse(
			await readFile(join(userArea, "curation", "state.json"), "utf8"),
		) as { pins: Record<string, boolean> };
		expect(state.pins["acme-deploy"]).toBe(true);
		const log = await history.log({ limit: 10 });
		expect(log.some((commit) => commit.summary === "Imported from the curation store")).toBe(true);
		expect(log.some((commit) => commit.action === "pin")).toBe(true);
	});

	test("second run returns already", async () => {
		const { userArea, history } = await setup();
		await mkdir(join(userArea, "skills", "acme-deploy"), { recursive: true });
		await writeFile(join(userArea, "skills", "acme-deploy", "SKILL.md"), SKILL);
		expect(await migrateUserCuration(userArea, history)).toBe("migrated");
		expect(await migrateUserCuration(userArea, history)).toBe("already");
		// The marker did not move the history: still one commit.
		const count = await git(userArea, ["rev-list", "--count", "HEAD"]);
		expect(count.trim()).toBe("1");
	});

	test("a user created after boot migrates on first curationOf", async () => {
		// The boot-level seam: curationOf migrates a user the boot's
		// initial sweep never saw. This test drives the migration seam
		// directly (the boot wiring is covered by curation-host.test.ts's
		// boot-with-existing-users path).
		const { userArea, history } = await setup();
		await mkdir(join(userArea, "skills", "acme-deploy"), { recursive: true });
		await writeFile(join(userArea, "skills", "acme-deploy", "SKILL.md"), SKILL);
		// The first curationOf-shaped call runs the migration.
		expect(await migrateUserCuration(userArea, history)).toBe("migrated");
		await access(join(historyDir(userArea), "MIGRATED"));
	});
});
