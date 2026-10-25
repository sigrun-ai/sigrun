/**
 * U5 Task 3 — change notes in the submit path (spec §8.3): before the
 * agent's next turn, core writes ONE `sigrun.blocks.note` entry covering
 * every surface with change records above `notedThrough`, then advances
 * each surface's `notedThrough`.
 *
 * Where (§8.3 "Where"): `submitOp` (the composer route AND
 * `host.conversations.submit`) plus `fireJob` — every turn starter. The
 * note is a `type: "write"` submission whose entry's `model` is one user
 * message; pi-durable places queued writes before queued inputs at every
 * boundary (`harness/inbox.js` applyBoundary), so a note queued while the
 * agent is busy still precedes its input, a steer included.
 *
 * Exactly once (§8.3 "Exactly once"): the note's `requestId` is
 * `blocks-note:<conversationId>:<sha256 of the sorted (entryId,
 * notedThrough) pairs before advancing>` — stable under retries, so a
 * crash between the admission and the `notedThrough` advance re-sends
 * under the same key and pi-durable returns the existing submission.
 *
 * Coverage (the brief's Step-1 list):
 * - three moves make no turns (submission count unchanged);
 * - the next composer message produces, in order, one
 *   `sigrun.blocks.note` entry (the §8.3 format: header line, `• <title>
 *   (<user>): <summaries>` lines, `Current state of <title>: …`) then
 *   the user entry;
 * - a fourth message with no new edits writes no note;
 * - busy queueing (Review Focus 1): an edit followed by a steer queues
 *   the note write and the steer; the note entry lands before the steer
 *   entry and the note's own requestId is stable (a second
 *   `writePendingNote` before the first placed still yields one note);
 * - crash recovery: a throw after the note's admission leaves
 *   `notedThrough` behind; a new edit plus another message recomputes
 *   the SAME requestId (positions never advanced) and exactly one note
 *   entry exists (pi-durable's `submissionByRequest` dedup); the
 *   deduped retry advances `notedThrough` only as far as the ADMITTED
 *   note covered (the coverage rides the note entry's `data`), so the
 *   later edit stays pending and a second note names it on the next
 *   turn.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import type {
	ConversationId,
	EntryRecord,
	SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { JsonObject, Tree } from "@sigrun/shared/blocks";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { BlocksEntry, BlocksNoteEntry } from "../src/harness/blocks/entries.js";
import { readBlocksState } from "../src/harness/blocks/state.js";
import { createServer } from "../src/server/index.js";
import { NOTE_HEADER } from "../src/server/blocks/notes.js";
import { applyChatAction } from "../src/server/blocks/chat-surfaces.js";
import * as NotesModule from "../src/server/blocks/notes.js";
import { seededIdentity } from "./helpers/identity.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The §8.5 ranking list: reorderable, bound to /cards. */
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

// (The two-surface note case lives in test/blocks-answers.test.ts.)

// ---------------------------------------------------------------------------
// The hermetic boot: harness + faux provider + server (the Task-2 shape)
// ---------------------------------------------------------------------------

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly faux: FauxProviderHandle;
	readonly aliceToken: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-blocks-notes-"));
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
	});
	// Auto-naming off (the tools.test pattern): the namer would consume
	// scripted responses.
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const identity = await seededIdentity(join(dir, "seed"), "alice");
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		builtins: false,
		env: {},
		settingsDir: dir,
	});
	const { token: aliceToken } = await opened.identity.tokens.create(
		"alice-cli",
		"alice",
	);
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, faux, aliceToken };
}

/** One assistant tool round (the Task-1 suite's helper). */
function toolRound(
	...calls: { name: string; args: JsonObject }[]
): AssistantMessage {
	return fauxAssistantMessage(
		calls.map((call) => fauxToolCall(call.name, call.args)),
		{ stopReason: "toolUse" },
	);
}

/**
 * Create one alice-owned conversation and drive `show_blocks` tool calls
 * (one per block) through the REAL submission path, returning the
 * conversation id and each block's entry id (blocks in call order).
 */
async function conversationWithBlocks(
	server: TestServer,
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
	const conversation = await opened.harness.conversation(
		conversationId as ConversationId,
		BACKGROUND_CONTEXT,
	);
	expect(conversation).toBeDefined();
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
		// Entries page newest-first; blocks are expected creation-ordered.
		.reverse()
		.map((entry) => String(entry.id));
	expect(entryIds).toHaveLength(blocks.length);
	return { conversationId, entryIds };
}

/** One move on a block, as alice, through the core handler directly. */
async function move(
	server: TestServer,
	conversationId: number,
	entryId: string,
	action: string,
	itemId: string,
	toIndex: number,
): Promise<void> {
	const outcome = await applyChatAction(
		server.opened.harness,
		conversationId,
		entryId,
		"alice",
		action,
		{ itemId, from: { index: 0 }, to: { index: toIndex } },
	);
	expect(outcome).toMatchObject({ ok: true });
}

/** Post one composer message (the HTTP submissions route) and wait. */
async function composerMessage(
	server: TestServer,
	conversationId: number,
	text: string,
): Promise<SubmissionRecord> {
	const response = await server.app.inject({
		method: "POST",
		url: `/v1/conversations/${conversationId}/submissions`,
		headers: { authorization: `Bearer ${server.aliceToken}` },
		payload: { input: text },
	});
	expect(response.statusCode).toBe(202);
	const body = response.json() as { submission: SubmissionRecord };
	const submission = await server.opened.harness.submission(
		body.submission.id,
		BACKGROUND_CONTEXT,
	);
	expect(submission).toBeDefined();
	return await submission!.wait(BACKGROUND_CONTEXT);
}

/** The conversation's durable submissions (ascending). */
async function submissionsOf(
	opened: OpenedHarness,
	conversationId: number,
): Promise<SubmissionRecord[]> {
	// `storage` is the boot-exposed Storage handle (the jobs fire.ts
	// pattern — the public field, never a private reach).
	const page = await opened.storage.scanSubmissions(
		{ conversationId: conversationId as ConversationId, order: "ascending" },
		100,
		undefined,
		BACKGROUND_CONTEXT,
	);
	return [...page.items];
}

/** The conversation's entries, oldest first. */
async function entriesOf(
	opened: OpenedHarness,
	conversationId: number,
): Promise<EntryRecord[]> {
	const conversation = await opened.harness.conversation(
		conversationId as ConversationId,
		BACKGROUND_CONTEXT,
	);
	const page = await conversation!.entries(
		{},
		200,
		undefined,
		BACKGROUND_CONTEXT,
	);
	return [...page.items].reverse();
}

/** The text of an entry's single model user message. */
function modelText(entry: EntryRecord): string {
	const message = entry.model?.[0];
	if (message === undefined || message.role !== "user") {
		throw new Error(`entry ${entry.id} (${entry.kind}) has no user model message`);
	}
	const content = message.content;
	return typeof content === "string"
		? content
		: content
				.map((part) => (part.type === "text" ? part.text : ""))
				.join("");
}

describe("change notes in the submit path (spec §8.3)", () => {
	test("moves make no turns; the next composer message carries one note, then the user entry; a quiet message writes none", async () => {
		const server = await bootServer();
		const { conversationId, entryIds } = await conversationWithBlocks(
			server,
			{ tree: RANKING_TREE, data: RANKING_DATA, title: "Ranking" },
		);
		const [entryId] = entryIds;
		const before = await submissionsOf(server.opened, conversationId);

		// Three moves: saved edits, NO turn (submission count unchanged).
		await move(server, conversationId, entryId!, "reorderCards", "c4", 0);
		await move(server, conversationId, entryId!, "reorderCards", "c3", 1);
		await move(server, conversationId, entryId!, "reorderCards", "c2", 2);
		expect(await submissionsOf(server.opened, conversationId)).toHaveLength(
			before.length,
		);

		// The next composer message: one note entry, then the user entry.
		server.faux.setResponses([fauxAssistantMessage("sounds good")]);
		const record = await composerMessage(server, conversationId, "does this flow well?");
		expect(record.status).toBe("done");

		const entries = await entriesOf(server.opened, conversationId);
		const note = entries.find((entry) => entry.kind === BlocksNoteEntry.kind);
		expect(note).toBeDefined();
		const text = modelText(note!);
		// The §8.3 shape: header, one bullet naming the surface and the
		// editor, and the full current order.
		expect(text).toContain(NOTE_HEADER);
		expect(text).toContain("• Ranking (alice): ");
		expect(text).toContain("moved 'Clair de Lune' from 4th to 1st");
		expect(text).toContain("Current state of Ranking:");
		expect(text).toContain("1. Clair de Lune");
		expect(text).toContain("2. Reflets");
		expect(text).toContain("3. Gymnopédie");
		expect(text).toContain("4. Arabesque");
		// The note precedes the user entry in the transcript.
		const userIndex = entries.findIndex(
			(entry) => entry.id === record.entry,
		);
		expect(userIndex).toBeGreaterThan(-1);
		expect(entries.indexOf(note!)).toBeLessThan(userIndex);
		// notedThrough advanced past the three records.
		const state = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId!,
			BACKGROUND_CONTEXT,
		);
		expect(state?.changes).toHaveLength(3);
		expect(state?.notedThrough).toBe(3);

		// A fourth message with no new edits writes no note.
		server.faux.setResponses([fauxAssistantMessage("ok")]);
		await composerMessage(server, conversationId, "thanks");
		const after = await entriesOf(server.opened, conversationId);
		expect(
			after.filter((entry) => entry.kind === BlocksNoteEntry.kind),
		).toHaveLength(1);
	});

	test("busy queueing (Review Focus 1): an edit then a steer queues the note before the steer entry", async () => {
		const server = await bootServer();
		const { conversationId, entryIds } = await conversationWithBlocks(
			server,
			{ tree: RANKING_TREE, data: RANKING_DATA, title: "Ranking" },
		);
		const [entryId] = entryIds;
		// The agent goes busy: a slow tool round, then the final answer.
		server.faux.setResponses([
			toolRound({ name: "bash", args: { command: "sleep 1" } }),
			fauxAssistantMessage("merged answer"),
		]);
		const conversation = await server.opened.harness.conversation(
			conversationId as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const first = await conversation!.submit(
			{ type: "input", content: "start" },
			BACKGROUND_CONTEXT,
		);
		// The edit lands mid-run (no turn of its own).
		await move(server, conversationId, entryId!, "reorderCards", "c4", 0);
		// The steer goes through the REAL composer path (submitOp), which
		// must write the note first and queue both.
		const steerResponse = await server.app.inject({
			method: "POST",
			url: `/v1/conversations/${conversationId}/submissions`,
			headers: { authorization: `Bearer ${server.aliceToken}` },
			payload: { input: "wait, one more thing", whenBusy: "steer" },
		});
		expect(steerResponse.statusCode).toBe(202);
		const steerRecord = (
			steerResponse.json() as { submission: SubmissionRecord }
		).submission;
		const steer = await server.opened.harness.submission(
			steerRecord.id,
			BACKGROUND_CONTEXT,
		);
		await Promise.all([
			first.wait(BACKGROUND_CONTEXT),
			steer!.wait(BACKGROUND_CONTEXT),
		]);
		// A queued submission's record carries no entry until placed —
		// re-read it settled.
		const steerPlaced = await steer!.status(BACKGROUND_CONTEXT);

		const entries = await entriesOf(server.opened, conversationId);
		const note = entries.find((entry) => entry.kind === BlocksNoteEntry.kind);
		expect(note).toBeDefined();
		const steerEntryIndex = entries.findIndex(
			(entry) => entry.id === steerPlaced.entry,
		);
		expect(steerEntryIndex).toBeGreaterThan(-1);
		expect(entries.indexOf(note!)).toBeLessThan(steerEntryIndex);
		// Exactly one note for those changes, and notedThrough advanced.
		const state = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId!,
			BACKGROUND_CONTEXT,
		);
		expect(state?.notedThrough).toBe(1);
	});

	test("crash between the note admission and the notedThrough advance: the retry recomputes the same requestId, one note entry exists, and the deduped retry advances only what the ADMITTED note covered", async () => {
		const server = await bootServer();
		const { conversationId, entryIds } = await conversationWithBlocks(
			server,
			{ tree: RANKING_TREE, data: RANKING_DATA, title: "Ranking" },
		);
		const [entryId] = entryIds;
		await move(server, conversationId, entryId!, "reorderCards", "c4", 0);
		const conversation = await server.opened.harness.conversation(
			conversationId as ConversationId,
			BACKGROUND_CONTEXT,
		);

		// The note admission succeeds, then the injected crash lands BEFORE
		// notedThrough advances (the test seam: one throw after admission).
		NotesModule.throwAfterNextNoteAdmissionForTesting();
		await expect(
			NotesModule.writePendingNote(
				server.opened.harness,
				conversation!,
				undefined,
				BACKGROUND_CONTEXT,
			),
		).rejects.toThrow("injected crash after note admission");
		// The note IS durably admitted (requestId dedup record exists);
		// notedThrough never advanced.
		const crashedState = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId!,
			BACKGROUND_CONTEXT,
		);
		expect(crashedState?.notedThrough).toBe(0);

		// A new edit, then another message: the retry computes the requestId
		// from the PRE-advance positions — identical to the crashed attempt's
		// — so pi-durable returns the existing submission and no second note
		// entry ever appears. The retry's freshly computed note would cover
		// BOTH edits, but pi-durable DISCARDS it (the admitted text names
		// only the first move) — so the advance must come from the ADMITTED
		// entry's durable coverage, leaving the second edit still pending.
		await move(server, conversationId, entryId!, "reorderCards", "c3", 0);
		server.faux.setResponses([fauxAssistantMessage("got it")]);
		await composerMessage(server, conversationId, "next message");

		const entries = await entriesOf(server.opened, conversationId);
		expect(
			entries.filter((entry) => entry.kind === BlocksNoteEntry.kind),
		).toHaveLength(1);
		// The advance covers ONLY what the admitted note named (seq 1).
		// The second edit stays pending — advancing past it would mark a
		// change noted that no admitted note ever described (the review
		// finding this fix answers), and trimChanges would then make it
		// unrecoverable.
		const state = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId!,
			BACKGROUND_CONTEXT,
		);
		expect(state?.notedThrough).toBe(1);

		// The NEXT turn notes the surviving edit (the durable-coverage
		// advance is position-stable, so its key differs from the first
		// note's — a fresh note entry lands).
		server.faux.setResponses([fauxAssistantMessage("noted")]);
		await composerMessage(server, conversationId, "and now?");
		const after = await entriesOf(server.opened, conversationId);
		const notes = after.filter(
			(entry) => entry.kind === BlocksNoteEntry.kind,
		);
		expect(notes).toHaveLength(2);
		// The second note names the second edit.
		expect(modelText(notes[1]!)).toContain("Reflets");
		const final = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId!,
			BACKGROUND_CONTEXT,
		);
		expect(final?.notedThrough).toBe(2);
	});

	test("host.conversations.submit writes the pending note too (the W5 bridge path)", async () => {
		const server = await bootServer();
		const { conversationId, entryIds } = await conversationWithBlocks(
			server,
			{ tree: RANKING_TREE, data: RANKING_DATA, title: "Ranking" },
		);
		const [entryId] = entryIds;
		await move(server, conversationId, entryId!, "reorderCards", "c4", 0);
		server.faux.setResponses([fauxAssistantMessage("via bridge")]);
		// The bridge surface the seam hosts hand extensions (spec §9.5):
		// the SAME submitOp the composer route runs.
		const bridge = server.app.hostBridge;
		await bridge.conversations.submit(conversationId as ConversationId, [
			{ type: "text", text: "bridge input" },
		]);
		const entries = await entriesOf(server.opened, conversationId);
		const notes = entries.filter(
			(entry) => entry.kind === BlocksNoteEntry.kind,
		);
		expect(notes).toHaveLength(1);
		expect(modelText(notes[0]!)).toContain(NOTE_HEADER);
	});
});
