/**
 * U5 Task 2 — the chat-block surface routes (spec §8.2): a chat block
 * reuses U3's surface machinery with CORE as the handler.
 *
 * `GET /v1/conversations/:id/blocks/:entryId` → `{tree, data, rev,
 * treeRev: 0, access}`; `…/data?since=` and `…/actions` mirror §7.2.
 * Access is the CONVERSATION's (write edits; read sees; hidden is 404
 * — indistinguishable from an unknown conversation, §5.9). Ops are
 * kept and returned like `sharedData` surfaces (chat data is the same
 * for everyone who can see the conversation).
 *
 * The harness boots the same way the Task-1 suite does (faux provider
 * scripting REAL tool rounds), with the server mounted on top via
 * `app.inject` — so a real `show_blocks` tool call creates the block,
 * and the HTTP routes read and edit its state family through the same
 * durable machinery production uses.
 *
 * Coverage (the brief's test list):
 * - write principal GET → the block's tree/data/rev/access;
 *   hidden (a non-shared private conversation) → 404; read principal
 *   POST → 403;
 * - `move` applies `DataOp.move`, bumps rev, appends
 *   `{seq: 1, by: "alice", action: "reorder", summary: …}` and answers
 *   `{ok: true, rev, ops}`;
 * - a cross-group move sets the item's `groupBy` field; a check
 *   appends "checked 'milk' in 'Shopping'"; a `turn: false` submit
 *   writes the form values at its `bind` and appends "set 'Notes' to
 *   '…'" (80-char truncation);
 * - Review Focus 3: alice and bob each move once → two records, each
 *   with its own `by`;
 * - a duplicate actionId applies once;
 * - more than 50 records with notedThrough past them are trimmed on
 *   the next append;
 * - the `data?since=` window returns the kept ops.
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
import type { Context } from "@earendil-works/chord";
import type {
	Conversation,
	ConversationId,
	Harness,
	Tx,
} from "@earendil-works/pi-durable";
import type { JsonObject, Tree } from "@sigrun/shared/blocks";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { BlocksEntry } from "../src/harness/blocks/entries.js";
import {
	BlocksStateDoc,
	readBlocksState,
	type ChangeRecord,
} from "../src/harness/blocks/state.js";
import { createServer } from "../src/server/index.js";
import { applyChatAction } from "../src/server/blocks/chat-surfaces.js";
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

/** A grouped lanes board: cross-group moves set `status`. */
const LANES_TREE: Tree = {
	v: 1,
	root: {
		type: "section",
		title: "Chores",
		children: [
			{
				type: "collection",
				id: "tasks",
				items: { $: "/tasks" },
				display: "lanes",
				groupBy: "status",
				groups: [
					{ id: "todo", title: "To do" },
					{ id: "done", title: "Done" },
				],
				reorder: { within: true, across: true },
				onMove: "moveTask",
				item: { title: { $: "./title" } },
			},
		],
	},
};

const LANES_DATA: JsonObject = {
	tasks: [
		{ id: "t1", title: "Write spec", status: "todo" },
		{ id: "t2", title: "Ship it", status: "todo" },
		{ id: "d1", title: "Review", status: "done" },
	],
};

/** A checkable shopping list (onCheck edit). */
const SHOPPING_TREE: Tree = {
	v: 1,
	root: {
		type: "section",
		title: "Shopping",
		children: [
			{
				type: "collection",
				id: "shopping",
				items: { $: "/items" },
				display: "list",
				checkable: "bought",
				onCheck: "toggleBought",
				item: { title: { $: "./name" } },
			},
		],
	},
};

const SHOPPING_DATA: JsonObject = {
	items: [{ id: "m1", name: "milk", bought: false }],
};

/** A `turn: false` submit form (writes values at its bind). */
const FORM_TREE: Tree = {
	v: 1,
	root: {
		type: "form",
		id: "notes-form",
		bind: "/notes",
		mode: "submit",
		onSubmit: "saveNotes",
		turn: false,
		children: [
			{ type: "longtext", name: "Notes", label: "Notes" },
		],
	},
};

// ---------------------------------------------------------------------------
// The hermetic boot: harness + faux provider + server
// ---------------------------------------------------------------------------

interface TestServer {
	readonly app: FastifyInstance;
	readonly opened: OpenedHarness;
	/** The booted faux provider (responses are settable per scenario). */
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly aliceToken: string;
	readonly bobToken: string;
	readonly carolToken: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/**
 * Boot one server: the faux provider with NO scripted responses yet
 * (each test appends its own rounds), token auth, three users (alice
 * the owner, bob shared write, carol shared read).
 */
async function bootServer(): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-blocks-routes-"));
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
	for (const user of ["bob", "carol"]) {
		if (identity.users.get(user) === undefined) {
			await identity.users.add({
				user,
				name: `${user} acme`,
				admin: false,
				source: "cli",
			});
		}
	}
	const opened = await openHarness(config, {
		identity,
		extensions: [contributor],
		builtins: false,
		env: {},
		settingsDir: dir,
	});
	const tokens = {} as Record<string, string>;
	for (const user of ["alice", "bob", "carol"]) {
		const { token } = await opened.identity.tokens.create(
			`${user}-cli`,
			user,
		);
		tokens[user] = token;
	}
	const app = await createServer(opened, config);
	cleanups.push(async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return {
		app,
		opened,
		faux,
		aliceToken: tokens.alice!,
		bobToken: tokens.bob!,
		carolToken: tokens.carol!,
	};
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
		readonly method: "GET" | "POST" | "PATCH";
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

/**
 * Create one conversation owned by alice (shared household-write by
 * default so bob writes and carol reads at the chosen level) and drive
 * one `show_blocks` tool call through the REAL submit path, returning
 * the conversation id and the block's entry id.
 */
async function conversationWithBlock(
	server: TestServer,
	tree: Tree,
	data: JsonObject,
	title: string,
	sharing: "private" | "write" | "read" = "write",
): Promise<{ conversationId: number; entryId: string }> {
	const { opened, app, aliceToken, faux } = server;
	// Create as alice via the route (the auth hook stamps the owner).
	const created = await call(app, {
		method: "POST",
		url: "/v1/conversations",
		token: aliceToken,
	});
	expect(created.status).toBe(201);
	const conversationId = created.body.id as number;
	// The sharing grant (alice patches her own conversation's meta).
	if (sharing !== "private") {
		const shared = await call(app, {
			method: "PATCH",
			url: `/v1/conversations/${conversationId}/meta`,
			token: aliceToken,
			payload: {
				sharing: {
					scope: "household",
					level: sharing === "write" ? "write" : "read",
				},
			},
		});
		expect(shared.status).toBe(200);
	}
	// The tool call drives through the REAL submission path.
	const conversation = await opened.harness.conversation(
		conversationId as never,
		BACKGROUND_CONTEXT,
	);
	expect(conversation).toBeDefined();
	faux.setResponses([
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
	// Read the entry back through the conversation's history.
	const page = await conversation!.entries(
		{},
		100,
		undefined,
		BACKGROUND_CONTEXT,
	);
	for (const entry of page.items) {
		if (entry.kind === BlocksEntry.kind) {
			return { conversationId, entryId: String(entry.id) };
		}
	}
	throw new Error("no sigrun.blocks entry in the conversation");
}

describe("chat block routes (spec §8.2)", () => {
	test("GET returns the block for the write principal; hidden → 404; read actions → 403", async () => {
		const server = await bootServer();
		const { conversationId, entryId } = await conversationWithBlock(
			server,
			RANKING_TREE,
			RANKING_DATA,
			"Ranking",
			// Shared at READ: carol sees the block read-only (alice, the
			// owner, still writes).
			"read",
		);
		const base = `/v1/conversations/${conversationId}/blocks/${entryId}`;

		// The write principal (alice, the owner) sees the block.
		const got = await call(server.app, {
			method: "GET",
			url: base,
			token: server.aliceToken,
		});
		expect(got.status).toBe(200);
		expect(got.body).toMatchObject({
			tree: RANKING_TREE,
			data: RANKING_DATA,
			rev: 0,
			treeRev: 0,
			access: "write",
		});

		// The shared-read principal (carol) sees it too, read access.
		const read = await call(server.app, {
			method: "GET",
			url: base,
			token: server.carolToken,
		});
		expect(read.status).toBe(200);
		expect(read.body.access).toBe("read");

		// A hidden conversation (bob on alice's PRIVATE conversation) is
		// 404 — indistinguishable from an unknown conversation id.
		const priv = await conversationWithBlock(
			server,
			RANKING_TREE,
			RANKING_DATA,
			"Private",
			"private",
		);
		const denied = await call(server.app, {
			method: "GET",
			url: `/v1/conversations/${priv.conversationId}/blocks/${priv.entryId}`,
			token: server.bobToken,
		});
		const unknownConv = await call(server.app, {
			method: "GET",
			url: `/v1/conversations/999999/blocks/${priv.entryId}`,
			token: server.bobToken,
		});
		expect(denied.status).toBe(404);
		expect(denied.body).toEqual(unknownConv.body);

		// A read principal's action is 403, nothing applied.
		const stateBefore = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		const forbidden = await call(server.app, {
			method: "POST",
			url: `${base}/actions`,
			token: server.carolToken,
			payload: {
				action: "reorderCards",
				payload: {
					itemId: "c4",
					from: { group: "", index: 3 },
					to: { group: "", index: 0 },
				},
				actionId: "act-denied",
			},
		});
		expect(forbidden.status).toBe(403);
		const stateAfter = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(stateAfter).toEqual(stateBefore);
	});

	test("move applies DataOp.move, bumps rev, appends the change record, and answers {ok, rev, ops}", async () => {
		const server = await bootServer();
		const { conversationId, entryId } = await conversationWithBlock(
			server,
			RANKING_TREE,
			RANKING_DATA,
			"Ranking",
		);
		const base = `/v1/conversations/${conversationId}/blocks/${entryId}`;

		const result = await call(server.app, {
			method: "POST",
			url: `${base}/actions`,
			token: server.aliceToken,
			payload: {
				action: "reorderCards",
				payload: {
					itemId: "c4",
					from: { group: "", index: 3 },
					to: { group: "", index: 0 },
				},
				actionId: "act-move-1",
			},
		});
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ ok: true, rev: 1 });
		// The ops echoed back: one DataOp.move from index 3 to index 0 of
		// the bound array (the §6.3 accept-with-ops shape).
		const ops = result.body.ops as { op: string; from: string; path: string }[];
		expect(ops).toEqual([
			{ op: "move", from: "/cards/3", path: "/cards/0" },
		]);

		// The durable state: rev bumped, the record appended.
		const state = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(state?.rev).toBe(1);
		expect(state?.data.cards).toEqual([
			{ id: "c4", title: "Clair de Lune" },
			{ id: "c1", title: "Arabesque" },
			{ id: "c2", title: "Gymnopédie" },
			{ id: "c3", title: "Reflets" },
		]);
		expect(state?.changes).toHaveLength(1);
		const record = state?.changes[0] as ChangeRecord | undefined;
		expect(record).toMatchObject({
			seq: 1,
			by: "alice",
			action: "reorder",
			summary: "moved 'Clair de Lune' from 4th to 1st in 'Ranking'",
		});
		expect(typeof record?.at).toBe("number");

		// The since window carries the kept ops (sharedData semantics).
		const delta = await call(server.app, {
			method: "GET",
			url: `${base}/data?since=0`,
			token: server.aliceToken,
		});
		expect(delta.status).toBe(200);
		expect(delta.body.rev).toBe(1);
		expect(delta.body.treeRev).toBe(0);
		expect(delta.body.ops).toEqual([
			{ op: "move", from: "/cards/3", path: "/cards/0" },
		]);
	});

	test("a cross-group move sets the item's groupBy field", async () => {
		const server = await bootServer();
		const { conversationId, entryId } = await conversationWithBlock(
			server,
			LANES_TREE,
			LANES_DATA,
			"Chores",
		);
		const result = await call(server.app, {
			method: "POST",
			url: `/v1/conversations/${conversationId}/blocks/${entryId}/actions`,
			token: server.aliceToken,
			payload: {
				action: "moveTask",
				payload: {
					itemId: "t1",
					from: { group: "todo", index: 0 },
					to: { group: "done", index: 0 },
				},
				actionId: "act-cross",
			},
		});
		expect(result.status).toBe(200);
		const state = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		// The moved item's status flipped to the destination group; its
		// position is the group-relative drop index.
		expect(state?.data.tasks).toEqual([
			{ id: "t2", title: "Ship it", status: "todo" },
			{ id: "t1", title: "Write spec", status: "done" },
			{ id: "d1", title: "Review", status: "done" },
		]);
		const record = state?.changes[0] as ChangeRecord | undefined;
		expect(record?.summary).toBe("moved 'Write spec' from 1st to 1st in 'Done'");
	});

	test("a check appends \"checked 'milk' in 'Shopping'\" and sets the field", async () => {
		const server = await bootServer();
		const { conversationId, entryId } = await conversationWithBlock(
			server,
			SHOPPING_TREE,
			SHOPPING_DATA,
			"Shopping",
		);
		const result = await call(server.app, {
			method: "POST",
			url: `/v1/conversations/${conversationId}/blocks/${entryId}/actions`,
			token: server.aliceToken,
			payload: {
				action: "toggleBought",
				payload: { itemId: "m1", value: true },
				actionId: "act-check",
			},
		});
		expect(result.status).toBe(200);
		expect(result.body).toMatchObject({ ok: true, rev: 1 });
		const state = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(state?.data.items).toEqual([
			{ id: "m1", name: "milk", bought: true },
		]);
		const record = state?.changes[0] as ChangeRecord | undefined;
		expect(record?.summary).toBe("checked 'milk' in 'Shopping'");
		expect(record?.action).toBe("edit");
	});

	test("a turn:false submit writes the form values at its bind and truncates at 80 chars", async () => {
		const server = await bootServer();
		const { conversationId, entryId } = await conversationWithBlock(
			server,
			FORM_TREE,
			{},
			"Notes",
		);
		const long = "y".repeat(81);
		const result = await call(server.app, {
			method: "POST",
			url: `/v1/conversations/${conversationId}/blocks/${entryId}/actions`,
			token: server.aliceToken,
			payload: {
				action: "saveNotes",
				payload: { values: { Notes: long } },
				actionId: "act-submit",
				turn: false,
			},
		});
		expect(result.status).toBe(200);
		const state = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		// The values landed at the form's bind (/notes).
		expect(state?.data).toEqual({ notes: { Notes: long } });
		const record = state?.changes[0] as ChangeRecord | undefined;
		expect(record?.action).toBe("submit");
		expect(record?.summary).toBe(`set 'Notes' to '${"y".repeat(80)}…'`);
	});

	test("Review Focus 3: alice and bob each move once → two records with their own by", async () => {
		const server = await bootServer();
		const { conversationId, entryId } = await conversationWithBlock(
			server,
			RANKING_TREE,
			RANKING_DATA,
			"Ranking",
		);
		const base = `/v1/conversations/${conversationId}/blocks/${entryId}`;
		const first = await call(server.app, {
			method: "POST",
			url: `${base}/actions`,
			token: server.aliceToken,
			payload: {
				action: "reorderCards",
				payload: {
					itemId: "c4",
					from: { group: "", index: 3 },
					to: { group: "", index: 0 },
				},
				actionId: "act-rf3-a",
			},
		});
		expect(first.status).toBe(200);
		// Bob (household-write) acts on the same surface: c1 to the end.
		const second = await call(server.app, {
			method: "POST",
			url: `${base}/actions`,
			token: server.bobToken,
			payload: {
				action: "reorderCards",
				payload: {
					itemId: "c1",
					from: { group: "", index: 1 },
					to: { group: "", index: 3 },
				},
				actionId: "act-rf3-b",
			},
		});
		expect(second.status).toBe(200);

		const state = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(state?.rev).toBe(2);
		expect(state?.changes).toHaveLength(2);
		expect((state?.changes[0] as ChangeRecord).by).toBe("alice");
		expect((state?.changes[0] as ChangeRecord).seq).toBe(1);
		expect((state?.changes[1] as ChangeRecord).by).toBe("bob");
		expect((state?.changes[1] as ChangeRecord).seq).toBe(2);
		expect((state?.changes[1] as ChangeRecord).summary).toBe(
			"moved 'Arabesque' from 2nd to 4th in 'Ranking'",
		);
	});

	test("a duplicate actionId applies once (U3's dedup)", async () => {
		const server = await bootServer();
		const { conversationId, entryId } = await conversationWithBlock(
			server,
			RANKING_TREE,
			RANKING_DATA,
			"Ranking",
		);
		const base = `/v1/conversations/${conversationId}/blocks/${entryId}`;
		const body = {
			action: "reorderCards",
			payload: {
				itemId: "c4",
				from: { group: "", index: 3 },
				to: { group: "", index: 0 },
			},
			actionId: "act-dup",
		};
		const first = await call(server.app, {
			method: "POST",
			url: `${base}/actions`,
			token: server.aliceToken,
			payload: body,
		});
		expect(first.status).toBe(200);
		expect(first.body.rev).toBe(1);
		// The duplicate: same actionId, same principal — the FIRST stored
		// result, nothing applied again.
		const duplicate = await call(server.app, {
			method: "POST",
			url: `${base}/actions`,
			token: server.aliceToken,
			payload: body,
		});
		expect(duplicate.status).toBe(200);
		expect(duplicate.body).toEqual(first.body);

		const state = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(state?.rev).toBe(1);
		expect(state?.changes).toHaveLength(1);
	});

	test("more than 50 records with notedThrough past them are trimmed on the next append", async () => {
		const server = await bootServer();
		const { conversationId, entryId } = await conversationWithBlock(
			server,
			RANKING_TREE,
			RANKING_DATA,
			"Ranking",
		);
		const base = `/v1/conversations/${conversationId}/blocks/${entryId}`;

		// Seed 51 records directly through the state family (the write the
		// route would have made, minus HTTP round-trips): seq 1..51,
		// notedThrough 50 (past all but the last).
		const conversation = await server.opened.harness.conversation(
			conversationId as never,
			BACKGROUND_CONTEXT,
		);
		const seeded: ChangeRecord[] = [];
		for (let seq = 1; seq <= 51; seq++) {
			seeded.push({
				seq,
				at: 1,
				by: "alice",
				action: "edit",
				summary: `seed ${seq}`,
			});
		}
		await conversation!.commit(async (tx) => {
			const draft = await tx.doc(
				BlocksStateDoc,
				conversationId as never,
				entryId,
				entryId,
			);
			draft.changes = seeded;
			draft.notedThrough = 50;
		}, BACKGROUND_CONTEXT);

		// The next append (seq 52, over the 50 threshold) trims every
		// record at or below notedThrough.
		const result = await call(server.app, {
			method: "POST",
			url: `${base}/actions`,
			token: server.aliceToken,
			payload: {
				action: "reorderCards",
				payload: {
					itemId: "c4",
					from: { group: "", index: 3 },
					to: { group: "", index: 0 },
				},
				actionId: "act-trim",
			},
		});
		expect(result.status).toBe(200);

		const state = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		const seqs = state?.changes.map((record) => record.seq);
		// Seq 51 (above notedThrough 50) and the new 52 survive; the 50
		// noted ones are gone.
		expect(seqs).toEqual([51, 52]);
	});

	test("a move on an unknown entryId is 404; an unknown action name is 400", async () => {
		const server = await bootServer();
		const { conversationId, entryId } = await conversationWithBlock(
			server,
			RANKING_TREE,
			RANKING_DATA,
			"Ranking",
		);
		const base = `/v1/conversations/${conversationId}/blocks/${entryId}`;
		const unknown = await call(server.app, {
			method: "GET",
			url: `/v1/conversations/${conversationId}/blocks/999999`,
			token: server.aliceToken,
		});
		expect(unknown.status).toBe(404);
		const badAction = await call(server.app, {
			method: "POST",
			url: `${base}/actions`,
			token: server.aliceToken,
			payload: {
				action: "nope",
				payload: {},
				actionId: "act-unknown",
			},
		});
		expect(badAction.status).toBe(400);
	});

	test("nextSeq stays monotonic when a trim empties the array (review minor 3)", async () => {
		const server = await bootServer();
		const { conversationId, entryId } = await conversationWithBlock(
			server,
			RANKING_TREE,
			RANKING_DATA,
			"Ranking",
		);
		// Seed: notedThrough past EVERY recorded seq, then the trim
		// shape — an empty changes array with notedThrough > 0. Without
		// the notedThrough anchor the next append would restart at seq 1,
		// below notedThrough, breaking per-surface monotonicity.
		const conversation = await server.opened.harness.conversation(
			conversationId as never,
			BACKGROUND_CONTEXT,
		);
		await conversation!.commit(async (tx) => {
			const draft = await tx.doc(
				BlocksStateDoc,
				conversationId as never,
				entryId,
				entryId,
			);
			draft.changes = [];
			draft.notedThrough = 7;
		}, BACKGROUND_CONTEXT);
		const base = `/v1/conversations/${conversationId}/blocks/${entryId}`;
		const result = await call(server.app, {
			method: "POST",
			url: `${base}/actions`,
			token: server.aliceToken,
			payload: {
				action: "reorderCards",
				payload: {
					itemId: "c4",
					from: { group: "", index: 3 },
					to: { group: "", index: 0 },
				},
				actionId: "act-seq",
			},
		});
		expect(result.status).toBe(200);
		const state = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(state?.changes).toHaveLength(1);
		expect(state?.changes[0]?.seq).toBe(8);
	});

	test("an interleaved move between planning and apply: the op addresses the CURRENT data (review important 1)", async () => {
		const server = await bootServer();
		const { conversationId, entryId } = await conversationWithBlock(
			server,
			RANKING_TREE,
			RANKING_DATA,
			"Ranking",
		);
		const base = `/v1/conversations/${conversationId}/blocks/${entryId}`;
		// First action lands: c4 to the front.
		const first = await call(server.app, {
			method: "POST",
			url: `${base}/actions`,
			token: server.aliceToken,
			payload: {
				action: "reorderCards",
				payload: {
					itemId: "c4",
					from: { group: "", index: 3 },
					to: { group: "", index: 0 },
				},
				actionId: "act-ilv-a",
			},
		});
		expect(first.body.rev).toBe(1);
		// The second action's PAYLOAD is stale — `from.index: 0` is where
		// c1 sat before the first move (it is now 2nd). The plan is
		// derived inside the commit against the CURRENT data, so the ops
		// address c1's actual index (1) and the summary names the
		// positions at apply time.
		const second = await call(server.app, {
			method: "POST",
			url: `${base}/actions`,
			token: server.aliceToken,
			payload: {
				action: "reorderCards",
				payload: {
					itemId: "c1",
					from: { group: "", index: 0 },
					to: { group: "", index: 3 },
				},
				actionId: "act-ilv-b",
			},
		});
		expect(second.status).toBe(200);
		expect(second.body.ops).toEqual([
			{ op: "move", from: "/cards/1", path: "/cards/3" },
		]);
		const state = await readBlocksState(
			server.opened.harness,
			conversationId,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(state?.data.cards).toEqual([
			{ id: "c4", title: "Clair de Lune" },
			{ id: "c2", title: "Gymnopédie" },
			{ id: "c3", title: "Reflets" },
			{ id: "c1", title: "Arabesque" },
		]);
		const record = state?.changes[1] as ChangeRecord | undefined;
		// The summary names the pre-edit position c1 ACTUALLY held (2nd),
		// falling back from the payload's stale index.
		expect(record?.summary).toBe("moved 'Arabesque' from 2nd to 4th in 'Ranking'");
});

		test("a move committed INSIDE this action's commit window: ops and summary address the post-compete data (fix round 2)", async () => {
				// The serialized-POST test above still lets pre-in-commit-planning
				// code pass: the first move is committed before the second handler
				// starts, so even a plan computed at handler-entry sees the new
				// data. THIS test lands the competing move INSIDE the window — a
				// harness proxy whose conversation().commit performs the competing
				// commit before delegating — so only a plan derived from the
				// COMMIT-TIME draft can address the right row.
				const server = await bootServer();
				const { conversationId, entryId } = await conversationWithBlock(
						server,
						RANKING_TREE,
						RANKING_DATA,
						"Ranking",
				);
				const realHarness = server.opened.harness;
				const realConversation = await realHarness.conversation(
						conversationId as ConversationId,
						BACKGROUND_CONTEXT,
				);
				expect(realConversation).toBeDefined();
				// A commit wrapper whose FIRST invocation (applyChatAction's own
				// edit commit) lands a competing move — c4 to the front — before
				// the real commit runs. Competing commits afterwards would be
				// queued, not interleaved, so exactly one wrap.
		let competed = false;
		// A call-forwarding proxy: the concrete Conversation's methods
		// touch private fields, so a prototype-spread is out — every
		// member forwards to the real instance bound as receiver, with
		// `commit` wrapped. The competing commit runs BEFORE this
		// action's own commit, inside the first commit call.
		const real = realConversation!;
		const competingConversation: Conversation = {
			get id(): ConversationId {
				return real.id;
			},
			agent: (context) => real.agent(context),
			configure: (change, context) => real.configure(change, context),
			submit: (submission, context) => real.submit(submission, context),
			reset: (handoff, context) => real.reset(handoff, context),
			compact: (instructions, context) => real.compact(instructions, context),
			commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> {
				if (!competed) {
					competed = true;
					return real
						.commit(async (tx) => {
							const draft = await tx.doc(
								BlocksStateDoc,
								conversationId as ConversationId,
								entryId,
								entryId,
							);
							draft.data = {
								cards: [
									{ id: "c4", title: "Clair de Lune" },
									{ id: "c1", title: "Arabesque" },
									{ id: "c2", title: "Gymnopédie" },
									{ id: "c3", title: "Reflets" },
								],
							};
							draft.rev += 1;
						}, context)
						.then(() => real.commit(change, context));
				}
				return real.commit(change, context);
			},
			context: (context, options) => real.context(context, options),
			entries: (query, limit, cursor, context) =>
				real.entries(query, limit, cursor, context),
			fork: (at, options, context) => real.fork(at, options, context),
			abort: (context, options) => real.abort(context, options),
			waitForIdle: (context) => real.waitForIdle(context),
			viewState: (context) => real.viewState(context),
			watch: (context) => real.watch(context),
		};
		// A Proxy (not a prototype spread): every member forwards BOUND
		// to the real instance, so pi-durable's private fields stay
		// reachable; only `conversation` is wrapped.
		const proxyHarness: Harness = new Proxy(realHarness, {
			get(target, property) {
				if (property === "conversation") {
					return (
						id: ConversationId,
						context: Context,
					): Promise<Conversation | undefined> =>
						target.conversation(id, context).then((handle) =>
							handle === undefined ||
							id !== (conversationId as ConversationId)
								? handle
								: competingConversation,
						);
				}
				const value: unknown = Reflect.get(target, property);
				return typeof value === "function" && property !== "constructor"
					? (value as (...args: never[]) => unknown).bind(target)
					: value;
			},
		});
				// Stale payload (from.index 0): c1 sat 1st when the user dragged
				// it; the competing move already put c4 ahead of it.
				const outcome = await applyChatAction(
						proxyHarness,
						conversationId,
						entryId,
						"alice",
						"reorderCards",
						{
								itemId: "c1",
								from: { group: "", index: 0 },
								to: { group: "", index: 3 },
						},
				);
				expect(outcome).toMatchObject({
						ok: true,
						rev: 2,
						ops: [{ op: "move", from: "/cards/1", path: "/cards/3" }],
				});
				const state = await readBlocksState(
						server.opened.harness,
						conversationId,
						entryId,
						BACKGROUND_CONTEXT,
				);
				expect(state?.rev).toBe(2);
				const record = state?.changes[state.changes.length - 1] as
						| ChangeRecord
						| undefined;
				expect(record?.summary).toBe(
						"moved 'Arabesque' from 2nd to 4th in 'Ranking'",
				);
		});
});
