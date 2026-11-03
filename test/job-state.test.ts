/** Per-user job-state roots and the encoded on-disk job id mapping. */

import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { DirectoryUser } from "../src/harness/identity/users.js";
import { UserDirectory } from "../src/harness/identity/users.js";
import { createWorkspaceService } from "../src/harness/workspace.js";
import { jobStateDir, removeJobState } from "../src/jobs/state-dir.js";
import { IsolationState } from "../src/sandbox/isolation.js";
import { WorkerPool } from "../src/sandbox/pool.js";
import type { ManagedPaths } from "../src/sandbox/grants.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-job-state-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function record(user: string, init: Partial<DirectoryUser> = {}): DirectoryUser {
	return { user, admin: false, createdAt: 1, source: "cli", ...init };
}

let directoryCounter = 0;

async function serviceFor(
	dataDir: string,
	records: readonly DirectoryUser[],
	options: {
		osUsers?: { available: boolean; status: "available" | "off" | "osUsers requires CAP_SETUID" };
		lookupAccount?: (login: string) => { uid: number; gid: number; groups: number[]; home: string } | undefined;
	} = {},
) {
	const managed: ManagedPaths = {
		roots: {
			configDir: join(dataDir, "config"),
			dataDir,
			cacheDir: join(dataDir, "cache"),
			stateDir: join(dataDir, "state"),
		},
		storagePath: join(dataDir, "sigrun.db"),
		coreRoot: join(dataDir, "core"),
		userAreas: (user) => join(dataDir, "users", user),
	};
	// A REAL directory (never a cast): jobsRoot reads list() and the seam
	// must break loudly if UserDirectory's list contract ever changes. add
	// stamps createdAt itself, so only the other record fields seed. The
	// file is unique per fixture (one test seeds two fixtures over the
	// same dataDir).
	directoryCounter += 1;
	const directory = new UserDirectory(join(dataDir, `users-${directoryCounter}.json`));
	for (const { createdAt: _stamped, ...user } of records) await directory.add(user);
	return createWorkspaceService({
		// The jobsRoot path never touches isolation or the worker pool (both
		// serve forConversation only) — the real constructors, not casts.
		isolation: new IsolationState({
			mode: "off",
			availability: { available: false, abi: 0, reason: "unavailable" },
			userCount: () => directory.list().length,
			log: () => undefined,
		}),
		pool: new WorkerPool({
			launcher: () => {
				throw new Error("jobsRoot tests never launch a worker");
			},
			idleMinutes: () => 10,
			log: () => undefined,
			workerEntry: { command: process.execPath, args: [] },
		}),
		directory,
		managed,
		ownerOf: async () => undefined,
		defaultWorkspacePath: join(dataDir, "workspace"),
		...options,
	});
}

describe("WorkspaceService.jobsRoot", () => {
	test("uses the named user's managed area", async () => {
		const dataDir = await tempDir();
		const service = await serviceFor(dataDir, [record("alice")]);
		expect(service.jobsRoot("alice")).toBe(join(dataDir, "users", "alice", "jobs"));
		});

	test("an ownerless job uses the primary admin's managed area", async () => {
		const dataDir = await tempDir();
		const service = await serviceFor(dataDir, [record("root-admin", { admin: true })]);
		expect(service.jobsRoot(undefined)).toBe(join(dataDir, "users", "root-admin", "jobs"));
		});

	test("an orphaned owner falls back to the first admin", async () => {
		const dataDir = await tempDir();
		const service = await serviceFor(dataDir, [
			record("alice"),
			record("root-admin", { admin: true }),
		]);
		expect(service.jobsRoot("ghost")).toBe(join(dataDir, "users", "root-admin", "jobs"));
		});

	test("an empty directory, or one with no selected record, uses the data root", async () => {
		const dataDir = await tempDir();
		expect((await serviceFor(dataDir, [])).jobsRoot("alice")).toBe(join(dataDir, "jobs"));
		expect((await serviceFor(dataDir, [record("alice")])).jobsRoot("ghost")).toBe(join(dataDir, "jobs"));
	});

	test("an osUser's jobs live under the XDG state default in the account home", async () => {
		const dataDir = await tempDir();
		const service = await serviceFor(dataDir, [record("alice", { osUser: "alice-os" })], {
			osUsers: { available: true, status: "available" },
			lookupAccount: () => ({
				uid: 1001,
				gid: 1001,
				groups: [1001],
				home: "/home/alice-os",
			}),
		});
		expect(service.jobsRoot("alice")).toBe("/home/alice-os/.local/state/sigrun/jobs");
		});

	test("an osUser with unavailable account switching has no jobs root", async () => {
		const dataDir = await tempDir();
		const service = await serviceFor(dataDir, [record("alice", { osUser: "alice-os" })], {
			osUsers: { available: false, status: "off" },
			lookupAccount: () => { throw new Error("must not be called"); },
		});
		expect(service.jobsRoot("alice")).toBeUndefined();
		});

	test("a failed or missing osAccount lookup has no jobs root", async () => {
		const dataDir = await tempDir();
		const options = { osUsers: { available: true, status: "available" } as const };
		const throwing = await serviceFor(dataDir, [record("alice", { osUser: "alice-os" })], {
			...options,
			lookupAccount: () => { throw new Error("account database unavailable"); },
		});
		expect(throwing.jobsRoot("alice")).toBeUndefined();
		const missing = await serviceFor(dataDir, [record("alice", { osUser: "alice-os" })], {
			...options,
			lookupAccount: () => undefined,
		});
		expect(missing.jobsRoot("alice")).toBeUndefined();
		});

	test("a service without deps has no jobs root", () => {
		expect(createWorkspaceService().jobsRoot("alice")).toBeUndefined();
		});
});

describe("job state directory helpers", () => {
	test("encodes the complete job id as one path segment", () => {
		expect(jobStateDir("/r", "ext:acme:nightly-check")).toBe("/r/ext%3Aacme%3Anightly-check");
		});

	test("removes a populated job-state directory", async () => {
		const root = await tempDir();
		const state = jobStateDir(root, "file:nightly-check");
		await mkdir(state, { recursive: true });
		await writeFile(join(state, "state.json"), "{}");
		await removeJobState(root, "file:nightly-check");
		expect(existsSync(state)).toBe(false);
		});

	test("an undefined root is a no-op", async () => {
		await expect(removeJobState(undefined, "file:nightly-check")).resolves.toBeUndefined();
		});

	test.skipIf(process.getuid?.() === 0)("an unremovable job-state directory rejects", async () => {
		const dir = await tempDir();
		const root = join(dir, "root");
		const state = jobStateDir(root, "file:nightly-check");
		await mkdir(state, { recursive: true });
		await writeFile(join(state, "state.json"), "{}");
		await chmod(root, 0o500);
		try {
			await expect(removeJobState(root, "file:nightly-check")).rejects.toThrow();
		} finally {
			await chmod(root, 0o700);
		}
		});
});
