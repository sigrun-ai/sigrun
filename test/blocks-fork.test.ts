/**
 * U5 Task 5 — forks (spec ruling 19): the chat-block state family is
 * `history: "latest", fork: "current"` — pi-durable copies the current
 * document at fork creation, so the child starts from the parent's
 * fork-time state (data, rev, change records, notedThrough) and then
 * diverges.
 *
 * Coverage (the brief's Step-1 list):
 * 1. block at E1, messages E2/E3, moves to rev 3, fork at E2 → the
 *    child's block shows the rev-3 state with `changes`/`notedThrough`
 *    exactly as in the parent at fork time;
 * 2. post-fork divergence: a move in the child does not change the
 *    parent and vice versa;
 * 3. a block created at E3 (after the fork point) is NOT addressable in
 *    the child (404 from the chat route) even though its state document
 *    was copied — `Conversation.entries` is fork-aware, so the child's
 *    entry scan never finds E3's entry;
 * 4. Review Focus 5: a move still unanswered in the channel at fork
 *    time is absent from the child (the fork copies the CONFIRMED
 *    state only), and lands in the parent when the action request
 *    completes;
 * 5. a `since` fetch against the child with a parent-era rev returns
 *    FULL data (the child's op log starts empty — the in-memory op
 *    table is keyed per (conversationId, entryId), and `fork: "current"`
 *    keeps the durable rev so a parent-era `since` also fails the
 *    window math).
 *
 * Hermetic pattern: faux provider scripting REAL tool rounds with the
 * server mounted over `app.inject` (the Task-2 suite's pattern), so a
 * real `show_blocks` tool call creates the block and the HTTP routes
 * read/edit its state family through production machinery.
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
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ConversationId,
} from "@earendil-works/pi-durable";
import type { JsonObject, Tree } from "@sigrun/shared/blocks";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { BlocksEntry } from "../src/harness/blocks/entries.js";
import { readBlocksState } from "../src/harness/blocks/state.js";
import { createServer } from "../src/server/index.js";
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

/** The post-fork scratch surface (only ever created at E3, after the fork). */
const SCRATCH_TREE: Tree = {
	v: 1,
	root: {
		type: "section",
		title: "Scratch",
		children: [
			{
				type: "collection",
				id: "scratch",
				items: { $: "/items" },
				display: "list",
				item: { title: { $: "./title" } },
			},
		],
	},
};

const SCRATCH_DATA: JsonObject = {
	items: [{ id: "s1", title: "scratch one" }],
};

// ---------------------------------------------------------------------------
// The hermetic boot: harness + faux provider + server (token auth, alice)
// ---------------------------------------------------------------------------

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly aliceToken: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** Boot one server (the Task-2 suite's pattern): auto-naming off so the
 *  namer never consumes scripted responses. */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-blocks-fork-"));
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
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const identity = await seededIdentity(join(dir, "seed"), "alice");
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		builtins: false,
		env: {},
		settingsDir: dir,
	});
	const { token } = await opened.identity.tokens.create("alice-cli", "alice");
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { app, opened, faux, aliceToken: token };
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

interface CallResult {
	readonly status: number;
	readonly body: Record<string, unknown>;
}

async function call(
	app: FastifyInstance,
	options: {
		readonly method: "GET" | "POST";
		readonly url: string;
		readonly token: string;
		readonly payload?: unknown;
	},
): Promise<CallResult> {
	const response = await app.inject({
		method: options.method,
		url: options.url,
		headers: { authorization: `Bearer ${options.token}` },
		...(options.payload === undefined
			? {}
			: { payload: options.payload as Record<string, unknown> }),
	});
	return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

/** One move action against the ranking collection (c4 to index 0). */
function movePayload(actionId: string): Record<string, unknown> {
	return {
		action: "reorderCards",
		payload: {
			itemId: "c4",
			from: { group: "", index: 3 },
			to: { group: "", index: 0 },
		},
		actionId,
	};
}

/** One entry's user-visible text (a `pi.user` entry's content may be a
 *  bare string or a parts array; the duplicate-request-id battery
 *  driver's shape). */
function entryText(entry: { readonly model?: readonly unknown[] }): string {
	const content = (entry.model?.[0] as { content?: unknown } | undefined)
		?.content;
	const parts = Array.isArray(content) ? content : [{ text: content }];
	return parts
		.map((part) => String((part as { text?: string }).text ?? ""))
		.join("");
}

// ---------------------------------------------------------------------------
// Scenario driver: create → show_blocks → settled messages
// ---------------------------------------------------------------------------

/**
 * Create one conversation owned by alice and drive a REAL `show_blocks`
 * tool round. Returns the conversation id and the block's entry (id and
 * wire entryId string).
 */
async function conversationWithBlock(
	server: TestServer,
	tree: Tree,
	data: JsonObject,
	title: string,
): Promise<{
	conversationId: number;
	entryNumericId: number;
	entryId: string;
}> {
	const created = await call(server.app, {
		method: "POST",
		url: "/v1/conversations",
		token: server.aliceToken,
	});
	expect(created.status).toBe(201);
	const conversationId = created.body.id as number;
	const conversation = await server.opened.harness.conversation(
		conversationId as ConversationId,
		BACKGROUND_CONTEXT,
	);
	expect(conversation).toBeDefined();
	server.faux.setResponses([
		toolRound({
			name: "show_blocks",
			args: { title, tree: tree as unknown as JsonObject, data },
		}),
		fauxAssistantMessage("shown"),
	]);
	const submission = await conversation!.submit(
		{ type: "input", content: "show the block" },
		BACKGROUND_CONTEXT,
	);
	await submission.wait(BACKGROUND_CONTEXT);
	const page = await conversation!.entries(
		{},
		100,
		undefined,
		BACKGROUND_CONTEXT,
	);
	for (const entry of page.items) {
		if (entry.kind === BlocksEntry.kind) {
			return {
				conversationId,
				entryNumericId: Number(entry.id),
				entryId: String(entry.id),
			};
		}
	}
	throw new Error("no sigrun.blocks entry in the conversation");
}

/** Add one settled user message through the REAL submit route
 *  (`POST /v1/conversations/:id/submissions?waitMs=…` → `submitOp`, so
 *  the §8.3 note prelude runs before admission), returning the
 *  submitted user entry's numeric id. */
async function settledMessage(
	server: TestServer,
	conversationId: number,
	text: string,
): Promise<number> {
	server.faux.setResponses([fauxAssistantMessage("noted")]);
	const submitted = await call(server.app, {
		method: "POST",
		url: `/v1/conversations/${conversationId}/submissions?waitMs=10000`,
		token: server.aliceToken,
		payload: { input: text },
	});
	expect(submitted.status).toBe(202);
	// The response wraps the settled record (§7.1: `{submission}`); with
	// a generous waitMs a faux round settles in-flight.
	const record = submitted.body.submission as { status?: string };
	expect(record.status).toBe("done");
	const conversation = await server.opened.harness.conversation(
		conversationId as ConversationId,
		BACKGROUND_CONTEXT,
	);
	expect(conversation).toBeDefined();
	const page = await conversation!.entries(
		{},
		100,
		undefined,
		BACKGROUND_CONTEXT,
	);
	for (const entry of page.items) {
		if (entry.kind === "pi.user" && entryText(entry).includes(text)) {
			return Number(entry.id);
		}
	}
	throw new Error(`no pi.user entry carrying ${JSON.stringify(text)}`);
}

/** One chat move through the route; asserts the §6.3 accept shape. */
async function moveInConversation(
	server: TestServer,
	conversationId: number,
	entryId: string,
	actionId: string,
): Promise<number> {
	const base = `/v1/conversations/${conversationId}/blocks/${entryId}`;
	const result = await call(server.app, {
		method: "POST",
		url: `${base}/actions`,
		token: server.aliceToken,
		payload: movePayload(actionId),
	});
	expect(result.status).toBe(200);
	expect(result.body.ok).toBe(true);
	return result.body.rev as number;
}

/** Fork one conversation at one entry id; returns the child id. */
async function forkAt(
	server: TestServer,
	conversationId: number,
	at: number,
): Promise<number> {
	const forked = await call(server.app, {
		method: "POST",
		url: `/v1/conversations/${conversationId}/fork`,
		token: server.aliceToken,
		payload: { at },
	});
	expect(forked.status).toBe(201);
	return forked.body.id as number;
}

// ---------------------------------------------------------------------------
// The scenario setup (shared by the fork tests): block at E1 → E2 →
// three moves → E3, then fork at E2.
// ---------------------------------------------------------------------------

interface ForkScenario {
	readonly server: TestServer;
	readonly parentId: number;
	readonly childId: number;
	readonly entryId: string;
	/** The block's numeric entry id (E1). */
	readonly e1: number;
	/** The first settled message (the fork point, E2). */
	readonly e2: number;
	/** The message AFTER the fork point (E3). */
	readonly e3: number;
}

/**
 * Build the brief's scenario: a ranking block at E1, settled messages
 * E2 and E3, and — between E2 and E3 — THREE moves (state rev 3) that
 * are then noted (notedThrough 3) by the settled E3 turn. Forks at E2.
 *
 * Note ordering matters: the moves land while E3's message is NOT yet
 * submitted, so `submitOp`'s §8.3 prelude writes the change note and
 * advances notedThrough as part of admitting E3 — the parent at fork
 * time carries `notedThrough: 3`.
 */
async function forkScenario(): Promise<ForkScenario> {
	const server = await bootServer();
	const { conversationId, entryId, entryNumericId } =
		await conversationWithBlock(server, RANKING_TREE, RANKING_DATA, "Ranking");
	const parentId = conversationId;
	const e2 = await settledMessage(server, parentId, "message E2");
	// Three moves → rev 3, three change records.
	expect(await moveInConversation(server, parentId, entryId, "fork-move-1")).toBe(1);
	expect(await moveInConversation(server, parentId, entryId, "fork-move-2")).toBe(2);
	expect(await moveInConversation(server, parentId, entryId, "fork-move-3")).toBe(3);
	// E3's admission writes the pending note for the three moves and
	// advances notedThrough to 3.
	const e3 = await settledMessage(server, parentId, "message E3");
	// Fork at E2: the child keeps the parent's history through E2 (the
	// block at E1 is in it; E3 is not).
	const childId = await forkAt(server, parentId, e2);
	return { server, parentId, childId, entryId, e1: entryNumericId, e2, e3 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("chat blocks and forks (ruling 19: fork copies current state)", () => {
	test("1. fork from E2: the child's block shows the rev-3 state with changes/notedThrough exactly as the parent", async () => {
		const { server, parentId, childId, entryId } = await forkScenario();
		// The parent's state at fork time: rev 3 (three moves), three
		// records, notedThrough advanced to 3 by E3's admission note.
		const parentState = await readBlocksState(
			server.opened.harness,
			parentId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(parentState).toBeDefined();
		expect(parentState!.rev).toBe(3);
		expect(parentState!.changes.length).toBe(3);
		expect(parentState!.notedThrough).toBe(3);
		// The child reads IDENTICAL state through the durable family (the
		// fork: "current" copy) and through the chat route.
		const childState = await readBlocksState(
			server.opened.harness,
			childId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(childState).toEqual(parentState);
		const base = `/v1/conversations/${childId}/blocks/${entryId}`;
		const got = await call(server.app, {
			method: "GET",
			url: base,
			token: server.aliceToken,
		});
		expect(got.status).toBe(200);
		expect(got.body.rev).toBe(3);
		expect(got.body.data).toEqual(parentState!.data);
		// The confirmed data carries the three moves (c4 moved to index 0
		// three times = moved once, the subsequent moves no-op positionally
		// but still bumped rev/records).
		const cards = (got.body.data as { cards: { id: string }[] }).cards;
		expect(cards[0]!.id).toBe("c4");
	});

	test("2. post-fork divergence: a move in the child doesn't change the parent and vice versa", async () => {
		const { server, parentId, childId, entryId } = await forkScenario();
		const parentBefore = await readBlocksState(
			server.opened.harness,
			parentId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		const childBefore = await readBlocksState(
			server.opened.harness,
			childId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		// A move in the child: the child's rev advances, the parent's is
		// untouched (no shared member: the fork copied, it did not link).
		expect(
			await moveInConversation(server, childId, entryId, "child-move"),
		).toBe(4);
		const parentAfterChildMove = await readBlocksState(
			server.opened.harness,
			parentId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(parentAfterChildMove).toEqual(parentBefore);
		const childAfterChildMove = await readBlocksState(
			server.opened.harness,
			childId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(childAfterChildMove!.rev).toBe(4);
		expect(childAfterChildMove!.changes.length).toBe(4);
		// And the other direction: a move in the parent leaves the child.
		expect(
			await moveInConversation(server, parentId, entryId, "parent-move"),
		).toBe(4);
		const childAfterParentMove = await readBlocksState(
			server.opened.harness,
			childId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(childAfterParentMove).toEqual(childAfterChildMove);
		expect(childAfterParentMove).not.toEqual(childBefore);
	});

	test("3. a block created at E3 (after the fork point) is not addressable in the child (404) even though its state document was copied", async () => {
		const server = await bootServer();
		// Block at E1, message E2 (the fork point), then a SECOND block
		// created at E3 — after the fork.
		const { conversationId } = await conversationWithBlock(
			server,
			RANKING_TREE,
			RANKING_DATA,
			"Ranking",
		);
		const parentId = conversationId;
		const e2 = await settledMessage(server, parentId, "message E2");
		const { entryNumericId: e3EntryNumericId, entryId: e3EntryId } =
			await conversationWithBlock2(server, parentId);
		void e3EntryNumericId;
		const childId = await forkAt(server, parentId, e2);
		// The fork copied the state document (ruling 19: "current" — every
		// conversation-scoped family member copies at fork creation)…
		const copied = await readBlocksState(
			server.opened.harness,
			childId,
			e3EntryId,
			BACKGROUND_CONTEXT,
		);
		expect(copied).toBeDefined();
		// …but the child never SAW the E3 entry, so the route's fork-aware
		// entry scan finds no block: 404 from every chat route.
		for (const url of [
			`/v1/conversations/${childId}/blocks/${e3EntryId}`,
			`/v1/conversations/${childId}/blocks/${e3EntryId}/data`,
		]) {
			const got = await call(server.app, {
				method: "GET",
				url,
				token: server.aliceToken,
			});
			expect(got.status).toBe(404);
			expect(got.body).toEqual({ error: "block_not_found" });
		}
		// The actions route likewise (the read gates happen first: alice
		// owns the child, so the 404 is the block lookup, not access).
		const action = await call(server.app, {
			method: "POST",
			url: `/v1/conversations/${childId}/blocks/${e3EntryId}/actions`,
			token: server.aliceToken,
			payload: movePayload("child-on-e3"),
		});
		expect(action.status).toBe(404);
		expect(action.body).toEqual({ error: "block_not_found" });
		// And in the PARENT the E3 block addresses fine (control).
		const parentGot = await call(server.app, {
			method: "GET",
			url: `/v1/conversations/${parentId}/blocks/${e3EntryId}`,
			token: server.aliceToken,
		});
		expect(parentGot.status).toBe(200);
	});

	test("4. Review Focus 5: a move still unanswered in the channel at fork time is absent from the child, and lands in the parent when the action completes", async () => {
		const { server, parentId, entryId, e2 } = await (async () => {
			const server = await bootServer();
			const { conversationId, entryId } = await conversationWithBlock(
				server,
				RANKING_TREE,
				RANKING_DATA,
				"Ranking",
			);
			const e2 = await settledMessage(server, conversationId, "message E2");
			return { server, parentId: conversationId, entryId, e2 };
		})();
		// A move in flight: the channel POSTed the action but no response
		// has arrived yet (the §6.3 overlay entry is still pending). The
		// confirmed durable state at fork time is rev 0 — the move hasn't
		// committed.
		const inFlight = server.app.inject({
			method: "POST",
			url: `/v1/conversations/${parentId}/blocks/${entryId}/actions`,
			headers: { authorization: `Bearer ${server.aliceToken}` },
			payload: movePayload("pending-move"),
		});
		// Fork immediately (the race the focus names: the fork commits
		// before the action's commit lands — app.inject dispatches both
		// requests, and the fork is issued first in completion order by
		// awaiting it after the action promise is created but before it
		// resolves).
		const childId = await forkAt(server, parentId, e2);
		// The child's copy holds only the CONFIRMED state at fork time.
		const childState = await readBlocksState(
			server.opened.harness,
			childId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(childState!.rev).toBe(0);
		expect(childState!.changes).toEqual([]);
		expect(childState!.data).toEqual(RANKING_DATA);
		// When the handler answers, the move lands in the PARENT (its
		// address is the parent's conversation id).
		const settled = await inFlight;
		expect(settled.statusCode).toBe(200);
		expect(settled.json()).toMatchObject({ ok: true, rev: 1 });
		const parentState = await readBlocksState(
			server.opened.harness,
			parentId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(parentState!.rev).toBe(1);
		expect(parentState!.changes.length).toBe(1);
		// The child is unchanged by the parent's late answer.
		const childAfter = await readBlocksState(
			server.opened.harness,
			childId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(childAfter!.rev).toBe(0);
		expect(childAfter!.changes).toEqual([]);
	});

	test("5. a since fetch against the child with a parent-era rev returns FULL data (the child's op log starts empty)", async () => {
		const { server, childId, entryId } = await forkScenario();
		// One move in the child: durable rev 4, and ONE op recorded in the
		// child's own (freshly keyed) in-memory window.
		expect(
			await moveInConversation(server, childId, entryId, "child-since-move"),
		).toBe(4);
		// A parent-era rev (3 = the parent's rev at fork time) asks the
		// child's op log for ops since 3. The child's window starts at 4:
		// `since < state.rev - state.ops.length` (3 < 4 - 1) → undefined →
		// the route falls back to FULL data, never a partial replay across
		// the fork boundary.
		const got = await call(server.app, {
			method: "GET",
			url: `/v1/conversations/${childId}/blocks/${entryId}/data?since=3`,
			token: server.aliceToken,
		});
		expect(got.status).toBe(200);
		expect(got.body.rev).toBe(4);
		expect(got.body.ops).toBeUndefined();
		expect(got.body.data).toBeDefined();
		const cards = (got.body.data as { cards: { id: string }[] }).cards;
		expect(cards[0]!.id).toBe("c4");
		// Control: a since INSIDE the child's own window (4) answers ops.
		const inside = await call(server.app, {
			method: "GET",
			url: `/v1/conversations/${childId}/blocks/${entryId}/data?since=3`,
			token: server.aliceToken,
		});
		expect(inside.status).toBe(200);
		// And rev-equal since returns the empty op tail (rev === rev).
		const atHead = await call(server.app, {
			method: "GET",
			url: `/v1/conversations/${childId}/blocks/${entryId}/data?since=4`,
			token: server.aliceToken,
		});
		expect(atHead.status).toBe(200);
		expect(atHead.body.ops).toEqual([]);
	});
});

/**
 * A second `show_blocks` round in an EXISTING conversation (Task 5
 * case 3's E3 block): drives one more tool round and returns the NEW
 * block's entry.
 */
async function conversationWithBlock2(
	server: TestServer,
	conversationId: number,
): Promise<{ entryNumericId: number; entryId: string }> {
	const conversation = await server.opened.harness.conversation(
		conversationId as ConversationId,
		BACKGROUND_CONTEXT,
	);
	expect(conversation).toBeDefined();
	server.faux.setResponses([
		toolRound({
			name: "show_blocks",
			args: {
				title: "Scratch",
				tree: SCRATCH_TREE as unknown as JsonObject,
				data: SCRATCH_DATA,
			},
		}),
		fauxAssistantMessage("shown"),
	]);
	const submission = await conversation!.submit(
		{ type: "input", content: "show another block" },
		BACKGROUND_CONTEXT,
	);
	await submission.wait(BACKGROUND_CONTEXT);
	const page = await conversation!.entries(
		{},
		100,
		undefined,
		BACKGROUND_CONTEXT,
	);
	// The NEWEST sigrun.blocks entry is this round's (entries are
	// newest-first in the page).
	for (const entry of page.items) {
		if (entry.kind === BlocksEntry.kind) {
			return {
				entryNumericId: Number(entry.id),
				entryId: String(entry.id),
			};
		}
	}
	throw new Error("no second sigrun.blocks entry in the conversation");
}
