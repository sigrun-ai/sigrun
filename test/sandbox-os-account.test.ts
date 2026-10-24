/** Multi-user M1 Task 8: optional OS-account mapping, without host-account I/O. */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentReader } from "@earendil-works/pi-durable";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { UserDirectory } from "../src/harness/identity/users.js";
import { selfPackageRoot } from "../src/harness/packages.js";
import {
	createWorkspaceService,
	defaultWorkspacePrefs,
} from "../src/harness/workspace.js";
import {
	probeOsUsers,
	type OsUsersAvailability,
} from "../src/sandbox/availability.js";
import { IsolationState } from "../src/sandbox/isolation.js";
import { lookupOsAccount } from "../src/sandbox/os-account.js";
import type { ManagedPaths } from "../src/sandbox/grants.js";
import type { UserPolicy } from "../src/sandbox/policy.js";
import { WorkerPool, resolveWorkerEntry, testLauncher } from "../src/sandbox/pool.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-sandbox-os-account-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function fixtureReader(passwd: string, group: string) {
	const files = new Map([
		["/etc/passwd", passwd],
		["/etc/group", group],
	]);
	return vi.fn((path: string): string => {
		const content = files.get(path);
		if (content === undefined) throw new Error(`unexpected account read: ${path}`);
		return content;
	});
}

describe("lookupOsAccount", () => {
	test("resolves the primary gid and deduplicated supplementary groups from fixtures", () => {
		const read = fixtureReader(
			[
				"# fixture, not the host passwd",
				"alice:x:1201:1301:Alice:/srv/alice:/bin/sh",
				"ignored:x:1202:1302::/srv/ignored:/bin/sh",
				"",
			].join("\n"),
			[
				"users:x:1301:alice,ignored",
				"developers:x:1401:ignored,alice,alice",
				"operators:x:1402:alice",
				"other:x:1403:ignored",
			].join("\n"),
		);

		expect(lookupOsAccount("alice", read)).toEqual({
			uid: 1201,
			gid: 1301,
			groups: [1301, 1401, 1402],
			home: "/srv/alice",
		});
		expect(read.mock.calls.map(([path]) => path).sort()).toEqual([
			"/etc/group",
			"/etc/passwd",
		]);
	});

	test("a missing account is undefined without consulting groups", () => {
		const read = fixtureReader("alice:x:1201:1301::/srv/alice:/bin/sh", "unused:x:1:alice");
		expect(lookupOsAccount("missing", read)).toBeUndefined();
		expect(read).toHaveBeenCalledExactlyOnceWith("/etc/passwd");
	});

	test.each([
		["uid", "root:x:0:1201::/root:/bin/sh"],
		["gid", "root:x:1201:0::/root:/bin/sh"],
	])("refuses a %s 0 account", (_label, passwd) => {
		const read = fixtureReader(passwd, "users:x:1201:root");
		expect(lookupOsAccount("root", read)).toBeUndefined();
	});
});

describe("probeOsUsers", () => {
	test("runs id as nobody and requires its exact uid output", async () => {
		const read = fixtureReader(
			"nobody:x:65534:65534::/nonexistent:/usr/sbin/nologin",
			"nogroup:x:65534:",
		);
		const run = vi.fn(async (
			_helper: string,
			_args: readonly string[],
			_options: { env: Record<string, string> },
		) => ({ stdout: "65534\n" }));
		await expect(probeOsUsers("/opt/sigrun-sandbox", { read, run })).resolves.toEqual({
			available: true,
			status: "available",
		});
		expect(run).toHaveBeenCalledOnce();
		const [helper, args, options] = run.mock.calls[0]!;
		expect(helper).toBe("/opt/sigrun-sandbox");
		expect(args).toEqual(["run", "--", "/usr/bin/id", "-u"]);
		const policy = JSON.parse(options.env.SIGRUN_SANDBOX_POLICY);
		expect(policy).toMatchObject({
			minAbi: 6,
			uid: 65534,
			gid: 65534,
			groups: [65534],
			rw: [],
		});
		expect(policy.ro).toEqual(expect.arrayContaining(["/usr/bin", "/etc"]));
	});

	test("a capability refusal becomes the pinned availability reason", async () => {
		const read = fixtureReader(
			"nobody:x:65534:65534::/nonexistent:/usr/sbin/nologin",
			"nogroup:x:65534:",
		);
		const result = await probeOsUsers("/opt/sigrun-sandbox", {
			read,
			run: async () => { throw new Error("helper exited 125"); },
		});
		expect(result).toEqual<OsUsersAvailability>({
			available: false,
			status: "osUsers requires CAP_SETUID",
		});
	});

	test("a command that prints the service uid is not a successful probe", async () => {
		const read = fixtureReader(
			"nobody:x:65534:65534::/nonexistent:/usr/sbin/nologin",
			"nogroup:x:65534:",
		);
		await expect(probeOsUsers("/opt/sigrun-sandbox", {
			read,
			run: async () => ({ stdout: "1000\n" }),
		})).resolves.toEqual({
			available: false,
			status: "osUsers requires CAP_SETUID",
		});
	});
});

async function workspaceFixture(osUsers: OsUsersAvailability): Promise<{
	service: ReturnType<typeof createWorkspaceService>;
	pool: WorkerPool;
	dir: string;
	home: string;
	launchedPolicies: UserPolicy[];
}> {
	const dir = await tempDir();
	const home = join(dir, "os-home");
	await mkdir(home);
	const coreRoot = selfPackageRoot();
	if (coreRoot === undefined) throw new Error("core root required");
	const users = new UserDirectory(join(dir, "users.json"));
	await users.add({ user: "alice", admin: true, source: "cli", osUser: "alice-os" });
	await users.add({ user: "bob", admin: false, source: "cli" });
	const workerEntry = resolveWorkerEntry(coreRoot);
	const baseLauncher = testLauncher(workerEntry);
	const launchedPolicies: UserPolicy[] = [];
	const launches = vi.fn((policy: UserPolicy) => {
		launchedPolicies.push(policy);
		return baseLauncher(policy);
	});
	const pool = new WorkerPool({
		launcher: launches,
		idleMinutes: () => 10,
		log: () => undefined,
		workerEntry,
	});
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
	const service = createWorkspaceService({
		isolation: new IsolationState({
			mode: "auto",
			availability: { available: true, abi: 6 },
			userCount: () => users.list().length,
			log: () => undefined,
		}),
		osUsers,
		lookupAccount: (login: string) => lookupOsAccount(login, fixtureReader(
			`${login}:x:1201:1301::${home}:/bin/sh`,
			"users:x:1301:alice-os\ndevelopers:x:1401:alice-os",
		)),
		pool,
		directory: users,
		managed,
		ownerOf: async () => "alice",
	});
	return { service, pool, dir, home, launchedPolicies };
}

describe("workspace OS-account selection", () => {
	test("an osUser with unavailable osUsers fails closed with the pinned reason", async () => {
		const { service, pool, dir, launchedPolicies } = await workspaceFixture({
			available: false,
			status: "off",
		});
		try {
			const env = await service.forConversation(
				{ id: 1 as never },
				defaultWorkspacePrefs(join(dir, "workspace")),
				null as unknown as DocumentReader,
				BACKGROUND_CONTEXT,
			);
			expect(env.id).toBe("unavailable");
			const result = await env.exec("id", undefined, BACKGROUND_CONTEXT);
			expect(result).toMatchObject({
				ok: false,
				error: { message: "isolation_unavailable: osUser requires CAP_SETUID" },
			});
			expect(launchedPolicies).toHaveLength(0);
		} finally {
			await pool.stopAll();
		}
	});

	test("an available osUsers probe maps the account identity and home into policy", async () => {
		const { service, pool, dir, home, launchedPolicies } = await workspaceFixture({
			available: true,
			status: "available",
		});
		try {
			const env = await service.forConversation(
				{ id: 1 as never },
				defaultWorkspacePrefs(join(dir, "workspace")),
				null as unknown as DocumentReader,
				BACKGROUND_CONTEXT,
			);
			expect(env.id).not.toBe("unavailable");
			const result = await env.exec("true", undefined, BACKGROUND_CONTEXT);
			expect(result.ok).toBe(true);
			expect(launchedPolicies).toHaveLength(1);
			const policy = launchedPolicies[0]!;
			expect(policy).toMatchObject({
				uid: 1201,
				gid: 1301,
				groups: [1301, 1401],
				home,
			});
			expect(policy.env.HOME).toBe(home);
		} finally {
			await pool.stopAll();
		}
	});
});
