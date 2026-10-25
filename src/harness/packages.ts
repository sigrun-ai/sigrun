/**
 * Boot-time extension package install (the pi-style packages dir).
 *
 * Sigrun deployments declare extensions in the settings file's unified
 * top-level `extensions` list (an `ExtensionSpec`: a string source or
 * `{source, entry?, ref?, enabled?}`) and restart — no image rebuild,
 * no manual npm. The `SIGRUN_EXTENSIONS` env var (a comma-separated
 * specifier list) REPLACES the file's list when set — env wins, validated
 * first; it is the one environment-shaped override of the declaration.
 *
 * The install list is derived from the entries' sources:
 * `normalizeExtSpec` flattens each entry, and `sourceKind` routes it —
 * npm-shaped sources (registry names/ranges/scoped specifiers, and
 * `file:` installable specifiers) install into the packages dir; git
 * sources (`git:` or an https `…​.git` URL, optional `@ref`) clone/fetch
 * into the git dir (`<config-dir>/git/`) with entry discovery; bare
 * `./`/`../`/absolute paths LOAD IN PLACE (nothing installed). A `file:`
 * entry is an INSTALLABLE npm specifier keyed by the TARGET's own
 * manifest name and compared by canonical absolute path; a `file:`-less
 * relative/absolute path never installs. `enabled: false` entries keep
 * their directory state but produce no loadable resolution. The packages
 * live in a dedicated section of the config directory
 * (`<config-dir>/packages/`, a sibling of `settings.json` and
 * `auth.json`), which is the PVC-backed path in every deployment shape,
 * so installed packages persist across restarts.
 *
 * The directory is a REAL npm root, exactly pi's shape (`~/.pi/agent/npm`):
 * a synthetic private root `package.json` (`{"name": "sigrun-packages",
 * "private": true, "dependencies": {…}}`) plus `node_modules/`. The root
 * manifest's `dependencies` map IS the resolved state (name → range);
 * the settings file's npm-shaped `extensions` entries are the
 * user-authored INTENT. Boot diffs the two (`planSync`):
 *
 * - a wanted specifier whose package is missing from (or whose range or
 *   canonical path differs in) the dependencies map → `npm install
 *   <changed specifiers> --prefix <packagesDir>`;
 * - a dependencies entry named by NO wanted specifier → `npm uninstall
 *   <name> --prefix <packagesDir>` (a removed declaration prunes);
 * - no diff → no subprocess at all (the fast path; a steady-state boot
 *   costs one file read).
 *
 * Fail-loud is the posture: an install or uninstall that fails, times out
 * (120s), or leaves the declared package unresolved fails the BOOT, naming
 * the specifier — an extension declared but uninstallable is a config
 * error, exactly like a bad `SIGRUN_*` value.
 *
 * SECURITY: `npm install` executes the installed packages' lifecycle
 * scripts (`postinstall` and friends). The packages dir is
 * operator-configured — the specifiers the operator declares carry the
 * same trust level as the extension code they name (which runs IN the
 * harness with full tool authority). This is pi's documented posture too:
 * the dir is trusted by configuration, not sandboxed.
 */

import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionSpec } from "./settings.js";

/** The npm install/uninstall timeout (ms) — one subprocess invocation. */
export const NPM_TIMEOUT_MS = 120_000;

/**
 * Runtime modules the HOST ships that extension packages may import bare.
 * Extension packages declare these devDependencies-only (the
 * provider-plugins dependency posture: pi-ai/pi-durable ship with sigrun,
 * typebox ships as pi-ai's own dependency — structural typing at runtime,
 * never identity), and npm never installs a dependency's devDependencies,
 * so a package installed into the packages dir cannot resolve them on its
 * own. {@link ensureHostModuleLinks} links sigrun's own copies into the
 * packages dir's node_modules so the dynamic import of such a package
 * resolves them — the SAME module instances the host runs.
 *
 * `@sigrun/sigrun` itself is here too (spec §14.1): the builders behind
 * `@sigrun/sigrun/blocks` must emit the SERVER's block-set version, so
 * extensions import the running copy — never a bundled or
 * registry-fetched one (the loader's exact-match rule quarantines a
 * tree that resolves a different version). Sigrun is the RUNNING
 * package, not a dependency: {@link resolveHostModuleDir} resolves it
 * to its own root instead of walking node_modules.
 */
/** The package this code ships in — the host runtime module that is the host itself. */
const SELF_MODULE_NAME = "@sigrun/sigrun";

export const HOST_RUNTIME_MODULES: readonly string[] = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-durable",
	"@earendil-works/chord",
	"typebox",
	SELF_MODULE_NAME,
];

/**
 * Read the `version` field of the package at `moduleDir` (following
 * links — a linked entry reads its target's manifest). `undefined` when
 * the dir carries no readable manifest: callers treat that as "nothing
 * to compare", never as a mismatch.
 */
function installedVersionAt(moduleDir: string): string | undefined {
	try {
		const parsed = JSON.parse(
			readFileSync(join(moduleDir, "package.json"), "utf8"),
		) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The version of the HOST's own copy of a runtime module (the tree
 * sigrun itself runs from), or `undefined` when sigrun's tree does not
 * carry it. The loader's host-module guard compares every extension's
 * resolution against THIS value (spec §6.4 R6).
 */
export function hostModuleVersion(name: string): string | undefined {
	const dir = resolveHostModuleDir(name);
	return dir === undefined ? undefined : installedVersionAt(dir);
}

/**
 * The running package's own root: the nearest ancestor of THIS module
 * whose manifest is named `@sigrun/sigrun`. The node_modules walk below
 * can never find the running package — sigrun is not a dependency of
 * itself, and a source checkout carries no
 * `node_modules/@sigrun/sigrun` anywhere above `src/` (the published
 * install resolves through its OWN root, which is this same dir).
 * `undefined` when no ancestor carries the manifest.
 */
export function selfPackageRoot(): string | undefined {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let hops = 0; hops < 10; hops++) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				const parsed = JSON.parse(
					readFileSync(manifest, "utf8"),
				) as { name?: unknown };
				if (parsed.name === SELF_MODULE_NAME) return dir;
			} catch {
				// Unreadable manifest — keep walking.
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/**
 * Resolve a host runtime module's package dir from sigrun's own tree: the
 * nearest `node_modules/<name>` walking up from THIS module's location
 * (the repo root in every deploy shape — sigrun runs from source). The
 * walk stops at the filesystem root; `undefined` when nothing resolves.
 * The ONE exception is sigrun itself (see {@link selfPackageRoot}): the
 * link target is the running package's own root.
 */
function resolveHostModuleDir(name: string): string | undefined {
	if (name === SELF_MODULE_NAME) return selfPackageRoot();
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let hops = 0; hops < 10; hops++) {
		const candidate = join(dir, "node_modules", ...name.split("/"));
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/**
 * Link every host runtime module into the packages dir's node_modules
 * (absolute dir symlinks), so packages installed there whose manifests
 * declare those modules devDependencies-only resolve their bare imports
 * — without the link, `import()` of the package fails ERR_MODULE_NOT_FOUND
 * (the packages dir is an unrelated node_modules tree; Node's upward walk
 * from the package never finds sigrun's own).
 *
 * Present entries are LEFT ALONE (an npm-installed real copy — a package
 * that declared the module a runtime dependency — wins over the link; the
 * sync never fights npm's own tree). A stale BROKEN link is removed before
 * relinking. A module unresolvable from sigrun's tree warns and skips: a
 * package that does not import it never needs the link, and the loader's
 * quarantine names the gap for one that does.
 */
export function ensureHostModuleLinks(packagesDir: string): void {
	const nodeModules = join(packagesDir, "node_modules");
	if (!existsSync(nodeModules)) return;
	for (const name of HOST_RUNTIME_MODULES) {
		const linkPath = join(nodeModules, ...name.split("/"));
		// existsSync follows links: an INTACT link (or a real npm-installed
		// copy) reads true and is left alone.
		if (existsSync(linkPath)) {
			// A present entry whose version differs from the host's is
			// SURFACED, not replaced (spec §6.4 R6): the sync never fights
			// npm's tree — an npm-installed copy still wins over the link —
			// but a skewing copy must not sit silently. The loader's guard
			// quarantines the extensions that RESOLVE a skewing module; this
			// warn covers the packages tree itself (same version reads equal
			// for an intact host link, so links never trip it).
			const present = installedVersionAt(linkPath);
			const host = hostModuleVersion(name);
			if (
				present !== undefined &&
				host !== undefined &&
				present !== host
			) {
				console.warn(
					`packages: ${name}@${present} installed in ${packagesDir} differs from host ${host}`,
				);
			}
			continue;
		}
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(linkPath);
		} catch {
			stat = undefined; // nothing at the path
		}
		if (stat !== undefined) {
			// Present but NOT a link: something npm placed that does not
			// resolve (a stray file) — leave it for npm, never fight the tree.
			if (!stat.isSymbolicLink()) continue;
			// A present-but-BROKEN symlink (existsSync followed it and failed):
			// clear it so the fresh link below is creatable.
			rmSync(linkPath, { force: true });
		}
		const target = resolveHostModuleDir(name);
		if (target === undefined) {
			console.warn(
				`packages: host module ${name} not found in the sigrun tree; not linking into ${packagesDir}`,
			);
			continue;
		}
		mkdirSync(dirname(linkPath), { recursive: true });
		try {
			symlinkSync(target, linkPath, "dir");
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException | null)?.code === "EEXIST") continue;
			throw cause;
		}
	}
}

/** The packages dir's synthetic root manifest name (pi's is `pi-extensions`). */
export const PACKAGES_ROOT_NAME = "sigrun-packages";

/** The packages dir under the config dir: `<configDir>/packages`. */
export function packagesDirOf(configDir: string): string {
	return join(configDir, "packages");
}

/** The synthetic root manifest path: `<packagesDir>/package.json`. */
export function packagesManifestPath(packagesDir: string): string {
	return join(packagesDir, "package.json");
}

/**
 * The failure type: the boot wiring (`src/index.ts`) lets this throw —
 * boot fails loud naming the specifier (or the manifest path).
 */
export class PackageSyncError extends Error {}

interface PackagesManifest {
	readonly dependencies?: Record<string, string>;
}

/** The install plan: which specifiers to install, which names to remove. */
interface SyncPlan {
	readonly install: readonly string[];
	readonly uninstall: readonly string[];
}

/**
 * One `npm <args>` invocation against the packages dir (execFile — no
 * shell, so no quoting surface). `--legacy-peer-deps` disables npm's
 * peer-resolution for every managed install — pi's own posture for its
 * extension installs: an extension declaring `@sigrun/sigrun` (or
 * pi-durable/pi-ai) a `peerDependency: "*"` must resolve the HOST's
 * linked copy, never an npm-solved registry copy whose version would
 * quarantine the extension at load. Failures and timeouts reject with a
 * `PackageSyncError` carrying npm's stderr tail; `verbose` captures the
 * full output for the error message.
 */
function runNpm(
	args: readonly string[],
	packagesDir: string,
	verbose?: boolean,
): Promise<void> {
	return new Promise((resolve, reject) => {
			execFile(
				"npm",
				[
					...args,
					"--prefix",
					packagesDir,
					"--no-audit",
					"--no-fund",
					"--legacy-peer-deps",
				],
				{ timeout: NPM_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
				(error, stdout, stderr) => {
				if (error === null) {
					if (verbose === true && stderr !== "") {
						console.warn(`packages: npm ${args[0] ?? ""}: ${stderr.trim()}`);
					}
					resolve();
					return;
				}
				const timedOut = error.killed === true || error.signal === "SIGTERM";
				const detail = (stderr || stdout).trim().split("\n").slice(-5).join("\n");
				reject(
					new PackageSyncError(
						`packages: npm ${args.join(" ")} ${timedOut ? `timed out after ${NPM_TIMEOUT_MS}ms` : `failed (exit ${String(error.code)})`}` +
							(detail === "" ? "" : `:\n${detail}`),
					),
				);
			},
		);
	});
}

/**
 * Read the packages dir's root manifest dependencies (name → range). A
 * missing manifest is the empty map (first boot with `packages` set);
 * a manifest that exists but does not parse fails loud — the dir is
 * sigrun-owned, so a corrupt manifest is an operator-visible error, not
 * something to silently reinstall over.
 */
function readInstalled(packagesDir: string): Record<string, string> {
	const path = packagesManifestPath(packagesDir);
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (cause) {
		throw new PackageSyncError(
			`packages: ${path} is not valid JSON (${
				cause instanceof Error ? cause.message : String(cause)
			})`,
		);
	}
	const manifest = parsed as PackagesManifest;
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		(manifest.dependencies !== undefined &&
			(typeof manifest.dependencies !== "object" ||
				manifest.dependencies === null ||
				Array.isArray(manifest.dependencies)))
	) {
		throw new PackageSyncError(
			`packages: ${path} must be an object with an optional dependencies map`,
		);
	}
	return { ...(manifest.dependencies ?? {}) };
}

/**
 * Parse an npm package specifier into `{ name, range }`.
 *
 * A specifier is `<name>@<range>` with the `@<range>` part optional
 * (npm installs `latest` when it is absent); scoped names
 * (`@scope/name`) carry their leading `@`, so the range split is the
 * LAST `@` that is not the first character. For PATH-shaped specifiers
 * (`file:`, `./`, `/`) the "name" is the path itself — npm keys those
 * dependencies entries by the package's OWN manifest name, so callers
 * needing the real identity use {@link identifySpecifier}.
 */
export function parsePackageSpecifier(specifier: string): {
	name: string;
	range: string;
} {
	const at = specifier.lastIndexOf("@");
	if (at <= 0) return { name: specifier, range: "" };
	return { name: specifier.slice(0, at), range: specifier.slice(at + 1) };
}

/** Whether a specifier names a path (`file:`, `./x`, `../x`, `/x`, a tarball) rather than a registry package. */
function isPathSpecifier(name: string): boolean {
	return (
		name.startsWith("file:") ||
		name.startsWith("./") ||
		name.startsWith("../") ||
		name.startsWith("/") ||
		name.endsWith(".tgz")
	);
}

/** The filesystem path of a path-shaped specifier (`file:` URL and plain forms). */
function specToPath(spec: string): string {
	if (spec.startsWith("file://")) return fileURLToPath(spec);
	if (spec.startsWith("file:")) return spec.slice("file:".length);
	return spec;
}

/**
 * Canonical absolute path of a path-shaped specifier. `base` is the
 * directory a RELATIVE spec resolves against — the process cwd for a
 * wanted specifier (npm resolves install args against its cwd, which is
 * the sigrun process's), the packages dir for a recorded range (npm
 * relativizes `file:` dependency entries against the manifest's dir).
 */
function canonicalizePath(spec: string, base: string): string {
	return resolve(base, specToPath(spec));
}

/**
 * The minimal manifest fields sigrun reads off a package's
 * `package.json` (the name for install identity, the version for the
 * `GET /v1/extensions` inventory).
 */
interface PackageManifest {
	readonly name?: string;
	readonly version?: string;
	/** UI-blocks U3 (spec §11.1): the extension's declared assets dir. */
	readonly sigrun?: { readonly assets?: unknown };
}

/** Read a package's manifest: the directory form, else the tarball form. */
function readManifest(absPath: string): PackageManifest | undefined {
	try {
		return JSON.parse(
			readFileSync(join(absPath, "package.json"), "utf8"),
		) as PackageManifest;
	} catch {
		// Not a readable directory manifest — try the tarball form.
	}
	if (absPath.endsWith(".tgz")) {
		try {
			const out = execFileSync(
				"tar",
				["-xzOf", absPath, "package/package.json"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
			);
			return JSON.parse(out) as PackageManifest;
		} catch {
			// Unreadable tarball — the name is unknown; the install itself
			// will fail loud if the specifier is bad.
		}
	}
	return undefined;
}

/**
 * The `name` of a path-shaped specifier's target package, when readable.
 * A directory's `package.json` reads directly; a `.tgz` tarball's
 * `package/package.json` reads by listing the archive (npm keys a tarball
 * install by the packed manifest's name too). Exported for the loader's
 * provisional-identity derivation (the nearest manifest above a load
 * entry names the package).
 */
export function readPackageName(absPath: string): string | undefined {
	const name = readManifest(absPath)?.name;
	return typeof name === "string" && name !== "" ? name : undefined;
}

/**
 * The `version` of a path-shaped specifier's target package, when
 * readable — `readPackageName`'s sibling over the SAME manifests
 * (directory `package.json`, else the tarball's `package/package.json`).
 * Exported for the loader's outcome recording: the extension inventory
 * (`GET /v1/extensions`, spec §7.7) surfaces the manifest version.
 */
export function readPackageVersion(absPath: string): string | undefined {
	const version = readManifest(absPath)?.version;
	return typeof version === "string" && version !== "" ? version : undefined;
}

/**
 * The declared `sigrun.assets` directory (spec §11.1), resolved
 * absolute against the package root; `undefined` when the manifest
 * declares none (or no manifest reads). A non-string declaration is
 * ignored — assets are simply absent.
 */
export function readPackageAssetsDir(absPath: string): string | undefined {
	const declared = readManifest(absPath)?.sigrun?.assets;
	if (typeof declared !== "string" || declared === "") return undefined;
	return resolve(absPath, declared);
}

interface SpecifierIdentity {
	/** The key npm's dependencies map uses (the target's own manifest name for path specs). */
	readonly name: string;
	/** Registry range, or the canonical absolute path for path specs. */
	readonly range: string;
	/** True when the specifier is path-shaped (`file:`/path). */
	readonly pathShaped: boolean;
}

/**
 * The identity a specifier installs under: registry specs key by their
 * parsed name; path specs key by the target package's OWN manifest name
 * (npm's rule) and compare by canonical absolute path (npm relativizes
 * the recorded `file:` entry against the packages dir, so a raw string
 * compare would reinstall on every boot).
 */
export function identifySpecifier(specifier: string): SpecifierIdentity {
	const { name, range } = parsePackageSpecifier(specifier);
	if (!isPathSpecifier(name)) return { name, range, pathShaped: false };
	const absPath = canonicalizePath(name, process.cwd());
	return {
		name: readPackageName(absPath) ?? name,
		range: absPath,
		pathShaped: true,
	};
}

/**
 * One normalized name-bearing entry derived from a settings `extensions`
 * value: what should be installed/loaded and whether it is enabled.
 */
export interface NormalizedExtSpec {
	/** The source specifier (string shorthand resolves to `source`). */
	readonly source: string;
	/** Entry-point override from the object form, when present. */
	readonly entry?: string;
	/** Git ref from the object form or the `@ref` suffix, when present. */
	readonly ref?: string;
	/** Default true. */
	readonly enabled: boolean;
}

/**
 * Normalize one settings `extensions` entry (string or object form) into
 * the install/load stem. Exported for the unit tests.
 */
export function normalizeExtSpec(entry: ExtensionSpec): NormalizedExtSpec {
	if (typeof entry === "string") {
		return { source: entry, enabled: true };
	}
	return {
		source: entry.source,
		...(entry.entry === undefined ? {} : { entry: entry.entry }),
		...(entry.ref === undefined ? {} : { ref: entry.ref }),
		enabled: entry.enabled ?? true,
	};
}

/**
 * The kind of source a normalized spec points at, deciding which boot
 * tree gets it (packages dir, git dir, or load-in-place).
 */
export function sourceKind(source: string): "npm" | "git" | "path" | "bare" {
	if (source.startsWith("git:") || /^https?:\/\/.*\.git/.test(source)) {
		return "git";
	}
	// `file:` is an INSTALLABLE npm specifier (npm records it in the
	// packages manifest and loads the symlinked source — the dev-checkout
	// shape). Bare ./ ../ / paths are LOAD-IN-PLACE (nothing installed).
	if (
		((source.startsWith("./") || source.startsWith("../")) &&
			!source.startsWith("file:")) ||
		(source.startsWith("/") && !source.startsWith("file:/"))
	) {
		return "path";
	}
	// A git https/shp URL without a .git suffix would collide with the
	// npm "name" grammar: only definite .git URLs are git here; everything
	// else is a registry/bare name.
	return "npm";
}

/**
 * Diff the wanted specifiers against the installed dependencies map.
 * Wanted-but-missing or range/path-changed → install; installed-but-
 * unwanted → uninstall. Exported for the unit tests (the diff rules are
 * the sync's core logic).
 */
export function planSync(
	wanted: readonly string[],
	installed: Record<string, string>,
	packagesDir: string,
): SyncPlan {
	const install: string[] = [];
	const wantedNames = new Set<string>();
	for (const specifier of wanted) {
		const id = identifySpecifier(specifier);
		wantedNames.add(id.name);
		const installedRange = installed[id.name];
		if (installedRange === undefined) {
			install.push(specifier);
			continue;
		}
		if (id.pathShaped) {
			// A recorded registry range where a path is wanted (the package
			// moved to a local checkout) is a change too.
			const recordedPath = installedRange.startsWith("file:")
				? canonicalizePath(installedRange, packagesDir)
				: undefined;
			if (recordedPath !== id.range) install.push(specifier);
			continue;
		}
		// A rangeless registry specifier ("name") accepts any installed
		// entry (npm recorded the resolved version or "latest" —
		// reinstalling every boot would defeat the fast path); a ranged
		// specifier must match the recorded range exactly, else the
		// declaration changed.
		if (id.range !== "" && installedRange !== id.range) {
			install.push(specifier);
		}
	}
	const uninstall = Object.keys(installed).filter((name) => !wantedNames.has(name));
	return { install, uninstall };
}

/**
 * Ensure the packages dir exists with its synthetic root manifest. The
 * manifest is written ONLY when absent — once npm owns the dir it keeps
 * the manifest's dependencies map current, and rewriting it here would
 * fight npm's own writes.
 */
function ensurePackagesDir(packagesDir: string): void {
	mkdirSync(packagesDir, { recursive: true });
	const path = packagesManifestPath(packagesDir);
	if (!existsSync(path)) {
		writeFileSync(
			path,
			`${JSON.stringify({ name: PACKAGES_ROOT_NAME, private: true }, null, "\t")}\n`,
		);
	}
}

export interface SyncPackagesOptions {
	/** Log the plan/no-op line (default true; tests pass false). */
	readonly log?: boolean;
	/** Log npm's own stderr on successful installs (default false). */
	readonly verbose?: boolean;
	/** The config dir (git dir parent); derived from the packages dir's parent when omitted. */
	readonly configDir?: string;
}

/**
 * One loadable extension resolution from the sync (W5 Task 4: a UNION —
 * an entry-bearing package, or a skills-only package with no loadable
 * entry but declared skill dirs):
 *
 * - `entry`: the `entry` is an absolute `file://` URL (npm/bare/path
 *   packages, discovered git checkouts) or the original load specifier
 *   (paths changed nothing); `skills` carries the package's manifest
 *   skill dirs (existing directories only, resolved against the package
 *   root) when it declared any.
 * - `skills-only`: a package that declares skills and has NO loadable
 *   entry (spec §9.4 — e.g. a pi-compat package whose only pi extension
 *   is TypeScript, unimportable under plain node): nothing is imported;
 *   the loader records outcome `ok` and serves only the skills.
 *
 * `enabled` mirrors the source spec (always true from the sync —
 * disabled entries never reach the loader).
 */
export type ExtensionResolution =
	| {
			readonly kind: "entry";
			readonly entry: string;
			readonly enabled: boolean;
			readonly skills?: readonly string[];
		}
	| {
			readonly kind: "skills-only";
			readonly name: string;
			readonly skills: readonly string[];
			readonly enabled: boolean;
	  };

/**
 * Reconcile the packages dir with the settings file's `extensions`
 * intent (the npm-shaped entries; git/path entries never reach the npm
 * root).
 *
 * @param extensions the settings file's unified `extensions` array
 *   (already validated: string or object entries).
 * @param packagesDir the packages dir (`packagesDirOf(configDir)`).
 * @throws PackageSyncError on any install/uninstall failure, timeout, or
 *   a declared specifier that does not resolve afterward.
 */
export async function syncPackages(
	extensions: readonly ExtensionSpec[],
	packagesDir: string,
	options: SyncPackagesOptions = {},
): Promise<ExtensionResolution[]> {
	// Normalize + split by source kind: npm-shaped entries install into
	// the packages dir; git entries clone/fetch into the git dir; path
	// entries load in place; disabled entries keep their directory state
	// but produce no loadable resolution.
	const normalized = extensions.map(normalizeExtSpec);
	const resolutions: ExtensionResolution[] = [];
	const gitDir = gitDirOf(
		options.configDir ?? resolve(dirname(packagesDir)),
	);
	const npmSpecs: string[] = [];
	for (const spec of normalized) {
		if (!spec.enabled) continue;
		const kind = sourceKind(spec.source);
		if (kind === "npm") {
			npmSpecs.push(spec.source);
			continue;
		}
		if (kind === "git") {
			const { source, ref } = splitGitRef(spec.source, spec.ref);
			const repoDir = await syncGit(source, ref, gitDir, options);
			let entry: string | undefined;
			try {
				entry = findExtEntry(repoDir, spec.entry);
			} catch (cause) {
				throw cause instanceof GitSyncError
					? new GitSyncError(
							`git extension ${sanitizeUrl(spec.source)}: ${cause.message}`,
						)
					: cause;
			}
			// The §9.4 three cases: a discoverable entry resolves entry-kind
			// (carrying any manifest skills); NO entry + declared skills is the
			// valid skills-only package; NO entry and NO skills keeps today's
			// loud throw.
			const skills = manifestSkills(repoDir);
			if (entry !== undefined) {
				resolutions.push({
					kind: "entry",
					entry: pathToFileURL(entry).href,
					enabled: true,
					...(skills.length === 0 ? {} : { skills }),
				});
				continue;
			}
			if (skills.length > 0) {
				resolutions.push({
					kind: "skills-only",
					name: readPackageName(repoDir) ?? basename(repoDir),
					skills,
					enabled: true,
				});
				continue;
			}
			throw new GitSyncError(
				`git extension ${sanitizeUrl(spec.source)}: no loadable entry (no sigrun manifest, no dist/index.js) — ship a built entry; a .ts source cannot load under plain node`,
			);
		}
		// path kind: load in place (nothing installed). A path package's
		// manifest skills still ride along (the path target is its root).
		const pathRoot =
			sourceKind(spec.source) === "path" && statIsDirectory(spec.source)
				? spec.source
				: undefined;
		const pathSkills = pathRoot === undefined ? [] : manifestSkills(pathRoot);
		resolutions.push({
			kind: "entry",
			entry: spec.source,
			enabled: true,
			...(pathSkills.length === 0 ? {} : { skills: pathSkills }),
		});
	}
	await syncPackagesFlat(npmSpecs, packagesDir, options);
	// npm-path resolutions (bare names, file: forms): resolved through the
	// packages dir then the app tree — the loader's resolution seam, kept.
	for (const spec of normalized) {
		if (!spec.enabled) continue;
		if (sourceKind(spec.source) !== "npm") continue;
		const explicitEntry = spec.entry;
		const root = manifestRootOf(spec.source, packagesDir);
		const skills = root === undefined ? [] : manifestSkills(root);
		const pushSkillsOnly = (): void => {
			resolutions.push({
				kind: "skills-only",
				name: root === undefined ? spec.source : (readPackageName(root) ?? basename(root)),
				skills,
				enabled: true,
			});
		};
		const resolved = resolveExtensionEntry(spec.source, packagesDir);
		if (resolved === undefined) {
			// Nothing resolvable: skills-only when the package declares skills,
			// else today's shape (the specifier verbatim — the import fails
			// loud at load, the quarantine).
			if (skills.length > 0) {
				pushSkillsOnly();
				continue;
			}
			resolutions.push({ kind: "entry", entry: spec.source, enabled: true });
			continue;
		}
		// A resolved DIRECTORY is packageEntry's "nothing discoverable"
		// fallback (no self-resolvable entry, no manifest entry, no
		// convention file): with declared skills that is the skills-only
		// package; without, keep today's loud dir-import failure.
		const resolvedPath = resolved.startsWith("file://")
			? fileURLToPath(resolved)
			: resolved;
		if (statIsDirectory(resolvedPath)) {
			if (skills.length > 0) {
				pushSkillsOnly();
				continue;
			}
			resolutions.push({ kind: "entry", entry: resolved, enabled: true });
			continue;
		}
		resolutions.push({
			kind: "entry",
			entry: explicitEntry === undefined
				? resolved
				: pathToFileURL(join(dirname(resolved), explicitEntry)).href,
			enabled: true,
			...(skills.length === 0 ? {} : { skills }),
		});
	}
	return resolutions;
}

/** Split a git source into its fetch URL + declared ref. */
function splitGitRef(source: string, objectRef?: string): { source: string; ref?: string } {
	if (objectRef !== undefined) return { source, ref: objectRef };
	// The @ref suffix: only treat the segment AFTER the last slash (a
	// scoped/URL @ in the host part is not a ref).
	const slash = source.lastIndexOf("/");
	const at = source.lastIndexOf("@");
	if (at > slash + 1) return { source: source.slice(0, at), ref: source.slice(at + 1) };
	return { source };
}

/** The pre-existing flat npm synchronizer (now an internal step). */
async function syncPackagesFlat(
	packages: readonly string[],
	packagesDir: string,
	options: SyncPackagesOptions = {},
): Promise<void> {
	const log = options.log !== false;
	ensurePackagesDir(packagesDir);
	const installed = readInstalled(packagesDir);
	const plan = planSync(packages, installed, packagesDir);
	if (plan.install.length === 0 && plan.uninstall.length === 0) {
		// Fast path: the dir already matches the declaration — no
		// subprocess, no npm startup cost (the steady-state boot).
		if (log) console.log(`packages: ${packages.length} declared, 0 changes`);
		// Host-module links are idempotent-cheap (an existsSync per module)
		// and still ensured here: a packages dir populated by an older boot
		// (or hand-copied) gains them on the next steady-state boot.
		ensureHostModuleLinks(packagesDir);
		return;
	}
	if (plan.uninstall.length > 0) {
		if (log) console.log(`packages: removing ${plan.uninstall.join(", ")}`);
		await runNpm(["uninstall", ...plan.uninstall], packagesDir, options.verbose);
	}
	if (plan.install.length > 0) {
		if (log) console.log(`packages: installing ${plan.install.join(", ")}`);
		// npm resolves a CWD-relative file: install arg against ITS OWN cwd
		// (the spawned npm inherits sigrun's, but an operator's "./x" is
		// authored against the deploy root) — absolutize path specifiers so
		// the meaning never depends on the subprocess's working directory.
		const installArgs = plan.install.map((specifier) => {
			const id = identifySpecifier(specifier);
			return id.pathShaped ? `file:${id.range}` : specifier;
		});
		await runNpm(
			["install", "--save-exact=false", ...installArgs],
			packagesDir,
			options.verbose,
		);
		// Post-install assertion: every DECLARED specifier must now resolve
		// against the packages dir. npm exit 0 with nothing installed is the
		// classic bad-specifier failure mode (typo'd name, unreachable
		// registry serving an empty success) — catch it here, at boot, not
		// at extension-load time.
		const nodeModules = join(packagesDir, "node_modules");
		for (const specifier of plan.install) {
			const { name } = identifySpecifier(specifier);
			if (!existsSync(join(nodeModules, ...name.split("/"), "package.json"))) {
				throw new PackageSyncError(
					`packages: ${JSON.stringify(specifier)} installed without error but ` +
						`${join(nodeModules, ...name.split("/"))} does not exist — the specifier ` +
						`does not resolve to an installed package`,
				);
			}
		}
	}
	// Uninstalled-but-still-present is npm's problem to have gotten right —
	// npm uninstall is authoritative; no post-assertion (a leftover
	// transitive dep directory is normal and not an error).
	// Host-module links: after any npm pass (install or uninstall), so the
	// dir the loader resolves from carries the host's runtime modules.
	ensureHostModuleLinks(packagesDir);
	if (log) console.log("packages: sync complete");
}

/**
 * Resolve an extension LOAD specifier against the packages dir first
 * (deployment-installed wins), falling back to bare import resolution
 * (paths, `file://` URLs, dev checkouts, image-bundled packages).
 *
 * Returns the absolute entry path to dynamic-import. The packages dir is
 * an unrelated tree from sigrun's own `node_modules`, so Node's upward
 * walk never finds packages-dir modules from sigrun's imports — the
 * packages dir must be consulted explicitly, via its own root manifest as
 * the resolution anchor. A bare name that resolves in BOTH places loads
 * from the packages dir (the deployment's declared version wins over
 * whatever the image happened to bundle).
 *
 * Returns `undefined` when nothing resolves — the loader quarantines with
 * its standard not-found message.
 */
export function resolveExtensionEntry(
	specifier: string,
	packagesDir: string,
): string | undefined {
	// Bare ./ ../ / relative paths are load-in-place (never packages-dir
	// entries; the pre-packages behavior). NOTE: `file:` is NOT here —
	// a `file:` LOAD specifier may name a package the packages dir
	// installed under its own manifest name (via a file: INSTALL
	// specifier — the npm symlinked checkout); resolve through the
	// manifest first, then fall through to bare resolution.
	if (
		(specifier.startsWith("./") || specifier.startsWith("../")) &&
		!specifier.startsWith("file:")
	) {
		return specifier;
	}
	if (specifier.startsWith("/") || specifier.startsWith("file://")) {
		return specifier;
	}
	// A file:-installed package LOADS under its own manifest name, which
	// resolves from the packages dir to the real (symlinked) source —
	// exactly pi's "symlink a dev checkout" shape. For a file:-SHAPE load
	// specifier, the manifest name is looked up BY PATH identity (npm
	// records the dep under the target's own manifest name, not the
	// specifier): find the dependency entry whose canonical path matches
	// this specifier's.
	const manifest = packagesManifestPath(packagesDir);
	if (existsSync(manifest)) {
		if (specifier.startsWith("file:") || specifier.startsWith("/")) {
			const id = identifySpecifier(specifier);
			const name = readPackageName(id.pathShaped ? id.range : specifier) ?? id.name;
			const pkgDir = join(packagesDir, "node_modules", ...name.split("/"));
				if (existsSync(pkgDir)) return packageEntry(pkgDir, name);
		} else {
			try {
				return importableEntry(createRequire(manifest).resolve(specifier));
			} catch {
				// Not installed in the packages dir — fall through to bare
				// resolution.
			}
		}
	}
	try {
		return importableEntry(createRequire(import.meta.url).resolve(specifier));
	} catch {
		return undefined;
	}
}

/**
 * Import-shape the resolved entry: `import()` must receive a `file://`
 * URL (Windows absolutes are not import specifiers; POSIX absolutes are
 * tolerated, but the URL is the portable form).
 */
function importableEntry(absolutePath: string): string {
	return pathToFileURL(absolutePath).href;
}

/**
 * Resolve a packages-dir package's ENTRY FILE — the thing `import()` can
 * actually load. A bare package DIRECTORY url is not importable in ESM
 * (`ERR_UNSUPPORTED_DIR_IMPORT`), so the loader needs the file.
 * Self-resolution through the package's own manifest (anchored at its
 * root — `exports` map or `main`) is the npm-blessed computation;
 * conventional fallbacks (`index.js`, `dist/index.js`, `index.ts`) cover
 * manifest-less shapes, and a package with none of those resolves to its
 * dir so the loader's import fails LOUD (quarantined with the path)
 * instead of silently resolving something adjacent.
 */
function packageEntry(pkgDir: string, name: string): string {
	try {
		return importableEntry(
			createRequire(join(pkgDir, "package.json")).resolve(name),
		);
	} catch {
		// No self-resolvable entry (no exports, no main) — probe the
		// manifest and conventions in priority order.
	}
	// W5 Task 4: the manifest entry (sigrun.extension, else the first
	// non-`.ts` pi entry — {@link manifestEntry} warns each `.ts` skip).
	const manifest = manifestEntry(pkgDir);
	if (manifest !== undefined) return importableEntry(manifest);
	for (const entry of ["index.js", "dist/index.js", "index.ts"]) {
		if (existsSync(join(pkgDir, entry))) {
			return importableEntry(join(pkgDir, entry));
		}
	}
	// The package DIR is today's loud fallback: an unimportable entry the
	// loader quarantines naming the path (the sync's caller decides
	// skills-only when the package declared skill dirs).
	return importableEntry(pkgDir);
}

// ---------------------------------------------------------------------------
// Git sources — the non-npm half of the unified extensions list
// ---------------------------------------------------------------------------

/** A git-source sync failure (clone, fetch, ref, or entry discovery). */
export class GitSyncError extends Error {}

/**
 * Strip userinfo credentials from a URL surfaced in an error or log:
 * `https://user:token@host/path` renders as `https://<sanitized>@host/path`.
 * Never echoes secret material.
 */
export function sanitizeUrl(url: string): string {
	// Only strip userinfo that CONTAINS a colon (user:pass = credential).
	// A plain non-colon user (`ssh://git@host`, the git-remote convention)
	// is not secret material and stays visible.
	return url.replace(
		/^(https?|ssh):\/\/[^/@]*:[^/@]+@/,
		(_match, scheme: string) => `${scheme}://<sanitized>@`,
	);
}

/**
 * The git checkout dir under the config dir: `<configDir>/git` (pi's
 * package-manager layout — host/path segments, one dir per repo).
 */
export function gitDirOf(configDir: string): string {
	return join(configDir, "git");
}

/**
 * The clone target for one git source: `<gitDir>/<host>/<path>…`.
 * Rejects any resulting path that escapes `gitDir` (the traversal guard).
 */
export function gitTargetDir(gitDir: string, source: string): string {
	// Two dir shapes: absolute sources (file:/ https:// with real slashes)
	// map to <gitDir>/<domain-ish prefix>/<hash of path> — flat, safe,
	// and never encodes a filesystem path inside gitDir (a local
	// file:///tmp/repo must not nest tmp dirs that could escape).
	const stripped = source
		.replace(/^(git:|https?:|ssh:)/, "")
		.replace(/\.git$/, "")
		.split("@")[0];
	const segments = stripped.split("/").filter((s) => s !== "");
	// Local absolute paths / URLs with a real scheme: flatten to a single
	// segment keyed by a stable digest (traversal-safe by construction).
	if (source.startsWith("file:") || source.startsWith("https:/") || source.startsWith("ssh:")) {
		segments.splice(1);
	}
	// Hash every segment beyond the first two (host/leaf only in pi's
	// layout) when the source is a full URL/abs path.
	const leaf = segments.at(-1) ?? "";
	const digest = createHash("sha256").update(stripped).digest("hex").slice(0, 12);
	const safeSegments = [leaf || digest].map((s) => s.replace(/[^A-Za-z0-9._-]/g, "-"));
	const target = join(gitDir, ...safeSegments);
	if (!target.startsWith(gitDir)) {
		throw new GitSyncError(
			`git source ${sanitizeUrl(source)} resolves outside the git dir`,
		);
	}
	return target;
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
	return new Promise((resolveResult, rejectResult) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: NPM_TIMEOUT_MS, encoding: "utf8" },
			(error, stdout) =>
				error === null
					? resolveResult(stdout)
					: rejectResult(
							new GitSyncError(
								`git ${args[0]} failed: ${sanitizeUrl(String(stderrTail(error)))}`,
							),
						),
		);
	});
}

/** The last stderr line of a child failure (concise context, no spam). */
function stderrTail(error: Error & { stderr?: unknown }): string {
	const raw = typeof error.stderr === "string" ? error.stderr : error.message;
	const lines = raw.trim().split("\n").filter((l) => l !== "");
	return lines.at(-1) ?? error.message;
}

/**
 * Clone-or-reconcile one git source into `gitDir`. Absent → clone.
 * Present + `ref` → fetch + checkout FETCH_HEAD (pi's ensureGitRef
 * pattern). Present + no ref → plain fetch only (the checkout stays
 * where the user left it — no silent rebases).
 */
export async function syncGit(
	source: string,
	ref: string | undefined,
	gitDir: string,
	options: { log?: boolean } = {},
): Promise<string> {
	const log = options.log !== false;
	mkdirSync(gitDir, { recursive: true });
	const target = gitTargetDir(gitDir, source);
	const { source: fetchUrl } = splitGitRef(source, ref);
	// A `git:` source is a LOCAL-first shorthand: `git:file://…` clones a
	// local path (hermetic tests); any other host part stays as written
	// (git itself resolves https/ssh schemes). The scheme is what pi uses;
	// the shim only strips the `git:` marker itself.
	const url = fetchUrl.startsWith("git:") ? fetchUrl.slice(4) : fetchUrl;
	if (!existsSync(target)) {
		if (log) console.log(`git: cloning ${sanitizeUrl(url)} → ${target}`);
		await runGit(["clone", url, target], gitDir);
	} else if (ref !== undefined) {
		if (log) console.log(`git: fetching ${sanitizeUrl(url)} @ ${ref}`);
		await runGit(["fetch", "origin", ref], target);
		await runGit(["checkout", "FETCH_HEAD"], target);
	} else {
		if (log) console.log(`git: fetching ${sanitizeUrl(url)} (no ref change)`);
		await runGit(["fetch", "origin"], target);
	}
	return target;
}

/**
 * The pi-compat `.ts` skip warning (spec §9.4): a `pi.extensions` entry
 * ending in `.ts` cannot load under plain node (the build spec removed
 * the `.ts` entry fallback) — it is skipped, keeping the package's
 * skills loadable. ONE line per skipped entry, per discovery.
 */
function warnTsPiExtension(entry: string): void {
	console.warn(
		`pi-compat: skipping TypeScript pi extension ${entry} (not loadable under node); loading the package's skills only`,
	);
}

/** The manifest fields the entry/skill discovery reads. */
interface DiscoveryManifest {
	readonly sigrun?: { readonly extension?: unknown; readonly skills?: unknown };
	readonly pi?: { readonly extensions?: unknown; readonly skills?: unknown };
}

/** Read one package root's manifest (absent/unreadable → undefined). */
function readDiscoveryManifest(pkgRoot: string): DiscoveryManifest | undefined {
	const manifestPath = join(pkgRoot, "package.json");
	if (!existsSync(manifestPath)) return undefined;
	try {
		return JSON.parse(readFileSync(manifestPath, "utf8")) as DiscoveryManifest;
	} catch {
		return undefined;
	}
}

/** A string-array manifest field (skills lists), else undefined. */
function manifestStringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.every((entry) => typeof entry === "string")
		? (value as readonly string[])
		: undefined;
}

/**
 * A package root's manifest skill dirs (spec §9.4): `sigrun.skills`
 * (string[]) else pi-compat `pi.skills` (string[] — same SKILL.md format,
 * so no warning), each resolved against the package root, keeping only
 * EXISTING directories. No manifest, no field, or nothing existing → [].
 */
export function manifestSkills(pkgRoot: string): readonly string[] {
	const manifest = readDiscoveryManifest(pkgRoot);
	if (manifest === undefined) return [];
	const declared =
		manifestStringArray(manifest.sigrun?.skills) ??
		manifestStringArray(manifest.pi?.skills);
	if (declared === undefined) return [];
	const dirs: string[] = [];
	for (const dir of declared) {
		const resolved = resolve(pkgRoot, dir);
		if (statIsDirectory(resolved)) dirs.push(resolved);
	}
	return dirs;
}

/** Whether `path` is an existing directory (never throws). */
function statIsDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * A package root's manifest ENTRY (the discovery both git checkouts and
 * packages-dir packages run, W5 Task 4): the `sigrun.extension` manifest
 * value VERBATIM (an entry that does not resolve keeps today's loud
 * load-time failure — never a silent skills-only downgrade), else the
 * FIRST `pi.extensions` entry that does not end in `.ts` (each `.ts` skip
 * warns once; a `.ts`-only list discovers no entry — the package loads
 * its skills only). `undefined` when the manifest declares no usable
 * entry.
 */
export function manifestEntry(pkgRoot: string): string | undefined {
	const manifest = readDiscoveryManifest(pkgRoot);
	if (manifest === undefined) return undefined;
	const sigrunEntry = manifest.sigrun?.extension;
	if (typeof sigrunEntry === "string" && sigrunEntry !== "") {
		return join(pkgRoot, sigrunEntry);
	}
	const piEntries = manifestStringArray(manifest.pi?.extensions);
	if (piEntries !== undefined) {
		for (const entry of piEntries) {
			if (/\.ts$/.test(entry)) {
				warnTsPiExtension(join(pkgRoot, entry));
				continue;
			}
			return join(pkgRoot, entry);
		}
		console.warn(
			`pi-compat: no loadable pi extension in ${pkgRoot} (all entries are TypeScript); loading the package's skills only`,
		);
	}
	return undefined;
}

/**
 * The package ROOT a resolution's manifest skills read from, for
 * npm/file-shaped sources: the packages-dir install (`node_modules/<name>`
 * under the packages dir — npm keys path-shaped installs by the target
 * package's own manifest name), else the path target itself when it is a
 * package dir. `undefined` when neither carries a manifest (a bare
 * app-tree resolution — no root to read skills from; such a package
 * contributes skills through its factory result instead).
 */
function manifestRootOf(
	specifier: string,
	packagesDir: string,
): string | undefined {
	const id = identifySpecifier(specifier);
	const name = id.pathShaped ? (readPackageName(id.range) ?? id.name) : id.name;
	const installed = join(packagesDir, "node_modules", ...name.split("/"));
	if (existsSync(join(installed, "package.json"))) return installed;
	if (id.pathShaped && existsSync(join(id.range, "package.json"))) return id.range;
	return undefined;
}

/**
 * Entry discovery for a synced git checkout, in priority order: the
 * object form's explicit `entry` (must exist — a declared entry that
 * does not resolve is today's loud failure), the manifest entry
 * (`sigrun.extension` verbatim, else the first non-`.ts` pi entry — see
 * {@link manifestEntry}), or `dist/index.js`. Returns `undefined` when
 * nothing is discoverable: the CALLER then decides skills-only (declared
 * skills) vs today's loud throw. No `.ts` fallback (build-and-webui Task
 * 3, BREAKING): the built server runs plain node, which cannot load a
 * `.ts` entry — npm/git/path sources must ship a built entry.
 */
export function findExtEntry(
	repoDir: string,
	explicitEntry: string | undefined,
): string | undefined {
	if (explicitEntry !== undefined) {
		const entry = join(repoDir, explicitEntry);
		if (!existsSync(entry)) {
			throw new GitSyncError(
				`git source entry ${explicitEntry} does not exist in the checkout`,
			);
		}
		return entry;
	}
	const manifest = manifestEntry(repoDir);
	if (manifest !== undefined) return manifest;
	const dist = join(repoDir, "dist", "index.js");
	if (existsSync(dist)) return dist;
	return undefined;
}
