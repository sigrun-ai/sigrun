/**
 * Task 10 (tabs+skills plan): the per-user WORKSPACE skills history —
 * a second GitHistory per user over `<workspace>/skills`, caught up on
 * every settled run with actor `agent` and the Sigrun-Conversation
 * trailer.
 *
 * Splits:
 *  - `workspaceRoot` (WorkspaceService): one test per selection rule
 *    (default path / multi-user without isolation / osUser unavailable
 *    / the buildUserPolicy precedence) — pure unit level, no harness.
 *  - `workspaceRepoSpec` + `workspaceHistoryFor`: the repo layout, the
 *    per-(user, workspace path) cache, the changed-path commit.
 *  - The settle catch-up: a settled run commits the agent's edits to
 *    `<workspace>/skills`, credited `agent` with Sigrun-Conversation —
 *    unit level (injected hub event) and end to end (a real run whose
 *    tool call edits the skills root).
 *  - A settle-hook git failure is logged and swallowed (never into the
 *    event bus).
 *  - The git dir is never inside the work tree (structural pin).
 *
 * Tests own their literals: alice/bob, mkdtemp roots.
 */

import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import type { DirectoryUser } from "../src/harness/identity/users.js";
import { IsolationState } from "../src/sandbox/isolation.js";
import { type ManagedPaths } from "../src/sandbox/grants.js";
import {
	createWorkspaceService,
	type WorkspaceServiceDeps,
} from "../src/harness/workspace.js";
import { workspaceRepoSpec } from "../src/history/workspace-history.js";
import { historyDir } from "../src/curation/paths.js";
import { createServer } from "../src/server/index.js";
import type { FastifyInstance } from "fastify";
import { seededIdentity } from "./helpers/identity.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) {
		try {
			await teardown();
		} catch {}
	}
}, 180_000);

const warns: string[] = [];
const consoleWarn = console.warn;
// The settle-hook failure test observes the log line: hook failures are
// swallowed, so the ONLY evidence is the warn.
console.warn = (...args: unknown[]): void => {
	warns.push(args.map((value) => String(value)).join(" "));
	consoleWarn(...args);
};
afterEach(() => {
	warns.length = 0;
});

// ---------------------------------------------------------------------------
// workspaceRoot: the four selection rules (WorkspaceService unit level)
// ---------------------------------------------------------------------------

function managedFixture(dir: string): ManagedPaths {
	return {
		roots: {
			configDir: join(dir, "config"),
			dataDir: join(dir, "data"),
			cacheDir: join(dir, "cache"),
			stateDir: join(dir, "state"),
		},
		storagePath: join(dir, "data", "sigrun.db"),
		coreRoot: join(dir, "core"),
		userAreas: (user) => join(dir, "data", "users", user),
	};
}

function userRecord(overrides: Partial<DirectoryUser> & { user: string }): DirectoryUser {
	return {
		admin: false,
		createdAt: 0,
		source: "cli",
		...overrides,
	};
}

function serviceDeps(
	dir: string,
	records: readonly DirectoryUser[],
	overrides?: Partial<WorkspaceServiceDeps>,
): WorkspaceServiceDeps {
	const managed = managedFixture(dir);
	const isolation = new IsolationState({
		mode: "off",
		availability: { available: false, abi: 0, reason: "test: isolation off" },
		userCount: () => records.length,
		log: () => {},
	});
	return {
		isolation,
		defaultWorkspacePath: join(dir, "default-workspace"),
		// Test seams only — pool is never touched by workspaceRoot.
		pool: undefined as never,
		managed,
		directory: {
			list: () => [...records],
		} as unknown as WorkspaceServiceDeps["directory"],
		ownerOf: async () => undefined,
		...overrides,
	};
}

describe("WorkspaceService.workspaceRoot", () => {
	test("rule 1: one directory record and isolation inactive → the default workspace path", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-wsroot-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const service = createWorkspaceService(
			serviceDeps(dir, [userRecord({ user: "alice" })]),
		);
		expect(service.workspaceRoot("alice")).toBe(join(dir, "default-workspace"));
		// An ownerless conversation selects the same single record.
		expect(service.workspaceRoot(undefined)).toBe(join(dir, "default-workspace"));
	});

	test("rule 2: more than one record and isolation inactive → undefined", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-wsroot-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const service = createWorkspaceService(
			serviceDeps(dir, [userRecord({ user: "alice" }), userRecord({ user: "bob" })]),
		);
		expect(service.workspaceRoot("alice")).toBeUndefined();
		expect(service.workspaceRoot(undefined)).toBeUndefined();
	});

	test("rule 3: an osUser record with osUsers unavailable (or a failing lookup) → undefined", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-wsroot-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const record = userRecord({ user: "alice", osUser: "alice-os" });
		const unavailable = createWorkspaceService(
			serviceDeps(dir, [record], {
				osUsers: { available: false, status: "osUsers requires CAP_SETUID" },
			}),
		);
		expect(unavailable.workspaceRoot("alice")).toBeUndefined();
		const failing = createWorkspaceService(
			serviceDeps(dir, [record], {
				osUsers: { available: true, status: "available" },
				lookupAccount: () => {
					throw new Error("test: passwd read failed");
				},
			}),
		);
		expect(failing.workspaceRoot("alice")).toBeUndefined();
		const missing = createWorkspaceService(
			serviceDeps(dir, [record], {
				osUsers: { available: true, status: "available" },
				lookupAccount: () => undefined,
			}),
		);
		expect(missing.workspaceRoot("alice")).toBeUndefined();
	});

	test("rule 4: a stored workspace wins over the osUser home; validateUserPath-refused → undefined", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-wsroot-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const stored = join(dir, "stored-workspace");
		const home = join(dir, "os-home");
		await mkdir(stored, { recursive: true });
		await mkdir(home, { recursive: true });
		const record = userRecord({ user: "alice", osUser: "alice-os", workspace: stored });
		const service = createWorkspaceService(
			serviceDeps(dir, [record], {
				osUsers: { available: true, status: "available" },
				lookupAccount: () => ({ uid: 1001, gid: 1001, groups: [1001], home }),
			}),
		);
		expect(service.workspaceRoot("alice")).toBe(stored);
		// A refused stored path (the user area ITSELF contains the curation
		// dir — the seal's canonical refusal) resolves to undefined.
		// Rule 4 needs the osUser path, so alice keeps her os account.
		const refused = join(dir, "data", "users", "alice");
		await mkdir(refused, { recursive: true });
		const bad = createWorkspaceService(
			serviceDeps(
				dir,
				[userRecord({ user: "alice", osUser: "alice-os", workspace: refused })],
				{
					osUsers: { available: true, status: "available" },
					lookupAccount: () => ({ uid: 1001, gid: 1001, groups: [1001], home }),
				},
			),
		);
		expect(bad.workspaceRoot("alice")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// workspaceRepoSpec / workspaceHistoryFor
// ---------------------------------------------------------------------------

describe("workspaceRepoSpec", () => {
	test("the repo layout is the plan's exact shape and the git dir is never inside the work tree", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-wsspec-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const userArea = join(dir, "users", "alice");
		const workspace = join(dir, "workspaces", "alice");
		const spec = workspaceRepoSpec(userArea, workspace);
		expect(spec.gitDir).toBe(join(historyDir(userArea), "workspace.git"));
		expect(spec.workTree).toBe(join(workspace, "skills"));
		expect(spec.pathspec).toEqual(["."]);
		// Structural pin: the git dir can never be staged as work-tree
		// content (the info/exclude guard's complement — here the layout
		// itself holds it).
		const relative = spec.gitDir.startsWith(`${spec.workTree}/`);
		expect(relative).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// The settle-time catch-up
// ---------------------------------------------------------------------------

/** Boot one real server with one faux provider (no extensions). */
async function bootServer(
	responses: readonly import("@earendil-works/pi-ai").AssistantMessage[],
	options?: { readonly users?: readonly (Partial<DirectoryUser> & { user: string })[] },
): Promise<{
	app: FastifyInstance;
	opened: OpenedHarness;
	config: SigrunConfig;
	dir: string;
	tokens: Record<string, string>;
}> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-wshist-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000, reasoning: false }],
	});
	faux.setResponses([...responses]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const env = {
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: join(dir, "workspace"),
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_AUTH: "token",
	};
	const config = loadConfig(env);
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ namingModel: false }),
		"utf8",
	);
	const identity = await seededIdentity(dir, "alice");
	for (const user of options?.users ?? []) {
		if (identity.users.get(user.user) !== undefined) continue;
		await identity.users.add({
			admin: false,
			source: "cli",
			createdAt: Date.now(),
			...user,
		} as DirectoryUser);
	}
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		env,
		settingsDir: dir,
	});
	const tokens: Record<string, string> = {};
	for (const record of identity.users.list()) {
		tokens[record.user] = (await opened.identity.tokens.create("test", record.user)).token;
	}
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true, maxRetries: 3 });
	});
	return { app, opened, config, dir, tokens };
}

function auth(tokens: Record<string, string>, user: string) {
	return { authorization: `Bearer ${tokens[user]}` };
}

async function waitFor<T>(probe: () => Promise<T | undefined>, label: string): Promise<T> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const found = await probe();
		if (found !== undefined) return found;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("workspace skills history — settle catch-up", () => {
	test("a settled run commits the agent's skills/ edits credited to agent with Sigrun-Conversation", { timeout: 60_000 }, async () => {
		const server = await bootServer([]);
		// One directory user, isolation off → the default workspace path.
		const skillsDir = join(server.dir, "workspace", "skills");
		await mkdir(skillsDir, { recursive: true });
		await writeFile(join(skillsDir, "note.md"), "agent was here\n", "utf8");
		const create = await server.app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: auth(server.tokens, "alice"),
		});
		expect(create.statusCode).toBe(201);
		const conversationId = create.json().id as number;
		// The settle itself is injected: the history commit is the unit
		// under test, not the provider's answer.
		server.opened.events.publish({
			type: "run.settled",
			conversationId,
			outcome: "answered",
		});
		const history = server.opened.history.workspace("alice");
		expect(history).toBeDefined();
		const commits = await waitFor(async () => {
			const log = await history!.log({ limit: 10 });
			return log.length > 0 ? log : undefined;
		}, "the workspace history commit");
		expect(commits).toHaveLength(1);
		expect(commits[0]!.actor).toEqual({ kind: "agent" });
		expect(commits[0]!.summary).toBe("agent changes");
		expect(commits[0]!.conversationId).toBe(conversationId);
		expect(commits[0]!.paths).toContain("note.md");
	});

	test("a settled run end to end: a tool edit to skills/ lands in the history", { timeout: 60_000 }, async () => {
		const call = fauxToolCall("write", {
			path: "skills/e2e-note.md",
			content: "written by the agent\n",
		});
		const server = await bootServer([
			fauxAssistantMessage([call], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const create = await server.app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: auth(server.tokens, "alice"),
		});
		const conversationId = create.json().id as number;
		const submitted = await server.app.inject({
			method: "POST",
			url: `/v1/conversations/${conversationId}/submissions?waitMs=15000`,
			payload: { input: "write the note" },
			headers: { ...auth(server.tokens, "alice"), "content-type": "application/json" },
		});
		expect(submitted.statusCode).toBe(202);
		const history = server.opened.history.workspace("alice");
		const commits = await waitFor(async () => {
			const log = await history!.log({ limit: 10 });
			return log.some((commit) => commit.paths.includes("e2e-note.md"))
				? log
				: undefined;
		}, "the end-to-end workspace history commit");
		const commit = commits.find((entry) => entry.paths.includes("e2e-note.md"))!;
		expect(commit.actor).toEqual({ kind: "agent" });
		expect(commit.conversationId).toBe(conversationId);
	});

	test("ownerless conversations do nothing", { timeout: 60_000 }, async () => {
		const server = await bootServer([]);
		const skillsDir = join(server.dir, "workspace", "skills");
		await mkdir(skillsDir, { recursive: true });
		await writeFile(join(skillsDir, "note.md"), "x\n", "utf8");
		server.opened.events.publish({
			type: "run.settled",
			conversationId: 424242,
			outcome: "answered",
		});
		// Give the bounded lane a chance to run; no repo must be created.
		// (The factory itself always resolves for alice — the single-record
		// posture — so the assertion is on the REPO, not the instance.)
		await new Promise((resolve) => setTimeout(resolve, 500));
		const spec = workspaceRepoSpec(
			join(server.dir, "data", "users", "alice"),
			join(server.dir, "workspace"),
		);
		await expect(access(spec.gitDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("a settle hook git failure is logged and swallowed", { timeout: 60_000 }, async () => {
		const server = await bootServer([]);
		const skillsDir = join(server.dir, "workspace", "skills");
		await mkdir(skillsDir, { recursive: true });
		const spec = workspaceRepoSpec(
			join(server.dir, "data", "users", "alice"),
			join(server.dir, "workspace"),
		);
		const create = await server.app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: auth(server.tokens, "alice"),
		});
		const conversationId = create.json().id as number;
		// First settle: one successful catch-up, so the repo EXISTS — the
		// failure below must hit the commit path, never recoverCorrupt's
		// loud re-init (which would succeed, not fail).
		await writeFile(join(skillsDir, "first.md"), "one\n", "utf8");
		server.opened.events.publish({
			type: "run.settled",
			conversationId,
			outcome: "answered",
		});
		const history = server.opened.history.workspace("alice");
		await waitFor(async () => {
			const log = await history!.log({ limit: 10 });
			return log.length > 0 ? log : undefined;
		}, "the first workspace history commit");
		// A FRESH index.lock (mtime now — under the 10-minute staleness
		// threshold) fails only the commit: checkIndexLock's logged,
		// swallowed path.
		await writeFile(join(spec.gitDir, "index.lock"), "", "utf8");
		await writeFile(join(skillsDir, "second.md"), "two\n", "utf8");
		warns.length = 0;
		server.opened.events.publish({
			type: "run.settled",
			conversationId,
			outcome: "answered",
		});
		// The event bus must not see a throw: the failure is a log line.
		await waitFor(async () => {
			return warns.some(
				(line) =>
					line.includes("workspace history") &&
					line.includes("index.lock present"),
			)
				? true
				: undefined;
		}, "the index.lock failure log");
		// The hub is still alive (the failure never escaped the side lane).
		expect(() =>
			server.opened.events.publish({
				type: "run.settled",
				conversationId,
				outcome: "answered",
			}),
		).not.toThrow();
	});

	test("a settle catch-up prepare failure is logged once, not per settle", { timeout: 60_000 }, async () => {
		const server = await bootServer([]);
		// The work tree does not exist and cannot be created by the hook:
		// prepare() fails on the readability check — the class the brief
		// requires logged (git.ts catchUp's prepare-failure branch).
		const create = await server.app.inject({
			method: "POST",
			url: "/v1/conversations",
			headers: auth(server.tokens, "alice"),
		});
		const conversationId = create.json().id as number;
		warns.length = 0;
		server.opened.events.publish({
			type: "run.settled",
			conversationId,
			outcome: "answered",
		});
		await waitFor(async () => {
			return warns.some(
				(line) =>
					line.includes("workspace history") &&
					line.includes("history catch-up skipped"),
			)
				? true
				: undefined;
		}, "the prepare-failure log");
		const logged = warns.filter((line) =>
			line.includes("history catch-up skipped"),
		);
		expect(logged).toHaveLength(1);
		// A second settle does NOT re-log (once per repo instance).
		server.opened.events.publish({
			type: "run.settled",
			conversationId,
			outcome: "answered",
		});
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(
			warns.filter((line) => line.includes("history catch-up skipped")),
		).toHaveLength(1);
	});

	test("a changed workspace path: the next catch-up records the new tree as one commit", { timeout: 60_000 }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-wsmove-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
		const { GitHistory } = await import("../src/history/git.js");
		const { workspaceHistoryFor } = await import("../src/history/workspace-history.js");
		const userArea = join(dir, "users", "alice");
		const workspaceA = join(dir, "workspaces", "a");
		const workspaceB = join(dir, "workspaces", "b");
		await mkdir(join(workspaceA, "skills"), { recursive: true });
		await mkdir(join(workspaceB, "skills"), { recursive: true });
		const gitHome = join(dir, "git-home");
		const make = (workspace: string) =>
			new GitHistory(workspaceRepoSpec(userArea, workspace), { gitHome });
		// Cache per (user, workspace path): the factory resolves one
		// instance per path; a changed path yields a NEW instance on the
		// SAME gitDir.
		const cache = new Map<string, InstanceType<typeof GitHistory>>();
		const historyFor = (user: string, workspace: string) =>
			workspaceHistoryFor(user, workspace, {
				cache,
				create: make,
			});
		const first = historyFor("alice", workspaceA);
		expect(historyFor("alice", workspaceA)).toBe(first);
		await writeFile(join(workspaceA, "skills", "one.md"), "one\n", "utf8");
		await first!.catchUp({ actor: { kind: "agent" }, summary: "agent changes" });
		const second = historyFor("alice", workspaceB);
		expect(second).not.toBe(first);
		expect(second).toBeDefined();
		await writeFile(join(workspaceB, "skills", "two.md"), "two\n", "utf8");
		await second!.catchUp({ actor: { kind: "agent" }, summary: "agent changes" });
		// ONE repo: the log reads both commits, one per tree.
		const log = await second!.log({ limit: 10 });
		expect(log).toHaveLength(2);
		expect(log[0]!.paths).toContain("two.md");
		expect(log[1]!.paths).toContain("one.md");
	});
});
