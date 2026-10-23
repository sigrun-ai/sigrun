/**
 * .github/workflows/ci.yml — the CI contract (image-workflow spec §3, CI
 * half), pinned the same way the chart is: the file IS the deliverable,
 * and a silent edit that drops a checkout, weakens permissions, or reverts
 * the registry-mode lock dance to the bare `--package-lock-only` form
 * (which keeps `link:` entries → dangling built-in symlinks → boot
 * quarantine — the exact failure the dance exists to prevent) must fail
 * a test, not a live run.
 *
 * These are STRUCTURE assertions (YAML-parsed shape + the exact strings
 * the steps run) — they prove the workflow says the right thing, not that
 * GitHub executes it; live validation is the post-push gate (Task 8).
 *
 * Parsed as data with `yaml` (already the manifests-test dependency), the
 * same YAML 1.2 reading GitHub's own parser uses.
 */

import { readFileSync } from "node:fs";
import YAML from "yaml";
import { describe, expect, test } from "vitest";

const WORKFLOW_FILE = new URL("../.github/workflows/ci.yml", import.meta.url);

interface Step {
	name?: string;
	run?: string | number;
	uses?: string;
	with?: Record<string, unknown>;
}

interface Job {
	"runs-on"?: string | string[];
	steps?: Step[];
}

/** Parsed ci.yml (fails loud when the file is absent/malformed — a
 * missing workflow is a missing deliverable, not a skip). */
function workflow(): { on: Record<string, unknown>; jobs: Record<string, Job>; permissions?: Record<string, string> } {
	const parsed = YAML.parse(readFileSync(WORKFLOW_FILE, "utf8"));
	expect(parsed, "ci.yml must exist and parse").toBeTypeOf("object");
	return parsed as { on: Record<string, unknown>; jobs: Record<string, Job>; permissions?: Record<string, string> };
}

/** A step's run body as a string (YAML may parse bare `run:` short forms
 * as non-strings; the contract is the text). */
function runOf(step: Step): string {
	return typeof step.run === "string" ? step.run : String(step.run ?? "");
}

describe(".github/workflows/ci.yml (image-workflow §3, CI half)", () => {
	test("triggers on pull_request and push to main", () => {
		const { on } = workflow();
		expect(on).toHaveProperty("pull_request");
		const push = on.push as Record<string, unknown> | undefined;
		expect(push).toBeDefined();
		expect(push?.branches).toEqual(["main"]);
	});

	test("workflow-level permissions are read-only (contents: read)", () => {
		const { permissions } = workflow();
		expect(permissions?.contents).toBe("read");
	});

	test("the test job checks out all four repos in the sibling layout", () => {
		const { jobs } = workflow();
		const test = jobs.test;
		expect(test).toBeDefined();
		const paths = (test?.steps ?? [])
			.filter((s) => s.uses?.startsWith("actions/checkout@"))
			.map((s) => (s.with as { path?: string } | undefined)?.path);
		expect(paths).toEqual(["sigrun", "sigrun-ext-codemode", "sigrun-ext-mcp", "sigrun-ext-tool-search"]);
	});

	test("the test job runs npm ci, the suite, and typecheck on node 22", () => {
		const { jobs } = workflow();
		const runs = (jobs.test?.steps ?? []).map(runOf).join("\n");
		expect(runs).toContain("npm ci");
		expect(runs).toContain("npm test");
		expect(runs).toContain("npm run typecheck");
		const nodeVersion = (jobs.test?.steps ?? [])
			.find((s) => s.uses?.startsWith("actions/setup-node@"))
			?.with as { "node-version"?: string } | undefined;
		expect(nodeVersion?.["node-version"]).toBe("22");
	});

	test("image-build: the registry-mode dance uses the explicit-specs lock regen", () => {
		const { jobs } = workflow();
		const steps = jobs["image-build"]?.steps ?? [];
		const runs = steps.map(runOf);
		const dance = runs.find((r) => r.includes("publish-deps.mjs registry"));
		expect(dance, "a step must run publish-deps.mjs registry").toBeDefined();
		// The pins are derived, never hardcoded: the dance reads the three
		// @sigrun/ext-* versions publish-deps.mjs just wrote into package.json
		// (each sourced from the sibling checkout's own manifest), then names
		// them explicitly in the lock regen — a bare `npm install
		// --package-lock-only` keeps the lock's `link:` entries and npm ci
		// materializes dangling built-in symlinks (boot quarantine).
		expect(dance).toContain("publish-deps.mjs registry");
		const install = runs.find((r) => r.includes("npm install") && r.includes("--package-lock-only"));
		expect(install, "an npm-install step must carry --package-lock-only").toBeDefined();
		expect(install).toContain("@sigrun/ext-");
	});

	test("image-build: docker build-push-action with push:false, linux/amd64 only", () => {
		const { jobs } = workflow();
		const steps = jobs["image-build"]?.steps ?? [];
		const build = steps.find((s) => s.uses?.startsWith("docker/build-push-action@"));
		expect(build).toBeDefined();
		expect((build?.with as { push?: boolean } | undefined)?.push).toBe(false);
		expect((build?.with as { platforms?: string } | undefined)?.platforms).toBe("linux/amd64");
	});

	test("chart-lint: fetches the gitignored vendored dependency, then lint + template", () => {
		const { jobs } = workflow();
		const runs = (jobs["chart-lint"]?.steps ?? []).map(runOf);
		const joined = runs.join("\n");
		expect(joined).toContain("helm dependency update charts/sigrun");
		expect(joined).toContain("helm lint charts/sigrun");
		expect(joined).toContain("helm template charts/sigrun");
	});
});
