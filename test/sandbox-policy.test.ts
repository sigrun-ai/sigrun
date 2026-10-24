/** Multi-user M1 Task 4: the exact per-user Landlock grant and env policy. */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { DirectoryUser } from "../src/harness/identity/users.js";
import type { ManagedPaths } from "../src/sandbox/grants.js";
import {
	buildUserPolicy,
	defaultModuleTrees,
	nodeRuntimePaths,
} from "../src/sandbox/policy.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-sandbox-policy-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function record(user = "alice"): DirectoryUser {
	return { user, admin: false, createdAt: 1, source: "cli" };
}

async function fixture(): Promise<{
	managed: ManagedPaths;
	moduleTrees: string[];
	coreRoot: string;
}> {
	const dir = await tempDir();
	const coreRoot = join(dir, "core");
	const managed: ManagedPaths = {
		roots: {
			configDir: join(dir, "config"),
			dataDir: join(dir, "data"),
			cacheDir: join(dir, "cache"),
			stateDir: join(dir, "state"),
		},
		storagePath: join(dir, "data", "sigrun.db"),
		coreRoot,
		userAreas: (user) => join(dir, "data", "users", user),
	};
	await Promise.all(
		[...Object.values(managed.roots), coreRoot].map((path) =>
			mkdir(path, { recursive: true }),
		),
	);
	const moduleTrees = defaultModuleTrees(coreRoot);
	await Promise.all(moduleTrees.map((path) => mkdir(path, { recursive: true })));
	return { managed, moduleTrees, coreRoot };
}

function policyFor(user: DirectoryUser, init: {
	managed: ManagedPaths;
	moduleTrees: readonly string[];
	osAccount?: { uid: number; gid: number; groups: number[]; home: string };
}) {
	return buildUserPolicy(user, {
		managed: init.managed,
		nodeBinDir: "/ignored/by/runtime/discovery",
		moduleTrees: init.moduleTrees,
		osAccount: init.osAccount,
	});
}

describe("buildUserPolicy", () => {
	test("a plain user gets exactly the specified rw and ro paths, stable-sorted", async () => {
		const { managed, moduleTrees, coreRoot } = await fixture();
		const result = policyFor(record(), { managed, moduleTrees });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const workspace = managed.userAreas("alice") + "/workspace";
		const home = managed.userAreas("alice") + "/home";
		const tmp = join(managed.roots.stateDir, "sandbox", "alice", "tmp");
		expect(result.policy.user).toBe("alice");
		expect(result.policy.workspace).toBe(workspace);
		expect(result.policy.home).toBe(home);
		expect(result.policy.tmp).toBe(tmp);
		expect([...result.policy.rw].sort()).toEqual(
			[
				workspace,
				home,
				tmp,
				"/dev/null",
				"/dev/zero",
				"/dev/full",
				"/dev/random",
				"/dev/urandom",
				"/dev/tty",
				"/dev/pts",
			].sort(),
		);
		expect(result.policy.rw).toEqual([...result.policy.rw].sort());
		expect([...result.policy.ro].sort()).toEqual(
			[
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
				...moduleTrees,
			].filter((path, index, paths) => paths.indexOf(path) === index).sort(),
		);
		expect(result.policy.ro).toEqual([...result.policy.ro].sort());
		for (const forbidden of [
			"/dev/shm",
			coreRoot,
			managed.roots.configDir,
			managed.roots.dataDir,
			managed.roots.cacheDir,
			managed.roots.stateDir,
			managed.storagePath,
		]) {
			expect(result.policy.rw).not.toContain(forbidden);
			expect(result.policy.ro).not.toContain(forbidden);
		}
		expect(result.policy.uid).toBeUndefined();
		expect(result.policy.gid).toBeUndefined();
		expect(result.policy.groups).toBeUndefined();
	});

	test("creates workspace, home, and tmp as 0700, without creating grant paths", async () => {
		const { managed, moduleTrees } = await fixture();
		const result = policyFor(record(), { managed, moduleTrees });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		for (const path of [result.policy.workspace, result.policy.home, result.policy.tmp]) {
			expect((await stat(path)).mode & 0o777).toBe(0o700);
		}
		const missingGrant = join(await tempDir(), "never-create-this-grant");
		const missing = policyFor(
			{ ...record(), grants: [{ path: missingGrant, access: "rw" }] },
			{ managed, moduleTrees },
		);
		expect(missing.ok).toBe(false);
		expect(existsSync(missingGrant)).toBe(false);
	});

	test("uses a stored workspace and partitions grants by access", async () => {
		const { managed, moduleTrees } = await fixture();
		const dir = await tempDir();
		const workspace = join(dir, "stored-workspace");
		const rwGrant = join(dir, "rw-grant");
		const roGrant = join(dir, "ro-grant");
		await Promise.all([workspace, rwGrant, roGrant].map((path) => mkdir(path)));
		const result = policyFor(
			{
				...record(),
				workspace,
				grants: [
					{ path: rwGrant, access: "rw" },
					{ path: roGrant, access: "ro" },
				],
			},
			{ managed, moduleTrees },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.policy.workspace).toBe(await realpath(workspace));
		expect(result.policy.rw).toContain(rwGrant);
		expect(result.policy.rw).not.toContain(roGrant);
		expect(result.policy.ro).toContain(roGrant);
		expect(result.policy.ro).not.toContain(rwGrant);
	});

	test("an inherited foreign user-area grant is accepted into the recipient's rw policy", async () => {
		const { managed, moduleTrees } = await fixture();
		const inherited = join(managed.userAreas("alice"), "workspace");
		await mkdir(inherited, { recursive: true });
		const result = policyFor(
			{
				...record("bob"),
				grants: [{ path: inherited, access: "rw", inheritedFrom: "alice" }],
			},
			{ managed, moduleTrees },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.policy.rw).toContain(await realpath(inherited));
	});

	test("an osAccount changes home and carries uid, gid, and groups", async () => {
		const { managed, moduleTrees } = await fixture();
		const osHome = join(await tempDir(), "os-home");
		await mkdir(osHome);
		const result = policyFor(record("bob"), {
			managed,
			moduleTrees,
			osAccount: { uid: 1001, gid: 1002, groups: [1002, 2000], home: osHome },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.policy.home).toBe(osHome);
		expect(result.policy.rw).toContain(osHome);
		expect(result.policy.rw).not.toContain(managed.userAreas("bob") + "/home");
		expect(result.policy.uid).toBe(1001);
		expect(result.policy.gid).toBe(1002);
		expect(result.policy.groups).toEqual([1002, 2000]);
	});

	test.each([
		["core root", (managed: ManagedPaths) => managed.coreRoot],
		["store root", (managed: ManagedPaths) => managed.roots.configDir],
		["storage path", (managed: ManagedPaths) => managed.storagePath],
	])("an osAccount home at the %s is refused without creating a policy", async (_label, homeFor) => {
		const { managed, moduleTrees } = await fixture();
		const home = homeFor(managed);
		const result = policyFor(record("bob"), {
			managed,
			moduleTrees,
			osAccount: { uid: 1001, gid: 1002, groups: [1002], home },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain(home);
		expect("policy" in result).toBe(false);
	});

	test.skipIf(process.platform !== "linux")("an osAccount home at /dev/shm is refused without creating a policy", async () => {
		const { managed, moduleTrees } = await fixture();
		const result = policyFor(record("bob"), {
			managed,
			moduleTrees,
			osAccount: { uid: 1001, gid: 1002, groups: [1002], home: "/dev/shm" },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("/dev/shm");
		expect("policy" in result).toBe(false);
	});

	test.skipIf(process.platform !== "linux")("a stored /dev/shm grant is refused rather than entering the policy", async () => {
		const { managed, moduleTrees } = await fixture();
		const result = policyFor(
			{ ...record(), grants: [{ path: "/dev/shm", access: "rw" }] },
			{ managed, moduleTrees },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("/dev/shm");
	});

	test("env removes SSH_AUTH_SOCK and overrides HOME, TMPDIR, and USER", async () => {
		const { managed, moduleTrees } = await fixture();
		const before = new Map(
			["SSH_AUTH_SOCK", "HOME", "TMPDIR", "USER", "SIGRUN_API_TOKEN", "LC_TEST"].map(
				(key) => [key, process.env[key]],
			),
		);
		try {
			process.env.SSH_AUTH_SOCK = "/service/account/agent.sock";
			process.env.HOME = "/service/home";
			process.env.TMPDIR = "/service/tmp";
			process.env.USER = "service";
			process.env.SIGRUN_API_TOKEN = "must-not-leak";
			process.env.LC_TEST = "C";
			const result = policyFor(record("carol"), { managed, moduleTrees });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.policy.env).not.toHaveProperty("SSH_AUTH_SOCK");
			expect(Object.hasOwn(result.policy.env, "SSH_AUTH_SOCK")).toBe(false);
			expect(result.policy.env).not.toHaveProperty("SIGRUN_API_TOKEN");
			expect(result.policy.env.HOME).toBe(result.policy.home);
			expect(result.policy.env.TMPDIR).toBe(result.policy.tmp);
			expect(result.policy.env.USER).toBe("carol");
			expect(result.policy.env.LC_TEST).toBe("C");
		} finally {
			for (const [key, value] of before) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test("a stored grant that now fails revalidation returns no policy and names its path", async () => {
		const { managed, moduleTrees } = await fixture();
		const grant = join(await tempDir(), "formerly-safe-grant");
		await mkdir(grant);
		const user = { ...record(), grants: [{ path: grant, access: "rw" as const }] };
		const moved: ManagedPaths = {
			...managed,
			roots: { ...managed.roots, dataDir: join(grant, "new-data") },
		};
		const result = policyFor(user, { managed: moved, moduleTrees });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result).toEqual({ ok: false, reason: expect.stringContaining(grant) });
		expect("policy" in result).toBe(false);
	});
});

describe("caller-supplied moduleTrees", () => {
	test.each([
		["filesystem root", () => "/"],
		["configDir", (managed: ManagedPaths) => managed.roots.configDir],
		["store root", (managed: ManagedPaths) => managed.roots.cacheDir],
		["coreRoot itself", (managed: ManagedPaths) => managed.coreRoot],
	])("rejects the %s and names the offending path", async (_label, treeFor) => {
		const { managed, coreRoot } = await fixture();
		const tree = treeFor(managed);
		const result = buildUserPolicy(record(), {
			managed,
			nodeBinDir: "/ignored",
			moduleTrees: [join(coreRoot, "src"), tree],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain(tree);
		expect("policy" in result).toBe(false);
	});

	test.skipIf(!existsSync("/dev/shm"))("rejects /dev/shm and names the offending path", async () => {
		const { managed, coreRoot } = await fixture();
		const result = buildUserPolicy(record(), {
			managed,
			nodeBinDir: "/ignored",
			moduleTrees: [join(coreRoot, "src"), "/dev/shm"],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("/dev/shm");
	});

	test.skipIf(!existsSync("/dev/shm"))("rejects a module-tree ancestor of /dev/shm", async () => {
		const { managed, coreRoot } = await fixture();
		const result = buildUserPolicy(record(), {
			managed,
			nodeBinDir: "/ignored",
			moduleTrees: [join(coreRoot, "src"), "/dev"],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("/dev");
	});

	test("accepts legitimate core descendants", async () => {
		const { managed, coreRoot } = await fixture();
		const trees = [join(coreRoot, "dist"), join(coreRoot, "node_modules")];
		await mkdir(trees[0]!);
		const result = buildUserPolicy(record(), {
			managed,
			nodeBinDir: "/ignored",
			moduleTrees: trees,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.policy.ro).toEqual(expect.arrayContaining(trees));
	});
});

describe("defaultModuleTrees", () => {
	test("uses dist when present, otherwise src, and always shared and node_modules", async () => {
		const coreRoot = await tempDir();
		await mkdir(join(coreRoot, "src"));
		expect(defaultModuleTrees(coreRoot)).toEqual([
			join(coreRoot, "src"),
			join(coreRoot, "shared"),
			join(coreRoot, "node_modules"),
		]);
		await mkdir(join(coreRoot, "dist"));
		expect(defaultModuleTrees(coreRoot)).toEqual([
			join(coreRoot, "dist"),
			join(coreRoot, "shared"),
			join(coreRoot, "node_modules"),
		]);
		expect(defaultModuleTrees(coreRoot)).not.toContain(coreRoot);
	});
});

describe("nodeRuntimePaths", () => {
	test("the current dynamically linked node yields its binary and library directories", () => {
		const paths = nodeRuntimePaths();
		expect(paths).toContain(dirname(process.execPath));
		expect(paths.length).toBeGreaterThan(1);
		expect(paths).toEqual([...new Set(paths)].sort());
		expect(paths.every(isAbsolute)).toBe(true);
		expect(paths.every(existsSync)).toBe(true);
	});

	test("a static executable and a nonexistent executable yield only their binary directory", async () => {
		const dir = await tempDir();
		const executable = join(dir, "static-node");
		await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		expect(nodeRuntimePaths(executable)).toEqual([dir]);
		const missing = join(dir, "missing-node");
		expect(nodeRuntimePaths(missing)).toEqual([dirname(missing)]);
	});

	test("the known system library directory is present when ldd independently reports it", () => {
		const output = execFileSync("/usr/bin/ldd", [process.execPath], {
			encoding: "utf8",
		});
		const systemLibrary = "/usr/lib/x86_64-linux-gnu";
		if (output.includes(systemLibrary)) {
			expect(nodeRuntimePaths()).toContain(systemLibrary);
		}
		expect(nodeRuntimePaths()).not.toContain("(0x000000000000)");
		expect(nodeRuntimePaths().some((path) => path.includes("linux-vdso"))).toBe(false);
	});

	test("a hostile ldd earlier on PATH cannot inject a protected directory", async () => {
		const { managed } = await fixture();
		const dir = await tempDir();
		const fakeLoader = join(dir, "ldd");
		const executable = join(dir, "static-node-for-loader-test");
		await writeFile(
			fakeLoader,
			`#!/bin/sh\nprintf '%s\\n' 'libhostile.so => ${managed.roots.dataDir}/libhostile.so (0x1)'\n`,
			{ mode: 0o700 },
		);
		await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		const previousPath = process.env.PATH;
		try {
			process.env.PATH = `${dir}:${previousPath ?? ""}`;
			expect(nodeRuntimePaths(executable, managed)).toEqual([dir]);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	test("a real discovered library directory is dropped when it is a protected root", async () => {
		const { managed } = await fixture();
		const discovered = nodeRuntimePaths().find(
			(path) => path !== realpathSync(dirname(process.execPath)),
		);
		expect(discovered).toBeDefined();
		if (discovered === undefined) return;
		const protectedManaged: ManagedPaths = {
			...managed,
			roots: { ...managed.roots, dataDir: discovered },
		};
		expect(nodeRuntimePaths(process.execPath)).toContain(discovered);
		expect(nodeRuntimePaths(process.execPath, protectedManaged)).not.toContain(discovered);
	});

	test("static fallback drops a protected binary directory", async () => {
		const { managed } = await fixture();
		const executable = join(managed.roots.dataDir, "static-node");
		await writeFile(executable, "#!/bin/sh\nexit 0\n");
		expect(nodeRuntimePaths(executable, managed)).toEqual([]);
	});

	test.skipIf(process.platform !== "linux")("/dev/shm is never returned as a discovered runtime directory", () => {
		expect(nodeRuntimePaths()).not.toContain("/dev/shm");
	});

	test("controlled dot-dot spellings of one real directory deduplicate canonically", async () => {
		const dir = await tempDir();
		const library = join(dir, "lib");
		await mkdir(join(dir, "sub"));
		await mkdir(library);
		const executable = join(dir, "node");
		await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		const duplicate = join(dir, "sub", "..", "lib");
		const readLdd = (loader: string, execPath: string): string => {
			expect(loader).toBe("/usr/bin/ldd");
			expect(execPath).toBe(executable);
			return [
				`libone.so => ${join(library, "libone.so")} (0x1)`,
				`libtwo.so => ${join(duplicate, "libtwo.so")} (0x2)`,
			].join("\n");
		};
		const paths = nodeRuntimePaths(executable, undefined, readLdd);
		const canonicalLibrary = await realpath(library);
		expect(paths).toEqual([dir, canonicalLibrary].sort());
		expect(paths.filter((path) => path === canonicalLibrary)).toHaveLength(1);
	});
});
