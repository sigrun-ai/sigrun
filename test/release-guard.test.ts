/**
 * release-guard.mjs (release workstream Task 2.2): the tag/manifest/
 * ancestry guard every extension release job runs before publishing.
 *
 * These tests are hermetic BY CONSTRUCTION: the script's ancestry checks
 * shell out to `git` in the process CWD, so every ancestry case runs in a
 * temp git repo created here (never the real sigrun checkout — a test
 * whose verdict depends on the developer's local main would flake across
 * machines). `GIT_CONFIG_GLOBAL=/dev/null` keeps fixture commits working
 * on machines whose global git config enforces signing.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..");
const GUARD = join(REPO_ROOT, "scripts", "release-guard.mjs");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };

/** Run the guard; returns exit code, stdout and stderr. */
function runGuard(
	args: string[],
	cwd: string,
): { code: number; stdout: string; stderr: string } {
	const res = spawnSync(process.execPath, [GUARD, ...args], {
		cwd,
		encoding: "utf8",
	});
	return {
		code: res.status ?? 2,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
	};
}

/** A temp dir holding a package.json with the given version. */
function manifestDir(version: string): string {
	const dir = mkdtempSync(join(tmpdir(), "release-guard-manifest-"));
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify({ name: "@acme/ext-widget", version })}\n`,
	);
	return dir;
}

/** Commit a file in a temp git repo and return the commit SHA. */
function commitFile(repo: string, file: string, content: string): string {
	writeFileSync(join(repo, file), content);
	execFileSync("git", ["add", file], { cwd: repo, env: GIT_ENV });
	execFileSync(
		"git",
		["-c", "user.name=Tester", "-c", "user.email=tester@example.invalid", "commit", "-m", "commit"],
		{ cwd: repo, env: GIT_ENV, stdio: "ignore" },
	);
	return execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repo,
		env: GIT_ENV,
		encoding: "utf8",
	}).trim();
}

/**
 * A temp git repo with a two-commit history on the default branch and a
 * `v<version>` tag on the FIRST commit, plus `refs/remotes/origin/main`
 * at HEAD (the CI checkout contract: fetch-depth 0 + an explicit fetch
 * of main, so the ancestry check has real refs). Returns the dir, the
 * tagged (first) commit SHA, and the untagged HEAD SHA.
 */
function gitRepoWithTag(version: string): {
	dir: string;
	taggedSha: string;
	headSha: string;
} {
	const dir = mkdtempSync(join(tmpdir(), "release-guard-git-"));
	execFileSync("git", ["init", "-b", "main"], { cwd: dir, env: GIT_ENV });
	const first = commitFile(dir, "one.txt", "one\n");
	execFileSync("git", ["tag", `v${version}`], { cwd: dir, env: GIT_ENV });
	const head = commitFile(dir, "two.txt", "two\n");
	execFileSync(
		"git",
		["update-ref", "refs/remotes/origin/main", "HEAD"],
		{ cwd: dir, env: GIT_ENV },
	);
	return { dir, taggedSha: first, headSha: head };
}

/** A bare temp git repo with a `main` branch (no tags, no origin ref). */
function bareGitRepo(): { dir: string; headSha: string } {
	const dir = mkdtempSync(join(tmpdir(), "release-guard-git-"));
	execFileSync("git", ["init", "-b", "main"], { cwd: dir, env: GIT_ENV });
	const head = commitFile(dir, "one.txt", "one\n");
	return { dir, headSha: head };
}

describe("release-guard.mjs", () => {
	test("matching tag and version passes", () => {
		const { dir } = gitRepoWithTag("0.2.0");
		writeFileSync(
			join(dir, "package.json"),
			`${JSON.stringify({ name: "@acme/ext-widget", version: "0.2.0" })}\n`,
		);
		const res = runGuard(["v0.2.0", "package.json"], dir);
		expect(res.code, res.stderr).toBe(0);
	});

	test("tag v0.2.0 against manifest 0.2.1 fails, naming both", () => {
		const { dir } = gitRepoWithTag("0.2.0");
		writeFileSync(
			join(dir, "package.json"),
			`${JSON.stringify({ name: "@acme/ext-widget", version: "0.2.1" })}\n`,
		);
		const res = runGuard(["v0.2.0", "package.json"], dir);
		expect(res.code).toBe(1);
		expect(res.stderr).toContain("0.2.0");
		expect(res.stderr).toContain("0.2.1");
	});

	test("a tag without the v prefix fails", () => {
		const { dir } = gitRepoWithTag("0.2.0");
		const res = runGuard(["0.2.0", "package.json"], dir);
		expect(res.code).toBe(1);
		expect(res.stderr).toContain("0.2.0");
	});

	test("prerelease tag v0.2.0-rc.1 against version 0.2.0-rc.1 passes", () => {
		const { dir } = gitRepoWithTag("0.2.0-rc.1");
		writeFileSync(
			join(dir, "package.json"),
			`${JSON.stringify({ name: "@acme/ext-widget", version: "0.2.0-rc.1" })}\n`,
		);
		const res = runGuard(["v0.2.0-rc.1", "package.json"], dir);
		expect(res.code, res.stderr).toBe(0);
	});

	test("a missing manifest fails, naming the path", () => {
		const { dir } = gitRepoWithTag("0.2.0");
		const res = runGuard(["v0.2.0", "does/not/exist.json"], dir);
		expect(res.code).toBe(1);
		expect(res.stderr).toContain("does/not/exist.json");
	});

	test("--dry-run-ref passes for a SHA on main", () => {
		const { dir, headSha } = gitRepoWithTag("0.2.0");
		// No manifest in this temp repo at all: dry-run mode must not
		// consult it.
		const res = runGuard(
			["--dry-run-ref", headSha, "v9.9.9", "package.json"],
			dir,
		);
		expect(res.code, res.stderr).toBe(0);
	});

	test("--dry-run-ref fails for a SHA not on main, naming the SHA", () => {
		const { dir } = gitRepoWithTag("0.2.0");
		// An orphan commit reachable from nothing in this repo's main.
		const foreign = mkdtempSync(join(tmpdir(), "release-guard-foreign-"));
		execFileSync("git", ["init", "-b", "main"], { cwd: foreign, env: GIT_ENV });
		const foreignSha = commitFile(foreign, "f.txt", "foreign\n");
		// Fetch it into the repo under test so the object exists (the guard
		// must fail on ANCESTRY, not on a missing object).
		execFileSync("git", ["fetch", foreign, "main"], { cwd: dir, env: GIT_ENV });
		const res = runGuard(
			["--dry-run-ref", foreignSha, "v9.9.9", "package.json"],
			dir,
		);
		expect(res.code).toBe(1);
		expect(res.stderr).toContain(foreignSha);
	});

	test("--dry-run-ref still fails when the manifest disagrees", () => {
		// The mode replaces the tag+version checks entirely: a manifest
		// mismatch must NOT fail a valid dry-run ref.
		const { dir, headSha } = gitRepoWithTag("0.2.0");
		writeFileSync(
			join(dir, "package.json"),
			`${JSON.stringify({ name: "@acme/ext-widget", version: "0.2.1" })}\n`,
		);
		const res = runGuard(
			["--dry-run-ref", headSha, "v9.9.9", "package.json"],
			dir,
		);
		expect(res.code, res.stderr).toBe(0);
	});

	test("--skip-ancestry skips the origin/main check", () => {
		// main exists but refs/remotes/origin/main was never fetched —
		// the ancestry check would fail here without the skip.
		const { dir } = bareGitRepo();
		execFileSync("git", ["tag", "v0.2.0"], { cwd: dir, env: GIT_ENV });
		writeFileSync(
			join(dir, "package.json"),
			`${JSON.stringify({ name: "@acme/ext-widget", version: "0.2.0" })}\n`,
		);
		const res = runGuard(
			["v0.2.0", "package.json", "--skip-ancestry"],
			dir,
		);
		expect(res.code, res.stderr).toBe(0);
	});

	test("a tag whose commit is not on origin/main fails the ancestry check", () => {
		const { dir, headSha } = gitRepoWithTag("0.2.0");
		// Tag HEAD (untagged so far) with a NEW tag — it is one commit
		// beyond the origin/main ref gitRepoWithTag left at the first
		// commit... no: origin/main sits at HEAD here. Move it back.
		execFileSync(
			"git",
			["update-ref", "refs/remotes/origin/main", `${headSha}^`],
			{ cwd: dir, env: GIT_ENV },
		);
		execFileSync("git", ["tag", "v9.9.9", headSha], { cwd: dir, env: GIT_ENV });
		writeFileSync(
			join(dir, "package.json"),
			`${JSON.stringify({ name: "@acme/ext-widget", version: "9.9.9" })}\n`,
		);
		const res = runGuard(["v9.9.9", "package.json"], dir);
		expect(res.code).toBe(1);
		expect(res.stderr).toContain("v9.9.9");
	});
});
