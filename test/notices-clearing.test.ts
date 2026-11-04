/**
 * Notices Task 5 (spec §3.2 rules 2 and 8): the IMPLIED clears.
 *
 * Rule 2 — a user's next prompt clears that user's conversation notices:
 * `submitOp` clears `(opts.user, conversation)` right after the submit
 * admits. That one chokepoint covers web submissions, steers
 * (`whenBusy: "steer"`), chat-block answers (`blocks/answers.ts` runs
 * through `submitOp`), and host-bridge submits with the extension's
 * mapped user. EXEMPT: job runs and curator internal runs call
 * `conversation.submit` DIRECTLY — a scheduled run is not the user
 * dealing with the notice.
 *
 * Rule 8 — user deletion removes the notices file explicitly: the user
 * area stays for the workspace's recipient, so the file goes on its own
 * (`NoticesService.removeUser` → `NoticeStore.removeFile`), and the
 * store's `createdAt` stamp is the belt behind it (a stale file left
 * behind for a re-created username is discarded on load).
 *
 * Hermetic pattern (notices-service.test.ts): a real harness + real
 * Fastify app over a faux provider, tmp dirs, and `app.inject()`.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, SubmissionRecord } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { JsonObject, Tree } from "@sigrun/shared/blocks";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { BlocksEntry } from "../src/harness/blocks/entries.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { SessionMetaDoc } from "../src/server/session-meta.js";
import { seededIdentity } from "./helpers/identity.js";

/** The valid noticeActions fixture (`acme-notes`): the seam host's slug. */
const NOTES_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-notice-actions", "index.js"),
).href;

/** The §8.5 ranking block with a turn-carrying submit (blocks-answers' tree). */
const RANKING_TREE: Tree = {
	v: 1,
	root: {
		type: "section",
		title: "Ranking",
		children: [
			{
				type: "collection",
				id: "ranking",
				items: { $: "/cards" },
				display: "list",
				numbered: true,
				reorder: { within: true },
				onMove: "reorderCards",
				item: { title: { $: "./title" } },
			},
			{
				type: "form",
				id: "use-order",
				bind: "/order",
				mode: "submit",
				onSubmit: "useOrder",
				submitLabel: "Use this order",
				children: [],
			},
		],
	},
};

const RANKING_DATA: JsonObject = {
	cards: [
		{ id: "c1", title: "Arabesque" },
		{ id: "c2", title: "Gymnopédie" },
	],
};

interface TestRig {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly dir: string;
	readonly faux: FauxProviderHandle;
	readonly tokens: { readonly alice: string; readonly bob: string };
	readonly close: () => Promise<void>;
}

async function bootRig(options?: {
	/** A slow stream keeps a run busy long enough to steer into it. */
	readonly tokensPerSecond?: number;
}): Promise<TestRig> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-notices-clearing-"));
	// The auto-namer completes through the same faux provider and would
	// consume scripted responses (the blocks suites' pattern).
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
		...(options?.tokensPerSecond === undefined
			? {}
			: { tokensPerSecond: options.tokensPerSecond }),
	});
	faux.setResponses([]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_DATA_DIR: join(dir, "data"),
		SIGRUN_CACHE_DIR: join(dir, "cache"),
		SIGRUN_STATE_DIR: join(dir, "state"),
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		// Token auth: two directory users under the naive method refuse to
		// boot (the multi-user gate).
		SIGRUN_AUTH: "token",
		SIGRUN_API_TOKEN: "service-token-for-notices-clearing-tests",
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_CONFIG_DIR: join(dir, "config"),
	});
	const identity = await seededIdentity(dir, "alice");
	if (identity.users.get("bob") === undefined) {
		await identity.users.add({ user: "bob", admin: false, source: "cli" });
	}
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		env: { SIGRUN_CONFIG_DIR: join(dir, "config") },
		settingsDir: dir,
		builtins: false,
		extensionSpecifiers: [NOTES_SPECIFIER],
		expectHostBridge: true,
		// The multi-user admission guard needs an isolation probe; the real
		// helper is absent on CI hosts (the users-api pattern).
		isolationProbe: async () => ({ available: true, abi: 6 }),
	});
	const app = await createServer(opened, config);
	const tokens = {
		alice: (await opened.identity.tokens.create("alice-test", "alice")).token,
		bob: (await opened.identity.tokens.create("bob-test", "bob")).token,
	};
	return {
		app,
		opened,
		dir,
		faux,
		tokens,
		close: async () => {
			await app.close();
			await opened.harness.close(BACKGROUND_CONTEXT);
			await rm(dir, { recursive: true, force: true });
		},
	};
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** One conversation owned by `owner`, optionally shared. */
async function ownedConversation(
	rig: TestRig,
	owner: string,
	sharing?: {
		scope: "people";
		users: string[];
		level: "read" | "write";
	},
): Promise<number> {
	const conversation = await rig.opened.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: rig.opened.defaultModel },
			init: async (tx, id) => {
				const meta = await tx.doc(SessionMetaDoc, id);
				meta.owner = owner;
				if (sharing !== undefined) meta.sharing = sharing;
			},
		},
		BACKGROUND_CONTEXT,
	);
	return conversation.id as number;
}

/** Post one notice through the service (the fixture extension's slug). */
async function postNotice(
	rig: TestRig,
	input: Record<string, unknown>,
): Promise<string> {
	const posted = await rig.app.sigrunContext.notices.post("acme-notes", {
		user: "alice",
		title: "clearing notice",
		...input,
	});
	return posted.id;
}

/** One user's notice ids as the GET route serves them. */
async function noticeIds(
	rig: TestRig,
	token: string,
): Promise<readonly string[]> {
	const response = await rig.app.inject({
		method: "GET",
		url: "/v1/notices",
		headers: { authorization: `Bearer ${token}` },
	});
	expect(response.statusCode).toBe(200);
	const body = response.json() as { notices: { id: string }[] };
	return body.notices.map((notice) => notice.id);
}

/** The HTTP composer submit (the one submitOp the web client drives). */
async function submit(
	rig: TestRig,
	token: string,
	conversationId: number,
	body: Record<string, unknown>,
): Promise<SubmissionRecord> {
	const response = await rig.app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/submissions`,
		headers: { authorization: `Bearer ${token}` },
		payload: body,
	});
	expect(response.statusCode).toBe(202);
	return (response.json() as { submission: SubmissionRecord }).submission;
}

/** Wait for one admitted submission to settle (the rig's cleanup hygiene). */
async function settle(rig: TestRig, record: SubmissionRecord): Promise<void> {
	const submission = await rig.opened.harness.submission(
		record.id,
		BACKGROUND_CONTEXT,
	);
	expect(submission).toBeDefined();
	await submission!.wait(BACKGROUND_CONTEXT);
}

/** One assistant tool round (the blocks suites' helper). */
function toolRound(
	...calls: { name: string; args: JsonObject }[]
): AssistantMessage {
	return fauxAssistantMessage(
		calls.map((call) => fauxToolCall(call.name, call.args)),
		{ stopReason: "toolUse" },
	);
}

// ---------------------------------------------------------------------------
// Rule 2: the user's next prompt
// ---------------------------------------------------------------------------

test("alice's prompt clears her notices for that conversation only", async () => {
	const rig = await bootRig();
	cleanups.push(rig.close);
	const here = await ownedConversation(rig, "alice");
	const elsewhere = await ownedConversation(rig, "alice");
	const hereNotice = await postNotice(rig, {
		title: "here",
		conversationId: here,
	});
	const elsewhereNotice = await postNotice(rig, {
		title: "elsewhere",
		conversationId: elsewhere,
	});
	const appWide = await postNotice(rig, { title: "app-wide" });

	rig.faux.setResponses([fauxAssistantMessage("ok")]);
	const record = await submit(rig, rig.tokens.alice, here, {
		input: "dealing with it",
	});
	await settle(rig, record);

	// Exactly the other conversation's notice and the app-wide one
	// survive: the clear is per CONVERSATION (spec §3.2 rule 2), never
	// app-wide, never another conversation's.
	const remaining = await noticeIds(rig, rig.tokens.alice);
	expect(remaining).toEqual([appWide, elsewhereNotice]);
	expect(remaining).not.toContain(hereNotice);
});

test("a steer (whenBusy steer) clears", { timeout: 30_000 }, async () => {
	// A slow stream keeps the first turn busy, so the second submit is a
	// real steer rather than a plain admission.
	const rig = await bootRig({ tokensPerSecond: 40 });
	cleanups.push(rig.close);
	const conversation = await ownedConversation(rig, "alice");
	const longAnswer =
		"a deliberately long answer that keeps the run busy while the steer lands. ".repeat(
			4,
		);
	rig.faux.setResponses([fauxAssistantMessage(longAnswer)]);
	const first = await submit(rig, rig.tokens.alice, conversation, {
		input: "start the turn",
	});
	// The notice lands AFTER the first prompt (which would itself clear).
	const notice = await postNotice(rig, {
		title: "steer clears me",
		conversationId: conversation,
	});
	rig.faux.appendResponses([fauxAssistantMessage("merged answer")]);
	const steer = await submit(rig, rig.tokens.alice, conversation, {
		input: "one more thing",
		whenBusy: "steer",
	});
	// The steer really was a steer: the run was still in flight, so the
	// admission queued it behind the busy turn.
	expect(steer.status).toBe("queued");

	expect(await noticeIds(rig, rig.tokens.alice)).not.toContain(notice);
	await Promise.all([settle(rig, first), settle(rig, steer)]);
});

test("a chat-block answer clears", async () => {
	const rig = await bootRig();
	cleanups.push(rig.close);
	const conversationId = await ownedConversation(rig, "alice");
	const conversation = await rig.opened.harness.conversation(
		conversationId as ConversationId,
		BACKGROUND_CONTEXT,
	);
	// The block surface (a direct submit — no submitOp, so no clear).
	rig.faux.setResponses([
		toolRound({
			name: "show_blocks",
			args: {
				title: "Ranking",
				tree: RANKING_TREE as unknown as JsonObject,
				data: RANKING_DATA,
			},
		}),
		fauxAssistantMessage("shown"),
	]);
	const shown = await conversation!.submit(
		{ type: "input", content: "show the blocks" },
		BACKGROUND_CONTEXT,
	);
	await shown.wait(BACKGROUND_CONTEXT);
	const page = await conversation!.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	const entryId = page.items.find((entry) => entry.kind === BlocksEntry.kind)?.id;
	expect(entryId).toBeDefined();
	const notice = await postNotice(rig, {
		title: "answer clears me",
		conversationId,
	});

	// The answer path (blocks/answers.ts) runs through submitOp.
	rig.faux.setResponses([fauxAssistantMessage("answered")]);
	const answer = await rig.app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/blocks/${String(entryId)}/actions`,
		headers: {
			authorization: `Bearer ${rig.tokens.alice}`,
			"content-type": "application/json",
		},
		payload: { action: "useOrder", payload: { values: {} }, actionId: "act-1" },
	});
	expect(answer.statusCode).toBe(200);

	expect(await noticeIds(rig, rig.tokens.alice)).not.toContain(notice);
});

test("a host-bridge submit with user alice clears", async () => {
	const rig = await bootRig();
	cleanups.push(rig.close);
	const conversation = await ownedConversation(rig, "alice");
	const notice = await postNotice(rig, {
		title: "bridge clears me",
		conversationId: conversation,
	});
	const host = rig.opened.seamHosts.get("acme-notes");
	expect(host).toBeDefined();
	rig.faux.setResponses([fauxAssistantMessage("from the bridge")]);
	await host!.conversations.submit(
		conversation as ConversationId,
		[{ type: "text", text: "bridge input" }],
		{ user: "alice" },
	);

	expect(await noticeIds(rig, rig.tokens.alice)).not.toContain(notice);
});

test("another user's prompt clears nothing", async () => {
	const rig = await bootRig();
	cleanups.push(rig.close);
	// A conversation alice owns and shares with bob (write).
	const conversation = await ownedConversation(rig, "alice", {
		scope: "people",
		users: ["bob"],
		level: "write",
	});
	const notice = await postNotice(rig, {
		title: "alice's notice",
		conversationId: conversation,
	});

	rig.faux.setResponses([fauxAssistantMessage("bob answered")]);
	const bobSubmit = await submit(rig, rig.tokens.bob, conversation, {
		input: "bob's prompt",
	});
	await settle(rig, bobSubmit);
	// Bob's prompt is not alice dealing with her notice (spec §3.2).
	expect(await noticeIds(rig, rig.tokens.alice)).toContain(notice);

	// The control: alice's own prompt in the same conversation clears it.
	rig.faux.setResponses([fauxAssistantMessage("alice answered")]);
	const aliceSubmit = await submit(rig, rig.tokens.alice, conversation, {
		input: "alice's prompt",
	});
	await settle(rig, aliceSubmit);
	expect(await noticeIds(rig, rig.tokens.alice)).not.toContain(notice);
});

test("a job-fired run does not clear", async () => {
	const rig = await bootRig();
	cleanups.push(rig.close);
	const conversation = await ownedConversation(rig, "alice");
	const notice = await postNotice(rig, {
		title: "a job must not clear me",
		conversationId: conversation,
	});
	const created = await rig.app.inject({
		method: "POST",
		url: "/v1/jobs",
		headers: {
			authorization: `Bearer ${rig.tokens.alice}`,
			"content-type": "application/json",
		},
		payload: {
			name: "notices-fire",
			schedule: { every: "3600s" },
			action: {
				kind: "prompt",
				prompt: "say ok",
				conversation,
			},
		},
	});
	expect(created.statusCode).toBe(201);
	const jobId = (created.json() as { job: { id: string } }).job.id;

	rig.faux.setResponses([fauxAssistantMessage("job answer")]);
	const fired = await rig.app.inject({
		method: "POST",
		url: `/v1/jobs/${jobId}/run`,
		headers: { authorization: `Bearer ${rig.tokens.alice}` },
	});
	expect(fired.statusCode).toBe(200);
	expect((fired.json() as { outcome: string }).outcome).toBe("running");
	// The fire really did admit a turn — the exemption is about the PATH
	// (`fire.ts` calls `conversation.submit` directly), not about a fire
	// that never happened. Settle it, then check the notice survived.
	const page = await rig.opened.storage.scanSubmissions(
		{ conversationId: conversation as ConversationId, order: "ascending" },
		10,
		undefined,
		BACKGROUND_CONTEXT,
	);
	const jobInput = page.items.find((item) => item.type === "input");
	expect(jobInput).toBeDefined();
	await settle(rig, jobInput!);
	expect(await noticeIds(rig, rig.tokens.alice)).toContain(notice);
});

test("a failing clear never fails the submit", async () => {
	const rig = await bootRig();
	cleanups.push(rig.close);
	const conversation = await ownedConversation(rig, "alice");
	const notice = await postNotice(rig, {
		title: "the clear fails",
		conversationId: conversation,
	});
	const notices = rig.app.sigrunContext.notices;
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const failing = vi
		.spyOn(notices, "clearConversationFor")
		.mockRejectedValueOnce(new Error("notices store exploded"));
	try {
		rig.faux.setResponses([fauxAssistantMessage("ok")]);
		const record = await submit(rig, rig.tokens.alice, conversation, {
			input: "the turn still lands",
		});
		// The clear WAS attempted for this user and conversation (a
		// vacuous test would pass if the hook never ran).
		expect(failing).toHaveBeenCalledWith("alice", conversation);
		// The failure is logged, never propagated (a notice system must not
		// break a turn) — the turn admitted and the notice stayed.
		expect(
			warn.mock.calls.some((call) =>
				call.some((part) => String(part).includes("notices store exploded")),
			),
		).toBe(true);
		expect(await noticeIds(rig, rig.tokens.alice)).toContain(notice);
		await settle(rig, record);
	} finally {
		failing.mockRestore();
		warn.mockRestore();
	}
});

// ---------------------------------------------------------------------------
// Rule 8: user deletion
// ---------------------------------------------------------------------------

/** The `notices.json` path for one directory user. */
function noticeFile(rig: TestRig, user: string): string {
	return join(rig.dir, "data", "users", user, "notices.json");
}

test("re-created username starts empty", async () => {
	const rig = await bootRig();
	cleanups.push(rig.close);
	const bobNotice = await rig.app.sigrunContext.notices.post("acme-notes", {
		user: "bob",
		title: "bob's notice",
	});
	expect(existsSync(noticeFile(rig, "bob"))).toBe(true);
	expect(await noticeIds(rig, rig.tokens.bob)).toEqual([bobNotice.id]);

	// Delete bob: the file goes with him (the user area stays for the
	// workspace's recipient — the file is removed on its own).
	const deleted = await rig.app.inject({
		method: "DELETE",
		url: "/v1/users/bob?transferTo=alice",
		headers: { authorization: `Bearer ${rig.tokens.alice}` },
	});
	expect(deleted.statusCode).toBe(204);
	expect(existsSync(noticeFile(rig, "bob"))).toBe(false);

	// Re-create the same username: nothing comes back.
	await rig.opened.identity.users.add({
		user: "bob",
		admin: false,
		source: "cli",
	});
	const recreated = (
		await rig.opened.identity.tokens.create("bob-again", "bob")
	).token;
	expect(await noticeIds(rig, recreated)).toEqual([]);

	// The belt: a stale file left behind for the OLD directory record (an
	// older `createdAt` stamp) is discarded on load.
	await mkdir(join(rig.dir, "data", "users", "bob"), { recursive: true });
	await writeFile(
		noticeFile(rig, "bob"),
		`${JSON.stringify(
			{
				v: 1,
				userCreatedAt: 1,
				notices: [
					{
						id: "11111111-1111-4111-8111-111111111111",
						owner: "acme-notes",
						at: "2026-11-01T00:00:00.000Z",
						user: "bob",
						title: "stale notice",
					},
				],
			},
			null,
			"\t",
		)}\n`,
		"utf8",
	);
	expect(await noticeIds(rig, recreated)).toEqual([]);
});
