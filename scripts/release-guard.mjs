#!/usr/bin/env node
/**
 * release-guard.mjs (release workstream Task 2.2): the pre-publish guard
 * every release job runs. It answers one question: "is it safe to
 * publish what this run is about to publish?"
 *
 *   release-guard.mjs <tag> <package.json path> [--skip-ancestry]
 *   release-guard.mjs <tag> <package.json path> --dry-run-ref <sha>
 *   release-guard.mjs --chart <chart-v tag> <Chart.yaml path>
 *
 * Tag mode checks, in order:
 *
 *   1. the tag matches ^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$;
 *   2. the stripped tag equals the manifest's `version`;
 *   3. `git merge-base --is-ancestor <tag> origin/main` succeeds in the
 *      process CWD (the tag is reachable from main — a release never
 *      ships a commit that isn't).
 *
 * `--chart` mode is the same three checks against the CHART's own
 * versioning: the tag is `chart-v<semver>` and its stripped form must
 * equal the `version:` line of Chart.yaml. The chart's `appVersion` is
 * deliberately NOT checked here — it is the CORE release it deploys,
 * read from source by the chart job, and is expected to differ from the
 * chart's own version (that is the whole point of decoupling them).
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
const CHART_TAG_PATTERN = /^chart-v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

function fail(reason) {
	process.stderr.write(`release-guard: ${reason}\n`);
	process.exit(1);
}

function usage() {
	process.stderr.write(
		"usage: release-guard.mjs <tag> <package.json path> [--skip-ancestry | --dry-run-ref <sha>]\n" +
			"       release-guard.mjs --chart <chart-v tag> <Chart.yaml path> [--skip-ancestry]\n",
	);
	process.exit(2);
}

const args = process.argv.slice(2);
const positional = [];
let skipAncestry = false;
let dryRunRef;
let chartMode = false;
for (let i = 0; i < args.length; i += 1) {
	const arg = args[i];
	if (arg === "--chart") {
		chartMode = true;
	} else if (arg === "--skip-ancestry") {
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
// A dry run has no tag by definition, so it cannot be a chart run.
if (chartMode && dryRunRef !== undefined) usage();
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
if (chartMode) {
	if (!CHART_TAG_PATTERN.test(tag)) {
		fail(
			`tag '${tag}' does not match ^chart-v\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.]+)?$ — chart tags are chart-v<semver>`,
		);
	}
} else if (!TAG_PATTERN.test(tag)) {
	fail(
		`tag '${tag}' does not match ^v\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.]+)?$ — tags are v<semver>`,
	);
}
const version = chartMode ? tag.slice("chart-v".length) : tag.slice(1);

// 2. The artifact's own version equals the stripped tag. Read the file
// FIRST (fail-loud on the path before any git work runs). Chart mode
// reads `version:` from Chart.yaml (NOT appVersion — that is the core
// release the chart deploys, expected to differ); package mode reads
// `version` from package.json.
let artifactVersion;
if (chartMode) {
	let yaml;
	try {
		yaml = readFileSync(manifestPath, "utf8");
	} catch (cause) {
		fail(
			`cannot read chart ${manifestPath} (${cause instanceof Error ? cause.message : String(cause)})`,
		);
	}
	// Deliberately a LINE match, not a YAML parse: the guard is
	// dependency-free (no yaml package at .sigrun-tools), and Chart.yaml's
	// top-level `version:`/`appVersion:` are pinned-format lines the
	// workflow itself rewrites with sed. `appVersion` is explicitly
	// excluded (the chart's app is not the chart's version).
	const match = /^version:[ \t]*(.+?)[ \t]*$/m.exec(yaml);
	if (match === null) {
		fail(`chart ${manifestPath} has no top-level 'version:' line`);
	}
	artifactVersion = match[1].replace(/^["']|["']$/g, "");
} else {
	try {
		artifactVersion = JSON.parse(readFileSync(manifestPath, "utf8")).version;
	} catch (cause) {
		fail(
			`cannot read manifest ${manifestPath} (${cause instanceof Error ? cause.message : String(cause)})`,
		);
	}
}
if (typeof artifactVersion !== "string" || artifactVersion === "") {
	fail(`${manifestPath} has no version`);
}
if (artifactVersion !== version) {
	fail(
		`tag ${tag} (version ${version}) does not match ${manifestPath} version ${artifactVersion}`,
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
