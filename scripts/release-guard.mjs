#!/usr/bin/env node
/**
 * release-guard.mjs (release workstream Task 2.2): the pre-publish guard
 * every extension release job runs. It answers one question: "is it safe
 * to publish what this run is about to publish?"
 *
 *   release-guard.mjs <tag> <package.json path> [--skip-ancestry]
 *   release-guard.mjs <tag> <package.json path> --dry-run-ref <sha>
 *
 * Tag mode checks, in order:
 *
 *   1. the tag matches ^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$;
 *   2. the stripped tag equals the manifest's `version`;
 *   3. `git merge-base --is-ancestor <tag> origin/main` succeeds in the
 *      process CWD (the tag is reachable from main — a release never
 *      ships a commit that isn't).
 *
 * `--dry-run-ref <sha>` replaces the tag and version checks with
 * "`<sha>` is an ancestor of `origin/main`", so a `workflow_dispatch`
 * dry run can exercise current main before any tag carries the new
 * machinery. `--skip-ancestry` exists for unit tests ONLY — no workflow
 * passes it.
 *
 * Checkout contract: the job must check the repo out with
 * `fetch-depth: 0` and fetch the tag ref plus
 * `main:refs/remotes/origin/main`; the default fetch-depth 1 leaves
 * `origin/main` absent and the ancestry check fails (by design — a
 * guard that cannot verify ancestry fails closed).
 *
 * Exit 0 on pass; exit 1 with a one-line reason on stderr otherwise;
 * exit 2 on a usage error. DEPENDENCY-FREE (node: built-ins only): the
 * workflows run this from a bare checkout of this repo's scripts/ at
 * `.sigrun-tools`, with no `npm ci`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TAG_PATTERN = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

function fail(reason) {
	process.stderr.write(`release-guard: ${reason}\n`);
	process.exit(1);
}

function usage() {
	process.stderr.write(
		"usage: release-guard.mjs <tag> <package.json path> [--skip-ancestry | --dry-run-ref <sha>]\n",
	);
	process.exit(2);
}

const args = process.argv.slice(2);
const positional = [];
let skipAncestry = false;
let dryRunRef;
for (let i = 0; i < args.length; i += 1) {
	const arg = args[i];
	if (arg === "--skip-ancestry") {
		skipAncestry = true;
	} else if (arg === "--dry-run-ref") {
		i += 1;
		if (i >= args.length) usage();
		dryRunRef = args[i];
	} else if (arg.startsWith("--")) {
		usage();
	} else {
		positional.push(arg);
	}
}
if (positional.length !== 2 || (skipAncestry && dryRunRef !== undefined)) {
	usage();
}
const [tag, manifestPath] = positional;

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function isAncestor(ref, branch) {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", ref, branch], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

if (dryRunRef !== undefined) {
	// Dry-run mode: the tag and version checks do not apply (no tag
	// exists yet by definition); only ancestry of the candidate SHA
	// matters.
	if (!isAncestor(dryRunRef, "origin/main")) {
		fail(`dry-run ref ${dryRunRef} is not an ancestor of origin/main`);
	}
	process.exit(0);
}

// 1. Tag shape.
if (!TAG_PATTERN.test(tag)) {
	fail(
		`tag '${tag}' does not match ^v\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.]+)?$ — tags are v<semver>`,
	);
}
const version = tag.slice(1);

// 2. Manifest version equals the stripped tag. Read the manifest FIRST
// (fail-loud on the path before any git work runs).
let manifestVersion;
try {
	manifestVersion = JSON.parse(readFileSync(manifestPath, "utf8")).version;
} catch (cause) {
	fail(
		`cannot read manifest ${manifestPath} (${cause instanceof Error ? cause.message : String(cause)})`,
	);
}
if (typeof manifestVersion !== "string" || manifestVersion === "") {
	fail(`manifest ${manifestPath} has no version`);
}
if (manifestVersion !== version) {
	fail(
		`tag ${tag} (version ${version}) does not match manifest ${manifestPath} version ${manifestVersion}`,
	);
}

// 3. Ancestry: the tag's commit must be reachable from origin/main.
if (!skipAncestry) {
	try {
		git(["rev-parse", "--verify", `${tag}^{commit}`]);
	} catch {
		fail(`tag ${tag} does not resolve to a commit in this checkout`);
	}
	if (!isAncestor(tag, "origin/main")) {
		fail(
			`tag ${tag} is not an ancestor of origin/main (checkout needs fetch-depth 0 plus a fetched origin/main ref)`,
		);
	}
}
