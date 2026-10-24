/**
 * Per-user workspace/grant path validation (multi-user M1 §9.5).
 *
 * Every path is made absolute by the caller, resolved with realpath, and
 * only THEN compared in either direction: Landlock follows the resolved
 * hierarchy, so checking the spelling before realpath would let a symlink
 * into a store root through. Missing/unresolvable paths fail closed.
 *
 * CORE-OWNED VS FOREIGN EXTENSION DIRS: the reserved-slug list also names
 * core data dirs (`workspace`, `models`, `users`, …), but those names are
 * NOT extension directories for this validator. `<dataDir>/<name>` counts
 * as an extension directory only when `name` is not RESERVED_EXTENSION_SLUGS
 * and the directory exists. Core dirs have their own explicit rules:
 * `<dataDir>/users` is protected by the ancestor/equality check, and
 * `<dataDir>/users/<other>` by the other-user-area check. In particular,
 * `<dataDir>/workspace` and `<dataDir>/users/<user>/workspace` are valid.
 * Do not "fix" this by treating every data child as an extension dir.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { DirectoryUser } from "../harness/identity/users.js";
import { RESERVED_EXTENSION_SLUGS } from "../harness/reserved-sections.js";
import type { StoreRoots } from "../harness/stores.js";

/** One externally located directory the user's worker may access. */
export type Grant = {
	readonly path: string;
	readonly access: "ro" | "rw";
};

/** The protected paths needed to validate one user's policy inputs. */
export interface ManagedPaths {
	readonly roots: StoreRoots;
	readonly storagePath: string;
	readonly coreRoot: string;
	/** The owning user's area: `<dataDir>/users/<user>`. */
	userAreas(user: string): string;
}

/** A successful validation, with the value that must be persisted. */
export type ValidGrantPath = { readonly ok: true; readonly realpath: string };
/** A refused path, with the specific rule that fired. */
export type InvalidGrantPath = { readonly ok: false; readonly reason: string };

const RESERVED_SLUG_SET: ReadonlySet<string> = new Set(RESERVED_EXTENSION_SLUGS);

/** `child === parent` or `child` is below `parent` (path-segment aware). */
function inside(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function directoryExists(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Existing direct data children not claimed by a reserved core slug. */
function extensionDirectories(dataDir: string): string[] {
	try {
		return readdirSync(dataDir, { withFileTypes: true })
			.filter(
				(entry) =>
					(entry.isDirectory() || entry.isSymbolicLink()) &&
					!RESERVED_SLUG_SET.has(entry.name) &&
					directoryExists(join(dataDir, entry.name)),
			)
			.map((entry) => canonical(join(dataDir, entry.name)));
	} catch {
		return [];
	}
}

function rejectContaining(candidate: string, path: string, label: string): InvalidGrantPath | undefined {
	if (inside(path, candidate)) {
		return { ok: false, reason: `path is or contains ${label}` };
	}
	return undefined;
}

function rejectInside(candidate: string, path: string, label: string): InvalidGrantPath | undefined {
	if (inside(candidate, path)) {
		return { ok: false, reason: `path is inside ${label}` };
	}
	return undefined;
}

/**
 * Validate one workspace or grant. The returned realpath is the only value
 * callers may store or use to construct a policy.
 */
export function validateGrantPath(
	path: string,
	ctx: { readonly managed: ManagedPaths; readonly user: string },
): ValidGrantPath | InvalidGrantPath {
	if (!isAbsolute(path)) return { ok: false, reason: "path must be absolute" };
	let candidate: string;
	try {
		candidate = realpathSync(path);
	} catch {
		return { ok: false, reason: "path does not exist or cannot be resolved" };
	}

	const { managed, user } = ctx;
	const { roots } = managed;
	const rootLabels = [
		[roots.configDir, "configDir"],
		[roots.dataDir, "dataDir"],
		[roots.cacheDir, "cacheDir"],
		[roots.stateDir, "stateDir"],
		[managed.storagePath, "storagePath"],
		[join(roots.dataDir, "users"), "dataDir/users"],
		[managed.coreRoot, "coreRoot"],
	] as const;
	for (const [protectedPath, label] of rootLabels) {
		const rejected = rejectContaining(candidate, canonical(protectedPath), label);
		if (rejected !== undefined) return rejected;
	}

	const extensions = extensionDirectories(roots.dataDir);
	for (const extension of extensions) {
		const rejected = rejectContaining(candidate, extension, `extension directory ${extension}`);
		if (rejected !== undefined) return rejected;
	}

	for (const [protectedPath, label] of [
		[roots.configDir, "configDir"],
		[roots.stateDir, "stateDir"],
		[roots.cacheDir, "cacheDir"],
		[managed.storagePath, "storagePath"],
		[managed.coreRoot, "coreRoot"],
	] as const) {
		const rejected = rejectInside(candidate, canonical(protectedPath), label);
		if (rejected !== undefined) return rejected;
	}
	for (const extension of extensions) {
		const rejected = rejectInside(candidate, extension, `extension directory ${extension}`);
		if (rejected !== undefined) return rejected;
	}

	const usersRoot = canonical(join(roots.dataDir, "users"));
	if (inside(candidate, usersRoot)) {
		const ownArea = canonical(managed.userAreas(user));
		// Do not classify the user's own name as a child named `alice` when
		// the area does not exist yet: identity is the path segment, not the
		// existence of the directory.
		const candidateOwnArea = join(usersRoot, user);
		if (!inside(candidate, ownArea) && !inside(candidate, candidateOwnArea)) {
			return { ok: false, reason: "path is inside another user's area" };
		}
	}
	return { ok: true, realpath: candidate };
}

/** Re-run the current validation over every stored path for this user. */
export function revalidate(
	record: DirectoryUser,
	managed: ManagedPaths,
): { readonly ok: true } | InvalidGrantPath {
	const paths = [record.workspace, ...(record.grants ?? []).map((grant) => grant.path)];
	for (const path of paths) {
		if (path === undefined) continue;
		const result = validateGrantPath(path, { managed, user: record.user });
		if (!result.ok) return result;
	}
	return { ok: true };
}
