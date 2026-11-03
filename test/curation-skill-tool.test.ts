/**
 * Task A6 (curator P3/P4): the `skill_manage` tool, per-run state and
 * usage telemetry — the per-run half. The tool installs into
 * `sigrun.skills` (present once its options carry the curation wiring);
 * `list`/`view` work for the conversation owner anywhere, mutating
 * actions run ONLY inside a curator run (`sigrun.curation.run`), the
 * store user comes from the run doc (never the calling principal), and
 * read-before-write requires the skill's name in `viewed` (appended by
 * `markViewed` through `api.commit`).
 *
 * Hermetic pattern: a real harness over tmp sqlite (the learned-root
 * boot shape minus the server), conversations with owners stamped the
 * route way, curator-run conversations created with the run doc in the
 * creating commit (the A9 producer's shape), and the tool driven
 * through a `ToolExecutionApi` fake whose `snapshot`/`commit` delegate
 * to the real harness (the curation-overlays toolApi shape plus the
 * real document surface).
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { Tx } from "@earendil-works/pi-durable";
import type {
	ConversationId,
	ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { CurationRunDoc, curationRun } from "../src/curation/run-doc.js";
import { SkillStore } from "../src/curation/store.js";
import {
	OVERLAY_HEADING,
	OverlayStore,
	hashSkill,
} from "../src/curation/overlays.js";
import {
	createSkillsExtension,
	type SkillsOptions,
} from "../src/skills/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { seededIdentity } from "./helpers/identity.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

const ACME = `---\nname: acme-deploy\ndescription: Deploy acme\n---\n# Deploy\n\nDeploy the acme way.\n`;
const RELEASE = `---\nname: acme-release\ndescription: Release acme\n---\n# Release\n\nCut the acme release.\n`;

// ---------------------------------------------------------------------------
// Boot + wiring
// ---------------------------------------------------------------------------

/** One user's curation stores (the A9 host.curation shape, test-owned). */
interface UserStores {
	readonly user: string;
	readonly userArea: string;
	readonly store: SkillStore;
	readonly overlays: OverlayStore;
}

async function bootHarness(): Promise<{ opened: OpenedHarness; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-skill-tool-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
		settingsDir: dir,
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { opened, dir };
}

/** One user's store pair over the data-dir user area. */
function userOf(dir: string, user: string): UserStores {
	const userArea = join(dir, "data", "users", user);
	const store = new SkillStore({
		userArea,
		user,
		now: () => new Date(),
		nameTakenElsewhere: async () => undefined,
		userExists: () => true,
	});
	const overlays = new OverlayStore({
		userArea,
		user,
		userExists: () => true,
		feed: store,
	});
	return { user, userArea, store, overlays };
}

/** Skills options carrying the curation wiring (the A6 seam shape). */
function skillsOptions(
	dir: string,
	users: Map<string, UserStores>,
): SkillsOptions {
	return {
		userDir: join(dir, "config", "skills"),
		learnedRoot: (owner) =>
			owner === undefined
				? undefined
				: join(dir, "data", "users", owner, "skills"),
		packageRoots: (): readonly { extension: string; dir: string }[] => [],
		sectionMaxBytes: () => 4096,
		overlays: (owner) => users.get(owner ?? "")?.overlays,
		skillStore: (user) => users.get(user ?? "")?.store,
	};
}

/** The skills extension's `skill_manage` tool (present once wired). */
function skillManageTool(opts: SkillsOptions) {
	const extension = createSkillsExtension(opts);
	const tool = extension.tools?.find((candidate) => candidate.name === "skill_manage");
	if (tool === undefined) throw new Error("skill_manage tool not installed");
	return tool;
}

/**
 * A `ToolExecutionApi` whose document surface is REAL: `snapshot` and
 * `commit` delegate to the harness (owner stamps and `markViewed` read
 * and write the actual conversation docs), while `output` captures the
 * streamed text.
 */
function toolApi(opened: OpenedHarness, conversationId: number) {
	const chunks: string[] = [];
	const api = {
		conversationId,
		env: undefined,
		output: (chunk: string | Uint8Array) => {
			chunks.push(
				typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
			);
		},
		snapshot: (token: never, id: never, ctx: never) =>
			opened.harness.snapshot(token, id, ctx),
		commit: async (change: (tx: Tx) => unknown, ctx: never) => {
			const conversation = await opened.harness.conversation(
				conversationId as ConversationId,
				BACKGROUND_CONTEXT,
			);
			if (conversation === undefined) throw new Error("conversation vanished");
			return conversation.commit(change as (tx: Tx) => unknown, ctx as never);
		},
	} as unknown as ToolExecutionApi;
	return { api, chunks };
}

/** One owned conversation (the owner stamped the route way). */
async function ownedConversation(
	opened: OpenedHarness,
	user: string,
): Promise<number> {
	const conversation = await opened.harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
		BACKGROUND_CONTEXT,
	);
	await opened.harness.commit(async (tx) => {
		const meta = await tx.doc(SessionMetaDoc, conversation.id);
		meta.owner = user;
	}, BACKGROUND_CONTEXT);
	return conversation.id as number;
}

/**
 * One curator-run conversation: the run doc written in the creating
 * commit (the A9 producer's shape — the doc predates every observer),
 * owner stamped to the curated user (markInternal's shape).
 */
async function runConversation(
	opened: OpenedHarness,
	run: { user: string; reviewId: string; parent?: number },
): Promise<number> {
	const conversation = await opened.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: opened.defaultModel },
			init: async (tx, id) => {
				const doc = await tx.doc(CurationRunDoc, id);
				doc.user = run.user;
				doc.reviewId = run.reviewId;
				doc.allow = [];
				if (run.parent !== undefined) doc.parent = run.parent;
				const meta = await tx.doc(SessionMetaDoc, id);
				meta.owner = run.user;
			},
		},
		BACKGROUND_CONTEXT,
	);
	return conversation.id as number;
}

/** The text output of a direct tool execution result. */
function outputText(result: {
	output?: { type: string; text?: string }[];
}): string {
	return (result.output ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

// ---------------------------------------------------------------------------
// The six brief scenarios
// ---------------------------------------------------------------------------

describe("skill_manage (curator P3 tool, per-run state)", () => {
	test("list and view work in an ordinary owned conversation", { timeout: 20_000 }, async () => {
		const { opened, dir } = await bootHarness();
		const alice = userOf(dir, "alice");
		await alice.store.apply(
			"acme-deploy",
			{ kind: "create", content: ACME },
			{ actor: "curator" },
		);
		const tool = skillManageTool(skillsOptions(dir, new Map([["alice", alice]])));
		const id = await ownedConversation(opened, "alice");
		const { api, chunks } = toolApi(opened, id);
		const list = await tool.execute({ action: "list" }, api, BACKGROUND_CONTEXT);
		expect(list.isError).toBeUndefined();
		expect(chunks.join("")).toContain("- acme-deploy: Deploy acme");
		const view = await tool.execute(
			{ action: "view", name: "acme-deploy" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(view.isError).toBeUndefined();
		expect(chunks.join("")).toContain("Deploy the acme way.");
		// No run doc exists — the view left nothing behind.
		expect(await curationRun(opened.harness, id as ConversationId, BACKGROUND_CONTEXT)).toBeUndefined();
	});

	test("mutating action outside a curator run is refused", { timeout: 20_000 }, async () => {
		const { opened, dir } = await bootHarness();
		const alice = userOf(dir, "alice");
		await alice.store.apply(
			"acme-deploy",
			{ kind: "create", content: ACME },
			{ actor: "curator" },
		);
		const tool = skillManageTool(skillsOptions(dir, new Map([["alice", alice]])));
		const id = await ownedConversation(opened, "alice");
		const { api } = toolApi(opened, id);
		const refused = await tool.execute(
			{
				action: "patch",
				name: "acme-deploy",
				old_text: "Deploy the acme way.",
				new_text: "Deploy the acme way, carefully.",
			},
			api,
			BACKGROUND_CONTEXT,
		);
		expect(refused.isError).toBe(true);
		expect(outputText(refused)).toMatch(/curator run/i);
		// Nothing was written.
		expect(
			await readFile(join(alice.userArea, "skills", "acme-deploy", "SKILL.md"), "utf8"),
		).toBe(ACME);
	});

	test("in a curator run, a patch without a prior view is refused; after view it lands", { timeout: 20_000 }, async () => {
		const { opened, dir } = await bootHarness();
		const alice = userOf(dir, "alice");
		await alice.store.apply(
			"acme-deploy",
			{ kind: "create", content: ACME },
			{ actor: "curator" },
		);
		const tool = skillManageTool(skillsOptions(dir, new Map([["alice", alice]])));
		const id = await runConversation(opened, { user: "alice", reviewId: "review-1" });
		const { api, chunks } = toolApi(opened, id);
		// Patch before any view: refused, nothing written.
		const refused = await tool.execute(
			{
				action: "patch",
				name: "acme-deploy",
				old_text: "Deploy the acme way.",
				new_text: "Deploy the acme way, carefully.",
			},
			api,
			BACKGROUND_CONTEXT,
		);
		expect(refused.isError).toBe(true);
		expect(outputText(refused)).toMatch(/view/i);
		// View lands and marks the skill viewed through the real doc.
		const view = await tool.execute(
			{ action: "view", name: "acme-deploy" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(view.isError).toBeUndefined();
		expect(chunks.join("")).toContain("Deploy the acme way.");
		const run = await curationRun(opened.harness, id as ConversationId, BACKGROUND_CONTEXT);
		expect(run?.viewed).toContain("acme-deploy");
		// The patch now lands: file on disk, details carry the curation change.
		const patched = await tool.execute(
			{
				action: "patch",
				name: "acme-deploy",
				old_text: "Deploy the acme way.",
				new_text: "Deploy the acme way, carefully.",
			},
			api,
			BACKGROUND_CONTEXT,
		);
		expect(patched.isError).toBeUndefined();
		expect(patched.details).toMatchObject({
			curation: {
				changeId: expect.any(String) as unknown,
				summary: expect.stringContaining("acme-deploy") as unknown,
			},
		});
		expect(
			await readFile(join(alice.userArea, "skills", "acme-deploy", "SKILL.md"), "utf8"),
		).toContain("carefully");
		// The feed entry records the run.
		const entries = await alice.store.feed(3);
		expect(
			entries.some(
				(entry) => entry.action === "patch" && entry.reviewId === "review-1",
			),
		).toBe(true);
	});

	test("in a curator run, an empty-text create or write_file is refused and records no feed entry", { timeout: 20_000 }, async () => {
		const { opened, dir } = await bootHarness();
		const alice = userOf(dir, "alice");
		const tool = skillManageTool(skillsOptions(dir, new Map([["alice", alice]])));
		const id = await runConversation(opened, { user: "alice", reviewId: "review-empty" });
		const { api } = toolApi(opened, id);
		// An empty-text create: the phantom-empty-entry class — refused,
		// nothing on disk, no feed entry.
		const created = await tool.execute(
			{ action: "create", name: "acme-ghost", content: "" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(created.isError).toBe(true);
		expect(outputText(created)).toMatch(/empty/i);
		expect((await alice.store.list()).some((row) => row.name === "acme-ghost")).toBe(false);
		// An empty-text write_file on an existing skill: refused the same way.
		await alice.store.apply(
			"acme-deploy",
			{ kind: "create", content: ACME },
			{ actor: "curator" },
		);
		await tool.execute({ action: "view", name: "acme-deploy" }, api, BACKGROUND_CONTEXT);
		const written = await tool.execute(
			{ action: "write_file", name: "acme-deploy", file_path: "references/runbook.md", content: "" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(written.isError).toBe(true);
		expect(outputText(written)).toMatch(/empty/i);
		await expect(
			readFile(join(alice.userArea, "skills", "acme-deploy", "references", "runbook.md"), "utf8"),
		).rejects.toThrow();
		// Neither refusal reached the feed.
		const entries = await alice.store.feed(10);
		expect(
			entries.some(
				(entry) =>
					(entry.action === "create" && entry.skill === "acme-ghost") ||
					(entry.action === "write_file" && entry.skill === "acme-deploy"),
			),
		).toBe(false);
	});

	test("a non-ENOENT failure reading the learned root surfaces instead of degrading to unknown skill", { timeout: 20_000 }, async () => {
		const { opened, dir } = await bootHarness();
		const alice = userOf(dir, "alice");
		await alice.store.apply(
			"acme-deploy",
			{ kind: "create", content: ACME },
			{ actor: "curator" },
		);
		// A store whose view throws EACCES (a permissions failure, not a
		// missing file): the tool must surface it — failing open into
		// "unknown skill" would trap the run in a view-first loop.
		const broken: UserStores = {
			...alice,
			store: Object.assign(Object.create(Object.getPrototypeOf(alice.store)), alice.store, {
				view: async () => {
					const cause = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
					cause.code = "EACCES";
					throw cause;
				},
			}) as SkillStore,
		};
		const tool = skillManageTool(skillsOptions(dir, new Map([["alice", broken]])));
		const id = await runConversation(opened, { user: "alice", reviewId: "review-eacces" });
		const { api } = toolApi(opened, id);
		await expect(
			tool.execute({ action: "view", name: "acme-deploy" }, api, BACKGROUND_CONTEXT),
		).rejects.toThrow(/EACCES/);
	});

	test("in a curator run on alice's behalf, writes land in alice's store even when the run's parent was bob-shared", { timeout: 20_000 }, async () => {
		const { opened, dir } = await bootHarness();
		const alice = userOf(dir, "alice");
		const bob = userOf(dir, "bob");
		const tool = skillManageTool(
			skillsOptions(
				dir,
				new Map([
					["alice", alice],
					["bob", bob],
				]),
			),
		);
		const parent = await ownedConversation(opened, "bob");
		const id = await runConversation(opened, {
			user: "alice",
			reviewId: "review-2",
			parent,
		});
		const { api } = toolApi(opened, id);
		const created = await tool.execute(
			{ action: "create", name: "acme-release", content: RELEASE },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(created.isError).toBeUndefined();
		// The write landed in ALICE's store — the run doc's user, never the
		// parent's owner.
		expect(
			await readFile(join(alice.userArea, "skills", "acme-release", "SKILL.md"), "utf8"),
		).toBe(RELEASE);
		expect(
			await readdir(join(dir, "data", "users", "bob", "skills")).catch(() => ["<absent>"]),
		).toEqual(["<absent>"]);
	});

	test("ownerless conversation: list/view answer that there is no owner", { timeout: 20_000 }, async () => {
		const { opened, dir } = await bootHarness();
		const alice = userOf(dir, "alice");
		await alice.store.apply(
			"acme-deploy",
			{ kind: "create", content: ACME },
			{ actor: "curator" },
		);
		const tool = skillManageTool(skillsOptions(dir, new Map([["alice", alice]])));
		const conversation = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		const { api } = toolApi(opened, conversation.id as number);
		const list = await tool.execute({ action: "list" }, api, BACKGROUND_CONTEXT);
		expect(list.isError).toBe(true);
		expect(outputText(list)).toMatch(/no owner/i);
		const view = await tool.execute(
			{ action: "view", name: "acme-deploy" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(view.isError).toBe(true);
		expect(outputText(view)).toMatch(/no owner/i);
	});
});

// ---------------------------------------------------------------------------
// The overlay actions against the LIVE upstream (final review fix wave):
// the overlay action must hash the CURRENT upstream body resolved through
// the A5 machinery (the learned root is by construction absent for an
// overlay target — hashing it stored `""` and every tool-written overlay
// read as drifted), and `view` must serve upstream-only names (the stored
// overlay + the upstream body) so an overlay replace/remove can satisfy
// read-before-write at all (the learned-root view ENOENTs for them).
// ---------------------------------------------------------------------------

describe("skill_manage overlay actions over the live upstream", () => {
	const UPSTREAM = `---\nname: acme-upstream\ndescription: Deploy acme\n---\n# Upstream\n\nDeploy the acme way.\n`;

	/** Write the user-dir upstream skill most tests overlay. */
	async function writeUpstream(dir: string): Promise<void> {
		await mkdir(join(dir, "config", "skills", "acme-upstream"), {
			recursive: true,
		});
		await writeFile(
			join(dir, "config", "skills", "acme-upstream", "SKILL.md"),
			UPSTREAM,
		);
	}

	test("overlay create hashes the CURRENT upstream body (never the learned root)", { timeout: 20_000 }, async () => {
		const { opened, dir } = await bootHarness();
		const alice = userOf(dir, "alice");
		await writeUpstream(dir);
		const tool = skillManageTool(skillsOptions(dir, new Map([["alice", alice]])));
		const id = await runConversation(opened, {
			user: "alice",
			reviewId: "review-o1",
		});
		const { api } = toolApi(opened, id);
		const created = await tool.execute(
			{
				action: "overlay",
				name: "acme-upstream",
				content: "Prefer the blue button.",
				overlay_root: "user dir",
			},
			api,
			BACKGROUND_CONTEXT,
		);
		expect(created.isError).toBeUndefined();
		const stored = await alice.overlays.get({
			root: "user dir",
			skill: "acme-upstream",
		});
		expect(stored?.upstreamHash).toBe(hashSkill(UPSTREAM));
	});

	test("overlay create on a name with no live upstream is refused, naming the skill, and writes nothing", { timeout: 20_000 }, async () => {
		const { opened, dir } = await bootHarness();
		const alice = userOf(dir, "alice");
		const tool = skillManageTool(skillsOptions(dir, new Map([["alice", alice]])));
		const id = await runConversation(opened, {
			user: "alice",
			reviewId: "review-o2",
		});
		const { api } = toolApi(opened, id);
		const refused = await tool.execute(
			{
				action: "overlay",
				name: "acme-vanished",
				content: "Notes for a skill that is not there.",
				overlay_root: "user dir",
			},
			api,
			BACKGROUND_CONTEXT,
		);
		expect(refused.isError).toBe(true);
		expect(outputText(refused)).toContain("acme-vanished");
		expect(await alice.overlays.list()).toEqual([]);
	});

	test("view serves the stored overlay + upstream for an upstream-only name and feeds read-before-write; replace and remove then land", { timeout: 20_000 }, async () => {
		const { opened, dir } = await bootHarness();
		const alice = userOf(dir, "alice");
		await writeUpstream(dir);
		const tool = skillManageTool(skillsOptions(dir, new Map([["alice", alice]])));
		const id = await runConversation(opened, {
			user: "alice",
			reviewId: "review-o3",
		});
		const { api, chunks } = toolApi(opened, id);
		// A FIRST overlay needs no prior view (it does not exist yet).
		const created = await tool.execute(
			{ action: "overlay", name: "acme-upstream", content: "Prefer the blue button." },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(created.isError).toBeUndefined();
		// The learned-root view ENOENTs for this name; the tool must still
		// serve it (upstream body + the stored overlay under the heading)...
		const view = await tool.execute(
			{ action: "view", name: "acme-upstream" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(view.isError).toBeUndefined();
		const seen = chunks.join("");
		expect(seen).toContain("Deploy the acme way.");
		expect(seen).toContain(OVERLAY_HEADING);
		expect(seen).toContain("Prefer the blue button.");
		// ...and the view feeds the run's read-before-write ledger.
		const run = await curationRun(
			opened.harness,
			id as ConversationId,
			BACKGROUND_CONTEXT,
		);
		expect(run?.viewed).toContain("acme-upstream");
		// Replacing the EXISTING overlay now passes read-before-write.
		const replaced = await tool.execute(
			{ action: "overlay", name: "acme-upstream", content: "Prefer the green button." },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(replaced.isError).toBeUndefined();
		expect(
			(await alice.overlays.get({ root: "user dir", skill: "acme-upstream" }))
				?.text,
		).toBe("Prefer the green button.");
		// And so does removing it.
		const removed = await tool.execute(
			{ action: "overlay", name: "acme-upstream", remove: true },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(removed.isError).toBeUndefined();
		expect(
			await alice.overlays.get({ root: "user dir", skill: "acme-upstream" }),
		).toBeUndefined();
	});

	test("view of a name with no learned copy, no overlay, and no resolvable upstream still errors", { timeout: 20_000 }, async () => {
		const { opened, dir } = await bootHarness();
		const alice = userOf(dir, "alice");
		const tool = skillManageTool(skillsOptions(dir, new Map([["alice", alice]])));
		const id = await runConversation(opened, {
			user: "alice",
			reviewId: "review-o4",
		});
		const { api } = toolApi(opened, id);
		const refused = await tool.execute(
			{ action: "view", name: "acme-nowhere" },
			api,
			BACKGROUND_CONTEXT,
		);
		expect(refused.isError).toBe(true);
		expect(outputText(refused)).toContain("acme-nowhere");
	});
});
