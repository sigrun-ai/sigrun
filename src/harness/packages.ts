/**
 * Boot-time extension package install (the pi-style packages dir).
 *
 * Sigrun deployments declare extension PACKAGES in the settings file's
 * top-level `packages` array (npm package specifiers) and restart — no
 * image rebuild, no manual npm. The packages live in a dedicated section
 * of the config directory (`<config-dir>/packages/`, a sibling of
 * `settings.json` and `auth.json`), which is the PVC-backed path in every
 * deployment shape, so installed packages persist across restarts.
 *
 * The directory is a REAL npm root, exactly pi's shape (`~/.pi/agent/npm`):
 * a synthetic private root `package.json` (`{"name": "sigrun-packages",
 * "private": true, "dependencies": {…}}`) plus `node_modules/`. The root
 * manifest's `dependencies` map IS the resolved state (name → range); the
 * settings file's `packages` array is the user-authored INTENT. Boot diffs
 * the two:
 *
 * - a wanted specifier whose package is missing from (or whose range
 *   differs in) the dependencies map → `npm install <changed specifiers>
 *   --prefix <packagesDir>`;
 * - a dependencies entry named by NO wanted specifier → `npm uninstall
 *   <name> --prefix <packagesDir>` (a removed declaration prunes);
 * - no diff → no subprocess at all (the fast path; a steady-state boot
 *   costs one file read).
 *
 * `packages` is FILE-ONLY — installing is not an env-shaped act, so there
 * is no `SIGRUN_PACKAGES` (the `SIGRUN_EXTENSIONS` env var still wins the
 * separate LOAD list; `packages` vs `extensions` is the install/load
 * distinction documented in the README: a package may be
 * installed-but-not-loaded, and the load list may name a package installed
 * some other way — a dev checkout, an image-bundled one). The settings
 * bootstrap never writes `packages` (it records resolved boot reality;
 * `packages` intent has no resolution to record — the package dir's own
 * manifest is the record).
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

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The npm install/uninstall timeout (ms) — one subprocess invocation. */
export const NPM_TIMEOUT_MS = 120_000;

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
 * shell, so no quoting surface). Failures and timeouts reject with a
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
			[...args, "--prefix", packagesDir, "--no-audit", "--no-fund"],
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
 * The `name` of a path-shaped specifier's target package, when readable.
 * A directory's `package.json` reads directly; a `.tgz` tarball's
 * `package/package.json` reads by listing the archive (npm keys a tarball
 * install by the packed manifest's name too).
 */
function readPackageName(absPath: string): string | undefined {
	try {
		const pkg = JSON.parse(
			readFileSync(join(absPath, "package.json"), "utf8"),
		) as { name?: unknown };
		if (typeof pkg.name === "string" && pkg.name !== "") return pkg.name;
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
			const pkg = JSON.parse(out) as { name?: unknown };
			if (typeof pkg.name === "string" && pkg.name !== "") return pkg.name;
		} catch {
			// Unreadable tarball — the name is unknown; the install itself
			// will fail loud if the specifier is bad.
		}
	}
	return undefined;
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
}

/**
 * Reconcile the packages dir with the settings file's `packages` intent.
 *
 * @param packages the settings file's top-level `packages` array
 *   (already validated: non-empty strings).
 * @param packagesDir the packages dir (`packagesDirOf(configDir)`).
 * @throws PackageSyncError on any install/uninstall failure, timeout, or
 *   a declared specifier that does not resolve afterward.
 */
export async function syncPackages(
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
	// Paths and URLs are never packages-dir entries — they import
	// verbatim (the pre-packages loader behavior).
	if (
		specifier.startsWith("file:") ||
		specifier.startsWith("./") ||
		specifier.startsWith("../") ||
		specifier.startsWith("/")
	) {
		return specifier;
	}
	// A file:-installed package LOADS under its own manifest name, which
	// resolves from the packages dir to the real (symlinked) source —
	// exactly pi's "symlink a dev checkout" shape.
	const manifest = packagesManifestPath(packagesDir);
	if (existsSync(manifest)) {
		try {
			return importableEntry(createRequire(manifest).resolve(specifier));
		} catch {
			// Not installed in the packages dir — fall through to bare
			// resolution.
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
