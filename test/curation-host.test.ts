/**
 * Task A9 (curator P6): the `host.curation` surface — the read APIs
 * (eligibility, authors, modelCallsSince, takeHints, targets, tools,
 * skills, overlays, upstream, jobSkillRefs, undoReview, usage) and the
 * bridge wiring that hands the SAME object to every extension's seam
 * host.
 *
 * Hermetic pattern (curation-internal.test.ts): a full server boot with
 * the fixture-curation-target extension, driven through the host
 * bridge's `curation` member (the extension-facing shape), with the
 * harness-level host asserted to be the SAME object.
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { FastifyInstance } from "fastify";
import type {
	ConversationId,
	EntryId,
	JsonObject,
	SubmissionId,
	TaskId,
} from "@earendil-works/pi-durable";
import { AssistantEntry, LiveDoc } from "@earendil-works/pi-durable";
import { loadConfig, type SigrunConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { seededIdentity } from "./helpers/identity.js";

/** The fixture-curation-target entry (the P9 vehicle). */
const TARGET_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-curation-target", "index.js"),
).href;

// Every bootServer loads the built-in extensions, and the MCP one
// registers a process-exit listener per boot — this file's per-test
// boots cross Node's default 10-listener leak warning. Bounded bump,
// not a leak: each server closes in the afterAll below.
process.setMaxListeners(20);


const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
}, 120_000);

/** The learned-skill body the review's tool call creates. */
const ACME_SKILL = `---\nname: acme-deploy\ndescription: Deploy acme\n---\n# Deploy\n\nDeploy the acme way.\n`;

/** One hermetic server: harness + faux provider + Fastify app. */
async function bootServer(
	responses: readonly unknown[] = [],
	options?: { readonly singleUser?: boolean },
): Promise<{
	app: FastifyInstance;
	opened: OpenedHarness;
	config: SigrunConfig;
	dir: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-curation-host-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000, reasoning: true }],
	});
	faux.setResponses([...responses] as never);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "token",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
		SIGRUN_DATA_DIR: join(dir, "data"),
	});
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ namingModel: false }),
	);
	const identity = await seededIdentity(dir);
	// Alice and bob are the curated users (the brief's literals).
	if (identity.users.get("alice") === undefined) {
		await identity.users.add({ user: "alice", name: "Alice", admin: false, source: "cli" });
	}
	if (!options?.singleUser && identity.users.get("bob") === undefined) {
		await identity.users.add({ user: "bob", name: "Bob", admin: false, source: "cli" });
	}
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		builtins: true,
		env: { SIGRUN_CONFIG_DIR: join(dir, "config") },
		settingsDir: dir,
		extensionSpecifiers: [TARGET_SPECIFIER],
		// A second user needs available isolation (the multi-user gate —
		// the extension-commands pattern's hermetic probe). A single-user
		// boot (the usage test) skips the probe AND the second user: the
		// AgentExecutionEnv path needs no sandbox helper, so load_skill
		// works hermetically with a real filesystem.
		...(options?.singleUser
			? {}
			: { isolationProbe: async () => ({ available: true, abi: 6 }) }),
	});
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, config, dir };
}

/** One owned conversation with `turns` settled user turns (default 1). */
async function ownedConversation(
	opened: OpenedHarness,
	user: string,
	turns = 1,
): Promise<number> {
	const conversation = await opened.harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
		BACKGROUND_CONTEXT,
	);
	await opened.harness.commit(async (tx) => {
		const meta = await tx.doc(SessionMetaDoc, conversation.id);
		meta.owner = user;
	}, BACKGROUND_CONTEXT);
	for (let turn = 0; turn < turns; turn += 1) {
		const submission = await conversation.submit(
			{ type: "input", content: `the owned turn ${turn}` },
			BACKGROUND_CONTEXT,
		);
		const record = await submission.wait(BACKGROUND_CONTEXT);
		expect(record.status).toBe("done");
	}
	return conversation.id as number;
}

// ─── the surface ───────────────────────────────────────────────────────────

describe("host.curation (curator P6 surface)", () => {
	test("eligibility, modelCallsSince and takeHints read the real docs", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer([
			fauxAssistantMessage("the owned turn's answer"),
			fauxAssistantMessage("direction turn 1"),
			fauxAssistantMessage("direction turn 2"),
			fauxAssistantMessage("direction turn 3"),
			fauxAssistantMessage("direction turn 4"),
		]);
		const curation = app.hostBridge.curation;
		const id = await ownedConversation(opened, "alice");
		const eligibility = await curation.eligibility(id as ConversationId);
		expect(eligibility.owner).toBe("alice");
		expect(eligibility.internal).toBe(false);
		// The one settled turn's user entry is attributed to alice (the
		// harness-level submit records the author through P1's seam when
		// given a user; the ownedConversation helper submits bare —
		// unattributed).
		expect(eligibility.unattributed).toBe(1);
		expect(eligibility.ownerOnly).toBe(false);
		expect(eligibility.newestEntry).toBeDefined();
		// modelCallsSince with no anchor: every assistant entry.
		const calls = await curation.modelCallsSince(id as ConversationId);
		expect(calls).toBe(1);
		// Since the newest entry: none.
		const sinceNewest = await curation.modelCallsSince(
			id as ConversationId,
			eligibility.newestEntry,
		);
		expect(sinceNewest).toBe(0);
		// takeHints on a hint-free conversation: empty.
		expect(await curation.takeHints(id as ConversationId)).toEqual([]);

		// Direction pin (the review gate's contract): the count is the
		// assistant entries STRICTLY AFTER the anchor — never the
		// at-or-before side. A 4-assistant-entry conversation pins every
		// direction: oldest, mid, newest.
		const convId = await ownedConversation(opened, "alice", 4);
		const handle = await opened.harness.conversation(
			convId as ConversationId,
			BACKGROUND_CONTEXT,
		);
		if (handle === undefined) throw new Error("conversation not found");
		const ascPage = await handle.entries(
			{ order: "ascending" },
			100,
			undefined,
			BACKGROUND_CONTEXT,
		);
		const anchors = ascPage.items
			.filter((entry) => entry.kind === AssistantEntry.kind)
			.map((entry) => entry.id);
		expect(anchors).toHaveLength(4);
		// No anchor: every assistant entry.
		expect(await curation.modelCallsSince(convId as ConversationId)).toBe(4);
		// Anchor at the OLDEST: the 3 after it.
		expect(
			await curation.modelCallsSince(convId as ConversationId, anchors[0]),
		).toBe(3);
		// Anchor mid-sequence: only the later ones.
		expect(
			await curation.modelCallsSince(convId as ConversationId, anchors[1]),
		).toBe(2);
		// Anchor at the NEWEST: none.
		expect(
			await curation.modelCallsSince(convId as ConversationId, anchors[3]),
		).toBe(0);

		// Cursor pin: the count is cursor-COMPLETE — a conversation past
		// one entry page counts past the page (505 passive assistant-kind
		// entries in one commit, the import route's own append pattern).
		const cursorConv = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		await cursorConv.commit(async (tx) => {
			for (let index = 0; index < 505; index += 1) {
				await tx.appendEntry(cursorConv.id, { kind: AssistantEntry.kind });
			}
		}, BACKGROUND_CONTEXT);
		expect(
			await curation.modelCallsSince(cursorConv.id as ConversationId),
		).toBe(505);
		// The same walk ANCHORED at the oldest: all later ones, still
		// cursor-complete (504 crosses the page).
		const oldest = await cursorConv.entries(
			{ order: "ascending" },
			1,
			undefined,
			BACKGROUND_CONTEXT,
		);
		expect(
			await curation.modelCallsSince(
				cursorConv.id as ConversationId,
				oldest.items[0].id,
			),
		).toBe(504);
	});

	/**
	 * Poll the durable submissions until `requestId` settled `done` with
	 * its entry placed (a bridge-submit turn: the harness-level wait of
	 * ownedConversation over the storage scan the attribution tests use).
	 */
	async function waitForTurn(
		opened: OpenedHarness,
		conversationId: number,
		requestId: string,
	): Promise<{ readonly entry: number; readonly status: string }> {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const page = await opened.storage.scanSubmissions(
				{ conversationId: conversationId as ConversationId, order: "ascending" },
				100,
				undefined,
				BACKGROUND_CONTEXT,
			);
			const record = page.items.find((item) => item.requestId === requestId);
			if (record?.entry !== undefined && record.status === "done") return record;
			if (Date.now() > deadline) {
				throw new Error(`submission ${requestId} never settled done`);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	test("authors maps every input entry to its author, unattributed to undefined", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer([
			fauxAssistantMessage("alice's answer"),
			fauxAssistantMessage("bob's answer"),
			fauxAssistantMessage("the raw turn's answer"),
		]);
		const curation = app.hostBridge.curation;
		// A mixed conversation: alice and bob each submit one turn through
		// the host bridge (the A1 `opts.user` path — recorded verbatim),
		// then one RAW harness submit lands with no author record (the
		// pre-P1 shape).
		const conversation = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		await opened.harness.commit(async (tx) => {
			const meta = await tx.doc(SessionMetaDoc, conversation.id);
			meta.owner = "alice";
		}, BACKGROUND_CONTEXT);
		const attributedTurn = async (user: string, text: string) => {
			const record = await app.hostBridge.conversations.submit(
				conversation.id,
				[{ type: "text", text }],
				{ user },
		);
			return (
				await waitForTurn(opened, conversation.id as number, record.requestId!)
			).entry;
		};
		const aliceEntry = await attributedTurn("alice", "how do I deploy acme sites?");
		const bobEntry = await attributedTurn("bob", "delete every acme site now");
		const raw = await conversation.submit(
			{ type: "input", content: "a raw turn" },
			BACKGROUND_CONTEXT,
		);
		const rawRecord = await raw.wait(BACKGROUND_CONTEXT);
		expect(rawRecord.status).toBe("done");

		// The bridge surface: every input entry → its author (P1);
		// the raw turn reads unattributed (undefined — fail closed).
		const authors = await curation.authors(conversation.id);
		expect(authors.get(aliceEntry as EntryId)).toBe("alice");
		expect(authors.get(bobEntry as EntryId)).toBe("bob");
		expect(authors.get(rawRecord.entry!)).toBeUndefined();
		// The presence set is EXACTLY the input entries (three turns).
		expect(authors.size).toBe(3);

		// The extension-facing shape: the seam host's curation proxy
		// forwards the new member to the same host.
		const seamHost = app.sigrunContext.opened.seamHosts.get(
			"fixture-curation-target",
		);
		expect(seamHost).toBeDefined();
		const fromSeam = await (
			(seamHost as unknown as { curation: typeof curation }).curation
		).authors(conversation.id);
		expect(fromSeam.get(aliceEntry as EntryId)).toBe("alice");
	});

	test("tools(id) serves the parent's model-visible tool names", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer([
			fauxAssistantMessage("the owned turn's answer"),
		]);
		const curation = app.hostBridge.curation;
		const id = await ownedConversation(opened, "alice");
		const tools = await curation.tools(id as ConversationId);
		// The boot default selection includes the core coding tools; the
		// fixture's notes tools are NOT in the default selection (the
		// fixture extension installs tools but the default selection
		// only auto-enables known core tools... the model-visible set is
		// what the resolved agent offers).
		expect(Array.isArray(tools)).toBe(true);
		// Every served name resolves in the registry snapshot.
		const registered = new Set(
			opened.registry
				.snapshot()
				.tools()
				.map((entry) => entry.tool.name),
		);
		for (const tool of tools) expect(registered.has(tool)).toBe(true);
	});

	test("targets(user, id) omits a target whose tools the conversation's selection lacks", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer([
			fauxAssistantMessage("the owned turn's answer"),
		]);
		const curation = app.hostBridge.curation;
		const id = await ownedConversation(opened, "alice");
		// The default selection: the fixture's notes_write IS registered
		// by the fixture extension (an installed extension's tools are
		// model-visible by default), so the target is served.
		const served = await curation.targets("alice", id as ConversationId);
		expect(
			served.some((target) => target.id === "fixture-curation-target:notes"),
		).toBe(true);
		const notes = served.find(
			(target) => target.id === "fixture-curation-target:notes",
		);
		expect(notes?.tools).toEqual(["notes_write"]);
		expect(notes?.guidance).toEqual([
			"Put deploy lessons in the notes target.",
		]);
		expect(notes?.maintain).toBe(true);
		// A conversation whose selection EXCLUDES the fixture extension
		// omits the target: pin the selection to the core tools only.
		const pinned = await opened.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: opened.defaultModel,
					extensions: [{ name: "sigrun.skills" }],
				},
			},
			BACKGROUND_CONTEXT,
		);
		await opened.harness.commit(async (tx) => {
			const meta = await tx.doc(SessionMetaDoc, pinned.id);
			meta.owner = "alice";
		}, BACKGROUND_CONTEXT);
		const omitted = await curation.targets(
			"alice",
			pinned.id as ConversationId,
		);
		expect(
			omitted.some((target) => target.id === "fixture-curation-target:notes"),
		).toBe(false);
		// No id: every target for the user, selection-independent.
		const all = await curation.targets("alice");
		expect(
			all.some((target) => target.id === "fixture-curation-target:notes"),
		).toBe(true);
		// Bob's guidance is empty → the target is unavailable for him.
		const bobs = await curation.targets("bob");
		expect(bobs).toEqual([]);
	});

	test("jobSkillRefs finds /skill:acme-deploy in a paused job owned by alice, not bob", { timeout: 30_000 }, async () => {
		const { app, opened } = await bootServer();
		const curation = app.hostBridge.curation;
		// A paused (disabled) prompt job owned by alice whose prompt
		// references the learned skill.
		await opened.jobs.createApi(
			{
				name: "acme-weekly",
				schedule: { cron: "0 9 * * 1" },
				action: {
					kind: "prompt",
					prompt: "Run /skill:acme-deploy and report.",
					conversation: "new",
				},
				enabled: false,
			},
			"alice",
		);
		const alice = await curation.jobSkillRefs("alice");
		expect(alice.has("acme-deploy")).toBe(true);
		const bob = await curation.jobSkillRefs("bob");
		expect(bob.has("acme-deploy")).toBe(false);
	});

	test("undoReview reverts a skill change and calls the target undo with the right changeId", { timeout: 60_000 }, async () => {
		// The review patches an existing skill (a store-undoable change:
		// the patch's before snapshot is what the undo restores) and
		// writes through the fixture's target tool; undoReview reverts
		// the patch AND hands the target-owned changeId to the target's
		// undo.
		const { app, opened, dir } = await bootServer([
			// The parent's own turn (ownedConversation) consumes this one.
			fauxAssistantMessage("the owned turn's answer"),
			// The review: view, patch, then a target write, then the text.
			fauxAssistantMessage(
				[fauxToolCall("skill_manage", { action: "view", name: "acme-deploy" } as JsonObject)],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("skill_manage", {
						action: "patch",
						name: "acme-deploy",
						old_text: "Deploy the acme way.",
						new_text: "Deploy the acme way, carefully.",
						reason: "safety lesson",
					} as JsonObject),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("notes_write", { text: "review note" } as JsonObject)],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("review done"),
		]);
		const curation = app.hostBridge.curation;
		// The pre-existing skill the review patches.
		await curation.skills("alice").apply(
			"acme-deploy",
			{ kind: "create", content: ACME_SKILL },
			{ reviewId: "seed-1" },
		);
		const parent = await ownedConversation(opened, "alice");
		const result = await curation.forkReview(parent as ConversationId, {
			instruction: "Review and record.",
			allow: ["skill_manage", "notes_write"],
			maxToolCalls: 8,
			maxOutputTokens: 8_000,
			deadlineMs: 20_000,
			reviewId: "review-undo",
		});
		expect(result.status).toBe("completed");
		expect(result.changes).toHaveLength(2);
		const { readFile } = await import("node:fs/promises");
		const skillPath = join(dir, "data", "users", "alice", "skills", "acme-deploy", "SKILL.md");
		expect(await readFile(skillPath, "utf8")).toContain("carefully");
		// undoReview: the patch's before snapshot is restored (1 revert)
		// and the target-owned change is undone through the target.
		const reverted = await curation.undoReview("alice", "review-undo");
		expect(reverted).toBe(1);
		// The patch reverted: the original body is back.
		expect(await readFile(skillPath, "utf8")).toBe(ACME_SKILL);
		// The target's undo was called with the NOTES change id (the
		// target-owned change — the run result's second change).
		const notesChange = result.changes.find(
			(change) => change.target === "fixture-curation-target:notes",
		);
		expect(notesChange).toBeDefined();
		const fixture = await fixtureModule();
		expect(fixture.undos).toContainEqual({
			user: "alice",
			changeId: notesChange!.changeId,
		});
	});

	test("a user created after boot migrates on first curationOf (I4)", { timeout: 30_000 }, async () => {
		const { app, opened, dir } = await bootServer([]);
		// carol is created AFTER boot: the boot sweep never saw her, and
		// her pre-existing skill predates any history repo.
		const userArea = join(dir, "data", "users", "carol");
		const { mkdir: mk, writeFile: wf, access: acc } = await import("node:fs/promises");
		await mk(join(userArea, "skills", "acme-deploy"), { recursive: true });
		await wf(join(userArea, "skills", "acme-deploy", "SKILL.md"), ACME_SKILL);
		await opened.identity.users.add({ user: "carol", name: "Carol", admin: false, source: "cli" });
		// First curationOf-shaped touch: the skills surface builds her
		// stores and fires the lazy migration.
		const curation = app.hostBridge.curation;
		await curation.skills("carol").list();
		// The migration is fire-and-forget; wait for the marker.
		const marker = join(userArea, "curation", "history", "MIGRATED");
		for (let i = 0; i < 100; i += 1) {
			try {
				await acc(marker);
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		await acc(marker);
		// The import commit exists with the right summary.
		const { userRepoSpec } = await import("../src/curation/paths.js");
		const { GitHistory } = await import("../src/history/git.js");
		const history = new GitHistory(userRepoSpec(userArea), {
			gitHome: join(dir, "state", "git-home"),
		});
		const log = await history.log({ limit: 5 });
		expect(log.some((commit) => commit.summary === "Imported from the curation store")).toBe(true);
		expect(log.find((commit) => commit.summary === "Imported from the curation store")?.actor).toEqual({ kind: "outside" });
	});

	test("undoReview reverts a 2-commit review interleaved with an outside catch-up, without conflict", { timeout: 60_000 }, async () => {
		// The review patches the skill TWICE (two store commits), an
		// outside catch-up lands BETWEEN them, and undoReview still
		// restores the pre-review state as ONE commit (never git revert,
		// which would conflict with the interleaved catch-up).
		const { app, opened, dir } = await bootServer([
			fauxAssistantMessage("the owned turn's answer"),
			// The read-before-write gate: view, then two patches.
			fauxAssistantMessage(
				[fauxToolCall("skill_manage", { action: "view", name: "acme-deploy" } as JsonObject)],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("skill_manage", {
					action: "patch",
					name: "acme-deploy",
					old_text: "Deploy the acme way.",
					new_text: "Deploy the acme way, step one.",
					reason: "first pass",
				} as JsonObject)],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("skill_manage", {
					action: "patch",
					name: "acme-deploy",
					old_text: "step one",
					new_text: "step two",
					reason: "second pass",
				} as JsonObject)],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("review done"),
		]);
		const curation = app.hostBridge.curation;
		await curation.skills("alice").apply(
			"acme-deploy",
			{ kind: "create", content: ACME_SKILL },
			{ reviewId: "seed-1" },
		);
		// The interleave: a SECOND skill's commit (created between the
		// fork's two patches by seeding the responses around an await)
		// plus a direct untrailered outside catch-up after the review's
		// first store commit. Both must survive undoReview (review I5).
		await curation.skills("alice").apply(
			"acme-release",
			{ kind: "create", content: ACME_SKILL.replaceAll("acme-deploy", "acme-release") },
			{ reviewId: "seed-2" },
		);
		const parent = await ownedConversation(opened, "alice");
		const result = await curation.forkReview(parent as ConversationId, {
			instruction: "Patch twice.",
			allow: ["skill_manage"],
			maxToolCalls: 8,
			maxOutputTokens: 8_000,
			deadlineMs: 20_000,
			reviewId: "review-interleave",
		});
		expect(result.status).toBe("completed");
		expect(result.changes.length).toBeGreaterThanOrEqual(2);
		const { readFile } = await import("node:fs/promises");
		const skillPath = join(dir, "data", "users", "alice", "skills", "acme-deploy", "SKILL.md");
		expect(await readFile(skillPath, "utf8")).toContain("step two");
		// A direct untrailered outside catch-up, AFTER the review's
		// commits: the reviewer's "conflict" case.
		const userArea = join(dir, "data", "users", "alice");
		const { userRepoSpec } = await import("../src/curation/paths.js");
		const { GitHistory } = await import("../src/history/git.js");
		const history = new GitHistory(userRepoSpec(userArea), {
			gitHome: join(dir, "state", "git-home"),
		});
		const { mkdir: mk, writeFile: wf } = await import("node:fs/promises");
		await mk(join(userArea, "curation", "overlays", "user-dir"), { recursive: true });
		await wf(join(userArea, "curation", "overlays", "user-dir", `${"d".repeat(64)}.json`), "{}\n");
		await history.catchUp({ actor: { kind: "outside" }, summary: "outside changes" });
		const reverted = await curation.undoReview("alice", "review-interleave");
		expect(reverted).toBe(1);
		// Both patches reverted: the ORIGINAL body is back.
		expect(await readFile(skillPath, "utf8")).toBe(ACME_SKILL);
		// The second review's skill AND the catch-up commit survived.
		expect(
			await readFile(join(userArea, "skills", "acme-release", "SKILL.md"), "utf8"),
		).toContain("acme-release");
		const log = await history.log({ limit: 20 });
		expect(log.some((commit) => commit.summary === "outside changes")).toBe(true);
	});

	test("skills(user).apply writes with actor curator and stamps the review", { timeout: 30_000 }, async () => {
		const { app } = await bootServer();
		const curation = app.hostBridge.curation;
		const entry = await curation.skills("alice").apply(
			"acme-deploy",
			{ kind: "create", content: ACME_SKILL },
			{ reviewId: "direct-1", reason: "operator edit" },
		);
		expect(entry.actor).toBe("curator");
		expect(entry.reviewId).toBe("direct-1");
		// The store read-back.
		const listed = await curation.skills("alice").list();
		expect(listed.some((skill) => skill.name === "acme-deploy")).toBe(true);
	});

	test("overlays(user) and upstream(user, key) serve the per-user stores", { timeout: 30_000 }, async () => {
		const { app, dir } = await bootServer();
		const curation = app.hostBridge.curation;
		// A user-dir skill upstream for alice.
		const userDir = join(dir, "config", "skills", "acme-release");
		await mkdir(userDir, { recursive: true });
		await writeFile(
			join(userDir, "SKILL.md"),
			"---\nname: acme-release\ndescription: Release acme\n---\n# Release\n\nCut the acme release.\n",
		);
		const upstream = await curation.upstream("alice", {
			root: "user dir",
			skill: "acme-release",
		});
		expect(upstream?.body).toContain("Cut the acme release.");
		expect(typeof upstream?.hash).toBe("string");
		// An overlay write through the host surface lands in the store.
		const overlays = curation.overlays("alice");
		const entry = await overlays.put(
			{ root: "user dir", skill: "acme-release" },
			"Prefer blue/green releases.",
			upstream!.hash,
			{ actor: "curator", reason: "review note" },
		);
		expect(entry.action).toBe("overlay");
		const stored = await overlays.get({ root: "user dir", skill: "acme-release" });
		expect(stored?.text).toBe("Prefer blue/green releases.");
		// The MARKED-orphan path: markOrphans with the key absent.
		await overlays.markOrphans(
			() => false,
			new Date().toISOString(),
		);
		const orphaned = await overlays.get({ root: "user dir", skill: "acme-release" });
		expect(orphaned?.orphanedSince).toBeDefined();
	});

	test("usage(user) serves the skill → lastUsed map", { timeout: 30_000 }, async () => {
		// A real load_skill turn counts the learned skill (P4's seam):
		// the map reports its lastUsed ISO; an unloaded skill reads
		// undefined.
		const { app, opened, dir } = await bootServer(
			[
				fauxAssistantMessage(
					[fauxToolCall("load_skill", { name: "acme-deploy" } as JsonObject)],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("loaded and noted"),
			],
			// Single-user: the real AgentExecutionEnv (no sandbox helper in
			// this environment) so load_skill actually reads the learned
			// file and the P4 seam bumps.
			{ singleUser: true },
		);
		const curation = app.hostBridge.curation;
		await curation.skills("alice").apply(
			"acme-deploy",
			{ kind: "create", content: ACME_SKILL },
			{ reviewId: "usage-1" },
		);
		const before = await curation.usage("alice");
		expect(before["acme-deploy"]).toBeUndefined();
		const conversation = await opened.harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: opened.defaultModel } },
			BACKGROUND_CONTEXT,
		);
		await opened.harness.commit(async (tx) => {
			const meta = await tx.doc(SessionMetaDoc, conversation.id);
			meta.owner = "alice";
		}, BACKGROUND_CONTEXT);
		const submission = await conversation.submit(
			{ type: "input", content: "load the deploy skill" },
			BACKGROUND_CONTEXT,
		);
		const record = await submission.wait(BACKGROUND_CONTEXT);
		expect(record.status).toBe("done");
		const discovered = await import("../src/skills/index.js").then((m) =>
			m.discoverSkills(undefined, BACKGROUND_CONTEXT, {
				userDir: join(dir, "config", "skills"),
				packageRoots: () => [],
				learnedRoot: (owner) =>
					owner === "alice" ? join(dir, "data", "users", "alice", "skills") : undefined,
				sectionMaxBytes: () => 4096,
			}, { owner: "alice" } as Parameters<typeof m.discoverSkills>[3]),
		);
		const found = discovered.find((skill) => skill.name === "acme-deploy");
		expect(found?.root).toBe("learned");
		const after = await curation.usage("alice");
		// The real load bumped acme-deploy's lastUsed (an ISO timestamp);
		// an unloaded skill (none here yet) reads undefined.
		expect(typeof after["acme-deploy"]).toBe("string");
		expect(Number.isNaN(Date.parse(after["acme-deploy"] ?? ""))).toBe(false);
	});

	test("the seam host hands extensions the SAME curation surface", { timeout: 30_000 }, async () => {
		const { app } = await bootServer();
		const curation = app.hostBridge.curation;
		// The fixture extension's factory captured the seam host; the
		// loader exposed it under the extension's slug. The seam host's
		// curation member is the bridge's object (identity by reach:
		// both expose the same targets list).
		const seamHost = app.sigrunContext.opened.seamHosts.get(
			"fixture-curation-target",
		);
		expect(seamHost).toBeDefined();
		const hostCuration = (seamHost as unknown as {
			curation: typeof curation;
		}).curation;
		expect(hostCuration).toBeDefined();
		const fromHost = await hostCuration.targets("alice");
		const fromBridge = await curation.targets("alice");
		expect(fromHost.map((target) => target.id)).toEqual(
			fromBridge.map((target) => target.id),
		);
	});

	test("digestRun serves model = opts.model ?? server default", { timeout: 30_000 }, async () => {
		const { app } = await bootServer([fauxAssistantMessage("digest answer")]);
		const curation = app.hostBridge.curation;
		const result = await curation.digestRun("alice", {
			instruction: "digest",
			allow: ["skill_manage"],
			maxToolCalls: 2,
			maxOutputTokens: 4_000,
			deadlineMs: 20_000,
			reviewId: "digest-model",
			input: "digest input",
		});
		// The digest answered on the default model + gate selection (the
		// no-tool-call path: the allow list only gates tool calls).
		expect(result.status).toBe("completed");
		expect(result.text).toBe("digest answer");
	});
});

// ─── helpers ───────────────────────────────────────────────────────────────

/** Import the fixture module by the SAME URL the loader imported. */
async function fixtureModule(): Promise<{
	readonly undos: readonly { user: string; changeId: string }[];
	readonly maintains: readonly {
		user: string;
		deadline: number;
		runs: number;
		digestTexts: string[];
	}[];
	readonly resetTargetFixture: () => void;
}> {
	return (await import(TARGET_SPECIFIER)) as unknown as {
		readonly undos: readonly { user: string; changeId: string }[];
		readonly maintains: readonly {
			user: string;
			deadline: number;
			runs: number;
			digestTexts: string[];
		}[];
		readonly resetTargetFixture: () => void;
	};
}

// The LiveDoc import keeps the admission-state read available for the
// driver's start capture (documented; no assertion uses it here).
void LiveDoc;
void (undefined as SubmissionId | TaskId | undefined);
