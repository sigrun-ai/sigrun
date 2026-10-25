/**
 * Built-in extensions: codemode, MCP, tool search and OAuth ship WITH
 * core — present by default, disableable via settings `builtinExtensions`,
 * replaceable by a same-named configured extension.
 *
 * The first three mirror pi 1.3.0's built-in tool surface; OAuth adds
 * sigrun's standard OIDC/OAuth2 login providers without extra setup.
 *
 * Resolution root (Ruling 2): built-ins resolve through core's OWN
 * node_modules via `createRequire(import.meta.url)` — they are core
 * `dependencies`, never installed into the packages dir, and never pass
 * through `syncPackages`. A built-in that cannot be resolved from core's
 * tree at all yields an entry whose `import()` fails, and the loader
 * quarantines it (one `status: "quarantined"` outcome naming the
 * package), boot continues — never a throw (Ruling 7).
 *
 * Replacement (Ruling 5): a configured extension whose resolved package
 * name equals a built-in's name REPLACES that built-in — the built-in is
 * skipped, the configured one loads normally, one warning names both, and
 * `/v1/extensions` reports the built-in's row with `builtin: true` plus
 * `replacedBy: "<the configured specifier>"`. The configured name is
 * derived from its specifier through the packages helpers
 * (`readPackageName` for path-shaped entries, `parsePackageSpecifier`
 * otherwise), never by string equality on the raw specifier.
 *
 * Disabled (Ruling 6): `builtinExtensions: {codemode?, mcp?, toolSearch?, oauth?}`
 * (each defaulting to `true`, restart-required). A disabled built-in is
 * absent from `/v1/extensions` entirely; one log line records the skip.
 *
 * Quarantine test seam: callers may pass additional specifier strings
 * (`resolveBuiltins`'s third parameter), resolved like the real built-ins
 * (through core's tree; an absolute path passes through verbatim). The
 * boot wires it from `OpenHarnessOptions.extraBuiltins` — the hermetic
 * seam the quarantine test uses, never a settings field.
 */

import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SettingsFile } from "@sigrun/shared/settings";
import type { ResolvedExtensionInput } from "./loader.js";
import { parsePackageSpecifier, readPackageName } from "./packages.js";

/** One built-in extension's stable identity. */
export interface BuiltinExtension {
	/** The settings key (`builtinExtensions.<key>`). */
	readonly key: "codemode" | "mcp" | "toolSearch" | "oauth";
	/** The npm package name (the resolution specifier). */
	readonly specifier: string;
	/** The `/v1/extensions` row name — the slug the built-in's DECLARED
	 * extension name loads under (`codemode`, `sigrun.mcp` → `sigrun-mcp`,
	 * `tool-search`, `oauth`). The replacement row reports THIS name so a client
	 * sees the built-in's row under the same identity whether it loaded,
	 * was replaced or (absent, when disabled). */
	readonly slug: string;
}

/**
 * The four built-ins, in load order (codemode before tool-search: both
 * wrap pi-durable's own extensions and neither depends on the other, but
 * the order pins the tool-collision story should names ever overlap).
 * Specifiers are the published package names (Task 3) — npm keys a file:
 * dependency by the target's own manifest name, so the key must be the
 * name the packages publish under (the dev shape carries `file:` values
 * under these same keys until Task 8 publishes exact `0.1.0`s).
 */
export const BUILTIN_EXTENSIONS: readonly BuiltinExtension[] = [
	{ key: "codemode", specifier: "@sigrun/ext-codemode", slug: "codemode" },
	{ key: "mcp", specifier: "@sigrun/ext-mcp", slug: "sigrun-mcp" },
	{ key: "toolSearch", specifier: "@sigrun/ext-tool-search", slug: "tool-search" },
	{ key: "oauth", specifier: "@sigrun/oauth", slug: "oauth" },
];

/** The outcome of resolving the built-ins against settings + configured extensions. */
export interface ResolvedBuiltins {
	/** The loader inputs for every built-in that loads this boot. */
	readonly load: ResolvedExtensionInput[];
	/** The built-ins that did not load, with the reason. */
	readonly skipped: {
		readonly key: string;
		readonly reason: "disabled" | "replaced";
		/** The configured specifier that replaced the built-in (reason "replaced"). */
		readonly by?: string;
	}[];
}

/** The core-anchored require (built-ins resolve from core's own node_modules). */
const coreRequire = createRequire(import.meta.url);

/**
 * Resolve one specifier's load entry through core's own node_modules.
 * An unresolvable name yields an entry of the name itself: the loader's
 * `import()` fails on it and quarantines with the not-found message
 * naming the package (Ruling 2 — loud, never a throw). Absolute paths
 * (the test seam's fixture URLs) pass through verbatim.
 */
function builtinEntry(specifier: string): ResolvedExtensionInput {
	if (
		specifier.startsWith("file://") ||
		specifier.startsWith("/") ||
		specifier.startsWith("./") ||
		specifier.startsWith("../")
	) {
		return { name: specifier, entry: specifier };
	}
	try {
		const entry = pathToFileURL(coreRequire.resolve(specifier)).href;
		// The package root: the nearest manifest at or above the resolved
		// entry (the `exports` map may not export `./package.json`, so a
		// `resolve(name + "/package.json")` probe is not reliable).
		let dir = dirname(fileURLToPath(entry));
		let packageDir: string | undefined;
		for (let hops = 0; hops < 6; hops++) {
			if (basename(dir) === "node_modules") break;
			if (readPackageName(dir) !== undefined) {
				packageDir = dir;
				break;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return {
			name: specifier,
			entry,
			...(packageDir === undefined ? {} : { packageDir }),
		};
	} catch {
		return { name: specifier, entry: specifier };
	}
}

/**
 * The package name a configured load entry resolves to, when derivable:
 * path-shaped entries read the nearest manifest (`readPackageName`);
 * bare specifiers parse (`parsePackageSpecifier`). `undefined` when
 * nothing derives (a nameless bare entry) — such an entry can never
 * replace a built-in.
 */
function configuredPackageName(
	entry: ResolvedExtensionInput,
): string | undefined {
	const base = entry.entry ?? entry.name;
	if (base === undefined) return undefined;
	let path: string | undefined;
	if (base.startsWith("file://")) {
		try {
			path = fileURLToPath(base);
		} catch {
			path = undefined;
		}
	} else if (
		base.startsWith("file:") ||
		base.startsWith("/") ||
		base.startsWith("./") ||
		base.startsWith("../")
	) {
		path = resolve(
			base.startsWith("file:") ? base.slice("file:".length) : base,
		);
	}
	if (path !== undefined && isAbsolute(path)) {
		// A path-shaped entry: the nearest manifest at or above it names
		// the package (npm's own file:-dependency rule). A directory's
		// manifest reads directly; a FILE entry starts at its directory.
		const fileShaped = /\.(m?js|ts|cjs|tgz)$/.test(path);
		let dir = fileShaped && !path.endsWith(".tgz") ? dirname(path) : path;
		for (let hops = 0; hops < 6; hops++) {
			const name = readPackageName(dir);
			if (name !== undefined) return name;
			const parent = dirname(dir);
			if (parent === dir) return undefined;
			dir = parent;
		}
		return undefined;
	}
	return parsePackageSpecifier(base).name;
}

/**
 * Resolve which built-ins load this boot, against the settings file's
 * `builtinExtensions` disables and the configured extension list's
 * replacements. Built-ins load FIRST (boot prepends the returned list);
 * the replacement rule removes a built-in whose package name matches a
 * configured entry's resolved package name.
 *
 * One log line per skipped built-in (disabled or replaced) — never per
 * boot loop.
 */
export function resolveBuiltins(
	settings: SettingsFile,
	configured: readonly ResolvedExtensionInput[],
	/** Test seam: additional built-in specifiers (fixtures), resolved like the real ones. */
	extra: readonly string[] = [],
	/** Test seam: replace core resolution to exercise an unresolvable built-in. */
	resolveEntry?: (specifier: string, fallback: typeof builtinEntry) => ResolvedExtensionInput,
): ResolvedBuiltins {
	const resolve = resolveEntry ?? ((specifier: string) => builtinEntry(specifier));
	const toggles = settings.builtinExtensions;
	const load: ResolvedExtensionInput[] = [];
	const skipped: ResolvedBuiltins["skipped"][number][] = [];
	// The configured package names, computed once (replacement matching):
	// name → the display specifier the warning and `replacedBy` report.
	const configuredNames = new Map<string, string>();
	for (const entry of configured) {
		const name = configuredPackageName(entry);
		if (name !== undefined && !configuredNames.has(name)) {
			configuredNames.set(name, entry.name ?? entry.entry ?? name);
		}
	}
	for (const builtin of BUILTIN_EXTENSIONS) {
		if (toggles?.[builtin.key] === false) {
			console.info(
				`builtins: "${builtin.specifier}" disabled via settings builtinExtensions.${builtin.key} — skipping`,
			);
			skipped.push({ key: builtin.key, reason: "disabled" });
			continue;
		}
		const replacement = configuredNames.get(builtin.specifier);
		if (replacement !== undefined) {
			console.warn(
				`builtins: configured extension "${replacement}" replaces the built-in "${builtin.specifier}" (the built-in is skipped)`,
			);
			skipped.push({ key: builtin.key, reason: "replaced", by: replacement });
			continue;
		}
		load.push(resolve(builtin.specifier, builtinEntry));
	}
	// The test-seam extra entries (the boot's `extraBuiltins` option):
	// resolved exactly like the real built-ins, appended after them,
	// reported builtin.
	for (const specifier of extra) {
		load.push(resolve(specifier, builtinEntry));
	}
	return { load, skipped };
}
