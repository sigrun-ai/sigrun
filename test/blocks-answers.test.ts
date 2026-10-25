/**
 * U5 Task 3 — block answers as InputEntry turns (spec §8.4): a turn
 * action (`submit`, default `turn: true`; any action with `turn: true`)
 * makes core submit a user message for the acting user through the
 * normal submission path:
 *
 *   { type: "input",
 *     content: textProjection,             // "Submitted 'Ranking': 1. …"
 *     entry: { kind: "sigrun.blocks.answer",
 *              data: { entryId, action, payload, state } },
 *     requestId: "blocks:" + actionId }
 *
 * The surface's unnoted change records are folded into `content` first
 * and `notedThrough` advances BEFORE the §8.3 note step runs — so that
 * turn sends no separate note for this surface, while changes on OTHER
 * surfaces in the same conversation still get one.
 *
 * Coverage (the brief's Step-1 list):
 * - "Use this order" (`submit`, `turn` default) produces one input
 *   submission whose `content` carries the projection, whose entry is
 *   `sigrun.blocks.answer` with `{entryId, action, payload, state}`,
 *   whose `requestId` is `blocks:<actionId>`, folding this surface's
 *   unnoted changes in; no note for this surface; a pending change on
 *   another surface still notes;
 * - a double click (the same actionId) makes one turn (requestId
 *   dedup);
 * - Review Focus 4: an answer from a `read` principal → 403, no
 *   submission;
 * - `turn: false` submits stay edits (no answer turn);
 * - entry disjunction (submitOp): `opts.entry` set skips expansion
 *   (`expandInput` never runs) and the submission carries the answer
 *   entry; a `/skill:name` input on the same path still expands into
 *   `sigrun.user.expanded`; a forced both-set state throws before any
 *   submission;
 * - the supervisor-check wiring: a `submit` with the DEFAULT `turn`
 *   starts a turn (the planAction branch honors it — never a silent
 *   edit).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId, SubmissionRecord } from "@earendil-works/pi-durable";
import type { JsonObject, JsonValue, Tree } from "@sigrun/shared/blocks";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import {
	BlocksAnswerEntry,
	BlocksEntry,
} from "../src/harness/blocks/entries.js";
import { readBlocksState } from "../src/harness/blocks/state.js";
import { createServer } from "../src/server/index.js";
import { NOTE_HEADER } from "../src/server/blocks/notes.js";
import type { BlocksAnswerData } from "../src/server/blocks/answers.js";
import { applyChatAction } from "../src/server/blocks/chat-surfaces.js";
import { seededIdentity } from "./helpers/identity.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The §8.5 ranking block with a "Use this order" submit (turn default). */
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
		{ id: "c3", title: "Reflets" },
		{ id: "c4", title: "Clair de Lune" },
	],
};

/** A second block (the other-surface note case). */
const CHORES_TREE: Tree = {
	v: 1,
	root: {
		type: "section",
		title: "Chores",
		children: [
			{
				type: "collection",
				id: "chores",
				items: { $: "/chores" },
				display: "list",
				numbered: true,
				reorder: { within: true },
				onMove: "reorderChores",
				item: { title: { $: "./title" } },
			},
		],
	},
};

const CHORES_DATA: JsonObject = {
	chores: [
		{ id: "h1", title: "Dishes" },
		{ id: "h2", title: "Laundry" },
	],
};

/** A form whose submit sets `turn: false` explicitly (an edit). */
const QUIET_FORM_TREE: Tree = {
	v: 1,
	root: {
		type: "form",
		id: "quiet-form",
		bind: "/notes",
		mode: "submit",
		onSubmit: "saveNotes",
		turn: false,
		children: [{ type: "longtext", name: "Notes", label: "Notes" }],
	},
};

// ---------------------------------------------------------------------------
// Boot + drive helpers (the blocks-notes.test.ts shape)
// ---------------------------------------------------------------------------

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly faux: FauxProviderHandle;
	readonly aliceToken: string;
	readonly carolToken: string;
	/** The boot tmp dir (config lives at `<dir>/config`). */
	readonly dir: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-blocks-answers-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses([]);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_WEBUI: "false",
		SIGRUN_AUTH: "token",
		SIGRUN_CONFIG_DIR: join(dir, "config"),
	});
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const identity = await seededIdentity(join(dir, "seed"), "alice");
	if (identity.users.get("carol") === undefined) {
		await identity.users.add({
			user: "carol",
			name: "carol acme",
			admin: false,
			source: "cli",
		});
	}
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		builtins: false,
		env: { SIGRUN_CONFIG_DIR: join(dir, "config") },
		settingsDir: dir,
	});
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	const { token: carolToken } = await opened.identity.tokens.create(
		"carol-cli",
		"carol",
	);
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, faux, aliceToken, carolToken, dir };
}

function toolRound(
	...calls: { name: string; args: JsonObject }[]
): AssistantMessage {
	return fauxAssistantMessage(
		calls.map((call) => fauxToolCall(call.name, call.args)),
		{ stopReason: "toolUse" },
	);
}

async function conversationWithBlocks(
	server: TestServer,
	sharing: "private" | "read" | "write",
	...blocks: { tree: Tree; data: JsonObject; title: string }[]
): Promise<{ conversationId: number; entryIds: string[] }> {
	const { opened, app, aliceToken, faux } = server;
	const created = await app.inject({
		method: "POST",
		url: "/v1/conversations",
		headers: { authorization: `Bearer ${aliceToken}` },
	});
	expect(created.statusCode).toBe(201);
	const conversationId = (created.json() as { id: number }).id;
	if (sharing !== "private") {
		const shared = await app.inject({
			method: "PATCH",
			url: `/v1/conversations/${conversationId}/meta`,
			headers: { authorization: `Bearer ${aliceToken}` },
			payload: { sharing: { scope: "household", level: sharing } },
		});
		expect(shared.statusCode).toBe(200);
	}
	const conversation = await opened.harness.conversation(
		conversationId as ConversationId,
		BACKGROUND_CONTEXT,
	);
	faux.setResponses([
		...blocks.map((block) =>
			toolRound({
				name: "show_blocks",
				args: {
					title: block.title,
					tree: block.tree as unknown as JsonObject,
					data: block.data,
				},
			}),
		),
		fauxAssistantMessage("shown"),
	]);
	const submission = await conversation!.submit(
		{ type: "input", content: "show the blocks" },
		BACKGROUND_CONTEXT,
	);
	await submission.wait(BACKGROUND_CONTEXT);
	const page = await conversation!.entries(
		{},
		100,
		undefined,
		BACKGROUND_CONTEXT,
	);
	const entryIds = page.items
		.filter((entry) => entry.kind === BlocksEntry.kind)
		.reverse()
		.map((entry) => String(entry.id));
	expect(entryIds).toHaveLength(blocks.length);
	return { conversationId, entryIds };
}

/** Post one block action through the HTTP route; return status + body. */
async function postAction(
	server: TestServer,
	token: string,
	conversationId: number,
	entryId: string,
	action: string,
	payload: JsonValue,
	actionId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await server.app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/blocks/${entryId}/actions`,
		headers: { authorization: `Bearer ${token}` },
		payload: { action, payload, actionId },
	});
	return {
		status: response.statusCode,
		body: response.json() as Record<string, unknown>,
	};
}

/** The conversation's durable submissions (ascending). */
async function submissionsOf(
	opened: OpenedHarness,
	conversationId: number,
): Promise<SubmissionRecord[]> {
	const page = await opened.storage.scanSubmissions(
		{ conversationId: conversationId as ConversationId, order: "ascending" },
		100,
		undefined,
		BACKGROUND_CONTEXT,
	);
	return [...page.items];
}

describe("block answers as InputEntry turns (spec §8.4)", () => {
	test("'Use this order' submits one turn: content folds the unnoted changes and the projection; entry + requestId as spec'd; another surface still notes; a double click is one turn", async () => {
		const server = await bootServer();
		const { conversationId, entryIds } = await conversationWithBlocks(
			server,
			"private",
			{ tree: RANKING_TREE, data: RANKING_DATA, title: "Ranking" },
			{ tree: CHORES_TREE, data: CHORES_DATA, title: "Chores" },
		);
		const [rankingId, choresId] = entryIds;
		// One unnoted edit on EACH surface.
		const moved = await applyChatAction(
			server.opened.harness,
			conversationId,
			rankingId!,
			"alice",
			"reorderCards",
			{ itemId: "c4", from: { index: 3 }, to: { index: 0 } },
		);
		expect(moved).toMatchObject({ ok: true });
		const choreMoved = await applyChatAction(
			server.opened.harness,
			conversationId,
			choresId!,
			"alice",
			"reorderChores",
			{ itemId: "h2", from: { index: 1 }, to: { index: 0 } },
		);
		expect(choreMoved).toMatchObject({ ok: true });

		server.faux.setResponses([fauxAssistantMessage("playlist built")]);
		const submissionsBefore = await submissionsOf(
			server.opened,
			conversationId,
		);

		// The answer: the form's submit, turn defaulting to true.
		const answer = await postAction(
			server,
			server.aliceToken,
			conversationId,
			rankingId!,
			"useOrder",
			{ values: {} },
			"act-use-order",
		);
		expect(answer.status).toBe(200);

		// Wait for the answer turn to settle (the faux answer consumed).
		const deadline = Date.now() + 10_000;
		for (;;) {
			const subs = await submissionsOf(server.opened, conversationId);
			const answerSub = subs.find(
				(sub) => sub.requestId === "blocks:act-use-order",
			);
			if (answerSub?.status === "done") break;
			if (Date.now() > deadline) {
				throw new Error("the blocks answer turn never settled");
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		const subs = await submissionsOf(server.opened, conversationId);
		const fresh = subs.slice(submissionsBefore.length);
		// Exactly TWO new submissions: the answer input + the other
		// surface's note. The answer is an input carrying the spec'd entry.
		const answerSub = fresh.find(
			(sub) => sub.requestId === "blocks:act-use-order",
		);
		expect(answerSub).toBeDefined();
		expect(answerSub!.type).toBe("input");
		const notes = fresh.filter((sub) => sub.type === "write");
		expect(notes).toHaveLength(1);

		// The answer entry: kind + data + content.
		const conversation = await server.opened.harness.conversation(
			conversationId as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const answerEntry = await conversation!.entries(
			{ minEntryId: answerSub!.entry, maxEntryId: answerSub!.entry },
			1,
			undefined,
			BACKGROUND_CONTEXT,
		);
		const entry = answerEntry.items[0];
		expect(entry?.kind).toBe(BlocksAnswerEntry.kind);
		const data = entry?.data as BlocksAnswerData;
		expect(data.entryId).toBe(rankingId);
		expect(data.action).toBe("useOrder");
		expect(data.payload).toEqual({ values: {} });
		// The folded state is the surface's post-move data.
		expect(data.state).toEqual({
			cards: [
				{ id: "c4", title: "Clair de Lune" },
				{ id: "c1", title: "Arabesque" },
				{ id: "c2", title: "Gymnopédie" },
				{ id: "c3", title: "Reflets" },
			],
		});
		const message = entry?.model?.[0];
		const content = message?.role === "user" ? message.content : "";
		const text =
			typeof content === "string"
				? content
				: content
						.map((part) => (part.type === "text" ? part.text : ""))
						.join("");
		// The fold: the surface's own unnoted change, then the projection.
		expect(text).toContain(NOTE_HEADER);
		expect(text).toContain("• Ranking (alice): ");
		expect(text).toContain("Submitted 'Ranking':");
		expect(text).toContain("1. Clair de Lune");
		expect(text).toContain("2. Arabesque");

		// The answering surface's notedThrough advanced (no note for it);
		// the OTHER surface got its note through the same turn admission.
		const rankingState = await readBlocksState(
			server.opened.harness,
			conversationId,
			rankingId!,
			BACKGROUND_CONTEXT,
		);
		expect(rankingState?.notedThrough).toBe(1);
		const choresState = await readBlocksState(
			server.opened.harness,
			conversationId,
			choresId!,
			BACKGROUND_CONTEXT,
		);
		expect(choresState?.notedThrough).toBe(1);

		// A double click: the same actionId re-posts, the route dedups
		// (the cached accept body) and no second turn exists.
		const again = await postAction(
			server,
			server.aliceToken,
			conversationId,
			rankingId!,
			"useOrder",
			{ values: {} },
			"act-use-order",
		);
		expect(again.status).toBe(200);
		const after = await submissionsOf(server.opened, conversationId);
		expect(after).toHaveLength(subs.length);
	});

	test("a `turn: false` submit stays an edit (no answer turn)", async () => {
		const server = await bootServer();
		const { conversationId, entryIds } = await conversationWithBlocks(
			server,
			"private",
			{ tree: QUIET_FORM_TREE, data: {}, title: "Notes" },
		);
		const before = await submissionsOf(server.opened, conversationId);
		const saved = await postAction(
			server,
			server.aliceToken,
			conversationId,
			entryIds[0]!,
			"saveNotes",
			{ values: { Notes: "milk, eggs" } },
			"act-quiet-save",
		);
		expect(saved.status).toBe(200);
		expect(saved.body).toMatchObject({ ok: true });
		// No submission, no answer entry — a saved edit only.
		expect(await submissionsOf(server.opened, conversationId)).toHaveLength(
			before.length,
		);
		const state = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryIds[0]!,
			BACKGROUND_CONTEXT,
		);
		expect(state?.data).toEqual({ notes: { Notes: "milk, eggs" } });
		expect(state?.changes).toHaveLength(1);
	});

	test("Review Focus 4: an answer from a read principal → 403, no submission", async () => {
		const server = await bootServer();
		const { conversationId, entryIds } = await conversationWithBlocks(
			server,
			"read",
			{ tree: RANKING_TREE, data: RANKING_DATA, title: "Ranking" },
		);
		const before = await submissionsOf(server.opened, conversationId);
		const denied = await postAction(
			server,
			server.carolToken,
			conversationId,
			entryIds[0]!,
			"useOrder",
			{ values: {} },
			"act-carol",
		);
		expect(denied.status).toBe(403);
		expect(await submissionsOf(server.opened, conversationId)).toHaveLength(
			before.length,
		);
	});
});

describe("the entry disjunction in submitOp (the brief's enforced invariant)", () => {
	test("an answer submission skips expansion; a /skill input on the same path still expands; a forced both-set state throws before any submission", async () => {
		const server = await bootServer();
		const { conversationId } = await conversationWithBlocks(
			server,
			"private",
			{ tree: RANKING_TREE, data: RANKING_DATA, title: "Ranking" },
		);
		const conversation = await server.opened.harness.conversation(
			conversationId as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const { submitOp } = await import("../src/server/conversation-ops.js");

		// 1. An answer-shaped submitOp call (opts.entry set): the admitted
		// submission carries the answer entry and NO expanded entry — the
		// skip is observable at the entry boundary (expandInput is a module
		// import inside submitOp, so the ENTRY KIND is the evidence).
		server.faux.setResponses([fauxAssistantMessage("answer run")]);
		const ctx = { opened: server.opened } as unknown as Parameters<
			typeof submitOp
		>[0];
		const answerRecord = await submitOp(ctx, conversation!, "Submitted 'Ranking': 1. Clair de Lune", {
			entry: {
				kind: BlocksAnswerEntry.kind,
				data: {
					entryId: "1",
					action: "useOrder",
					payload: {},
					state: {},
				},
			},
		});
		const answerEntry = await conversation!.entries(
			{ minEntryId: answerRecord.entry, maxEntryId: answerRecord.entry },
			1,
			undefined,
			BACKGROUND_CONTEXT,
		);
		expect(answerEntry.items[0]?.kind).toBe(BlocksAnswerEntry.kind);

		// 2. A `/skill:name` input on the SAME path still expands (the
		// expansion entry carries what was typed).
		const configDir = join(server.dir, "config");
		await mkdir(join(configDir, "skills", "greet"), { recursive: true });
		await writeFile(
			join(configDir, "skills", "greet", "SKILL.md"),
			"---\nname: greet\ndescription: Greet\n---\nSay hello.\n",
		);
		server.faux.setResponses([fauxAssistantMessage("skill run")]);
		const skillRecord = await submitOp(
			ctx,
			conversation!,
			"/skill:greet",
		);
		const skillEntry = await conversation!.entries(
			{ minEntryId: skillRecord.entry, maxEntryId: skillRecord.entry },
			1,
			undefined,
			BACKGROUND_CONTEXT,
		);
		expect(skillEntry.items[0]?.kind).toBe("sigrun.user.expanded");

		// 3. A forced both-set state (opts.entry AND an input that expands)
		// throws BEFORE any submission is admitted.
		const before = await submissionsOf(server.opened, conversationId);
		await expect(
			submitOp(ctx, conversation!, "/skill:greet", {
				entry: { kind: BlocksAnswerEntry.kind, data: { entryId: "1" } },
			}),
		).rejects.toThrow(/entry/);
		expect(await submissionsOf(server.opened, conversationId)).toHaveLength(
			before.length,
		);
	});
});
