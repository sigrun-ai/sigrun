#!/usr/bin/env node
/**
 * ci-core-ref.mjs (CI-noise Task 1): resolve the latest RELEASED core
 * and its built-in pins from npm, for extension CI checkouts.
 *
 *   node scripts/ci-core-ref.mjs release   → JSON object of repo→tag refs
 *   node scripts/ci-core-ref.mjs main      → {} (every checkout at default branch)
 *
 * The resolver reads npm packuments (via an injectable `npmView`) to
 * determine which versions of the core and each built-in extension are
 * currently released. The output maps repo names to their release tags
 * (e.g. `{"sigrun": "v0.11.3", "sigrun-ext-gateway": "v0.1.26", ...}`).
 *
 * memory-markdown is a core devDependency (`file:../sigrun-memory-markdown`),
 * so npm records no pin for it. The rule: pick the newest version whose
 * `peerDependencies["@sigrun/shared"]` accepts the released core's
 * `@sigrun/shared` version (from the same packument's `dependencies`).
 *
 * `@sigrun/shared` and `@sigrun/tui` are in core's `dependencies` but
 * are NOT siblings — the resolver ignores them.
 *
 * The `npmView` function is injected for testability: it takes a spec
 * and field and returns the parsed JSON of `npm view <spec> <field>
 * --json`. In production it shells out to npm; in tests it returns
 * canned data.
 */
import { execFileSync } from "node:child_process";
import semver from "semver";
import { BUILTINS } from "./builtins-map.mjs";

/** Package → repo name mapping. */
const PACKAGE_TO_REPO = {
	"@sigrun/ext-codemode": "sigrun-ext-codemode",
	"@sigrun/ext-curator": "sigrun-ext-curator",
	"@sigrun/ext-gateway": "sigrun-ext-gateway",
	"@sigrun/ext-mcp": "sigrun-ext-mcp",
	"@sigrun/ext-tool-search": "sigrun-ext-tool-search",
	"@sigrun/oauth": "sigrun-ext-oauth",
	"@sigrun/memory-markdown": "sigrun-memory-markdown",
};

/**
 * The real npmView: shells `npm view <spec> <field> --json` and parses
 * the stdout. Used by the CLI entry point.
 */
function realNpmView(spec, field) {
	const stdout = execFileSync("npm", ["view", spec, field, "--json"], {
		encoding: "utf8",
		timeout: 30_000,
	});
	return JSON.parse(stdout);
}

/**
 * Resolve repo→tag refs from npm.
 *
 * @param {string} mode - "release" or "main"
 * @param {(spec: string, field: string) => Promise<unknown>} npmView
 * @returns {Promise<Record<string, string>>}
 */
export async function resolveRefs(mode, npmView) {
	if (mode === "main") return {};

	// 1. Core's latest released version.
	const coreVersion = await npmView("@sigrun/sigrun", "dist-tags.latest");
	if (typeof coreVersion !== "string") {
		throw new Error(
			`ci-core-ref: expected a string for @sigrun/sigrun dist-tags.latest, got ${typeof coreVersion}`,
		);
	}

	// 2. Core's dependencies at that version (carries the built-in pins).
	const deps = await npmView("@sigrun/sigrun", "dependencies");
	if (typeof deps !== "object" || deps === null) {
		throw new Error(
			"ci-core-ref: expected an object for @sigrun/sigrun dependencies",
		);
	}

	// 3. Resolve each built-in from the map.
	const refs = { sigrun: `v${coreVersion}` };
	for (const pkg of Object.keys(BUILTINS)) {
		const version = deps[pkg];
		if (typeof version !== "string") {
			throw new Error(
				`ci-core-ref: built-in ${pkg} is missing from @sigrun/sigrun@${coreVersion} dependencies`,
			);
		}
		const repo = PACKAGE_TO_REPO[pkg];
		if (!repo) {
			throw new Error(`ci-core-ref: no repo mapping for ${pkg}`);
		}
		refs[repo] = `v${version}`;
	}

	// 4. memory-markdown: newest version whose shared peer accepts core's shared.
	const coreShared = deps["@sigrun/shared"];
	if (typeof coreShared !== "string") {
		throw new Error(
			`ci-core-ref: @sigrun/shared is missing from @sigrun/sigrun@${coreVersion} dependencies`,
		);
	}

	const mmVersions = await npmView("@sigrun/memory-markdown", "versions");
	if (!Array.isArray(mmVersions)) {
		throw new Error(
			"ci-core-ref: expected an array for @sigrun/memory-markdown versions",
		);
	}

	// Iterate newest-first to find the first compatible version.
	let mmResolved = false;
	for (let i = mmVersions.length - 1; i >= 0; i -= 1) {
		const v = mmVersions[i];
		const peers = await npmView(
			`@sigrun/memory-markdown@${v}`,
			"peerDependencies",
		);
		const sharedRange =
			typeof peers === "object" && peers !== null
				? peers["@sigrun/shared"]
				: undefined;
		if (
			typeof sharedRange === "string" &&
			semver.satisfies(coreShared, sharedRange)
		) {
			refs["sigrun-memory-markdown"] = `v${v}`;
			mmResolved = true;
			break;
		}
	}

	if (!mmResolved) {
		throw new Error(
			`ci-core-ref: no @sigrun/memory-markdown version accepts @sigrun/shared@${coreShared}`,
		);
	}

	return refs;
}

// CLI entry point — only when executed directly, not when imported
// (tests import resolveRefs without triggering process.exit).
import { fileURLToPath } from "node:url";
import { resolve as pathResolve } from "node:path";

const isMain =
	process.argv[1] &&
	pathResolve(process.argv[1]) === pathResolve(fileURLToPath(import.meta.url));

if (isMain) {
	const mode = process.argv[2];
	if (mode !== "release" && mode !== "main") {
		process.stderr.write("usage: ci-core-ref.mjs <release|main>\n");
		process.exit(2);
	}

	try {
		const refs = await resolveRefs(mode, realNpmView);
		process.stdout.write(JSON.stringify(refs, null, 2) + "\n");
	} catch (cause) {
		process.stderr.write(
			`ci-core-ref: ${cause instanceof Error ? cause.message : String(cause)}\n`,
		);
		process.exit(1);
	}
}
