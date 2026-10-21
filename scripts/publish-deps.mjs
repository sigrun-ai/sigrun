#!/usr/bin/env node
/**
 * The three built-in extensions are `file:` dependencies in the working
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
 *   postpack       -> `publish-deps.mjs file`     (restore)
 *   postpublish    -> `publish-deps.mjs file`     (restore)
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
};

/** The version every family package is published at. */
const FAMILY_VERSION = "0.1.0";

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
		const stale = Object.keys(BUILTINS).filter(
			(name) => manifest.dependencies?.[name] !== FAMILY_VERSION,
		);
		if (stale.length > 0) {
			for (const name of stale) manifest.dependencies[name] = FAMILY_VERSION;
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
		manifest.dependencies[name] = FAMILY_VERSION;
	}
	writeFileSync(MARKER, `${JSON.stringify(original, null, "\t")}\n`);
	writeManifest(manifest);
	process.stdout.write(
		`publish-deps: registry mode (${Object.keys(BUILTINS).join(", ")} -> ${FAMILY_VERSION})\n`,
	);
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
