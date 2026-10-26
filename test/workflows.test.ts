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

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { describe, expect, test } from "vitest";

const WORKFLOW_FILE = new URL("../.github/workflows/ci.yml", import.meta.url);
const RELEASE_FILE = new URL("../.github/workflows/release.yml", import.meta.url);
const SANDBOX_BUILD_FILE = new URL("../.github/workflows/sandbox-build.yml", import.meta.url);

interface Step {
	name?: string;
	run?: string | number;
	uses?: string;
	if?: string;
	with?: Record<string, unknown>;
	env?: Record<string, string>;
	"working-directory"?: string;
}

interface Job {
	"runs-on"?: string | string[];
	uses?: string;
	needs?: string | string[];
	if?: string;
	permissions?: Record<string, string>;
	env?: Record<string, string>;
	steps?: Step[];
}

interface ParsedWorkflow {
	on: Record<string, unknown>;
	jobs: Record<string, Job>;
	permissions?: Record<string, string>;
}

/** Parse a workflow file as data (fails loud when absent/malformed — a
 * missing workflow is a missing deliverable, not a skip). The single
 * loader every workflow assertion in this file goes through. */
function parseWorkflowFile(url: URL, label: string): ParsedWorkflow {
	const parsed = YAML.parse(readFileSync(url, "utf8"));
	expect(parsed, `${label} must exist and parse`).toBeTypeOf("object");
	return parsed as ParsedWorkflow;
}

/** Parsed ci.yml. */
function workflow(): ParsedWorkflow {
	return parseWorkflowFile(WORKFLOW_FILE, "ci.yml");
}

/** A step's run body as a string (YAML may parse bare `run:` short forms
 * as non-strings; the contract is the text). */
function runOf(step: Step): string {
	return typeof step.run === "string" ? step.run : String(step.run ?? "");
}

/** The sibling directories `publish-deps.mjs list` prints (Task 1.2: the
 * single enumeration the checkout set derives from — an inline names
 * array in a workflow would drift). */
function publishDepsListDirs(): string[] {
	const out = execFileSync(
		process.execPath,
		[new URL("../scripts/publish-deps.mjs", import.meta.url).pathname, "list"],
		{ encoding: "utf8" },
	).trim();
	return out === "" ? [] : out.split("\n").map((line) => line.split(" ")[1] ?? "");
}

/** The `repository:` values of the family-checkout composite action's
 * checkout steps (`sigrun-ai/<repo>` per sibling). */
function actionSiblingRepositories(): string[] {
	const action = YAML.parse(
		readFileSync(
			new URL("../.github/actions/family-checkout/action.yml", import.meta.url),
			"utf8",
		),
	) as { runs?: { steps?: { uses?: string; with?: Record<string, unknown> }[] } };
	return (action.runs?.steps ?? [])
		.filter((step) => step.uses?.startsWith("actions/checkout@"))
		.map((step) => String(step.with?.repository ?? ""));
}

/** Parsed release.yml. */
function releaseWorkflow(): ParsedWorkflow {
	return parseWorkflowFile(RELEASE_FILE, "release.yml");
}

/** Parsed sandbox-build.yml (the Task 2.1 reusable workflow both ci.yml's
 * `sandbox` job and release.yml consume — the musl build's single source
 * of truth). */
function sandboxBuildWorkflow(): ParsedWorkflow {
	return parseWorkflowFile(SANDBOX_BUILD_FILE, "sandbox-build.yml");
}

/** All steps of all jobs flattened (release assertions span jobs). */
function releaseSteps(): Step[] {
	const { jobs } = releaseWorkflow();
	return Object.values(jobs).flatMap((j) => j.steps ?? []);
}

describe(".github/workflows/release.yml (image-workflow §3, release half)", () => {
	test("triggers on v-tags and exposes the tag/dry-run/ref dispatch inputs", () => {
		const { on } = releaseWorkflow();
		const tags = (on.push as Record<string, unknown> | undefined)?.tags;
		expect(tags).toEqual(["v*"]);
		const dispatch = on.workflow_dispatch as
			| {
					inputs?: Record<
						string,
						{ required?: boolean; type?: string; default?: unknown }
					>;
				}
			| undefined;
		expect(dispatch, "workflow_dispatch trigger must exist").toBeDefined();
		// Tag stays REQUIRED: the dispatch re-runs an EXISTING tag's
		// release, never an arbitrary SHA — except in dry-run mode, where
		// the (also required) `ref` input replaces it.
		expect(dispatch?.inputs?.tag?.required).toBe(true);
		expect(dispatch?.inputs?.["dry-run"]?.type).toBe("boolean");
		expect(dispatch?.inputs?.["dry-run"]?.default).toBe(false);
		expect(dispatch?.inputs?.ref?.type).toBe("string");
		expect(dispatch?.inputs?.ref?.default).toBe("main");
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
		// push: is dry-run gated — true on a real release, false on a
		// dispatch dry run (the dry-run gating is pinned in its own case
		// below; here we only require that pushing is POSSIBLE, not that
		// the literal is `true`).
		expect(build?.with?.push, "the build must declare push:").toBeDefined();
		expect(String(build?.with?.push)).not.toBe("false");
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
		expect(runs).toMatch(/#v\}/);
	});

	test("the image job runs the registry-mode dance (explicit-specs lock regen)", () => {
		const { jobs } = releaseWorkflow();
		const runs = (jobs.image?.steps ?? []).map(runOf);
		const dance = runs.find((r) => r.includes("publish-deps.mjs registry"));
		expect(dance, "release build must run publish-deps.mjs registry").toBeDefined();
		const install = runs.find((r) => r.includes("npm install") && r.includes("--package-lock-only"));
		expect(install, "lock regen must carry --package-lock-only").toBeDefined();
		// The pins come from publish-deps.mjs's `pins` mode — the single
		// list every job shares; an inline names array would drift.
		expect(install).toContain('pins="$(node scripts/publish-deps.mjs pins)"');
		expect(install).toContain("npm install ${pins} --package-lock-only");
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

	test("release image job: core checkout pins the tag; siblings come from the composite action", () => {
		const { jobs } = releaseWorkflow();
		const steps = jobs.image?.steps ?? [];
		const checkouts = steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
		// The tag-pinned core checkout — the siblings arrive via the
		// composite action, which must follow the core checkout (it is
		// referenced FROM the core checkout's tree).
		const core = checkouts.find(
			(s) => (s.with as { path?: string } | undefined)?.path === "sigrun",
		);
		expect(core, "the image job checks out core at path sigrun").toBeDefined();
		expect(
			String((core?.with as { ref?: string } | undefined)?.ref ?? ""),
			"the image job's core checkout must pin the release tag",
		).toContain("refs/tags/");
		const family = steps.find(
			(s) => s.uses === "./sigrun/.github/actions/family-checkout",
		);
		expect(family, "the image job's siblings check out via family-checkout").toBeDefined();
		expect(steps.indexOf(family as Step)).toBeGreaterThan(steps.indexOf(core as Step));
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

	// ---- Task 2.3: the npm-publish half of the job graph ----

	test("guard is the FIRST job: every job needs it, directly or transitively", () => {
		const { jobs } = releaseWorkflow();
		const needsOf = (name: string): string[] => {
			const needs = jobs[name]?.needs;
			return Array.isArray(needs) ? needs : needs ? [String(needs)] : [];
		};
		// The tag guard stays first EVERYWHERE: walk the needs graph from
		// every non-guard job and assert every path bottoms out at guard.
		for (const name of Object.keys(jobs)) {
			if (name === "guard") continue;
			const visited = new Set<string>();
			const queue = [...needsOf(name)];
			expect(queue.length, `${name} must declare needs`).toBeGreaterThan(0);
			while (queue.length > 0) {
				const next = queue.pop() as string;
				if (visited.has(next)) continue;
				visited.add(next);
				queue.push(...needsOf(next));
			}
			expect(visited.has("guard"), `${name} must reach guard transitively`).toBe(true);
		}
	});

	test("publish-npm declares id-token: write (OIDC trusted publishing — no npm token anywhere)", () => {
		const { jobs } = releaseWorkflow();
		const permissions = jobs["publish-npm"]?.permissions;
		expect(permissions?.["id-token"], "publish-npm must declare id-token: write").toBe(
			"write",
		);
		// Publishing is trusted publishing ONLY: no token secret may ever
		// be REFERENCED (the rule is about secret wiring, not comments
		// documenting the posture; secrets.GITHUB_TOKEN is the workflow's
		// own auth for ghcr and stays allowed).
		const raw = readFileSync(RELEASE_FILE, "utf8");
		expect(raw).not.toMatch(/secrets\.NPM/);
		const tokens = [...raw.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*TOKEN)/g)].map(
			(m) => m[1],
		);
		expect(tokens, "only secrets.GITHUB_TOKEN may be referenced").toEqual([
			"GITHUB_TOKEN",
			"GITHUB_TOKEN",
		]);
	});

	test("publish-npm needs guard+sandbox, publishes leaf-first, each step skip-if-live and dry-run-aware", () => {
		const { jobs } = releaseWorkflow();
		const job = jobs["publish-npm"];
		expect(job, "publish-npm must exist").toBeDefined();
		const needs = job?.needs;
		expect(Array.isArray(needs) ? needs : [String(needs)]).toContain("guard");
		expect(Array.isArray(needs) ? needs : [String(needs)]).toContain("sandbox");
		// The sandbox platform tarballs publish from the reusable build's
		// artifact, not a rebuild.
		const download = (job?.steps ?? []).find((s) =>
			s.uses?.startsWith("actions/download-artifact@"),
		);
		expect(String(download?.with?.name ?? "")).toBe("sigrun-sandbox-musl");
		const runs = (job?.steps ?? []).map(runOf).join("\n");
		// Every publish step is skip-if-live (the tarball-URL curl probe is
		// the same idempotency contract ext-release.yml's live-check uses).
		expect(runs).toContain("curl -sf");
		// Dry-run aware: the workflow input gates real publishes (the DRY
		// env the run bodies read is populated FROM inputs.dry-run at job
		// level — assert both halves of the chain).
		expect(runs).toContain('"${DRY}"');
		expect(String(job?.env?.DRY ?? "")).toContain("inputs.dry-run");
		// Pre-check that every built-in pin is already live (one-shot).
		expect(runs).toContain("--timeout-min 0");
		// Prereleases publish under --tag next, never onto latest.
		expect(runs).toContain("--tag next");
		// npm 11.21+ is the OIDC trusted-publishing-capable line.
		expect(runs).toContain("npm@^11.21");
		// Core's publish runs its existing registry-mode dance: the
		// publish-deps.mjs registry/file bracket that prepublishOnly and
		// postpublish wrap around npm publish.
		expect(runs).toContain("publish-deps.mjs registry");
		expect(runs).toContain("publish-deps.mjs file");
	});

	test("publish order is leaf-first: sandbox platforms, shared, tui, then core", () => {
		const { jobs } = releaseWorkflow();
		const publishRuns = (jobs["publish-npm"]?.steps ?? [])
			.map(runOf)
			.filter((body) => body.includes("npm publish"));
		// Leaves go first: a failure part-way never leaves a live core
		// pointing at a missing family version. Assert each package's
		// publish step appears in exactly this order.
		const needles = [
			"linux-x64",
			"linux-arm64",
			"@sigrun/shared",
			"@sigrun/tui",
			"@sigrun/sigrun",
		];
		const positions = needles.map((needle) =>
			publishRuns.findIndex((body) => body.includes(needle)),
		);
		positions.forEach((position, index) => {
			expect(position, `a publish step must cover ${needles[index]}`).toBeGreaterThanOrEqual(
				0,
			);
		});
		for (let i = 1; i < positions.length; i += 1) {
			expect(
				positions[i],
				`${needles[i]} must publish AFTER ${needles[i - 1]} (leaf-first)`,
			).toBeGreaterThan(positions[i - 1] ?? -1);
		}
	});

	test("await-registry needs publish-npm, is skipped on dry-run, polls 15 min over the five versions", () => {
		const { jobs } = releaseWorkflow();
		const job = jobs["await-registry"];
		expect(job, "await-registry must exist").toBeDefined();
		// guard joins the needs list so needs.guard.outputs resolves
		// (needs contexts expose only DIRECT dependencies' outputs).
		expect(job?.needs).toEqual(["publish-npm", "guard"]);
		expect(String(job?.if ?? "")).toContain("inputs.dry-run");
		const runs = (job?.steps ?? []).map(runOf).join("\n");
		expect(runs).toContain("await-registry.mjs");
		expect(runs).toContain("--timeout-min 15");
		// The five core-family versions: two sandbox platforms, shared, tui,
		// core — derived, never hardcoded.
		expect(runs).toContain("@sigrun/shared@");
		expect(runs).toContain("@sigrun/tui@");
		expect(runs).toContain("@sigrun/sigrun@");
	});

	test("smoke needs await-registry and runs the registry-install smoke", () => {
		const { jobs } = releaseWorkflow();
		const job = jobs.smoke;
		expect(job, "smoke must exist").toBeDefined();
		expect(job?.needs).toEqual(["await-registry", "guard"]);
		const runs = (job?.steps ?? []).map(runOf).join("\n");
		expect(runs).toContain("smoke-registry.sh");
	});

	test("image and chart need smoke; on dry-run they need publish-npm and never push", () => {
		const { jobs } = releaseWorkflow();
		for (const name of ["image", "chart"] as const) {
			const job = jobs[name];
			const needs = job?.needs;
			expect(needs, `${name} must need smoke`).toContain("smoke");
			// Dry-run joins publish-npm: a skipped smoke would otherwise
			// cascade-skip the dry-run build.
			expect(needs, `${name} must need publish-npm`).toContain("publish-npm");
			// Every push-side step (registry login, push) must carry a
			// dry-run `if:` gate.
			const gated = (job?.steps ?? []).filter(
				(s) => s.if !== undefined && String(s.if).includes("dry"),
			);
			expect(
				gated.length,
				`${name} must gate its push steps on the dry-run resolution`,
			).toBeGreaterThan(0);
		}
		// The image build itself still builds on a dry run — only the
		// push flips off. build-push-action's push: must be an expression
		// that is false when the guard resolved dry=true.
		const build = (jobs.image?.steps ?? []).find((s) =>
			s.uses?.startsWith("docker/build-push-action@"),
		);
		expect(String(build?.with?.push ?? "")).toContain("guard.outputs.dry");
		expect(String(build?.with?.push ?? "")).not.toBe("true");
		// The chart push step is skipped entirely on dry-run (helm has no
		// --dry-run push).
		const chartPush = (jobs.chart?.steps ?? []).find((s) => runOf(s).includes("helm push"));
		expect(String(chartPush?.if ?? "")).toContain("guard.outputs.dry");
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

	test("every job that boots built-ins installs the siblings' own dependencies", () => {
		// A regression guard with a real history: core's `npm ci` installs
		// the five `file:` built-ins as LINKS into the sibling directories
		// but never installs THEIR node_modules. Each built-in's committed
		// dist/ imports its own runtime deps at load time
		// (@sigrun/shared/live in the gateway, oauth4webapi in oauth,
		// pi-durable in codemode/mcp/tool-search), so without a sibling
		// install every built-in quarantines and the suite reports
		// "Cannot find package ..." instead of testing behaviour. The
		// first real push of main failed exactly this way.
		const { jobs } = workflow();
		// Jobs that load built-ins: the suite itself, and sandbox-it
		// (it boots a real harness).
		for (const name of ["test", "sandbox-it"]) {
			const steps = jobs[name]?.steps ?? [];
			const install = steps.find((s) =>
				runOf(s).includes("npm ci --ignore-scripts"),
			);
			expect(install, `${name} must install the sibling dependencies`).toBeDefined();
			// It must run BEFORE the core build that compiles against them
			// and before the suite.
			const installIndex = steps.indexOf(install as Step);
			const coreInstall = steps.findIndex(
				(s) =>
					runOf(s).trim() === "npm ci" &&
					s["working-directory"] === "sigrun",
			);
			expect(coreInstall, `${name} must npm ci core`).toBeGreaterThan(-1);
			expect(installIndex).toBeLessThan(coreInstall);
			// And it must cover the whole sibling set, not an ad-hoc subset.
			const body = runOf(install as Step);
			for (const dir of publishDepsListDirs()) {
				expect(body, `${name} must install ${dir}`).toContain(dir);
			}
		}
	});

	test("the test job checks out all five repos in the sibling layout", () => {
		const { jobs } = workflow();
		const test = jobs.test;
		expect(test).toBeDefined();
		const steps = test?.steps ?? [];
		// Exactly ONE actions/checkout step: core at path `sigrun` (the
		// composite action can never overwrite the caller's own checkout —
		// in release.yml that checkout pins refs/tags/<tag>).
		const checkouts = steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
		expect(checkouts).toHaveLength(1);
		expect((checkouts[0]?.with as { path?: string } | undefined)?.path).toBe("sigrun");
		// The siblings come from the composite family-checkout action,
		// immediately after the core checkout.
		const family = steps.find(
			(s) => s.uses === "./sigrun/.github/actions/family-checkout",
		);
		expect(family, "the siblings check out via the family-checkout action").toBeDefined();
		expect(steps.indexOf(family as Step)).toBe(steps.indexOf(checkouts[0] as Step) + 1);
		// And the action's repository list IS the publish-deps list (so the
		// checkout set covers the gateway built-in and can never drift from
		// the packument rewrite — builtins-wiring.test.ts asserts the same
		// equality from the other side).
		const actionRepositories = actionSiblingRepositories();
		const listedDirs = publishDepsListDirs();
		expect(actionRepositories.map((repo) => repo.split("/")[1]).sort()).toEqual(
			[...listedDirs].sort(),
		);
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
		// The pins are derived, never hardcoded: publish-deps.mjs's `pins`
		// mode reads each built-in's version from its sibling manifest (the
		// single list every job shares), then the lock regen names them
		// explicitly — a bare `npm install --package-lock-only` keeps the
		// lock's `link:` entries and npm ci materializes dangling built-in
		// symlinks (boot quarantine).
		expect(dance).toContain("publish-deps.mjs registry");
		const install = runs.find((r) => r.includes("npm install") && r.includes("--package-lock-only"));
		expect(install, "an npm-install step must carry --package-lock-only").toBeDefined();
		expect(install).toContain('pins="$(node scripts/publish-deps.mjs pins)"');
		expect(install).toContain("npm install ${pins} --package-lock-only");
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

	test("sandbox: delegates to the shared reusable sandbox-build workflow", () => {
		const { jobs } = workflow();
		const sandbox = jobs.sandbox;
		expect(sandbox, "the sandbox job must exist").toBeDefined();
		// The musl build lives in sandbox-build.yml (Task 2.1) so
		// release.yml consumes the identical steps; the caller job is a
		// bare `uses:` — no runner, no steps (a `uses:` job can't have
		// either).
		expect(sandbox?.uses).toBe("./.github/workflows/sandbox-build.yml");
		expect(sandbox?.steps).toBeUndefined();
		expect(sandbox?.["runs-on"]).toBeUndefined();
	});

	// The sandbox platform manifests' shape is pinned in
	// test/package-manifest.test.ts (moved there in Task 1.3 — the
	// manifest-shape suite is the single source of truth).

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

describe(".github/workflows/sandbox-build.yml (Task 2.1 reusable musl build)", () => {
	test("is workflow_call-only with a single build job declaring its own runner", () => {
		const { on, jobs } = sandboxBuildWorkflow();
		expect(on).toHaveProperty("workflow_call");
		expect(Object.keys(jobs)).toEqual(["build"]);
		expect(jobs.build?.["runs-on"], "the reusable workflow declares its own runner").toBeDefined();
	});

	test("tests, lints, and builds both musl targets", () => {
		const { jobs } = sandboxBuildWorkflow();
		const steps = jobs.build?.steps ?? [];
		expect(steps.length, "the build job must exist").toBeGreaterThan(0);
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

	test("assembles, packs, and uploads both platform packages", () => {
		const { jobs } = sandboxBuildWorkflow();
		const steps = jobs.build?.steps ?? [];
		const runs = steps.map(runOf).join("\n");
		for (const [target, platform] of [
			["x86_64-unknown-linux-musl", "linux-x64"],
			["aarch64-unknown-linux-musl", "linux-arm64"],
		] as const) {
			expect(runs).toContain(`sandbox/target/${target}/release/sigrun-sandbox`);
			expect(runs).toContain(`sandbox/npm/${platform}/bin/sigrun-sandbox`);
		}
		expect(runs).toContain("chmod +x");
		const packs = steps.filter((s) => runOf(s).includes("npm pack"));
		expect(packs.map((s) => s["working-directory"])).toEqual([
			"sandbox/npm/linux-x64",
			"sandbox/npm/linux-arm64",
		]);
		const uploads = steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
		expect(uploads).toHaveLength(1);
		expect(String(uploads[0]?.with?.name ?? "")).toBe("sigrun-sandbox-musl");
		const paths = String(uploads[0]?.with?.path ?? "");
		expect(paths).toContain("sandbox/target/x86_64-unknown-linux-musl/release/sigrun-sandbox");
		expect(paths).toContain("sandbox/target/aarch64-unknown-linux-musl/release/sigrun-sandbox");
		expect(paths).toContain("sandbox/npm/linux-x64/*.tgz");
		expect(paths).toContain("sandbox/npm/linux-arm64/*.tgz");
	});
});
