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
const RELEASE_FILE = new URL("../.github/workflows/release.yml", import.meta.url);

interface Step {
	name?: string;
	run?: string | number;
	uses?: string;
	with?: Record<string, unknown>;
	env?: Record<string, string>;
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

/** Parsed release.yml (same contract: a missing/malformed release
 * workflow is a missing deliverable, not a skip). */
function releaseWorkflow(): {
	on: Record<string, unknown>;
	jobs: Record<string, Job>;
	permissions?: Record<string, string>;
} {
	const parsed = YAML.parse(readFileSync(RELEASE_FILE, "utf8"));
	expect(parsed, "release.yml must exist and parse").toBeTypeOf("object");
	return parsed as {
		on: Record<string, unknown>;
		jobs: Record<string, Job>;
		permissions?: Record<string, string>;
	};
}

/** All steps of all jobs flattened (release assertions span jobs). */
function releaseSteps(): Step[] {
	const { jobs } = releaseWorkflow();
	return Object.values(jobs).flatMap((j) => j.steps ?? []);
}

describe(".github/workflows/release.yml (image-workflow §3, release half)", () => {
	test("triggers on v-tags and exposes a REQUIRED tag input via workflow_dispatch", () => {
		const { on } = releaseWorkflow();
		const tags = (on.push as Record<string, unknown> | undefined)?.tags;
		expect(tags).toEqual(["v*"]);
		const dispatch = on.workflow_dispatch as
			| { inputs?: Record<string, { required?: boolean }> }
			| undefined;
		expect(dispatch, "workflow_dispatch trigger must exist").toBeDefined();
		// Required: the dispatch exists to RE-RUN an existing tag's release,
		// never to build an arbitrary SHA — an optional tag input would let a
		// typo silently release whatever HEAD happens to be.
		expect(dispatch?.inputs?.tag?.required).toBe(true);
	});

	test("workflow-level permissions are contents:read + packages:write", () => {
		const { permissions } = releaseWorkflow();
		expect(permissions?.contents).toBe("read");
		expect(permissions?.packages).toBe("write");
	});

	test("guards the dispatch: checkout refs/tags/<tag> with an exact-match fail-loud step", () => {
		const steps = releaseSteps();
		const runs = steps.map(runOf).join("\n");
		// The guard's belt is a describe with --exact-match: bare
		// `--exact-match` only sees annotated tags; the release runbook's
		// `git tag v<semver>` form is lightweight, so the workflow uses
		// `--tags --exact-match`. Either spelling satisfies the contract.
		const line = runs.split("\n").find((l) => l.includes("describe") && l.includes("--exact-match"));
		expect(line, "a step must run git describe --exact-match").toBeDefined();
		expect(line).toContain("--tags");
		// The workspace checkout must pin the ref, not HEAD — combined
		// with the guard this is the "existing tag only, never arbitrary
		// SHAs" contract. The probe clone the guard runs in has no ref;
		// the release checkout does.
		const tagged = releaseSteps().some(
			(s) =>
				s.uses?.startsWith("actions/checkout@") &&
				String((s.with as { ref?: string } | undefined)?.ref ?? "").startsWith("refs/tags/"),
		);
		expect(tagged, "a checkout must pin ref: refs/tags/<tag>").toBe(true);
	});

	test("pushes the image to ghcr.io/sigrun-ai/sigrun multi-arch", () => {
		const { jobs } = releaseWorkflow();
		const steps = jobs.image?.steps ?? [];
		const runs = steps.map(runOf).join("\n");
		expect(steps.length, "the image job must exist").toBeGreaterThan(0);
		const build = steps.find((s) => s.uses?.startsWith("docker/build-push-action@"));
		expect(build).toBeDefined();
		expect((build?.with as { platforms?: string } | undefined)?.platforms).toBe(
			"linux/amd64,linux/arm64",
		);
		expect((build?.with as { push?: boolean } | undefined)?.push).toBe(true);
		const tags = (build?.with as { tags?: string | string[] } | undefined)?.tags;
		const tagsText = Array.isArray(tags) ? tags.join("\n") : String(tags ?? "");
		expect(tagsText).toContain("ghcr.io/sigrun-ai/sigrun");
		expect(tagsText).toContain("latest");
		// The version label rides the APP_VERSION build-arg (Dockerfile ARG).
		const buildArgs = (build?.with as { "build-args"?: string } | undefined)?.[
			"build-args"
		];
		expect(String(buildArgs ?? "")).toContain("APP_VERSION=");
		// v prefix stripped for the image tag (v0.1.5 tag → 0.1.5 image).
		expect(runs).toContain("${TAG#v}");
	});

	test("the image job runs the registry-mode dance (explicit-specs lock regen)", () => {
		const { jobs } = releaseWorkflow();
		const runs = (jobs.image?.steps ?? []).map(runOf);
		const dance = runs.find((r) => r.includes("publish-deps.mjs registry"));
		expect(dance, "release build must run publish-deps.mjs registry").toBeDefined();
		const install = runs.find((r) => r.includes("npm install") && r.includes("--package-lock-only"));
		expect(install, "lock regen must carry --package-lock-only").toBeDefined();
		expect(install).toContain("@sigrun/ext-");
	});

	test("the chart job rewrites Chart.yaml from the tag and pushes to the OCI registry", () => {
		const { jobs } = releaseWorkflow();
		const runs = (jobs.chart?.steps ?? []).map(runOf).join("\n");
		expect(runs, "chart job must exist").toContain("helm package charts/sigrun");
		expect(runs).toContain("oci://ghcr.io/sigrun-ai/charts/sigrun");
		expect(runs).toContain("helm registry login ghcr.io");
		// The rewrite is sed on the two pinned-format lines (version +
		// appVersion), v-prefix stripped.
		expect(runs).toMatch(/sed.*Chart\.yaml/s);
	});

	test("authenticates with GITHUB_TOKEN only — no PAT secrets anywhere", () => {
		const raw = readFileSync(RELEASE_FILE, "utf8");
		const secretRefs = new Set(
			[...raw.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
		);
		expect(secretRefs.size, "the workflow must reference at least one secret").toBeGreaterThan(
			0,
		);
		expect([...secretRefs], "only secrets.GITHUB_TOKEN may be referenced").toEqual([
			"GITHUB_TOKEN",
		]);
		expect(raw).toContain("secrets.GITHUB_TOKEN");
	});
});

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

	test("image-build: docker build-push-action loads the local linux/amd64 image", () => {
		const { jobs } = workflow();
		const steps = jobs["image-build"]?.steps ?? [];
		const build = steps.find((s) => s.uses?.startsWith("docker/build-push-action@"));
		expect(build).toBeDefined();
		expect((build?.with as { push?: boolean } | undefined)?.push).toBe(false);
		expect((build?.with as { platforms?: string } | undefined)?.platforms).toBe("linux/amd64");
		expect((build?.with as { load?: boolean } | undefined)?.load).toBe(true);
		expect(steps.map(runOf).join("\n")).toContain("scripts/smoke-image.sh sigrun:ci-check");
	});

	test("image-build: loads the image for the smoke-check step", () => {
		const { jobs } = workflow();
		const steps = jobs["image-build"]?.steps ?? [];
		const build = steps.find((s) => s.uses?.startsWith("docker/build-push-action@"));
		expect((build?.with as { load?: boolean } | undefined)?.load).toBe(true);
		const buildIndex = steps.indexOf(build as Step);
		const smokeIndex = steps.findIndex((s) => runOf(s).includes("scripts/smoke-image.sh"));
		expect(smokeIndex, "image smoke-check must follow its build").toBeGreaterThan(buildIndex);
	});

	test("sandbox: tests, lints, and builds both musl targets", () => {
		const { jobs } = workflow();
		const steps = jobs.sandbox?.steps ?? [];
		expect(steps.length, "the sandbox job must exist").toBeGreaterThan(0);
		const runs = steps.map(runOf).join("\n");
		expect(runs).toContain("cargo test");
		expect(runs).toContain("cargo clippy");
		expect(runs).toContain("-- -D warnings");
		expect(runs).toContain("--target x86_64-unknown-linux-musl");
		expect(runs).toContain("--target aarch64-unknown-linux-musl");
		expect(runs).toContain("musl-tools");
		expect(runs).toContain("gcc-aarch64-linux-gnu");
		const toolchain = steps.find((s) => s.uses?.startsWith("dtolnay/rust-toolchain@"));
		expect(toolchain).toBeDefined();
		expect(String(toolchain?.with?.targets ?? "")).toContain("x86_64-unknown-linux-musl");
		expect(String(toolchain?.with?.targets ?? "")).toContain("aarch64-unknown-linux-musl");
		const env = Object.assign({}, ...steps.map((s) => s.env ?? {}));
		expect(env.CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER).toBe("aarch64-linux-gnu-gcc");
		expect(env.CC_aarch64_unknown_linux_musl).toBe("aarch64-linux-gnu-gcc");
	});

	test("sandbox: uploads both musl helper binaries as artifacts", () => {
		const { jobs } = workflow();
		const uploads = (jobs.sandbox?.steps ?? []).filter((s) =>
			s.uses?.startsWith("actions/upload-artifact@"),
		);
		const paths = uploads.map((s) => String(s.with?.path ?? "")).join("\n");
		expect(paths).toContain("sandbox/target/x86_64-unknown-linux-musl/release/sigrun-sandbox");
		expect(paths).toContain("sandbox/target/aarch64-unknown-linux-musl/release/sigrun-sandbox");
	});

	test("image smoke: probes the bundled helper and verifies tini is PID 1", () => {
		const smoke = readFileSync(new URL("../scripts/smoke-image.sh", import.meta.url), "utf8");
		expect(smoke).toContain('docker run --rm "$image" /usr/local/lib/sigrun/sigrun-sandbox probe');
		expect(smoke).toContain("JSON.parse");
		expect(smoke).toContain("ps -o comm= 1");
		expect(smoke).toContain('"tini"');
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
