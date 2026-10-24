/** Build the complete, deterministic Landlock policy for one directory user. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

const runtimePaths = new Map<string, string[]>();

function sortedUnique(paths: readonly string[]): string[] {
	return [...new Set(paths)].sort();
}

/**
 * The node binary directory plus every existing shared-library directory
 * reported by ldd. Static builds and ldd failures fall back to the binary
 * directory alone. Only absolute ldd targets are read; virtual entries
 * (linux-vdso and (0x...) addresses) have no such target. Results are
 * cached per executable so repeated policy builds do not re-run ldd.
 */
export function nodeRuntimePaths(execPath: string = process.execPath): string[] {
	const cached = runtimePaths.get(execPath);
	if (cached !== undefined) return cached;

	const paths = [dirname(resolve(execPath))];
	try {
		const output = execFileSync("ldd", [execPath], {
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
		// A static executable, a missing executable, or no ldd needs no libraries.
	}
	const result = sortedUnique(paths.filter((path) => existsSync(path)));
	runtimePaths.set(execPath, result);
	return result;
}

/** Only the core module trees, never the core installation root itself. */
export function defaultModuleTrees(coreRoot: string): string[] {
	const code = existsSync(join(coreRoot, "dist"))
		? join(coreRoot, "dist")
		: join(coreRoot, "src");
	return [code, join(coreRoot, "shared"), join(coreRoot, "node_modules")];
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
			!validateGrantPath(path, { managed, user: record.user }).ok,
	);
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
): { ok: true; policy: UserPolicy } | { ok: false; reason: string } {
	const validation = revalidate(record, ctx.managed);
	if (!validation.ok) {
		const path = failedStoredPath(record, ctx.managed);
		return {
			ok: false,
			reason: `${path ?? "stored workspace or grant"}: ${validation.reason}`,
		};
	}

	const userArea = ctx.managed.userAreas(record.user);
	const workspace = record.workspace ?? join(userArea, "workspace");
	const home = ctx.osAccount?.home ?? join(userArea, "home");
	const tmp = join(ctx.managed.roots.stateDir, "sandbox", record.user, "tmp");
	for (const path of [workspace, home, tmp]) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	}

	const grants = record.grants ?? [];
	const rw = sortedUnique([
		workspace,
		...grants.flatMap((grant) => (grant.access === "rw" ? [grant.path] : [])),
		home,
		tmp,
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
		...nodeRuntimePaths(),
		...ctx.moduleTrees,
		...grants.flatMap((grant) => (grant.access === "ro" ? [grant.path] : [])),
	]);
	const env = agentEnv();
	delete env.SSH_AUTH_SOCK;
	env.HOME = home;
	env.TMPDIR = tmp;
	env.USER = record.user;

	const policy: UserPolicy = {
		user: record.user,
		workspace,
		home,
		tmp,
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
