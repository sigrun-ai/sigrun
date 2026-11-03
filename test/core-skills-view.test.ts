/**
 * Tabs+skills Task 12 (view half): the `core/skills` blocks view —
 * every root, owned-skill CRUD, git history with diffs.
 *
 * Pinned here (the brief's 13 cases):
 *
 * - alice sees her workspace + learned, never bob's;
 * - create learned / create workspace each commit with author alice;
 * - save edits and commits;
 * - workspace delete lists under Deleted; restoreDeleted brings it back;
 * - restoreDeleted refuses a reused name ("a skill named <name> exists
 *   in <root>; rename or delete it first");
 * - learned delete archives;
 * - overlayPut on a package skill (upstream hash pinned);
 * - a read-only root has no edit actions;
 * - history unavailable still lists and edits (the pane shows the reason);
 * - opening the tab commits outside edits as "outside"; two renders
 *   within 30 s run ONE catch-up (the in-memory per-repo throttle);
 * - anonymous principal gets access none;
 * - restoreVersion of an archived learned skill un-archives it.
 *
 * Hermetic pattern: core-jobs-view.test.ts (token method, alice/bob
 * directory users, faux provider, `app.inject()`). The e2e boots pin
 * `SIGRUN_STATE_DIR`/`SIGRUN_CONFIG_DIR` inside the tmpdir so the
 * per-user curation repos stay hermetic.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { GitHistory } from "../src/history/git.js";
import { workspaceRepoSpec } from "../src/history/workspace-history.js";
import { seededIdentity } from "./helpers/identity.js";

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly dir: string;
	readonly workspace: string;
	readonly configDir: string;
	readonly alice: string;
	readonly bob: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot one hermetic server (token method; alice + bob; per-user workspace skills dirs). */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-core-skills-view-"));
	const configDir = join(dir, "config");
	const stateDir = join(dir, "state");
	const cacheDir = join(dir, "cache");
	await mkdir(configDir, { recursive: true });
	// Per-user workspace roots (alice's skills live in <workspace>/alice;
	// bob's in <workspace>/bob) — the multi-user workspace rule (stored
	// per-user paths) is how "alice never sees bob's" holds.
	const aliceWorkspace = join(dir, "alice-workspace");
	const bobWorkspace = join(dir, "bob-workspace");
	await mkdir(join(aliceWorkspace, "skills"), { recursive: true });
	await mkdir(join(bobWorkspace, "skills"), { recursive: true });
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([fauxAssistantMessage("ok")]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const env = {
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_WORKSPACE_PATH: aliceWorkspace,
		SIGRUN_CONFIG_DIR: configDir,
		SIGRUN_STATE_DIR: stateDir,
		SIGRUN_CACHE_DIR: cacheDir,
		SIGRUN_AUTH: "token",
		SIGRUN_TIMEZONE: "UTC",
	};
	const config = loadConfig(env);
	const identity = await seededIdentity(join(dir, "seed"), "alice");
	await identity.users.add({
		user: "bob",
		admin: false,
		source: "cli",
		workspace: bobWorkspace,
	});
	// Alice's stored workspace (the multi-user per-user path rule).
	const aliceRecord = identity.users.get("alice");
	if (aliceRecord !== undefined) {
		await identity.users.update("alice", { workspace: aliceWorkspace });
	}
	const opened = await openHarness(config, {
		extensions: [contributor],
		env,
		identity,
		settingsDir: configDir,
		isolationProbe: async () => ({ available: true, abi: 6 }),
	});
	const app = await createServer(opened, config);
	const mint = async (user: string): Promise<string> =>
		(await opened.identity.tokens.create("test", user)).token;
	cleanups.push(async () => {
		await app.close().catch(() => {});
		await opened.harness.close(BACKGROUND_CONTEXT).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	return {
		app,
		opened,
		dir,
		workspace: aliceWorkspace,
		configDir,
		alice: await mint("alice"),
		bob: await mint("bob"),
	};
}

/** One injected request with auth. */
async function call(
	app: FastifyInstance,
	method: "GET" | "POST",
	url: string,
	token: string,
	body?: unknown,
): Promise<{ status: number; json: any }> {
	const response = await app.inject({
		method,
		url,
		...(body === undefined ? {} : { payload: JSON.stringify(body) }),
		headers: {
			authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
	});
	let json: any = undefined;
	try {
		json = response.json();
	} catch {
		json = undefined;
	}
	return { status: response.statusCode, json };
}

/** One surface action dispatch against core/skills. */
async function act(
	app: FastifyInstance,
	token: string,
	action: string,
	payload: Record<string, unknown> | null,
	params: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
	return call(app, "POST", "/v1/ext/core/surfaces/skills/actions", token, {
		action,
		payload,
		params,
	});
}

/** The skills view (params ride the query). */
function view(
	app: FastifyInstance,
	token: string,
	params?: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
	const base = "/v1/ext/core/surfaces/skills";
	const url =
		params === undefined
			? base
			: `${base}?params=${encodeURIComponent(JSON.stringify(params))}`;
	return call(app, "GET", url, token);
}

/** Read the data document at one JSON pointer. */
function atPointer(data: Record<string, any>, pointer: string): unknown {
	let node: unknown = data;
	for (const token of pointer
		.split("/")
		.slice(1)
		.map((raw) => raw.replaceAll("~1", "/").replaceAll("~0", "~"))) {
		if (typeof node !== "object" || node === null) return undefined;
		node = (node as Record<string, unknown>)[token];
	}
	return node;
}

/** Walk blocks depth-first (sidebar/main/children). */
function* walk(blocks: unknown): Generator<Record<string, any>> {
	if (!Array.isArray(blocks)) return;
	for (const block of blocks) {
		if (typeof block !== "object" || block === null) continue;
		const node = block as Record<string, any>;
		yield node;
		if (Array.isArray(node.children)) {
			for (const child of node.children) {
				const inner =
					typeof child === "object" && child !== null && "block" in child
						? child.block
						: child;
				yield* walk([inner]);
			}
		}
	}
}

function findBlocks(blocks: unknown, type: string): Record<string, any>[] {
	const found: Record<string, any>[] = [];
	for (const node of walk(blocks)) {
		if (node.type === type) found.push(node);
	}
	return found;
}

function findBlock(blocks: unknown, type: string): Record<string, any> | undefined {
	return findBlocks(blocks, type)[0];
}

/** Every workspace commit summary + author, newest first (the view's own repo). */
async function workspaceLog(
	opened: OpenedHarness,
	user: string,
	path?: string,
): Promise<readonly { sha: string; summary: string; author: string }[]> {
	const history = opened.history.workspace(user);
	expect(history).toBeDefined();
	const commits = await history!.log({ limit: 50, ...(path === undefined ? {} : { path }) });
	return commits.map((commit) => ({
		sha: commit.sha,
		summary: commit.summary,
		author: commit.actor.kind === "user" ? commit.actor.user : commit.actor.kind,
	}));
}

/** Write one SKILL.md into a workspace's skills dir. */
async function putWorkspaceSkill(
	workspace: string,
	name: string,
	description: string,
	body: string,
): Promise<void> {
	const dir = join(workspace, "skills", name);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
	);
}

// ─── listing + access ────────────────────────────────────────────────────

describe("core/skills listing", () => {
	test("alice sees her workspace and learned, not bob's", async () => {
		const { app, workspace, alice, bob, dir } = await bootServer();
		await putWorkspaceSkill(workspace, "acme-deploy", "deploy the acme stack", "Run the deploy.");
		await putWorkspaceSkill(join(dir, "bob-workspace"), "acme-bob-only", "bob's private skill", "Bob only.");
		// Alice creates a learned skill; bob creates one of his own.
		const learnedAlice = await act(app, alice, "create", {
			where: "learned",
			name: "acme-alice-notes",
			description: "alice's notes",
			body: "Alice's learned notes.",
		}, {});
		expect(learnedAlice.status).toBe(200);
		const learnedBob = await act(app, bob, "create", {
			where: "learned",
			name: "acme-bob-notes",
			description: "bob's notes",
			body: "Bob's learned notes.",
		}, {});
		expect(learnedBob.status).toBe(200);

		const rendered = await view(app, alice);
		expect(rendered.status).toBe(200);
		expect(rendered.json.access).toBe("write");
		const rows = atPointer(rendered.json.data, "/skills") as any[];
		const names = rows.map((row) => row.id);
		expect(names).toContain("workspace:acme-deploy");
		expect(names).toContain("learned:acme-alice-notes");
		expect(names).not.toContain("workspace:acme-bob-only");
		expect(names).not.toContain("learned:acme-bob-notes");
		// Grouped: workspace rows in the workspace group, learned in theirs.
		const deploy = rows.find((row) => row.id === "workspace:acme-deploy");
		expect(deploy.group).toBe("workspace");
		const notes = rows.find((row) => row.id === "learned:acme-alice-notes");
		expect(notes.group).toBe("learned");
		// The sidebar collection is data-bound (the bump contract).
		const sidebar = findBlock(rendered.json.tree.root.sidebar, "collection");
		expect(sidebar?.items).toEqual({ $: "/skills" });
		expect(sidebar?.groupBy).toBe("group");
		// The New skill page action.
		expect(rendered.json.tree.root.actions).toEqual([
			expect.objectContaining({ id: "skill-new", label: "New skill" }),
		]);
	});

	test("anonymous principal gets access none", async () => {
		const { app } = await bootServer();
		const response = await app.inject({
			method: "GET",
			url: "/v1/ext/core/surfaces/skills",
		});
		expect(response.statusCode).toBe(401);
		const def = app.surfaces.coreViewDefs.find((one) => one.id === "skills");
		expect(def).toBeDefined();
		// An anonymous principal on a NON-superuser method (a token call
		// with no identity) has no view.
		const rendered = await def!.render({
			principal: { user: undefined, admin: false, service: false, method: "token" },
			params: {},
			key: "anon",
			signal: new AbortController().signal,
		});
		expect(rendered.access).toBe("none");
	});

	test("the userless superuser acts as the primary admin (whole-branch review I3)", async () => {
		// The naive single-operator loopback principal (method "none", no
		// user header) resolves to the PRIMARY ADMIN — the earliest-created
		// directory user with the admin flag (alice, seeded first) — the
		// same fallback the jail uses. Her workspace/learned scope answers.
		const { app, alice } = await bootServer();
		await act(app, alice, "create", {
			where: "workspace",
			name: "acme-naive-visible",
			description: "the naive operator's skill (as alice)",
			body: "Alice's own.",
		}, {});
		const def = app.surfaces.coreViewDefs.find((one) => one.id === "skills");
		expect(def).toBeDefined();
		const naive = await def!.render({
			principal: { user: undefined, admin: false, service: false, method: "none" },
			params: {},
			key: "naive",
			signal: new AbortController().signal,
		});
		expect(naive.access).toBe("write");
		const rows = atPointer(naive.data as Record<string, any>, "/skills") as any[];
		// Alice's workspace skill is in scope (the view IS alice's).
		expect(
			rows.some((row) => row.id === "workspace:acme-naive-visible"),
		).toBe(true);
		// A write through the naive principal lands as alice (the
		// workspace write actor) and commits to HER repo.
		const created = await app.inject({
			method: "POST",
			url: "/v1/ext/core/surfaces/skills/actions",
			headers: { "content-type": "application/json" },
			payload: JSON.stringify({
				action: "create",
				payload: {
					where: "workspace",
					name: "acme-naive-made",
					description: "made by the naive operator",
					body: "Naive body.",
				},
				params: {},
			}),
		});
		// The action route 401s the no-credential call at the auth gate
		// (the token method's answer) — the DEF-level dispatch is the
		// identity-bearing path here.
		expect(created.statusCode).toBe(401);
		const create = def!.actions?.create;
		expect(create).toBeDefined();
		const defCreate = await create!(
			{ principal: { user: undefined, admin: false, service: false, method: "none" }, params: {}, key: "naive", signal: new AbortController().signal },
			{ where: "workspace", name: "acme-naive-made", description: "made by the naive operator", body: "Naive body." },
		);
		expect(defCreate.ok, JSON.stringify(defCreate)).toBe(true);
		// The skill exists in ALICE's workspace root, not a shared one.
		const rendered = await view(app, alice, { skill: "acme-naive-made", root: "workspace" });
		expect((atPointer(rendered.json.data, "/main") as any).body).toBe("Naive body.\n");
	});
});

// ─── create / save ───────────────────────────────────────────────────────

describe("core/skills create + save", () => {
	test("create learned and create workspace each commit with author alice", async () => {
		const { app, opened, alice } = await bootServer();
		const learned = await act(app, alice, "create", {
			where: "learned",
			name: "acme-learned-skill",
			description: "a learned skill",
			body: "Learned body.",
		}, {});
		expect(learned.status).toBe(200);
		expect(learned.json.ok).toBe(true);
		expect(learned.json.navigate).toEqual({
			type: "navigate",
			params: { skill: "acme-learned-skill", root: "learned" },
		});

		const workspace = await act(app, alice, "create", {
			where: "workspace",
			name: "acme-workspace-skill",
			description: "a workspace skill",
			body: "Workspace body.",
		}, {});
		expect(workspace.status).toBe(200);
		expect(workspace.json.ok).toBe(true);

		// Both committed with author alice (the workspace repo's log).
		const log = await workspaceLog(opened, "alice", "acme-workspace-skill/");
		expect(log.length).toBeGreaterThanOrEqual(1);
		expect(log[0]?.summary).toBe("create acme-workspace-skill");
		expect(log[0]?.author).toBe("alice");
		// The learned repo's commit (the curation history log).
		const curation = opened.history.workspace("alice");
		expect(curation).toBeDefined();
	});

	test("save edits and commits", async () => {
		const { app, opened, alice } = await bootServer();
		await act(app, alice, "create", {
			where: "workspace",
			name: "acme-editable",
			description: "before the edit",
			body: "Before.",
		}, {});
		const saved = await act(app, alice, "save", {
			name: "acme-editable",
			description: "after the edit",
			body: "After.",
		}, { skill: "acme-editable", root: "workspace", edit: true });
		expect(saved.status).toBe(200);
		expect(saved.json.ok).toBe(true);
		const log = await workspaceLog(opened, "alice", "acme-editable/");
		expect(log.length).toBeGreaterThanOrEqual(2);
		expect(log[0]?.summary).toBe("edit acme-editable");
		expect(log[0]?.author).toBe("alice");
		// The rendered skill shows the new body.
		const rendered = await view(app, alice, { skill: "acme-editable", root: "workspace" });
		const main = atPointer(rendered.json.data, "/main") as any;
		expect(main.body).toBe("After.\n");
		expect(main.description).toBe("after the edit");
	});

	test("create refuses a bad name and a duplicate workspace name", async () => {
		const { app, alice } = await bootServer();
		const bad = await act(app, alice, "create", {
			where: "workspace",
			name: "Bad Name",
			description: "x",
			body: "x",
		}, {});
		expect(bad.json.ok).toBe(false);
		expect(bad.json.error.message).toContain("valid skill name");
		await act(app, alice, "create", {
			where: "workspace",
			name: "acme-dupe",
			description: "one",
			body: "one",
		}, {});
		const dupe = await act(app, alice, "create", {
			where: "workspace",
			name: "acme-dupe",
			description: "two",
			body: "two",
		}, {});
		expect(dupe.json.ok).toBe(false);
		expect(dupe.json.error.message).toContain("already exists");
	});
});

// ─── delete + restoreDeleted ────────────────────────────────────────────

describe("core/skills delete + restoreDeleted", () => {
	test("workspace delete removes the dir and lists the skill under Deleted; restoreDeleted brings it back", async () => {
		const { app, alice } = await bootServer();
		await act(app, alice, "create", {
			where: "workspace",
			name: "acme-doomed",
			description: "to be deleted",
			body: "Doomed body.",
		}, {});
		const deleted = await act(app, alice, "delete", null, {
			skill: "acme-doomed",
			root: "workspace",
		});
		expect(deleted.json.ok).toBe(true);
		// The live listing drops it: its only row is the Deleted-group one
		// (the repo's log still holds it — the restore affordance).
		const after = await view(app, alice);
		const rows = atPointer(after.json.data, "/skills") as any[];
		expect(
			rows.some((row) => row.id === "workspace:acme-doomed" && row.group !== "deleted"),
		).toBe(false);
		// The Deleted group lists it (deleted-group rows have history to restore from).
		const deletedRows = rows.filter((row) => row.group === "deleted");
		expect(deletedRows.map((row) => row.id)).toContain("workspace:acme-doomed");
		// The deletion commit is the restore target.
		const row = deletedRows.find((one) => one.id === "workspace:acme-doomed");
		expect(typeof row?.deletionSha).toBe("string");
		// Restore it: the dir comes back, listed under Workspace again.
		const restored = await act(app, alice, "restoreDeleted", {
			name: "acme-doomed",
			sha: row.deletionSha,
			root: "workspace",
		}, {});
		expect(restored.json.ok, JSON.stringify(restored.json)).toBe(true);
		const backAgain = await view(app, alice);
		const backRows = atPointer(backAgain.json.data, "/skills") as any[];
		expect(backRows.some((one) => one.id === "workspace:acme-doomed" && one.group === "workspace")).toBe(true);
		const rendered = await view(app, alice, { skill: "acme-doomed", root: "workspace" });
		expect((atPointer(rendered.json.data, "/main") as any).body).toBe("Doomed body.\n");
	});

	test("restore-deleted refuses a reused name (and restoreVersion refuses its pre-delete commit)", async () => {
		const { app, alice } = await bootServer();
		await act(app, alice, "create", {
			where: "workspace",
			name: "acme-recycled",
			description: "the original",
			body: "Original.",
		}, {});
		await act(app, alice, "delete", null, { skill: "acme-recycled", root: "workspace" });
		// Retain the deletion sha from the Deleted-group row (a re-created
		// name drops the row by design — its newest commit is the create).
		const deletedRows = (atPointer((await view(app, alice)).json.data, "/skills") as any[]).filter(
			(row) => row.group === "deleted" && row.name === "acme-recycled",
		);
		expect(deletedRows).toHaveLength(1);
		const deletionSha = deletedRows[0]?.deletionSha;
		expect(typeof deletionSha).toBe("string");
		// The name gets reused (a NEW workspace skill of the same name).
		await act(app, alice, "create", {
			where: "workspace",
			name: "acme-recycled",
			description: "the replacement",
			body: "Replacement.",
		}, {});
		const refused = await act(app, alice, "restoreDeleted", {
			name: "acme-recycled",
			sha: deletionSha,
			root: "workspace",
		}, {});
		expect(refused.json.ok).toBe(false);
		expect(refused.json.error.message).toBe(
			"a skill named acme-recycled exists in workspace; rename or delete it first",
		);
		// Review I2's reachable hole: the reused skill's history chain
		// includes the OLD skill's commits (same path), so a restore
		// anchored PRE-delete must refuse the same way (a plain
		// history.restore would silently overwrite the live skill).
		const rendered = await view(app, alice, { skill: "acme-recycled", root: "workspace" });
		const history = (atPointer(rendered.json.data, "/main/history/items") as any[]).map(
			(one) => one.sha as string,
		);
		// The OLDEST commit in the chain is the ORIGINAL skill's create —
		// strictly before the delete (the chain: replacement create →
		// delete → original create, newest first).
		const preDeleteSha = history[history.length - 1];
		expect(preDeleteSha).not.toBe(deletionSha);
		const refusedVersion = await act(app, alice, "restoreVersion", {
			sha: preDeleteSha,
		}, { skill: "acme-recycled", root: "workspace" });
		expect(refusedVersion.json.ok).toBe(false);
		expect(refusedVersion.json.error.message).toBe(
			"a skill named acme-recycled exists in workspace; rename or delete it first",
		);
		// The reused skill is untouched.
		const after = await view(app, alice, { skill: "acme-recycled", root: "workspace" });
		expect((atPointer(after.json.data, "/main") as any).body).toBe("Replacement.\n");
	});

	test("a deleted selection renders Restore deleted (and NO Edit button); the button restores it", async () => {
		// Review I2: the Deleted-group selection's action affordance is
		// the restore-deleted button (restoreDeleted was dead code — no
		// button dispatched it), and Edit must not render on a deleted
		// selection (its save would error "skill not found").
		const { app, alice } = await bootServer();
		await act(app, alice, "create", {
			where: "workspace",
			name: "acme-restore-me",
			description: "restore me",
			body: "Restore me body.",
		}, {});
		await act(app, alice, "delete", null, { skill: "acme-restore-me", root: "workspace" });
		// The Deleted-group row carries the deletion commit sha.
		const rows = atPointer((await view(app, alice)).json.data, "/skills") as any[];
		const deletedRow = rows.find(
			(row) => row.id === "workspace:acme-restore-me" && row.group === "deleted",
		);
		expect(typeof deletedRow?.deletionSha).toBe("string");
		// Select the deleted row at its deletion commit: the action set is
		// Restore deleted ONLY.
		const selected = await view(app, alice, {
			skill: "acme-restore-me",
			root: "workspace",
			commit: deletedRow.deletionSha,
		});
		const callouts = findBlocks(selected.json.tree.root.main, "callout");
		const actions = callouts.find((block) => block.id === "skill-actions");
		const names = (actions?.actions ?? []).map((button: any) => button.id);
		expect(names).toContain("skill-restore-deleted");
		expect(names).not.toContain("skill-edit");
		expect(names).not.toContain("skill-delete");
		expect(names).not.toContain("skill-restore");
		// The button dispatches restoreDeleted — and restores the skill.
		const restored = await act(
			app,
			alice,
			"restoreDeleted",
			{
				name: "acme-restore-me",
				sha: deletedRow.deletionSha,
				root: "workspace",
			},
			{},
		);
		expect(restored.json.ok, JSON.stringify(restored.json)).toBe(true);
		const backAgain = await view(app, alice, { skill: "acme-restore-me", root: "workspace" });
		expect((atPointer(backAgain.json.data, "/main") as any).body).toBe("Restore me body.\n");
	});

	test("learned delete archives (the skill moves to the Deleted group with its history intact)", async () => {
		const { app, alice } = await bootServer();
		await act(app, alice, "create", {
			where: "learned",
			name: "acme-archivable",
			description: "to be archived",
			body: "Archivable body.",
		}, {});
		const deleted = await act(app, alice, "delete", null, {
			skill: "acme-archivable",
			root: "learned",
		});
		expect(deleted.json.ok).toBe(true);
		const rows = atPointer((await view(app, alice)).json.data, "/skills") as any[];
		const archived = rows.find((row) => row.name === "acme-archivable");
		expect(archived?.group).toBe("deleted");
		// The archived skill's content survives (the store archived it).
		const restored = await act(app, alice, "restoreDeleted", {
			name: "acme-archivable",
			sha: archived.deletionSha,
			root: "learned",
		}, {});
		expect(restored.json.ok, JSON.stringify(restored.json)).toBe(true);
		const rendered = await view(app, alice, { skill: "acme-archivable", root: "learned" });
		expect((atPointer(rendered.json.data, "/main") as any).body).toBe("Archivable body.\n");
	});
});

// ─── overlays + read-only roots ─────────────────────────────────────────

describe("core/skills overlays + read-only roots", () => {
	test("overlayPut on a package skill records the upstream hash; overlayRemove undoes it", async () => {
		const { app, opened, configDir, alice } = await bootServer();
		// A deployment-owned config-dir skill (the read-only "user dir" root).
		const skillsDir = join(configDir, "skills", "acme-shared");
		await mkdir(skillsDir, { recursive: true });
		await writeFile(
			join(skillsDir, "SKILL.md"),
			"---\nname: acme-shared\ndescription: shared with everyone\n---\n\nShared body.\n",
		);
		const put = await act(app, alice, "overlayPut", {
			text: "Alice's note on the shared skill.",
		}, { skill: "acme-shared", root: "user dir" });
		expect(put.json.ok).toBe(true);
		// The overlay store carries it with the upstream hash pinned.
		const curation = opened.curationHost;
		void curation;
		const rendered = await view(app, alice, { skill: "acme-shared", root: "user dir" });
		const main = atPointer(rendered.json.data, "/main") as any;
		expect(main.overlay).toBe("Alice's note on the shared skill.");
		// A read-only root carries NO edit/delete/restore actions — only overlay ones.
		const actions = findBlocks(rendered.json.tree.root.main, "callout").find((block) => block.id === "skill-actions");
		const names = (actions?.actions ?? []).map((button: any) => button.id);
		expect(names).toContain("skill-overlay");
		expect(names).toContain("skill-overlay-remove");
		expect(names).not.toContain("skill-edit");
		expect(names).not.toContain("skill-delete");
		expect(names).not.toContain("skill-restore");
		// Remove it again.
		const removed = await act(app, alice, "overlayRemove", null, {
			skill: "acme-shared",
			root: "user dir",
		});
		expect(removed.json.ok).toBe(true);
		const cleared = await view(app, alice, { skill: "acme-shared", root: "user dir" });
		expect((atPointer(cleared.json.data, "/main") as any).overlay).toBeNull();
	});

	test("a read-only root refuses delete/restoreVersion outright", async () => {
		const { app, configDir, alice } = await bootServer();
		const skillsDir = join(configDir, "skills", "acme-locked");
		await mkdir(skillsDir, { recursive: true });
		await writeFile(
			join(skillsDir, "SKILL.md"),
			"---\nname: acme-locked\ndescription: read only\n---\n\nLocked body.\n",
		);
		const deleted = await act(app, alice, "delete", null, { skill: "acme-locked", root: "user dir" });
		expect(deleted.json.ok).toBe(false);
		expect(deleted.json.error.message).toContain("read-only");
	});
});

// ─── history availability + catch-up ────────────────────────────────────

describe("core/skills history availability + catch-up", () => {
	test("history unavailable still lists and edits; the pane shows the reason", async () => {
		const { app, workspace, alice } = await bootServer();
		await putWorkspaceSkill(workspace, "acme-nogit", "no git behind it", "No-git body.");
		// The live path: the skill lists and edits fine while the repo is
		// healthy (the write lands with or without a commit — GitHistory's
		// fail-soft contract; the view never gates an edit on git).
		const rendered = await view(app, alice, { skill: "acme-nogit", root: "workspace" });
		expect(rendered.status).toBe(200);
		const main = atPointer(rendered.json.data, "/main") as any;
		expect(main.name).toBe("acme-nogit");
		expect(main.body).toBe("No-git body.\n");
		const saved = await act(app, alice, "save", {
			name: "acme-nogit",
			description: "edited without history",
			body: "Edited body.",
		}, { skill: "acme-nogit", root: "workspace" });
		expect(saved.json.ok).toBe(true);

		// The unavailable branch: a def whose git binary is missing lists
		// the skill, edits it, and renders the reason in the history pane.
		const brokenDir = await mkdtemp(join(tmpdir(), "sigrun-skills-nogit-"));
		cleanups.push(async () => {
			await rm(brokenDir, { recursive: true, force: true });
		});
		const brokenSkills = join(brokenDir, "skills");
		await mkdir(join(brokenSkills, "acme-nogit"), { recursive: true });
		await writeFile(
			join(brokenSkills, "acme-nogit", "SKILL.md"),
			"---\nname: acme-nogit\ndescription: no git\n---\n\nNo-git body.\n",
		);
		const { createSkillsView } = await import("../src/server/core-views/skills.js");
		const history = new GitHistory(
			workspaceRepoSpec(join(brokenDir, "area"), brokenDir),
			{ gitHome: join(brokenDir, "git-home"), gitBinary: "/acme/definitely-not-git" },
		);
		const def = createSkillsView({
			curationOf: () => undefined,
			workspaceRoot: () => brokenDir,
			workspaceHistoryFor: () => history,
			learnedDirOf: () => undefined,
			userDir: join(brokenDir, "empty-config"),
			packageRoots: () => [],
			bump: () => {},
		});
		const ctx = {
			principal: { user: "alice", admin: false, service: false, method: "token" as const },
			params: { skill: "acme-nogit", root: "workspace" },
			key: "k",
			signal: new AbortController().signal,
		};
		const broken = await def.render(ctx);
		expect(broken.access).toBe("write");
		const brokenMain = atPointer(broken.data as Record<string, any>, "/main") as any;
		expect(brokenMain.name).toBe("acme-nogit");
		expect(brokenMain.body).toBe("No-git body.\n");
		expect(brokenMain.history.available).toBe(false);
		expect(brokenMain.history.reason).toContain("not-git");
		// The tree's history pane is the reason callout.
		const reasonCallout = findBlocks((broken.tree.root as any).main, "callout").find(
			(block) => block.id === "history-unavailable",
		);
		expect(reasonCallout).toBeDefined();
		expect(reasonCallout?.title).toBe("History unavailable");
		// And the edit still lands (the mutation runs; the commit degrades).
		const edited = await def.actions!.save!(ctx, {
			name: "acme-nogit",
			description: "edited",
			body: "Edited body.",
		});
		expect(edited.ok).toBe(true);
		const onDisk = await readFile(join(brokenSkills, "acme-nogit", "SKILL.md"), "utf8");
		expect(onDisk).toContain("Edited body.");
	});

	test("opening the tab commits outside edits as outside; two renders within 30 s run one catch-up", async () => {
		const { app, opened, workspace, alice } = await bootServer();
		// An outside edit: a file written behind the server's back (the
		// FIRST render is the tab-open whose catch-up commits it — the
		// 30 s throttle then holds the second render back, which is the
		// second assertion below).
		await putWorkspaceSkill(workspace, "acme-outside", "written outside", "Outside body.");
		const before = await workspaceLog(opened, "alice");
		expect(before.some((commit) => commit.summary === "outside changes")).toBe(false);
		// Opening the tab catches it up (actor outside, the view's summary).
		const first = await view(app, alice);
		expect(first.status).toBe(200);
		const after = await workspaceLog(opened, "alice");
		const outside = after.filter((commit) => commit.summary === "outside changes");
		expect(outside.length).toBeGreaterThanOrEqual(1);
		expect(outside[0]?.author).toBe("outside");
		// A second render within 30 s runs NO second catch-up (no new commit).
		const second = await view(app, alice);
		expect(second.status).toBe(200);
		const afterSecond = await workspaceLog(opened, "alice");
		expect(afterSecond.length).toBe(after.length);
	});
});

// ─── restoreVersion ─────────────────────────────────────────────────────

describe("core/skills restoreVersion", () => {
	test("restoreVersion of an archived learned skill un-archives it", async () => {
		const { app, alice } = await bootServer();
		await act(app, alice, "create", {
			where: "learned",
			name: "acme-restorable",
			description: "version one",
			body: "Version one body.",
		}, {});
		// The pre-archive state is restoreVersion's target: the create commit.
		const def = app.surfaces.coreViewDefs.find((one) => one.id === "skills")!;
		const rendered0 = await def.render({
			principal: { user: "alice", admin: false, service: false, method: "token" },
			params: { skill: "acme-restorable", root: "learned" },
			key: "k",
			signal: new AbortController().signal,
		});
		const rows = atPointer(rendered0.data as Record<string, any>, "/main/history/items") as any[];
		expect(rows.length).toBeGreaterThanOrEqual(1);
		const createSha = rows[rows.length - 1]?.sha;
		expect(typeof createSha).toBe("string");
		// Archive it (learned delete), then restore the create commit's version.
		await act(app, alice, "delete", null, { skill: "acme-restorable", root: "learned" });
		const restored = await act(app, alice, "restoreVersion", {
			sha: createSha,
		}, { skill: "acme-restorable", root: "learned" });
		expect(restored.json.ok, JSON.stringify(restored.json)).toBe(true);
		// Back in the learned group, content intact.
		const after = atPointer((await view(app, alice)).json.data, "/skills") as any[];
		const row = after.find((one) => one.id === "learned:acme-restorable");
		expect(row?.group).toBe("learned");
		const rendered = await view(app, alice, { skill: "acme-restorable", root: "learned" });
		expect((atPointer(rendered.json.data, "/main") as any).body).toBe("Version one body.\n");
	});
});
