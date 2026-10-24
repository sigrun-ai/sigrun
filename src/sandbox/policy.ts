/** Build the complete, deterministic Landlock policy for one directory user. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { agentEnv } from "../harness/agent-env.js";
import type { DirectoryUser } from "../harness/identity/users.js";
import type { ManagedPaths } from "./grants.js";
import { revalidate, validateGrantPath } from "./grants.js";

export interface UserPolicy {
	readonly user: string;
	readonly workspace: string;
	readonly home: string;
	readonly tmp: string;
	readonly ro: readonly string[];
	readonly rw: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly uid?: number;
	readonly gid?: number;
	readonly groups?: readonly number[];
}

type PolicyResult =
	| { ok: true; policy: UserPolicy }
	| { ok: false; reason: string };

function canonical(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

function sortedUnique(paths: readonly string[]): string[] {
	return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function sortedUniqueCanonical(paths: readonly string[]): string[] {
	return sortedUnique(
		paths.flatMap((path) => {
			const real = canonical(path);
			return real === undefined ? [] : [real];
		}),
	);
}

function inside(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function protectedRuntimePath(path: string, managed: ManagedPaths): boolean {
	const protectedPaths = [
		...Object.values(managed.roots),
		managed.storagePath,
		managed.coreRoot,
	];
	return protectedPaths.some((protectedPath) => {
		const real = canonical(protectedPath) ?? resolve(protectedPath);
		return inside(path, real) || inside(real, path);
	});
}

function filteredRuntimePaths(
	paths: readonly string[],
	managed: ManagedPaths | undefined,
): string[] {
	return paths.filter(
		(path) =>
			!inside("/dev/shm", path) &&
			(managed === undefined || !protectedRuntimePath(path, managed)),
	);
}

/**
 * The node binary directory plus every existing shared-library directory
 * reported by a trusted absolute ldd (/usr/bin/ldd, then /bin/ldd). Static
 * builds and loader failures fall back to the binary directory alone. Only
 * absolute ldd targets are read; virtual entries have no such target. All
 * candidates are realpath-canonicalized before deduplication and sorting.
 * The raw cache is keyed by execPath; protected-root filtering is per call,
 * so one managed layout can never reuse another layout's filtered result.
 */
export function nodeRuntimePaths(
	execPath: string = process.execPath,
	managed?: ManagedPaths,
): string[] {
	const binaryDirectory = canonical(dirname(resolve(execPath)));
	const cached = runtimePaths.get(execPath);
	if (cached !== undefined) {
		return filteredRuntimePaths(cached, managed);
	}

	const paths = binaryDirectory === undefined ? [] : [binaryDirectory];
	const loader = ["/usr/bin/ldd", "/bin/ldd"].find((path) => existsSync(path));
	if (loader !== undefined) {
		try {
			const output = execFileSync(loader, [execPath], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			for (const match of output.matchAll(/=>\s+(\/[^\s]+)/g)) {
				const target = match[1];
				if (target !== undefined && isAbsolute(target)) {
					paths.push(dirname(target));
				}
			}
		} catch {
			// A static executable, a missing executable, or ldd failure adds nothing.
		}
	}
	const result = sortedUniqueCanonical(paths);
	runtimePaths.set(execPath, result);
	return filteredRuntimePaths(result, managed);
}

const runtimePaths = new Map<string, string[]>();

/** Only the core module trees, never the core installation root itself. */
export function defaultModuleTrees(coreRoot: string): string[] {
	const code = existsSync(join(coreRoot, "dist"))
		? join(coreRoot, "dist")
		: join(coreRoot, "src");
	return [code, join(coreRoot, "shared"), join(coreRoot, "node_modules")];
}

function validateUserPath(
	path: string,
	record: DirectoryUser,
	managed: ManagedPaths,
): ReturnType<typeof validateGrantPath> {
	const candidate = canonical(path) ?? resolve(path);
	if (inside(candidate, "/dev/shm") || inside("/dev/shm", candidate)) {
		return { ok: false, reason: "path is or contains /dev/shm" };
	}
	return validateGrantPath(path, { managed, user: record.user });
}

function failedStoredPath(
	record: DirectoryUser,
	managed: ManagedPaths,
): string | undefined {
	const paths = [
		record.workspace,
		...(record.grants ?? []).map((grant) => grant.path),
	];
	return paths.find(
		(path) =>
			path !== undefined &&
			!validateUserPath(path, record, managed).ok,
	);
}

function invalidReason(path: string, reason: string): PolicyResult {
	return { ok: false, reason: `${path}: ${reason}` };
}

/** Build a user's grants and environment, or fail closed with the bad path. */
export function buildUserPolicy(
	record: DirectoryUser,
	ctx: {
		managed: ManagedPaths;
		/** Retained for the M1 caller contract; runtime discovery supersedes it. */
		nodeBinDir: string;
		moduleTrees: readonly string[];
		osAccount?: { uid: number; gid: number; groups: number[]; home: string };
	},
): PolicyResult {
	const validation = revalidate(record, ctx.managed);
	if (!validation.ok) {
		const path = failedStoredPath(record, ctx.managed);
		return {
			ok: false,
			reason: `${path ?? "stored workspace or grant"}: ${validation.reason}`,
		};
	}

	// EVERY per-user path passes the same validator before entering policy:
	// stored workspace/grants via revalidate, and workspace/home again below.
	// An osAccount home must validate BEFORE any directory is created.
	// tmp is the ONE sanctioned stateDir exception: it is derived only from
	// stateDir/sandbox/<user>/tmp and never silently routed around validation.
	const userArea = ctx.managed.userAreas(record.user);
	const requestedWorkspace = record.workspace ?? join(userArea, "workspace");
	const requestedHome = ctx.osAccount?.home ?? join(userArea, "home");
	if (ctx.osAccount !== undefined) {
		const validation = validateUserPath(requestedHome, record, ctx.managed);
		if (!validation.ok) return invalidReason(requestedHome, validation.reason);
	}
	const tmp = join(ctx.managed.roots.stateDir, "sandbox", record.user, "tmp");
	for (const path of [requestedWorkspace, requestedHome, tmp]) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	}
	const workspaceValidation = validateUserPath(requestedWorkspace, record, ctx.managed);
	if (!workspaceValidation.ok) {
		return invalidReason(requestedWorkspace, workspaceValidation.reason);
	}
	const homeValidation = validateUserPath(requestedHome, record, ctx.managed);
	if (!homeValidation.ok) return invalidReason(requestedHome, homeValidation.reason);
	const realTmp = canonical(tmp);
	if (realTmp === undefined) return invalidReason(tmp, "path cannot be resolved");
	const realWorkspace = workspaceValidation.realpath;
	const realHome = homeValidation.realpath;

	const grants = [];
	for (const grant of record.grants ?? []) {
		const result = validateUserPath(grant.path, record, ctx.managed);
		if (!result.ok) return invalidReason(grant.path, result.reason);
		grants.push({ ...grant, path: result.realpath });
	}
	const rw = sortedUnique([
		realWorkspace,
		...grants.flatMap((grant) => (grant.access === "rw" ? [grant.path] : [])),
		realHome,
		realTmp,
		"/dev/null",
		"/dev/zero",
		"/dev/full",
		"/dev/random",
		"/dev/urandom",
		"/dev/tty",
		"/dev/pts",
	]);
	const ro = sortedUnique([
		"/usr",
		"/bin",
		"/sbin",
		"/lib",
		"/lib32",
		"/lib64",
		"/etc",
		"/opt",
		"/proc",
		"/sys",
		...nodeRuntimePaths(process.execPath, ctx.managed),
		...ctx.moduleTrees,
		...grants.flatMap((grant) => (grant.access === "ro" ? [grant.path] : [])),
	]);
	const env = agentEnv();
	delete env.SSH_AUTH_SOCK;
	env.HOME = realHome;
	env.TMPDIR = realTmp;
	env.USER = record.user;

	const policy: UserPolicy = {
		user: record.user,
		workspace: realWorkspace,
		home: realHome,
		tmp: realTmp,
		ro,
		rw,
		env,
	};
	if (ctx.osAccount !== undefined) {
		return {
			ok: true,
			policy: {
				...policy,
				uid: ctx.osAccount.uid,
				gid: ctx.osAccount.gid,
				groups: ctx.osAccount.groups,
			},
		};
	}
	return { ok: true, policy };
}
