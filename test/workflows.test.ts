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
const EXT_CI_FILE = new URL("../.github/workflows/ext-ci.yml", import.meta.url);
const EXT_RELEASE_FILE = new URL("../.github/workflows/ext-release.yml", import.meta.url);
const CHART_RELEASE_FILE = new URL("../.github/workflows/chart-release.yml", import.meta.url);

interface Step {
	name?: string;
	run?: string | number;
	uses?: string;
	if?: string;
	id?: string;
	with?: Record<string, unknown>;
	env?: Record<string, string>;
	shell?: string;
	"working-directory"?: string;
}

interface Job {
	"runs-on"?: string | string[];
	uses?: string;
	needs?: string | string[];
	if?: string;
	permissions?: Record<string, string>;
	env?: Record<string, string>;
	outputs?: Record<string, string>;
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

/** Parsed ext-ci.yml (the reusable workflow shared by extension repos). */
function extCiWorkflow(): ParsedWorkflow {
	return parseWorkflowFile(EXT_CI_FILE, "ext-ci.yml");
}

/** The shared extension test procedure, parsed independently of either
 * reusable workflow so its checkout order cannot drift between them. */
function extTestAction(): {
	inputs: Record<string, { default?: unknown; required?: boolean; type?: string }>;
	runs: { steps: Step[] };
} {
	const action = YAML.parse(
		readFileSync(new URL("../.github/actions/ext-test/action.yml", import.meta.url), "utf8"),
	);
	expect(action, "ext-test action must exist and parse").toBeTypeOf("object");
	return action;
}

/** The family-checkout composite's inputs and checkout steps. */
function familyCheckoutAction(): {
	inputs: Record<string, { default?: unknown }>;
	runs: { steps: Step[] };
} {
	return YAML.parse(
		readFileSync(
			new URL("../.github/actions/family-checkout/action.yml", import.meta.url),
			"utf8",
		),
	);
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
		// `tag` is OPTIONAL, and must stay so: a dry run passes `ref`
		// instead and has no tag at all, so a required `tag` makes the
		// dry-run path impossible to invoke ("Required input 'tag' not
		// provided"). A real dispatch with no tag still fails closed —
		// the guard resolves the empty tag to the branch name and refuses
		// it, since it is not v<semver> and does not match the manifest.
		expect(dispatch?.inputs?.tag?.required).toBe(false);
		expect(dispatch?.inputs?.tag?.type).toBe("string");
		expect(dispatch?.inputs?.["dry-run"]?.type).toBe("boolean");
		expect(dispatch?.inputs?.["dry-run"]?.default).toBe(false);
		expect(dispatch?.inputs?.["dry-run"]?.required).toBe(true);
		expect(dispatch?.inputs?.ref?.type).toBe("string");
		expect(dispatch?.inputs?.ref?.default).toBe("main");
		// `ref` is what a dry run releases, so it must be supplied.
		expect(dispatch?.inputs?.ref?.required).toBe(true);
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
		expect(install).toContain("npm install --save-exact ${pins} --package-lock-only");
	});

	test("the release keeps its fatal pins-live check", () => {
		const steps = releaseWorkflow().jobs["publish-npm"]?.steps ?? [];
		const check = steps.find((step) => step.name === "Pre-check: every built-in pin is live");
		expect(check, "the release pre-check must exist").toBeDefined();
		const body = runOf(check as Step);
		expect(body).toContain('pins="$(node scripts/publish-deps.mjs pins)"');
		expect(body).toContain("await-registry.mjs");
		expect(body).toContain("--timeout-min 0 ${pins}");
		expect(body).toContain("set -euo pipefail");
		expect(body).not.toContain("::notice::");
		expect(body).not.toContain("live=false");
		expect((check as Step & { "continue-on-error"?: boolean })["continue-on-error"]).not.toBe(true);
	});

	test("core release no longer publishes the chart (it has its own workflow)", () => {
		// The chart has an independent version line, so a core tag must not
		// push it: `helm push` refuses an existing chart version, and a
		// chart-only release ahead of core would burn numbers core later
		// needs. The chart moved to chart-release.yml.
		const { jobs } = releaseWorkflow();
		expect(jobs.chart, "release.yml must not carry a chart job").toBeUndefined();
		const runs = Object.values(jobs)
			.flatMap((job) => (job?.steps ?? []).map(runOf))
			.join("\n");
		expect(runs).not.toContain("helm push");
		expect(runs).not.toContain("helm package");
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
		const tokens = [...raw.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(
			(m) => m[1],
		);
		// Assert the SET, not a count: the count changes whenever a job that
		// logs in to ghcr enters or leaves this workflow (the chart job did,
		// when it gained its own chart-release.yml).
		expect(
			[...new Set(tokens)].sort(),
			"only secrets.GITHUB_TOKEN may be referenced",
		).toEqual(["GITHUB_TOKEN"]);
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

	test("the leaf publishes build what they ship: workspace install before shared/tui publish (the 0.4.2 dist fix)", () => {
		const { jobs } = releaseWorkflow();
		const steps = jobs["publish-npm"]?.steps ?? [];
		const installIdx = steps.findIndex((s) => runOf(s).includes("npm ci") && s.name?.includes("Install the workspace"));
		const sharedIdx = steps.findIndex((s) => s.name?.includes("Publish @sigrun/shared"));
		const tuiIdx = steps.findIndex((s) => s.name?.includes("Publish @sigrun/tui"));
		expect(installIdx, "an Install-the-workspace step must exist").toBeGreaterThan(-1);
		// The install runs BEFORE both leaf publishes: the leaves'`prepublishOnly` builds need `tsc`, and a fresh checkout has no node_modules.
		expect(installIdx).toBeLessThan(sharedIdx);
		expect(installIdx).toBeLessThan(tuiIdx);
	});

	test("core's registry-mode dance keeps the manifest registry-shaped THROUGH npm ci", () => {
		// Two coupled invariants, both learned from a real dry-run failure
		// (the step had never executed before the extension publishes
		// unblocked it):
		//
		//  1. `npm ci` requires the manifest and lock to AGREE. Restoring
		//     file: specifiers before it aborts with EUSAGE ("Missing:
		//     <name>@<version> from lock file"). The restore belongs in
		//     postpublish, after the publish — never between the lock regen
		//     and the ci.
		//  2. A bare `npm install <name>@<version>` REWRITES the spec to a
		//     caret range, which would publish `^0.1.1` and fail core's own
		//     manifest gate. The regen must pin exactly.
		const { jobs } = releaseWorkflow();
		const core = (jobs["publish-npm"]?.steps ?? [])
			.map(runOf)
			.find(
				(body) =>
					body.includes('base="https://registry.npmjs.org/@sigrun/sigrun/-"') &&
					body.includes("publish-deps.mjs registry"),
			);
		expect(core, "the core publish step must exist").toBeDefined();
		const body = core ?? "";
		// Anchor on the COMMAND, not the substring: the comment above the
		// dance names `npm ci` in prose, which would match first.
		const ci = body
			.split("\n")
			.findIndex((line) => line.trim() === "npm ci");
		const regenLine = body
			.split("\n")
			.findIndex((line) => line.trim() === "node scripts/publish-deps.mjs registry");
		const restoreLine = body
			.split("\n")
			.findIndex((line) => line.trim() === "node scripts/publish-deps.mjs file");
		const restore = restoreLine === -1 ? -1 : restoreLine;
		expect(regenLine, "the dance must switch to registry mode").toBeGreaterThanOrEqual(0);
		expect(ci, "the dance must run npm ci").toBeGreaterThanOrEqual(0);
		expect(regenLine, "registry mode must precede npm ci").toBeLessThan(ci);
		// No restore between the regen and the ci (the EUSAGE trap).
		expect(
			restore === -1 || restore > ci,
			"the file: restore must NOT run before npm ci (manifest/lock mismatch → EUSAGE)",
		).toBe(true);
		// Exact pins: the regen must not let npm widen the spec.
		expect(body).toContain("npm install --save-exact");
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
		// The 0.4.2 dist fix: the smoke must also prove the PROJECT-install
		// shape (hoisted @sigrun/shared from the registry). The global shape
		// alone passed for four broken releases because core's bundled
		// shared copy hides the defect.
		expect(runs).toContain("project-install");
	});

	test("image needs smoke; on dry-run it needs publish-npm and never pushes", () => {
		// The chart is no longer in this workflow (chart-release.yml owns
		// it), so only the image job is checked here.
		const { jobs } = releaseWorkflow();
		const job = jobs.image;
		const needs = job?.needs;
		expect(needs, "image must need smoke").toContain("smoke");
		// Dry-run joins publish-npm: a skipped smoke would otherwise
		// cascade-skip the dry-run build.
		expect(needs, "image must need publish-npm").toContain("publish-npm");
		// Every push-side step (registry login, push) must carry a
		// dry-run `if:` gate.
		const gated = (job?.steps ?? []).filter(
			(s) => s.if !== undefined && String(s.if).includes("dry"),
		);
		expect(
			gated.length,
			"image must gate its push steps on the dry-run resolution",
		).toBeGreaterThan(0);
		// The image build itself still builds on a dry run — only the
		// push flips off. build-push-action's push: must be an expression
		// that is false when the guard resolved dry=true.
		const build = (job?.steps ?? []).find((s) =>
			s.uses?.startsWith("docker/build-push-action@"),
		);
		expect(String(build?.with?.push ?? "")).toContain("guard.outputs.dry");
		expect(String(build?.with?.push ?? "")).not.toBe("true");
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

	test("the test job checks out all six repos in the sibling layout", () => {
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
		// after the core checkout and the push-only settle wait.
		const family = steps.find(
			(s) => s.uses === "./sigrun/.github/actions/family-checkout",
		);
		expect(family, "the siblings check out via the family-checkout action").toBeDefined();
		expect(steps.indexOf(family as Step)).toBeGreaterThan(
			steps.indexOf(checkouts[0] as Step),
		);
		// And the action's repository list IS the publish-deps list (so the
		// checkout set covers the gateway built-in and can never drift from
		// the packument rewrite — builtins-wiring.test.ts asserts the same
		// equality from the other side).
		const actionRepositories = actionSiblingRepositories();
		const listedDirs = publishDepsListDirs();
		// memory-markdown checks out with the family (core's devDependency —
		// the curation e2e loads it) but is NOT a built-in: the action set is
		// the built-ins PLUS the dev siblings.
		expect(actionRepositories.map((repo) => repo.split("/")[1]).sort()).toEqual(
			[...listedDirs, "sigrun-memory-markdown"].sort(),
		);
	});

	test("ci settles 180 s on push before checking siblings out", () => {
		const { jobs } = workflow();
		for (const name of ["test", "sandbox-it", "image-build"]) {
			const steps = jobs[name]?.steps ?? [];
			const checkout = steps.find(
				(step) => step.uses?.startsWith("actions/checkout@"),
			);
			const settle = steps.find((step) => runOf(step).trim() === "sleep 180");
			expect(settle, `${name} waits for the push batch`).toBeDefined();
			expect(settle?.if).toBe("github.event_name == 'push'");
			const family = steps.find(
				(step) => step.uses === "./sigrun/.github/actions/family-checkout",
			);
			expect(family, `${name} checks out the family`).toBeDefined();
			expect(steps.indexOf(settle as Step)).toBe(steps.indexOf(checkout as Step) + 1);
			expect(steps.indexOf(family as Step)).toBe(steps.indexOf(settle as Step) + 1);
		}
		const chart = jobs["chart-lint"]?.steps ?? [];
		expect(chart.some((step) => runOf(step).trim() === "sleep 180")).toBe(false);
	});

	test("image-build skips with a notice when a pin is not live", () => {
		const steps = workflow().jobs["image-build"]?.steps ?? [];
		const family = steps.find(
			(step) => step.uses === "./sigrun/.github/actions/family-checkout",
		);
		const gate = steps.find((step) => step.id === "pins-live");
		expect(gate, "the pins-live gate must exist").toBeDefined();
		expect(steps.indexOf(gate as Step)).toBe(steps.indexOf(family as Step) + 1);
		const body = runOf(gate as Step);
		expect(body).toContain('pins="$(node scripts/publish-deps.mjs pins)"');
		expect(body).toContain('npm view "${pin}" version 2>&1');
		expect(body).toContain('*E404*|*"not found"*) missing+=("${pin}")');
		expect(body).toContain('echo "::error::npm view returned no version for ${pin}"');
		expect(body).toMatch(
			/\*\)\n\s+echo "::error::npm view failed for \$\{pin\}"\n\s+echo "\$\{published\}"\n\s+exit 1\n\s+;;/,
		);
		expect(body).toMatch(
			/if \[ -z "\$\{published\}" \]; then\n\s+echo "::error::npm view returned no version for \$\{pin\}"\n\s+echo "\$\{published\}"\n\s+exit 1/,
		);
		expect(body).not.toContain('[ -z "${published}" ]; then\n              missing+=');
		expect(body).toContain("live=false");
		expect(body).toContain(
			"::notice::image build skipped: ${missing[*]} not on npm yet (the release checks this)",
		);
		const regen = steps.find((step) => runOf(step).includes("publish-deps.mjs registry"));
		expect(steps.indexOf(gate as Step)).toBeLessThan(steps.indexOf(regen as Step));
		const guarded = [
			regen,
			steps.find((step) => step.uses?.startsWith("docker/build-push-action@")),
			steps.find((step) => runOf(step).includes("scripts/smoke-image.sh")),
		];
		for (const step of guarded) {
			expect(step?.if).toBe("steps.pins-live.outputs.live == 'true'");
		}
		for (const step of [gate, ...guarded]) {
			expect(step).not.toHaveProperty("continue-on-error");
		}
		expect(workflow().jobs["image-build"]?.if).toBeUndefined();
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
		expect(install).toContain("npm install --save-exact ${pins} --package-lock-only");
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

	test("image smoke: boots as the invoking uid, matching the bind-mount owner", () => {
		// The smoke `mktemp -d`s a 0700 state dir and bind-mounts it at
		// /data. A bind mount carries the host owner in verbatim, and on a
		// GitHub runner that owner is the runner uid (1001) — NOT the
		// image's default 1000. A container pinned to 1000 therefore cannot
		// write /data at all and boot dies with EACCES (the failure this
		// asserts against). Running as the invoking uid is what a rootless
		// runtime does for sigrun in production (k8s runAsUser + fsGroup,
		// compose `user:`).
		const smoke = readFileSync(new URL("../scripts/smoke-image.sh", import.meta.url), "utf8");
		const boot = smoke.slice(smoke.indexOf("docker run --rm -d"));
		expect(boot, "the smoke's boot run must pass --user").toContain(
			'--user "$(id -u):$(id -g)"',
		);
	});

	test("entrypoint: sets HOME under the data volume, overridable via SIGRUN_HOME", () => {
		// Docker derives HOME from the runtime uid's passwd entry, so any
		// uid the image has no entry for gets "/" — and sigrun's tier-3
		// store roots are homedir()-relative, so boot would mkdir '/.local'
		// and die. The entrypoint therefore sets HOME itself, defaulting
		// onto the data volume and overridable by its OWN knob (never
		// derived from SIGRUN_CONFIG_DIR/SIGRUN_DATA_DIR, so home and
		// config can live on separate volumes).
		const entrypoint = readFileSync(new URL("../docker/entrypoint.sh", import.meta.url), "utf8");
		expect(entrypoint).toContain('export HOME="${SIGRUN_HOME:-/data/home}"');
		// The drop must not NEED a passwd entry: --init-groups fails outright
		// for any uid the image has no entry for, which is exactly the
		// rootless case the trampoline serves. Assert on the EXEC line (the
		// comment above it names the rejected flag in prose).
		const exec = entrypoint
			.split("\n")
			.find((line) => line.trimStart().startsWith("exec setpriv"));
		expect(exec, "the root path must exec setpriv").toBeDefined();
		expect(exec).toContain("--clear-groups");
		expect(exec).not.toContain("--init-groups");
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

describe(".github/actions/ext-test (shared extension test procedure)", () => {
	test("ext-ci and ext-release take core-ref (default main) and delegate to the ext-test action", () => {
		const ci = extCiWorkflow();
		const release = parseWorkflowFile(EXT_RELEASE_FILE, "ext-release.yml");
		for (const [label, workflowFile] of [
			["ext-ci.yml", ci],
			["ext-release.yml", release],
		] as const) {
			const call = workflowFile.on.workflow_call as {
				inputs?: Record<string, { type?: string; default?: unknown }>;
			};
			expect(call.inputs?.["core-ref"]?.type, label).toBe("string");
			expect(call.inputs?.["core-ref"]?.default, label).toBe("main");
			const steps = workflowFile.jobs.test?.steps ?? [];
			expect(steps.filter((step) => step.uses?.startsWith("actions/checkout@"))).toHaveLength(0);
			const testAction = steps.find(
				(step) => step.uses === "sigrun-ai/sigrun/.github/actions/ext-test@main",
			);
			expect(testAction, `${label} test job must delegate to ext-test`).toBeDefined();
			expect(testAction?.with?.["package-dir"]).toBe("${{ inputs.package-dir }}");
			expect(testAction?.with?.["needs-core"]).toBe("${{ inputs.needs-core }}");
			expect(testAction?.with?.["core-ref"]).toBe("${{ inputs['core-ref'] }}");
			expect(testAction?.with?.repo).toBe("${{ github.event.repository.name }}");
			if (label === "ext-ci.yml") {
				expect(testAction?.with?.ref, "ext-ci keeps the triggering SHA").toBeUndefined();
			}
		}
		expect(ci.jobs.test?.steps?.some((step) => runOf(step).includes("npm test"))).toBe(false);
		expect(release.jobs.test?.steps?.some((step) => runOf(step).includes("npm test"))).toBe(false);
	});

	test("release mode checks core out at the resolved tag", () => {
		const action = extTestAction();
		expect(Object.keys(action.inputs)).toEqual([
			"package-dir",
			"needs-core",
			"core-ref",
			"repo",
			"refs",
			"ref",
		]);
		const steps = action.runs.steps;
		const resolve = steps.find((step) => step.id === "resolve");
		expect(resolve, "the resolver must expose refs").toBeDefined();
		expect(runOf(resolve as Step)).toContain("node .sigrun-tools/scripts/ci-core-ref.mjs");
		expect(resolve?.if).toBe("(inputs.needs-core == 'true' || inputs.refs != '') && inputs.refs == ''");
		expect(runOf(resolve as Step)).toContain(
			"npm install --prefix .sigrun-tools --no-save semver@^7",
		);
		expect(runOf(resolve as Step)).toContain(
			"rm -f .sigrun-tools/package.json .sigrun-tools/package-lock.json",
		);
		expect(runOf(resolve as Step)).toContain("[ -n \"$refs\" ] || refs='{}'");
		const tools = steps.find(
			(step) => step.with?.repository === "sigrun-ai/sigrun" && step.with?.path === ".sigrun-tools",
		);
		expect(tools, "release mode needs the resolver from core main").toBeDefined();
		expect(tools?.with?.ref).toBe("main");
		expect(tools?.with?.["sparse-checkout"]).toBe("scripts/");
		const core = steps.find(
			(step) => step.with?.repository === "sigrun-ai/sigrun" && step.with?.path === "sigrun",
		);
		expect(core, "needs-core must check out core").toBeDefined();
		expect(core?.if).toBe("inputs.needs-core == 'true'");
		expect(core?.with?.ref).toBe(
			"${{ fromJSON(steps.resolve.outputs.refs || inputs.refs).sigrun || '' }}",
		);
		const family = steps.find(
			(step) => step.uses === "sigrun-ai/sigrun/.github/actions/family-checkout@main",
		);
		expect(family?.with?.exclude).toBe("${{ inputs.repo }}");
		expect(family?.with?.refs).toBe("${{ steps.resolve.outputs.refs || inputs.refs }}");
		const underTest = steps.find(
			(step) => step.uses?.startsWith("actions/checkout@") && step.with?.path === "${{ inputs.repo }}",
		);
		expect(underTest?.with?.ref).toBe("${{ inputs.ref }}");
		expect(
			steps.indexOf(underTest as Step),
			"the repo under test must be checked out after core and the family",
		).toBe(steps.indexOf(family as Step) + 1);
		const plain = steps.find(
			(step) => step.uses?.startsWith("actions/checkout@") && step.if === "inputs.needs-core != 'true'",
		);
		expect(plain, "the plain lane keeps its root checkout").toBeDefined();
		expect(plain?.with?.ref).toBe("${{ inputs.ref }}");
		const needsCoreSteps = steps.filter(
			(step) => step.if !== undefined && String(step.if).includes("needs-core"),
		);
		expect(
			needsCoreSteps.every(
				(step) =>
					!/\binputs\.needs-core\s*(?:$|[)&|])/.test(String(step.if)),
			),
			"composite inputs are strings: bare if: inputs.needs-core treats 'false' as true",
		).toBe(true);
		const runs = steps.map(runOf).join("\n");
		const setupCheck = steps.find((step) => step.name === "Reject sibling links without the family layout");
		const install = steps.find((step) => step.name === "Install");
		expect(setupCheck, "the setup-error check must exist").toBeDefined();
		expect(install, "the package install step must exist").toBeDefined();
		expect(steps.indexOf(setupCheck as Step)).toBeLessThan(steps.indexOf(install as Step));
		expect(runs).toContain("npm ci --prefix sigrun && (cd sigrun && npm run build)");
		for (const repo of [
			"sigrun-ext-codemode",
			"sigrun-ext-curator",
			"sigrun-ext-gateway",
			"sigrun-ext-mcp",
			"sigrun-ext-oauth",
			"sigrun-memory-markdown",
		]) {
			expect(runs).toContain(repo);
		}
		expect(runs).toContain(
			"This package links ../ sibling repos (file:); set needs-core: true in .github/workflows/ci.yml and release.yml",
		);
		expect(runs).toContain(
			"npm ci failed; if it reports the lockfile out of sync (EUSAGE), regenerate package-lock.json in the family layout (npm install next to ../sigrun) and commit it",
		);
		for (const command of ["npm run build", "npm test", "npm run typecheck"]) {
			expect(runs).toContain(command);
		}
		for (const step of steps.filter((step) => step.run !== undefined)) {
			expect(step.shell, "composite run steps must declare bash").toBe("bash");
		}
	});

	test("push + core-ref main waits; pull_request does not", () => {
		const settle = extTestAction().runs.steps.find((step) => runOf(step).includes("sleep 180"));
		expect(settle, "a 180 second settle step must exist").toBeDefined();
		expect(settle?.if).toBe(
			"(inputs.needs-core == 'true' || inputs.refs != '') && inputs.core-ref == 'main' && github.event_name == 'push'",
		);
		expect(settle?.if).not.toContain("pull_request");
		const steps = extTestAction().runs.steps;
		const core = steps.find((step) => step.with?.path === "sigrun");
		expect(steps.indexOf(settle as Step)).toBeLessThan(steps.indexOf(core as Step));
	});

	test("publish uses the resolved refs", () => {
		const workflowFile = parseWorkflowFile(EXT_RELEASE_FILE, "ext-release.yml");
		const { guard, test, publish } = workflowFile.jobs;
		expect(guard?.outputs?.refs).toBe("${{ steps.resolve.outputs.refs }}");
		const resolver = (guard?.steps ?? []).find(
			(step) => step.id === "resolve" && runOf(step).includes("ci-core-ref.mjs"),
		);
		expect(resolver, "guard resolves once for both test and publish").toBeDefined();
		expect(runOf(resolver as Step)).toContain(
			"npm install --prefix .sigrun-tools --no-save semver@^7",
		);
		expect(runOf(resolver as Step)).toContain(
			"rm -f .sigrun-tools/package.json .sigrun-tools/package-lock.json",
		);
		expect(runOf(resolver as Step)).toContain("[ -n \"$refs\" ] || refs='{}'");
		const testAction = (test?.steps ?? []).find(
			(step) => step.uses === "sigrun-ai/sigrun/.github/actions/ext-test@main",
		);
		expect(testAction?.with?.refs).toBe("${{ needs.guard.outputs.refs }}");
		expect(String(testAction?.with?.ref).replace(/\s+/g, " ")).toBe(
			"${{ inputs.dry-run && inputs.dry-run-ref || (inputs.tag != '' && format('refs/tags/{0}', inputs.tag) || github.ref) }}",
		);
		const core = (publish?.steps ?? []).find((step) => step.with?.path === "sigrun");
		expect(core?.with?.ref).toBe("${{ fromJSON(needs.guard.outputs.refs).sigrun || '' }}");
		const family = (publish?.steps ?? []).find(
			(step) => step.uses === "sigrun-ai/sigrun/.github/actions/family-checkout@main",
		);
		expect(family?.with?.refs).toBe("${{ needs.guard.outputs.refs }}");
		expect(family?.with?.exclude).toBe("${{ github.event.repository.name }}");
		const publishSteps = publish?.steps ?? [];
		const underTest = publishSteps.find(
			(step) => step.with?.path === "${{ github.event.repository.name }}",
		);
		expect(publishSteps.indexOf(underTest as Step)).toBe(publishSteps.indexOf(family as Step) + 1);
	});

	test("family-checkout accepts refs", () => {
		const action = familyCheckoutAction();
		expect(action.inputs.refs?.default).toBe("{}");
		const repositories = actionSiblingRepositories();
		expect(repositories).toHaveLength(7);
		for (const repository of repositories) {
			const repo = repository.split("/")[1];
			const step = action.runs.steps.find((entry) => entry.with?.repository === repository);
			expect(step?.with?.ref, `${repo} must consume the resolved ref`).toBe(
				`\${{ fromJSON(inputs.refs)['${repo}'] || '' }}`,
			);
		}
	});
});

describe(".github/workflows/ext-release.yml (family releases)", () => {
	const parsed = () =>
		parseWorkflowFile(EXT_RELEASE_FILE, "ext-release.yml");

	test("the guard job checks out the repo under test BEFORE the tooling", () => {
		// actions/checkout cleans the worktree by default (git clean -ffdx),
		// so a checkout ordered after the tooling one deletes .sigrun-tools.
		// The first pilot tag failed exactly that way: "Cannot find module
		// .../.sigrun-tools/scripts/release-guard.mjs".
		const guard = parsed().jobs.guard;
		const checkouts = (guard?.steps ?? []).filter((step) =>
			step.uses?.startsWith("actions/checkout@"),
		);
		expect(checkouts.length, "the guard job needs both checkouts").toBe(2);
		const underTest = checkouts[0];
		const tools = checkouts[1];
		expect(
			(underTest?.with as { "fetch-depth"?: number } | undefined)?.["fetch-depth"],
			"the repo under test goes first, with full history for the ancestry check",
		).toBe(0);
		expect(
			(tools?.with as { path?: string } | undefined)?.path,
			"the tooling goes second, into .sigrun-tools",
		).toBe(".sigrun-tools");
		expect(
			(tools?.with as { clean?: boolean } | undefined)?.clean,
			"the tooling checkout must not clean away the repo under test",
		).toBe(false);
		// And the guard must actually run the tooling script from there.
		const runs = (guard?.steps ?? []).map(runOf).join("\n");
		expect(runs).toContain(".sigrun-tools/scripts/release-guard.mjs");
	});

	test("the publish job declares id-token: write and uses no npm token", () => {
		const publish = parsed().jobs.publish;
		expect(publish, "the publish job must exist").toBeDefined();
		const raw = readFileSync(EXT_RELEASE_FILE, "utf8");
		expect(raw).not.toMatch(/secrets\.NPM_TOKEN/);
		expect(raw).toMatch(/npm publish/);
		// OIDC is granted at the workflow level for this reusable workflow.
		const permissions = parsed().permissions ?? {};
		expect(permissions["id-token"]).toBe("write");
	});

	test("the publish job skips a version that is already live", () => {
		const runs = (parsed().jobs.publish?.steps ?? []).map(runOf).join("\n");
		// skip-if-live is what makes a tag re-run idempotent.
		expect(runs).toContain("curl -sf");
		expect(runs).toContain("registry.npmjs.org");
	});
});

describe(".github/workflows/chart-release.yml (chart decoupling)", () => {
	function chartWorkflow(): ParsedWorkflow {
		return parseWorkflowFile(CHART_RELEASE_FILE, "chart-release.yml");
	}

	test("triggers on chart-v* only, never on a core v* tag", () => {
		const { on } = chartWorkflow();
		const push = on as { push?: { tags?: string[] } };
		expect(push.push?.tags).toEqual(["chart-v*"]);
	});

	test("guards with --chart against Chart.yaml, not package.json", () => {
		const { jobs } = chartWorkflow();
		const runs = (jobs.guard?.steps ?? []).map(runOf).join("\n");
		expect(runs).toContain("release-guard.mjs");
		expect(runs).toContain("--chart");
		expect(runs).toContain("charts/sigrun/Chart.yaml");
		// The chart's version is the tag; a core-style tag would publish a
		// chart under the core's number.
		expect(runs).toContain("chart-v");
	});

	test("derives appVersion from SOURCE, never from the tag or the registry", () => {
		// The race this prevents: resolving appVersion by asking the
		// registry "what is latest?" can publish the chart pinned to the
		// PREVIOUS core version, permanently, when both tags go on one
		// commit. Reading package.json at the tagged commit is
		// deterministic.
		const { jobs } = chartWorkflow();
		const steps = jobs.chart?.steps ?? [];
		const appStep = steps.find((s) => (s.name ?? "").includes("appVersion"));
		expect(appStep, "the chart job must derive appVersion").toBeDefined();
		const body = runOf(appStep as Step);
		expect(body).toContain("package.json");
		// It must NOT consult the registry for the version.
		expect(body).not.toContain("npm view");
		expect(body).not.toContain("registry.npmjs.org");
		// Only the chart's OWN version is rewritten from the tag; appVersion
		// is written from the derived value.
		const runs = steps.map(runOf).join("\n");
		expect(runs).toContain('s/^version: .*/version: ${VERSION}/');
		expect(runs).toContain('appVersion: \\"${APP_VERSION}\\"');
	});

	test("waits for the appVersion image before pushing the chart", () => {
		// The chart's default image tag IS appVersion, so pushing before
		// that image exists deploys into ImagePullBackOff — and a pushed
		// chart version is immutable.
		const { jobs } = chartWorkflow();
		const steps = jobs.chart?.steps ?? [];
		const wait = steps.find((s) => (s.name ?? "").includes("Wait for the appVersion image"));
		expect(wait, "the chart job must wait for its image").toBeDefined();
		expect(runOf(wait as Step)).toContain("await-image.mjs");
		expect(runOf(wait as Step)).toContain("sigrun-ai/sigrun:${APP_VERSION}");
		// The wait must run BEFORE the push.
		const names = steps.map((s) => s.name ?? "");
		const waitIndex = names.findIndex((n) => n.includes("Wait for the appVersion image"));
		const pushIndex = names.findIndex((n) => n.includes("Push chart"));
		expect(waitIndex).toBeGreaterThan(-1);
		expect(pushIndex).toBeGreaterThan(waitIndex);
	});

	test("skips a chart version that is already live (helm push cannot overwrite)", () => {
		const { jobs } = chartWorkflow();
		const steps = jobs.chart?.steps ?? [];
		const probe = steps.find((s) => (s.name ?? "").includes("already live"));
		expect(probe, "the chart job needs a skip-if-live probe").toBeDefined();
		expect(runOf(probe as Step)).toContain("await-image.mjs");
		expect(runOf(probe as Step)).toContain("charts/sigrun/sigrun:${VERSION}");
		// Every push step is gated on live != true.
		const push = steps.find((s) => (s.name ?? "").includes("Push chart"));
		expect(String(push?.if ?? "")).toContain("steps.live.outputs.live");
	});
});
