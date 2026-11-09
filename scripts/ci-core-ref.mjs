#!/usr/bin/env node
/**
 * ci-core-ref.mjs (CI-noise Task 1): resolve the latest RELEASED core
 * and its built-in pins from npm, for extension CI checkouts.
 *
 *   node scripts/ci-core-ref.mjs release   → JSON object of repo→tag refs
 *   node scripts/ci-core-ref.mjs main      → {} (every checkout at default branch)
 *   node scripts/ci-core-ref.mjs release --core-manifest package.json
 *     → core + memory-markdown refs from a local tagged manifest
 *
 * --core-manifest covers the memory-markdown axis only, before the tagged
 * core is on npm. Built-in pins are omitted (they are file: specs until
 * prepublishOnly, and the release's existing pins pre-check covers them).
 *
 * The resolver reads npm packuments (via an injectable `npmView`) to
 * determine which versions of the core and each built-in extension are
 * currently released. The output maps repo names to their release tags
 * (e.g. `{"sigrun": "v0.11.3", "sigrun-ext-gateway": "v0.1.26", ...}`).
 *
 * memory-markdown is a core devDependency (`file:../sigrun-memory-markdown`),
 * so npm records no pin for it. The rule is TWO-AXIS, checked per candidate
 * (stable, newest-first):
 *   1. `peerDependencies["@sigrun/shared"]`, when present, must accept the
 *      released core's `@sigrun/shared` version (the plan's original rule;
 *      no published memory-markdown release declares this peer yet).
 *   2. Otherwise `peerDependencies["@earendil-works/pi-durable"]` must
 *      accept the released core's pi-durable pin — the real compat axis:
 *      every published memory-markdown release moved exactly with core's
 *      pi-durable bump (0.1.0/0.1.1 peer 1.3.0; 0.1.2/0.2.2/0.2.3 peer
 *      1.3.0 || 1.4.0; 0.2.4 peer ~1.5.0).
 * Both core versions come from the SAME packument's `dependencies`. If
 * neither axis accepts for any candidate, the resolver throws — never guess.
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
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
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
 * the stdout. Used by the CLI entry point. An absent optional field
 * (notably peerDependencies) prints nothing and exits 0.
 */
function realNpmView(spec, field) {
	const stdout = execFileSync("npm", ["view", spec, field, "--json"], {
		encoding: "utf8",
		timeout: 30_000,
	});
	if (!stdout.trim()) return undefined;
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
	if (mode !== "release") {
		throw new Error(`ci-core-ref: unknown mode '${mode}' (expected release or main)`);
	}

	// 1. Core's latest released version.
	const coreVersion = await npmView("@sigrun/sigrun", "dist-tags.latest");
	if (typeof coreVersion !== "string") {
		throw new Error(
			`ci-core-ref: expected a string for @sigrun/sigrun dist-tags.latest, got ${typeof coreVersion}`,
		);
	}

	// 2. Pin the dependencies query to the version just resolved, so a
	// concurrent release cannot mix two core manifests.
	const deps = await npmView(`@sigrun/sigrun@${coreVersion}`, "dependencies");
	if (typeof deps !== "object" || deps === null) {
		throw new Error(
			`ci-core-ref: expected an object for @sigrun/sigrun@${coreVersion} dependencies`,
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
		if (semver.valid(version) === null) {
			throw new Error(
				`ci-core-ref: built-in ${pkg} pin '${version}' is not an exact version`,
			);
		}
		const repo = PACKAGE_TO_REPO[pkg];
		if (!repo) {
			throw new Error(`ci-core-ref: no repo mapping for ${pkg}`);
		}
		refs[repo] = `v${version}`;
	}

	return resolveMemoryMarkdown(coreVersion, deps, npmView, refs);
}

/**
 * Resolve only the memory-markdown ref against a local tagged core
 * manifest. Built-in pins remain file: specs pre-publish and are covered
 * by the release workflow's existing pins pre-check, so they are omitted.
 *
 * @param {{version?: unknown, dependencies?: unknown}} manifest
 * @param {(spec: string, field: string) => Promise<unknown>} npmView
 * @returns {Promise<Record<string, string>>}
 */
export async function resolveRefsFromManifest(manifest, npmView) {
	if (typeof manifest !== "object" || manifest === null) {
		throw new Error("ci-core-ref: expected a core manifest object");
	}
	const coreVersion = manifest.version;
	if (typeof coreVersion !== "string" || semver.valid(coreVersion) === null) {
		throw new Error("ci-core-ref: the core manifest has no valid version");
	}
	const deps = manifest.dependencies;
	if (typeof deps !== "object" || deps === null) {
		throw new Error("ci-core-ref: the core manifest has no dependencies");
	}
	return resolveMemoryMarkdown(coreVersion, deps, npmView, {
		sigrun: `v${coreVersion}`,
	});
}

/** Resolve memory-markdown against the supplied core dependencies. */
async function resolveMemoryMarkdown(coreVersion, deps, npmView, refs) {
	// Newest version accepted by the shared peer when declared, or by the
	// pi-durable peer otherwise. A rejecting shared peer is authoritative.
	const coreShared = deps["@sigrun/shared"];
	if (typeof coreShared !== "string") {
		throw new Error(
			`ci-core-ref: @sigrun/shared is missing from @sigrun/sigrun@${coreVersion} dependencies`,
		);
	}
	const corePiDurable = deps["@earendil-works/pi-durable"];
	if (typeof corePiDurable !== "string") {
		throw new Error(
			`ci-core-ref: @earendil-works/pi-durable is missing from @sigrun/sigrun@${coreVersion} dependencies`,
		);
	}

	const mmVersions = await npmView("@sigrun/memory-markdown", "versions");
	if (!Array.isArray(mmVersions)) {
		throw new Error(
			"ci-core-ref: expected an array for @sigrun/memory-markdown versions",
		);
	}

	// npm's versions array is not an ordering contract. Consider only
	// stable versions, newest first, so a prerelease never becomes a CI ref.
	const candidates = mmVersions
		.filter((v) => semver.valid(v) !== null && semver.prerelease(v) === null)
		.sort(semver.rcompare);
	let mmResolved = false;
	for (const v of candidates) {
		const peers = await npmView(
			`@sigrun/memory-markdown@${v}`,
			"peerDependencies",
		);
		const sharedRange =
			typeof peers === "object" && peers !== null
				? peers["@sigrun/shared"]
				: undefined;
		const piDurableRange =
			typeof peers === "object" && peers !== null
				? peers["@earendil-works/pi-durable"]
				: undefined;
		const accepts =
			typeof sharedRange === "string"
				? semver.satisfies(coreShared, sharedRange)
				: typeof piDurableRange === "string" &&
					semver.satisfies(corePiDurable, piDurableRange);
		if (accepts) {
			refs["sigrun-memory-markdown"] = `v${v}`;
			mmResolved = true;
			break;
		}
	}

	if (!mmResolved) {
		throw new Error(
			`ci-core-ref: no @sigrun/memory-markdown version accepts @sigrun/shared@${coreShared} or @earendil-works/pi-durable@${corePiDurable}`,
		);
	}

	return refs;
}

// CLI entry point — only when executed directly, not when imported
// (tests import resolveRefs without triggering process.exit).
const isMain =
	process.argv[1] &&
	pathResolve(process.argv[1]) === pathResolve(fileURLToPath(import.meta.url));

if (isMain) {
	const [mode, ...args] = process.argv.slice(2);
	const usage =
		"usage: ci-core-ref.mjs <release|main> [--core-manifest <path>]\n";
	if (mode !== "release" && mode !== "main") {
		process.stderr.write(usage);
		process.exit(2);
	}
	if (mode === "main" && args.length > 0) {
		process.stderr.write(usage);
		process.exit(2);
	}
	if (args.length !== 0 && (args.length !== 2 || args[0] !== "--core-manifest")) {
		process.stderr.write(usage);
		process.exit(2);
	}

	try {
		const refs =
			args.length === 2
				? await resolveRefsFromManifest(
						JSON.parse(readFileSync(args[1], "utf8")),
						realNpmView,
					)
				: await resolveRefs(mode, realNpmView);
		process.stdout.write(JSON.stringify(refs, null, 2) + "\n");
	} catch (cause) {
		process.stderr.write(
			`ci-core-ref: ${cause instanceof Error ? cause.message : String(cause)}\n`,
		);
		process.exit(1);
	}
}
