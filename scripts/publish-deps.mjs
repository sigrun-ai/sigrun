#!/usr/bin/env node
/**
 * The built-in extensions are `file:` dependencies in the working
 * tree (they live in sibling checkouts and are not on npm until the
 * release's first publish), but a PUBLISHED tarball must declare registry
 * versions — `file:../sigrun-ext-mcp` resolves to nothing on a stranger's
 * machine.
 *
 * npm offers no way to express "this specifier for dev, that one for
 * publish": `overrides` refuses to differ from a direct dependency's own
 * spec (EOVERRIDE), and `publishConfig` has no dependency rewriting. So
 * the rewrite is explicit and bracketed by the pack/publish lifecycle:
 *
 *   prepublishOnly -> `publish-deps.mjs registry` (rewrite, then build)
 *   postpublish    -> `publish-deps.mjs file`     (restore)
 *
 * The restore is postpublish ONLY (0.1.1): npm 11 runs pack -> postpack
 * -> submit(packument+tarball), so a postpack restore flips the manifest
 * back to file: specifiers BEFORE the registry writes the packument —
 * @sigrun/sigrun@0.1.0 shipped a correct tarball but a dev-shape
 * packument (installers resolved file: deps and quarantined the
 * built-ins at boot). A bare `npm pack` in registry mode now leaves the
 * rewrite behind (git shows it; re-run `registry` self-heals, `file`
 * restores).
 *
 * `npm pack` does NOT run `prepublishOnly`, so a pack that must carry
 * registry versions (the release's clean-install smoke) runs this script
 * itself, exactly as the smoke's transcript shows.
 *
 * The rewrite is the ONLY difference: `dependencies` keeps every other
 * entry untouched, and the restore is byte-exact (the original specifiers
 * are recorded in the marker file, not reconstructed).
 *
 * RECOVERY: if a run dies mid-publish the tree may be left in registry
 * mode (git shows the tracked package.json diff). `node
 * scripts/publish-deps.mjs file` restores it; re-running `registry` is
 * also safe (it re-checks the manifest, not just the marker).
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "package.json");
const MARKER = join(ROOT, ".publish-deps-applied.json");

/** The built-in extensions and the sibling checkout each one lives in. */
const BUILTINS = {
	"@sigrun/ext-codemode": "../sigrun-ext-codemode",
	"@sigrun/ext-mcp": "../sigrun-ext-mcp",
	"@sigrun/ext-tool-search": "../sigrun-ext-tool-search",
	"@sigrun/oauth": "../sigrun-ext-oauth",
};

/**
 * The version each built-in publishes: read from the sibling checkout's
 * own manifest (the repo next door is the source of truth — versions
 * diverge across the family once a built-in ships features on its own
 * cadence, e.g. ext-mcp 0.2.0 while the others stay 0.1.0). Throws
 * fail-loud naming the sibling when its manifest is missing/malformed:
 * publishing against a guessed pin is worse than stopping.
 */
function familyVersion(name) {
	const sibling = BUILTINS[name];
	const manifestPath = join(ROOT, sibling, "package.json");
	let version;
	try {
		version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
	} catch (cause) {
		throw new Error(
			`publish-deps: cannot read ${manifestPath} (${cause instanceof Error ? cause.message : String(cause)})`,
		);
	}
	if (typeof version !== "string" || version === "") {
		throw new Error(`publish-deps: ${manifestPath} has no version`);
	}
	return version;
}

function readManifest() {
	return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

function writeManifest(manifest) {
	writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, "\t")}\n`);
}

const mode = process.argv[2];

if (mode === "registry") {
	if (existsSync(MARKER)) {
		// A previous run left the marker behind (it died between writing the
		// marker and finishing, or a publish failed before its restore). The
		// marker holds the ORIGINAL specifiers, so the restore is still safe —
		// but do not trust that the manifest was actually rewritten: a crash
		// between the two writes leaves file: specifiers in place, and a
		// publish would then ship them.
		const manifest = readManifest();
		const stale = Object.entries(BUILTINS)
			.filter(([name]) => manifest.dependencies?.[name] !== familyVersion(name))
			.map(([name]) => name);
		if (stale.length > 0) {
			for (const name of stale) manifest.dependencies[name] = familyVersion(name);
			writeManifest(manifest);
			process.stderr.write(
				`publish-deps: marker present but the manifest still carried ${stale.join(", ")} — re-applied\n`,
			);
		} else {
			process.stderr.write(
				"publish-deps: already in registry mode; nothing to do\n",
			);
		}
		process.exit(0);
	}
	const manifest = readManifest();
	const original = {};
	for (const name of Object.keys(BUILTINS)) {
		const current = manifest.dependencies?.[name];
		if (current === undefined) {
			process.stderr.write(`publish-deps: ${name} is not a dependency\n`);
			process.exit(1);
		}
		original[name] = current;
		manifest.dependencies[name] = familyVersion(name);
	}
	writeFileSync(MARKER, `${JSON.stringify(original, null, "\t")}\n`);
	writeManifest(manifest);
	const pins = Object.keys(BUILTINS).map((name) => `${name}@${familyVersion(name)}`);
	process.stdout.write(`publish-deps: registry mode (${pins.join(", ")})\n`);
} else if (mode === "file") {
	if (!existsSync(MARKER)) {
		process.stderr.write("publish-deps: not in registry mode; nothing to do\n");
		process.exit(0);
	}
	const original = JSON.parse(readFileSync(MARKER, "utf8"));
	const manifest = readManifest();
	for (const [name, specifier] of Object.entries(original)) {
		manifest.dependencies[name] = specifier;
	}
	writeManifest(manifest);
	rmSync(MARKER);
	process.stdout.write("publish-deps: dev mode restored\n");
} else {
	process.stderr.write("usage: publish-deps.mjs <registry|file>\n");
	process.exit(2);
}
