/**
 * U5 Task 1 — the chat-blocks entry kinds, the state family, and the two
 * core tools (spec §8.1/§8.2).
 *
 * Hermetic boots (the tools.test pattern): `openHarness` over a tmp sqlite
 * file with the faux provider scripting REAL tool rounds through the run
 * loop — `show_blocks`/`update_blocks` execute exactly as the model
 * drives them, and every assertion reads durable state (entries, the
 * state family) rather than internals.
 *
 * Later rounds discover the block's entry id through a faux response
 * FACTORY (the compaction suite's request-capture pattern): the factory
 * reads the transcript the model would see — the `show_blocks` tool
 * result's `entryId:` line — so `update_blocks` calls reference the real
 * id exactly as the model would.
 *
 * Coverage follows the plan's testable lines:
 *
 * - a valid `show_blocks` appends one `sigrun.blocks` entry, seeds state
 *   `{rev: 0, data, changes: [], notedThrough: 0}`, and its tool result is
 *   the `toText` projection plus the entryId;
 * - invalid trees (a `secret` field — chat forbids it; a 202-block tree —
 *   over the chat limit; `chart` with `x.kind: "nope"`) return tool errors
 *   naming each JSON path, and append NOTHING (no entry, no state doc);
 * - `update_blocks` applies ops, increments `rev`, records NO change
 *   record (the agent made the change), publishes `surface.changed`
 *   `{conversationId, entryId, rev}` through the publish seam, and its
 *   result is the NEW projection;
 * - Review Focus 2: after a simulated user move, an op targeting the
 *   pre-move index applies to CURRENT data (the projection shows the
 *   resulting order); an op on a missing path returns a tool error naming
 *   the op index;
 * - `update_blocks` on another conversation's entry id → tool error
 *   "no such block in this conversation".
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { toText } from "@sigrun/shared/blocks";
import type { DataOp, JsonObject, Tree } from "@sigrun/shared/blocks";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { BlocksEntry, type BlocksPayload } from "../src/harness/blocks/entries.js";
import { BlocksStateDoc, readBlocksState } from "../src/harness/blocks/state.js";
import {
	PROJECTION_LOCALE,
	PROJECTION_WIDTH,
	subscribeChatSurfaceChanged,
} from "../src/harness/blocks/tools.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A chat-legal ranking list (the spec §8.5 shape): a reorderable,
 * checkable collection bound to `/cards`.
 */
const RANKING_TREE: Tree = {
	v: 1,
	root: {
		type: "collection",
		id: "ranking",
		items: { $: "/cards" },
		display: "list",
		numbered: true,
		reorder: { within: true },
		onMove: "reorderCards",
		item: { title: { $: "./title" } },
	},
};

const RANKING_DATA: JsonObject = {
	cards: [
		{ id: "c1", title: "Clair de Lune" },
		{ id: "c2", title: "Gymnopédie" },
		{ id: "c3", title: "Arabesque" },
	],
};

/** The projection of one ranking state, at the tool's own constants. */
function rankingProjection(data: JsonObject): string {
	return toText(RANKING_TREE, data, {
		width: PROJECTION_WIDTH,
		locale: PROJECTION_LOCALE,
	});
}

/** A chat tree with a `secret` field — chat forbids every `secret` field (§5.7). */
const SECRET_TREE: Tree = {
	v: 1,
	root: {
		type: "stack",
		children: [
			{
				type: "form",
				id: "secret-form",
				bind: "/form",
				mode: "submit",
				children: [{ type: "secret", name: "token", label: "Token" }],
			},
		],
	},
};

/** A chat tree over the block limit (202 blocks > the chat limit of 200). */
function oversizedTree(): Tree {
	const children: { type: "markdown"; text: string }[] = [];
	for (let index = 0; index < 201; index++) {
		children.push({ type: "markdown", text: `item ${index}` });
	}
	return {
		v: 1,
		root: {
			type: "stack",
			children: children as unknown as Extract<
				Tree["root"],
				{ type: "stack" }
			>["children"],
		},
	};
}

/** A `chart` whose `x.kind` is not one of the axis kinds. */
const BAD_AXIS_TREE: Tree = {
	v: 1,
	root: {
		type: "chart",
		id: "bad-axis",
		x: { kind: "nope" as unknown as "time" },
		series: [{ name: "acme", kind: "line", data: { $: "/series/acme" } }],
	},
};

// ---------------------------------------------------------------------------
// The hermetic boot
// ---------------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** One hermetic boot: harness + faux provider + a fresh tmp dir. */
async function bootBlocks(
	responses: readonly unknown[],
): Promise<{ opened: OpenedHarness; faux: ReturnType<typeof fauxProvider> }> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-blocks-chat-"));
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses(responses as never);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	// Auto-naming off (the tools.test pattern): the namer completes through
	// the same faux provider and would consume scripted responses.
	await writeFile(join(dir, "settings.json"), '{"namingModel": false}');
	const opened = await openHarness(config, {
		extensions: [contributor],
		// Hermetic: no built-ins (their unscripted extra prompt sections stay
		// out of exact-response boots).
		builtins: false,
		env: {},
		settingsDir: dir,
	});
	cleanups.push(async () => {
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	});
	return { opened, faux };
}

/** One assistant message carrying tool calls (a tool round). */
function toolRound(
	...calls: { name: string; args: JsonObject }[]
): AssistantMessage {
	return fauxAssistantMessage(
		calls.map((call) => fauxToolCall(call.name, call.args)),
		{ stopReason: "toolUse" },
	);
}

/** The `entryId:` line of a `show_blocks` result in one transcript. */
function entryIdOf(messages: readonly Message[]): string {
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== "show_blocks") {
			continue;
		}
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("");
		const match = /entryId: (\d+)/.exec(text);
		if (match !== null) return match[1] as string;
	}
	throw new Error("no show_blocks entryId in transcript");
}

/** A response factory: `update_blocks` on the block the transcript shows. */
function updateBlock(
	ops: readonly DataOp[],
): (context: { messages: readonly Message[] }) => AssistantMessage {
	return (context) =>
		toolRound({
			name: "update_blocks",
			args: {
				entryId: entryIdOf(context.messages),
				ops: [...ops],
			},
		});
}

/**
 * Run one conversation turn through the harness and wait for settlement.
 * Returns the conversation handle and its entries (newest first).
 */
async function runTurn(opened: OpenedHarness, content: string) {
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: opened.defaultModel },
	});
	const submission = await root.submit(
		{ type: "input", content },
		BACKGROUND_CONTEXT,
	);
	const settled = await submission.wait(BACKGROUND_CONTEXT);
	expect(settled.status).toBe("done");
	const page = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	return { root, entries: page.items };
}

/** The tool-result messages for one tool, in transcript order. */
function toolResultsOf(
	entries: readonly { kind: string; model?: readonly Message[] }[],
	tool: string,
): { text: string; isError: boolean }[] {
	const results: { text: string; isError: boolean }[] = [];
	// Entries scan newest-first; iterate oldest-first so results are in
	// call order.
	for (const entry of [...entries].reverse()) {
		if (entry.kind !== "pi.tool-result") continue;
		for (const message of entry.model ?? []) {
			if (message.role !== "toolResult" || message.toolName !== tool) continue;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("");
			results.push({ text, isError: message.isError });
		}
	}
	return results;
}

/**
 * One conversation's `sigrun.blocks` entries, oldest first, with their
 * typed payloads (`{title, tree, data}` as created, spec §8.2) read from
 * the entry records the conversation scan returns.
 */
async function blocksRecordsOf(
	entries: readonly {
		id: number;
		kind: string;
		data?: unknown;
		model?: readonly Message[];
	}[],
): Promise<
	{ id: number; title: string; tree: Tree; data: JsonObject }[]
> {
	const records: { id: number; title: string; tree: Tree; data: JsonObject }[] =
		[];
	for (const entry of [...entries].reverse()) {
		if (entry.kind !== BlocksEntry.kind) continue;
		const payload = entry.data as BlocksPayload;
		records.push({ id: entry.id, ...payload });
	}
	return records;
}

// ---------------------------------------------------------------------------
// show_blocks
// ---------------------------------------------------------------------------

test("a valid show_blocks appends one sigrun.blocks entry, seeds state, and its result is the projection plus the entryId", async () => {
	const { opened } = await bootBlocks([
		toolRound({
			name: "show_blocks",
			args: {
				title: "Ranking",
				tree: RANKING_TREE as unknown as JsonObject,
				data: RANKING_DATA,
			},
		}),
		fauxAssistantMessage("done"),
	]);
	const { root, entries } = await runTurn(opened, "show the ranking");

	const blocks = await blocksRecordsOf(entries);
	expect(blocks).toHaveLength(1);
	// The entry's payload: {title, tree, data} as created (spec §8.2).
	expect(blocks[0]).toEqual({
		id: blocks[0]!.id,
		title: "Ranking",
		tree: RANKING_TREE,
		data: RANKING_DATA,
	});
	const entryId = String(blocks[0]!.id);

	// The seeded state: rev 0, the block's data, no changes, nothing noted.
	const state = await readBlocksState(
		opened.harness,
		root.id,
		entryId,
		BACKGROUND_CONTEXT,
	);
	expect(state).toEqual({
		rev: 0,
		data: RANKING_DATA,
		changes: [],
		notedThrough: 0,
	});

	// The tool result: the projection plus the entryId line.
	const [result] = toolResultsOf(entries, "show_blocks");
	expect(result?.isError).toBe(false);
	expect(result?.text).toBe(
		`${rankingProjection(RANKING_DATA)}\nentryId: ${entryId}`,
	);
});

test("invalid trees return tool errors naming each JSON path, and append nothing", async () => {
	const { opened } = await bootBlocks([
		toolRound(
			{
				name: "show_blocks",
				args: {
					title: "Secret form",
					tree: SECRET_TREE as unknown as JsonObject,
					data: {},
				},
			},
			{
				name: "show_blocks",
				args: {
					title: "Too big",
					tree: oversizedTree() as unknown as JsonObject,
					data: {},
				},
			},
			{
				name: "show_blocks",
				args: {
					title: "Bad axis",
					tree: BAD_AXIS_TREE as unknown as JsonObject,
					data: {},
				},
			},
		),
		fauxAssistantMessage("giving up"),
	]);
	const { root, entries } = await runTurn(opened, "show three bad blocks");

	// Nothing appended: no sigrun.blocks entries at all, and no state doc
	// for any id the failed calls could have produced — a state family
	// member exists only after a successful show_blocks.
	expect(await blocksRecordsOf(entries)).toHaveLength(0);
	for (const id of [1, 2, 3]) {
		expect(
			await readBlocksState(
				opened.harness,
				root.id,
				String(id),
				BACKGROUND_CONTEXT,
			),
		).toBeUndefined();
	}

	const results = toolResultsOf(entries, "show_blocks");
	expect(results).toHaveLength(3);
	for (const result of results) expect(result.isError).toBe(true);

	// The secret field: the path names the field inside the form.
	expect(results[0]?.text).toContain("root.children[0].children[0]");
	expect(results[0]?.text).toContain("secret field is not allowed in chat");
	// The oversized tree: over the chat limit of 200.
	expect(results[1]?.text).toContain("exceeds the chat limit of 200 blocks");
	expect(results[1]?.text).toContain("root");
	// The bad chart axis: the path names the axis kind prop.
	expect(results[2]?.text).toContain("root.x.kind");
});

// ---------------------------------------------------------------------------
// update_blocks
// ---------------------------------------------------------------------------

test("update_blocks applies ops, increments rev, records no change record, publishes surface.changed, and returns the new projection", async () => {
	const published: unknown[] = [];
	const unsubscribe = subscribeChatSurfaceChanged((event) => {
		published.push(event);
	});
	try {
		const { opened } = await bootBlocks([
			toolRound({
				name: "show_blocks",
				args: {
					title: "Ranking",
					tree: RANKING_TREE as unknown as JsonObject,
					data: RANKING_DATA,
				},
			}),
			updateBlock([{ op: "set", path: "/cards/2/title", value: "Reflets" }]),
			fauxAssistantMessage("done"),
		]);
		const { root, entries } = await runTurn(opened, "show and update");
		const blocks = await blocksRecordsOf(entries);
		expect(blocks).toHaveLength(1);
		const entryId = String(blocks[0]!.id);

		const updates = toolResultsOf(entries, "update_blocks");
		expect(updates).toHaveLength(1);
		expect(updates[0]?.isError).toBe(false);

		// The new data applied: card 3's title changed.
		const renamed: JsonObject = {
			cards: [
				{ id: "c1", title: "Clair de Lune" },
				{ id: "c2", title: "Gymnopédie" },
				{ id: "c3", title: "Reflets" },
			],
		};
		const state = await readBlocksState(
			opened.harness,
			root.id,
			entryId,
			BACKGROUND_CONTEXT,
		);
		expect(state?.rev).toBe(1);
		expect(state?.data).toEqual(renamed);
		// No change record: the AGENT made this change (spec §8.1).
		expect(state?.changes).toEqual([]);
		expect(state?.notedThrough).toBe(0);

		// The result is the NEW projection (the post-op state).
		expect(updates[0]?.text).toBe(rankingProjection(renamed));

		// surface.changed published exactly once, carrying the conversation,
		// the entry, and the new rev.
		expect(published).toEqual([
			{
				type: "surface.changed",
				conversationId: Number(root.id),
				entryId,
				rev: 1,
			},
		]);
	} finally {
		unsubscribe();
	}
});

test("after a simulated user move, an op on the old index applies to current data and the projection shows the resulting order", async () => {
	const { opened, faux } = await bootBlocks([
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
	const first = await runTurn(opened, "show the ranking");
	const blocks = await blocksRecordsOf(first.entries);
	expect(blocks).toHaveLength(1);
	const entryId = String(blocks[0]!.id);

	// The simulated user move (Review Focus 2's setup): Gymnopédie dragged
	// to the top — the write class Task 2's chat route owns, done here
	// directly against the state family, bumping rev and appending the
	// user's change record.
	const conversation = await opened.harness.conversation(
		first.root.id,
		BACKGROUND_CONTEXT,
	);
	expect(conversation).toBeDefined();
	const userMoved: JsonObject = {
		cards: [
			{ id: "c2", title: "Gymnopédie" },
			{ id: "c1", title: "Clair de Lune" },
			{ id: "c3", title: "Arabesque" },
		],
	};
	await conversation!.commit(async (tx) => {
		const draft = await tx.doc(
			BlocksStateDoc,
			first.root.id,
			entryId,
			entryId,
		);
		draft.data = userMoved;
		draft.rev += 1;
		draft.changes = [
			{
				seq: 1,
				at: 1,
				by: "alice",
				action: "reorder",
				summary: "moved 'Gymnopédie' from 2nd to 1st in 'Ranking'",
			},
		];
	}, BACKGROUND_CONTEXT);

	// Now the agent's turn: an op written against the OLD order (rename the
	// card at index 2 — Arabesque when the model last saw the data) applied
	// to CURRENT data, and the tool result shows the ACTUAL resulting
	// order (Gymnopédie first), so a misplaced op is visibly wrong.
	// The second turn's round references the entry id the transcript
	// already shows.
	faux.appendResponses([
		updateBlock([{ op: "set", path: "/cards/2/title", value: "Reflets" }]),
		fauxAssistantMessage("renamed"),
	]);
	const second = await runTurn(opened, "rename the card you saw at 3rd");
	const updates = toolResultsOf(second.entries, "update_blocks");
	expect(updates).toHaveLength(1);
	expect(updates[0]?.isError).toBe(false);

	const state = await readBlocksState(
		opened.harness,
		first.root.id,
		entryId,
		BACKGROUND_CONTEXT,
	);
	expect(state?.rev).toBe(2);
	expect(state?.data).toEqual({
		cards: [
			{ id: "c2", title: "Gymnopédie" },
			{ id: "c1", title: "Clair de Lune" },
			{ id: "c3", title: "Reflets" },
		],
	});
	// The agent's op records no change record — the user's survives alone.
	expect(state?.changes).toHaveLength(1);

	// The projection the model received: the CURRENT order after its op.
	expect(updates[0]?.text).toBe(
		rankingProjection({
			cards: [
				{ id: "c2", title: "Gymnopédie" },
				{ id: "c1", title: "Clair de Lune" },
				{ id: "c3", title: "Reflets" },
			],
		}),
	);
});

test("an op on a missing path returns a tool error naming the op index, and nothing is applied", async () => {
	const { opened } = await bootBlocks([
		toolRound({
			name: "show_blocks",
			args: {
				title: "Ranking",
				tree: RANKING_TREE as unknown as JsonObject,
				data: RANKING_DATA,
			},
		}),
		updateBlock([
			{ op: "set", path: "/cards/1/title", value: "ok" },
			{ op: "set", path: "/cards/9/title", value: "missing" },
		]),
		fauxAssistantMessage("done"),
	]);
	const { root, entries } = await runTurn(opened, "update two");
	const blocks = await blocksRecordsOf(entries);
	const entryId = String(blocks[0]!.id);

	const updates = toolResultsOf(entries, "update_blocks");
	expect(updates).toHaveLength(1);
	expect(updates[0]?.isError).toBe(true);
	// The error names the failing op's index (the second op, index 1).
	expect(updates[0]?.text).toMatch(/op 1|ops\[1\]|index 1/);

	// And nothing was applied: the state is unchanged (rev 0, original
	// data) — a failed op batch leaves no partial write.
	const state = await readBlocksState(
		opened.harness,
		root.id,
		entryId,
		BACKGROUND_CONTEXT,
	);
	expect(state?.rev).toBe(0);
	expect(state?.data).toEqual(RANKING_DATA);
});

test("update_blocks on another conversation's entry id → no such block in this conversation", async () => {
	const published: unknown[] = [];
	const unsubscribe = subscribeChatSurfaceChanged((event) => {
		published.push(event);
	});
	try {
		// Conversation A (the root): creates the block.
		const { opened, faux } = await bootBlocks([
			toolRound({
				name: "show_blocks",
				args: {
					title: "A",
					tree: RANKING_TREE as unknown as JsonObject,
					data: RANKING_DATA,
				},
			}),
			fauxAssistantMessage("done in A"),
		]);
		const first = await runTurn(opened, "show the ranking");
		const foreignId = String(
			(await blocksRecordsOf(first.entries))[0]!.id,
		);

		// Conversation B: a second conversation in the SAME harness, driven
		// through the same faux queue — it references A's entry id.
		const second = await opened.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: opened.defaultModel },
			},
			BACKGROUND_CONTEXT,
		);
		expect(Number(second.id)).not.toBe(Number(first.root.id));
		// Conversation B's round: a literal call referencing A's entry id.
		faux.appendResponses([
			toolRound({
				name: "update_blocks",
				args: {
					entryId: foreignId,
					ops: [{ op: "set", path: "/cards/2/title", value: "Reflets" }],
				},
			}),
			fauxAssistantMessage("done in B"),
		]);
		const submission = await second.submit(
			{
				type: "input",
				content: `update block ${foreignId} — set /cards/2/title to "Reflets"`,
			},
			BACKGROUND_CONTEXT,
		);
		expect((await submission.wait(BACKGROUND_CONTEXT)).status).toBe("done");

		// The tool call errored: the entry belongs to conversation A.
		const page = await second.entries({}, 100, undefined, BACKGROUND_CONTEXT);
		const updates = toolResultsOf(page.items, "update_blocks");
		expect(updates).toHaveLength(1);
		expect(updates[0]?.isError).toBe(true);
		expect(updates[0]?.text).toContain(
			"no such block in this conversation",
		);

		// And nothing was published or applied: A's state is untouched.
		expect(published).toEqual([]);
		const state = await readBlocksState(
			opened.harness,
			first.root.id,
			foreignId,
			BACKGROUND_CONTEXT,
		);
		expect(state?.rev).toBe(0);
	} finally {
		unsubscribe();
	}
});
