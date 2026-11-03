/**
 * GitHistory: isolated local git for sigrun-owned history (tabs+skills plan,
 * Task 7). Temp-dir fixtures; the module sets its own env, so the test
 * process's git config is irrelevant.
 */

import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import {
	GitHistory,
	type CommitMeta,
	type GitRepoSpec,
	type HistoryActor,
} from "../src/history/git.js";
import { gitArgs } from "../src/history/git.js";
import { decodeCommit, encodeTrailers } from "../src/history/trailers.js";

const git = (dir: string, args: string[]): Promise<{ stdout: string }> =>
	new Promise((resolve, reject) => {
		execFile(
			"git",
			["-C", dir, "-c", "commit.gpgsign=false", ...args],
			(error, stdout) =>
				error ? reject(error) : resolve({ stdout }),
		);
	});

async function rawCommit(
	dir: string,
	meta: CommitMeta & { sha?: string; at?: string },
	message: string,
): Promise<string> {
	const trailers = encodeTrailers(meta);
	const body = trailers === "" ? message : `${message}\n\n${trailers}`;
	await git(dir, [
		"-c",
		"user.name=test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"--allow-empty",
		"-m",
		body,
	]);
	const { stdout } = await git(dir, ["rev-parse", "HEAD"]);
	return stdout.trim();
}

async function rawShow(dir: string, sha: string): Promise<string> {
	const { stdout } = await git(dir, ["show", "--format=fuller", "--no-patch", sha]);
	return stdout;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface Fixture {
	readonly dir: string;
	readonly workTree: string;
	readonly gitDir: string;
	readonly gitHome: string;
	readonly spec: GitRepoSpec;
	readonly logLines: string[];
	readonly history: GitHistory;
}

interface FixtureOptions {
	readonly pathspec?: readonly string[];
	readonly gitBinary?: string;
	readonly now?: () => Date;
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-history-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
	const workTree = join(dir, "work");
	const gitDir = join(dir, "repo.git");
	const gitHome = join(dir, "state", "git-home");
	await mkdir(workTree, { recursive: true });
	const spec: GitRepoSpec = {
		gitDir,
		workTree,
		pathspec: options.pathspec ?? ["skills", "notes.md"],
	};
	const logLines: string[] = [];
	const history = new GitHistory(spec, {
		gitHome,
		gitBinary: options.gitBinary,
		now: options.now,
		log: (line) => logLines.push(line),
	});
	return { dir, workTree, gitDir, gitHome, spec, logLines, history };
}

const userMeta = (summary: string, user = "alice"): CommitMeta => ({
	actor: { kind: "user", user },
	summary,
});

describe("write", () => {
	test("commits the mutation with author and trailers", async () => {
		const { workTree, gitDir, history } = await fixture();
		const meta: CommitMeta = {
			...userMeta("create acme-deploy"),
			action: "apply",
			skill: "acme-deploy",
			reviewId: "rev-1",
			conversationId: 42,
			reason: "asked",
			undoes: "abc123",
		};
		const sha = await history.write(meta, async () => {
			await mkdir(join(workTree, "skills", "acme-deploy"), { recursive: true });
			await writeFile(join(workTree, "skills", "acme-deploy", "SKILL.md"), "body");
		});
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
		const show = await rawShow(gitDir, sha ?? "");
		expect(show).toMatch(/Author:\s+alice <alice@sigrun\.invalid>/);
		expect(show).toMatch(/Commit:\s+sigrun <sigrun@sigrun\.invalid>/);
		expect(show).toContain("create acme-deploy");
		for (const trailer of [
			"Sigrun-Actor: alice",
			"Sigrun-Action: apply",
			"Sigrun-Skill: acme-deploy",
			"Sigrun-Review: rev-1",
			"Sigrun-Conversation: 42",
			"Sigrun-Reason: asked",
			"Sigrun-Undoes: abc123",
		]) {
			expect(show).toContain(trailer);
		}
		const log = await history.log({ limit: 10 });
		expect(log).toHaveLength(1);
		const entry = log[0];
		expect(entry?.sha).toBe(sha);
		expect(entry?.actor).toEqual({ kind: "user", user: "alice" });
		expect(entry?.summary).toBe("create acme-deploy");
		expect(entry?.action).toBe("apply");
		expect(entry?.skill).toBe("acme-deploy");
		expect(entry?.reviewId).toBe("rev-1");
		expect(entry?.conversationId).toBe(42);
		expect(entry?.reason).toBe("asked");
		expect(entry?.undoes).toBe("abc123");
		expect(entry?.paths).toContain("skills/acme-deploy/SKILL.md");
		expect(Number.isNaN(Date.parse(entry?.at ?? ""))).toBe(false);
	});

	test("catch-up commits outside edits before the write as their own commit, credited to catchUpAs", async () => {
		const { workTree, gitDir, history } = await fixture();
		const outside = await mkdir(join(workTree, "skills"), { recursive: true }).then(() =>
			writeFile(join(workTree, "skills", "planted.md"), "outside"),
		);
		void outside;
		const sha = await history.write(
			userMeta("the write"),
			async () => {
				await writeFile(join(workTree, "notes.md"), "mine");
			},
			{ kind: "outside" },
		);
		expect(sha).toBeDefined();
		const log = await history.log({ limit: 10 });
		expect(log).toHaveLength(2);
		const catchUpEntry = log[1];
		expect(catchUpEntry?.actor).toEqual({ kind: "outside" });
		expect(catchUpEntry?.paths).toContain("skills/planted.md");
		const show = await rawShow(gitDir, catchUpEntry?.sha ?? "");
		expect(show).toMatch(/Author:\s+outside sigrun <outside-sigrun@sigrun\.invalid>/);
		expect(show).toContain("Sigrun-Actor: outside sigrun");
	});

	test("no change → no commit, returns undefined", async () => {
		const { workTree, history } = await fixture();
		const seed = await history.write(userMeta("seed"), async () => {
			await writeFile(join(workTree, "notes.md"), "x");
		});
		expect(seed).toBeDefined();
		const second = await history.write(userMeta("noop"), async () => {
			// no mutation
		});
		expect(second).toBeUndefined();
		const log = await history.log({ limit: 10 });
		expect(log).toHaveLength(1);
	});
});

describe("staging", () => {
	test(".gitignore in the work tree does not hide files", async () => {
		const { workTree, history } = await fixture({ pathspec: ["skills"] });
		await writeFile(join(workTree, ".gitignore"), "skills/\n");
		await mkdir(join(workTree, "skills"), { recursive: true });
		const sha = await history.write(userMeta("ignored?"), async () => {
			await writeFile(join(workTree, "skills", "hidden.md"), "still staged");
		});
		expect(sha).toBeDefined();
		const log = await history.log({ limit: 10 });
		expect(log[0]?.paths).toContain("skills/hidden.md");
	});

	test("a nested .git dir is skipped, other changes commit", async () => {
		const { workTree, gitDir, logLines, history } = await fixture({
			pathspec: ["skills"],
		});
		await mkdir(join(workTree, "skills", "nested"), { recursive: true });
		await git(join(workTree, "skills", "nested"), ["init", "--initial-branch=main"]);
		await writeFile(join(workTree, "skills", "nested", "file.md"), "nested");
		await writeFile(join(workTree, "skills", "top.md"), "top");
		const sha = await history.write(userMeta("nested"), async () => {});
		expect(sha).toBeDefined();
		const { stdout: tree } = await git(gitDir, [
			"--git-dir",
			gitDir,
			"ls-tree",
			"-r",
			"--name-only",
			"HEAD",
		]);
		expect(tree).toContain("skills/top.md");
		expect(tree).not.toContain("nested");
		expect(logLines.some((line) => line.includes("nested"))).toBe(true);
	});

	test("a .gitattributes naming a filter driver runs nothing", async () => {
		const { workTree, gitDir, history } = await fixture({ pathspec: ["skills"] });
		await writeFile(join(workTree, ".gitattributes"), "* filter=pwn\n");
		await mkdir(join(workTree, "skills"), { recursive: true });
		const content = "verbatim content\n";
		const sha = await history.write(userMeta("attr"), async () => {
			await writeFile(join(workTree, "skills", "a.md"), content);
		});
		expect(sha).toBeDefined();
		const { stdout } = await git(gitDir, [
			"--git-dir",
			gitDir,
			"show",
			"HEAD:skills/a.md",
		]);
		expect(stdout).toBe(content);
	});

	test("a pathspec entry that doesn't exist is skipped, the rest commits", async () => {
		const { workTree, history } = await fixture({ pathspec: ["a", "missing"] });
		await mkdir(join(workTree, "a"), { recursive: true });
		const sha = await history.write(userMeta("partial"), async () => {
			await writeFile(join(workTree, "a", "one.md"), "1");
		});
		expect(sha).toBeDefined();
		const log = await history.log({ limit: 10 });
		expect(log[0]?.paths).toEqual(["a/one.md"]);
	});
});

describe("concurrency and locking", () => {
	test("concurrent writers serialize (20 parallel writes → 20 commits)", async () => {
		const { workTree, history } = await fixture({ pathspec: ["skills"] });
		await mkdir(join(workTree, "skills"), { recursive: true });
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				history.write(userMeta(`write ${index}`), async () => {
					await writeFile(
						join(workTree, "skills", `file-${index}.md`),
						`content ${index}`,
					);
				}),
			),
		);
		for (const sha of results) expect(sha).toMatch(/^[0-9a-f]{40}$/);
		expect(new Set(results).size).toBe(20);
		const log = await history.log({ limit: 100 });
		expect(log).toHaveLength(20);
	});

	test("a stale index.lock is cleared; a fresh one fails the commit but not the write", async () => {
		const { dir, workTree, gitDir, history } = await fixture();
		const seed = await history.write(userMeta("seed"), async () => {
			await writeFile(join(workTree, "notes.md"), "seed");
		});
		expect(seed).toBeDefined();
		const lockPath = join(gitDir, "index.lock");
		await writeFile(lockPath, "");
		const stale = new Date(Date.now() - 11 * 60 * 1000);
		await utimes(lockPath, stale, stale);
		const afterStale = await history.write(userMeta("after stale"), async () => {
			await writeFile(join(workTree, "notes.md"), "stale-cleared");
		});
		expect(afterStale).toBeDefined();
		await expect(readFile(join(workTree, "notes.md"), "utf8")).resolves.toBe(
			"stale-cleared",
		);
		// A fresh lock fails the commit but the mutation still lands.
		await writeFile(lockPath, "");
		const blocked = await history.write(userMeta("blocked"), async () => {
			await writeFile(join(workTree, "notes.md"), "blocked");
		});
		expect(blocked).toBeUndefined();
		await expect(readFile(join(workTree, "notes.md"), "utf8")).resolves.toBe(
			"blocked",
		);
		const log = await history.log({ limit: 10 });
		expect(log).toHaveLength(2);
		expect(log[0]?.summary).toBe("after stale");
		await rm(lockPath, { force: true });
		void dir;
	});
});

describe("failure modes", () => {
	test("missing git binary: write still mutates, availability names git", async () => {
		const { workTree, history } = await fixture({
			gitBinary: "/nonexistent/git",
		});
		const availability = await history.availability();
		expect(availability.ok).toBe(false);
		if (!availability.ok) expect(availability.reason).toContain("/nonexistent/git");
		const sha = await history.write(userMeta("still lands"), async () => {
			await writeFile(join(workTree, "notes.md"), "mutated");
		});
		expect(sha).toBeUndefined();
		await expect(readFile(join(workTree, "notes.md"), "utf8")).resolves.toBe(
			"mutated",
		);
	});

	test("corrupt git dir is moved aside and re-initialized with a snapshot", async () => {
		const { dir, workTree, gitDir, logLines, history } = await fixture();
		const first = await history.write(userMeta("one"), async () => {
			await writeFile(join(workTree, "notes.md"), "v1");
		});
		expect(first).toBeDefined();
		await writeFile(join(gitDir, "HEAD"), "garbage not a ref\n");
		const second = await history.write(userMeta("two"), async () => {
			await writeFile(join(workTree, "notes.md"), "v2");
		});
		expect(second).toBeDefined();
		const siblings = await readdir(dir);
		const broken = siblings.filter((name) => name.startsWith("repo.git.broken-"));
		expect(broken).toHaveLength(1);
		expect(logLines.some((line) => line.includes("broken-"))).toBe(true);
		const log = await history.log({ limit: 10 });
		expect(log).toHaveLength(2);
		expect(log[1]?.summary).toBe(
			`Re-initialized after a corrupt history (old repo moved to ${broken[0]})`,
		);
		expect(log[0]?.summary).toBe("two");
	});

	test("an unreadable work tree: availability is {ok:false} and the write still lands", async (context) => {
		if (process.getuid?.() === 0) {
			context.skip();
			return;
		}
		const { workTree, gitDir, history } = await fixture();
		try {
			await chmod(workTree, 0o000);
			const availability = await history.availability();
			expect(availability.ok).toBe(false);
			if (!availability.ok) expect(availability.reason).toContain(workTree);
			let mutated = false;
			const sha = await history.write(userMeta("anyway"), async () => {
				mutated = true;
			});
			expect(mutated).toBe(true);
			expect(sha).toBeUndefined();
		} finally {
			await chmod(workTree, 0o755);
		}
		await stat(gitDir).then(
			() => {
				throw new Error("git dir should not have been created");
			},
			(error: NodeJS.ErrnoException) => {
				expect(error.code).toBe("ENOENT");
			},
		);
	});

	test("the host's global git config is ignored", async () => {
		const { workTree, gitDir, history } = await fixture();
		await mkdir(join(workTree, "skills"), { recursive: true });
		// Poison the ambient global config the test process would otherwise
		// see; the module replaces HOME + GIT_CONFIG_GLOBAL so it never reads
		// it. Hooks path and gpgsign would break or sign the commit if honored.
		const poisonedHome = join(workTree, "fake-home");
		await mkdir(join(poisonedHome, ".config", "git"), { recursive: true });
		await writeFile(
			join(poisonedHome, ".gitconfig"),
			"[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/gpg\n[core]\n\thooksPath = /nonexistent/hooks\n",
		);
		const previousHome = process.env.HOME;
		process.env.HOME = poisonedHome;
		try {
			const sha = await history.write(userMeta("unsigned"), async () => {
				await writeFile(join(workTree, "skills", "a.md"), "x");
			});
			expect(sha).toBeDefined();
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
		}
		const { stdout } = await git(gitDir, ["--git-dir", gitDir, "log", "-1", "--show-signature", "--format=%G?"]);
		expect(stdout.trim().startsWith("N")).toBe(true);
	});
});

describe("log", () => {
	test("pages by sha (30 commits → 25 + 5 with before)", async () => {
		const { workTree, history } = await fixture();
		await mkdir(join(workTree, "skills"), { recursive: true });
		const shas: string[] = [];
		for (let index = 0; index < 30; index++) {
			const sha = await history.write(userMeta(`commit ${index}`), async () => {
				await writeFile(join(workTree, "skills", `f-${index}.md`), `${index}`);
			});
			shas.push(sha ?? "");
		}
		const firstPage = await history.log({ limit: 25 });
		expect(firstPage).toHaveLength(25);
		expect(firstPage[0]?.summary).toBe("commit 29");
		const last = firstPage[24];
		expect(last?.summary).toBe("commit 5");
		const secondPage = await history.log({ limit: 25, before: last?.sha });
		expect(secondPage).toHaveLength(5);
		expect(secondPage.map((entry) => entry?.summary)).toEqual([
			"commit 4",
			"commit 3",
			"commit 2",
			"commit 1",
			"commit 0",
		]);
	});
});

describe("changes", () => {
	test("returns before/after per file, restricted to path", async () => {
		const { workTree, history } = await fixture();
		await mkdir(join(workTree, "skills"), { recursive: true });
		await history.write(userMeta("seed"), async () => {
			await writeFile(join(workTree, "notes.md"), "notes v1\n");
			await writeFile(join(workTree, "skills", "a.md"), "a v1\n");
		});
		const second = await history.write(userMeta("edit"), async () => {
			await writeFile(join(workTree, "notes.md"), "notes v2\n");
			await writeFile(join(workTree, "skills", "a.md"), "a v2\n");
		});
		const all = await history.changes(second ?? "");
		expect(all).toEqual([
			{ path: "notes.md", before: "notes v1\n", after: "notes v2\n" },
			{ path: "skills/a.md", before: "a v1\n", after: "a v2\n" },
		]);
		const filtered = await history.changes(second ?? "", "skills/a.md");
		expect(filtered).toEqual([
			{ path: "skills/a.md", before: "a v1\n", after: "a v2\n" },
		]);
		// Newly added file: empty before.
		const added = await history.write(userMeta("add"), async () => {
			await writeFile(join(workTree, "skills", "b.md"), "b v1\n");
		});
		const addChanges = await history.changes(added ?? "");
		expect(addChanges).toEqual([{ path: "skills/b.md", before: "", after: "b v1\n" }]);
		// Deletion: empty after.
		const removed = await history.write(userMeta("del"), async () => {
			await rm(join(workTree, "skills", "b.md"));
		});
		const removeChanges = await history.changes(removed ?? "");
		expect(removeChanges).toEqual([{ path: "skills/b.md", before: "b v1\n", after: "" }]);
	});

	test("binary or oversize files return the marker text", async () => {
		const { workTree, history } = await fixture();
		await mkdir(join(workTree, "skills"), { recursive: true });
		const binarySha = await history.write(userMeta("binary"), async () => {
			await writeFile(join(workTree, "skills", "bin.dat"), Buffer.from([0, 1, 2, 3]));
		});
		const binaryChanges = await history.changes(binarySha ?? "");
		expect(binaryChanges).toEqual([
			{
				path: "skills/bin.dat",
				before: "",
				after: "(binary or larger than 64 KiB)",
			},
		]);
		// An edit to a binary file marks both sides.
		const binaryEdit = await history.write(userMeta("binary edit"), async () => {
			await writeFile(join(workTree, "skills", "bin.dat"), Buffer.from([9, 8, 7, 0]));
		});
		expect(await history.changes(binaryEdit ?? "")).toEqual([
			{
				path: "skills/bin.dat",
				before: "(binary or larger than 64 KiB)",
				after: "(binary or larger than 64 KiB)",
			},
		]);
		const bigSha = await history.write(userMeta("big"), async () => {
			await writeFile(join(workTree, "skills", "big.md"), "x".repeat(70 * 1024));
		});
		const bigChanges = await history.changes(bigSha ?? "");
		expect(bigChanges).toEqual([
			{
				path: "skills/big.md",
				before: "",
				after: "(binary or larger than 64 KiB)",
			},
		]);
	});
});

describe("restore", () => {
	test("brings back a deleted file and commits it", async () => {
		const { workTree, history } = await fixture();
		await mkdir(join(workTree, "skills"), { recursive: true });
		const first = await history.write(userMeta("add"), async () => {
			await writeFile(join(workTree, "skills", "a.md"), "original\n");
		});
		await history.write(userMeta("delete"), async () => {
			await rm(join(workTree, "skills", "a.md"));
		});
		const restored = await history.restore(first, ["skills/a.md"], {
			...userMeta("restore a.md"),
			undoes: first,
		});
		expect(restored).toBeDefined();
		await expect(
			readFile(join(workTree, "skills", "a.md"), "utf8"),
		).resolves.toBe("original\n");
		const log = await history.log({ limit: 10 });
		expect(log[0]?.summary).toBe("restore a.md");
		expect(log[0]?.undoes).toBe(first);
	});

	test("removes a file added after sha", async () => {
		const { workTree, history } = await fixture();
		const first = await history.write(userMeta("seed"), async () => {
			await writeFile(join(workTree, "notes.md"), "seed\n");
		});
		await mkdir(join(workTree, "skills"), { recursive: true });
		await history.write(userMeta("add b"), async () => {
			await writeFile(join(workTree, "skills", "b.md"), "added later\n");
		});
		const restored = await history.restore(first, ["skills", "notes.md"], userMeta("back"));
		expect(restored).toBeDefined();
		await expect(readFile(join(workTree, "skills", "b.md"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(readFile(join(workTree, "notes.md"), "utf8")).resolves.toBe("seed\n");
	});

	test("with undefined removes the paths", async () => {
		const { workTree, history } = await fixture();
		await mkdir(join(workTree, "skills"), { recursive: true });
		await history.write(userMeta("seed"), async () => {
			await writeFile(join(workTree, "skills", "a.md"), "a\n");
			await writeFile(join(workTree, "notes.md"), "notes\n");
		});
		const restored = await history.restore(undefined, ["skills"], userMeta("before history"));
		expect(restored).toBeDefined();
		await expect(readFile(join(workTree, "skills", "a.md"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(readFile(join(workTree, "notes.md"), "utf8")).resolves.toBe("notes\n");
	});

	test("parentOf(root commit) is undefined, parentOf(second) is the root", async () => {
		const { workTree, history } = await fixture();
		const first = await history.write(userMeta("one"), async () => {
			await writeFile(join(workTree, "notes.md"), "1");
		});
		const second = await history.write(userMeta("two"), async () => {
			await writeFile(join(workTree, "notes.md"), "2");
		});
		expect(await history.parentOf(first ?? "")).toBeUndefined();
		expect(await history.parentOf(second ?? "")).toBe(first);
	});
});

describe("isolation", () => {
	test("every argv carries the isolation flags including -c safe.directory=<workTree>", () => {
		const spec: GitRepoSpec = {
			gitDir: "/tmp/example/repo.git",
			workTree: "/tmp/example/work",
			pathspec: ["skills"],
		};
		const argv = gitArgs(spec, "status", "--short");
		expect(argv[0]).toBe("--git-dir=/tmp/example/repo.git");
		expect(argv[1]).toBe("--work-tree=/tmp/example/work");
		for (const flag of [
			"-c",
			"commit.gpgsign=false",
			"tag.gpgsign=false",
			"core.hooksPath=/dev/null",
			"core.attributesFile=/dev/null",
			"core.excludesFile=/dev/null",
			"core.fsmonitor=false",
			"safe.directory=/tmp/example/work",
		]) {
			expect(argv).toContain(flag);
		}
		expect(argv[argv.length - 2]).toBe("status");
		expect(argv[argv.length - 1]).toBe("--short");
		const initArgv = gitArgs(spec, "init", "--initial-branch=main");
		expect(initArgv.slice(-2)).toEqual(["init", "--initial-branch=main"]);
	});
});

describe("trailers", () => {
	test("round-trip through encodeTrailers and decodeCommit", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-trailers-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		await git(dir, ["init", "--initial-branch=main"]);
		const metas: Array<CommitMeta & { expectedActor: HistoryActor }> = [
			{
				actor: { kind: "user", user: "alice" },
				expectedActor: { kind: "user", user: "alice" },
				summary: "a summary line",
				action: "apply",
				skill: "acme-deploy",
				reviewId: "r-9",
				conversationId: 7,
				reason: "because",
				undoes: "deadbeef",
			},
			{
				actor: { kind: "curator" },
				expectedActor: { kind: "curator" },
				summary: "curator edit",
				action: "overlay",
				skill: "acme-deploy",
			},
			{
				actor: { kind: "agent" },
				expectedActor: { kind: "agent" },
				summary: "agent changes",
				conversationId: 3,
			},
			{
				actor: { kind: "outside" },
				expectedActor: { kind: "outside" },
				summary: "outside changes",
			},
		];
		for (const meta of metas) {
			const sha = await rawCommit(dir, meta, meta.summary);
			const raw = await rawShow(dir, sha);
			const decoded = decodeCommit(raw);
			expect(decoded.sha).toBe(sha);
			expect(decoded.summary).toBe(meta.summary);
			expect(decoded.actor).toEqual(meta.expectedActor);
			expect(decoded.action).toBe(meta.action);
			expect(decoded.skill).toBe(meta.skill);
			expect(decoded.reviewId).toBe(meta.reviewId);
			expect(decoded.conversationId).toBe(meta.conversationId);
			expect(decoded.reason).toBe(meta.reason);
			expect(decoded.undoes).toBe(meta.undoes);
			expect(Number.isNaN(Date.parse(decoded.at))).toBe(false);
			expect(decoded.paths).toEqual([]);
		}
	});
});
