/**
 * The chat-blocks core tools (UI-blocks U5 Task 1, spec §8.1): the
 * `sigrun.blocks` pi-durable extension installed by `openHarness` beside
 * the coding/search tools, so EVERY agent has them.
 *
 * - `show_blocks {title, tree, data}` validates the tree against the
 *   `chat` placement (§5.7: no `page` root, no `secret` fields; §4.5
 *   limits 200 blocks / 256 KiB tree / 256 KiB data; handler names are
 *   free labels in chat — no `handlers` set). Validation errors go back
 *   to the model as the tool error, each naming its JSON path (§14.2).
 *   On success it appends ONE immutable `sigrun.blocks` entry and seeds
 *   the state family `{rev: 0, data, changes: [], notedThrough: 0}` in
 *   the SAME commit; the tool result is the §14.3 text projection of the
 *   tree and its initial data plus the `entryId`.
 * - `update_blocks {entryId, ops}` applies `DataOp`s to the surface's
 *   CURRENT data (spec §8.1's stale-index honesty: an op written against
 *   old indexes applies to current data — the returned projection shows
 *   the ACTUAL resulting order). It records NO change record (the agent
 *   made the change), increments `rev`, publishes
 *   `surface.changed {conversationId, entryId, rev}` through the publish
 *   seam, and its result is the NEW projection. A `DataOpError` (a
 *   missing path, a non-array where one is required) returns a tool
 *   error naming the op index; a failed batch leaves no partial write
 *   (the throw unwinds the commit before anything persisted). An entry id
 *   from another conversation (or one this conversation cannot see) is
 *   "no such block in this conversation".
 *
 * The publish seam (`subscribeChatSurfaceChanged`): the chat
 * `surface.changed` wire shape joins `HostEventWire` in Task 2 (shared/
 * views.ts), and the server binds the hub publish then. Until that
 * bind, the seam carries the events to in-process listeners only — the
 * default subscriber set is empty, so nothing is lost by not wiring it.
 */

import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type EntryId,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { DataOp, JsonObject, Tree } from "@sigrun/shared/blocks";
import { applyOps, DataOpError, toText } from "@sigrun/shared/blocks";
import { validateData, validateTree } from "../../blocks/validate.js";
import { BlocksEntry } from "./entries.js";
import { BlocksStateDoc } from "./state.js";

/** The §14.3 projection width for what the model sees of its own blocks (spec §8.1). */
export const PROJECTION_WIDTH = 100;

/**
 * The server locale for model-facing projections (spec §14.3: "the model
 * projection always uses the server's locale"). No locale setting exists
 * in config today; `en-CA` is the repo's projection convention (the
 * jobs run-namer and the block-text snapshots both use it).
 */
export const PROJECTION_LOCALE = "en-CA";

/**
 * The tool-description sentence (spec §8.1, verbatim): it teaches the
 * action kinds — silent saves, immediate submits, `turn: true` only when
 * a reply is needed.
 */
const ACTION_SENTENCE =
	"Interactive elements save the user's edits silently; you'll receive a summary of edits at your next turn. A `submit` sends you the result immediately; set `turn: true` on a `move` or `edit` only if each one needs an immediate reply.";

/** The `surface.changed` chat shape (spec §8.2): the wire union gains it in Task 2. */
export interface ChatSurfaceChanged {
	readonly type: "surface.changed";
	readonly conversationId: number;
	readonly entryId: string;
	readonly rev: number;
}

type ChatSurfaceChangedListener = (event: ChatSurfaceChanged) => void;

/** The publish seam's listener set (see `chatSurfaceChanged`). */
const chatSurfaceChangedListeners = new Set<ChatSurfaceChangedListener>();

/**
 * Publish one chat-surface change through the seam (spec §8.2's
 * `surface.changed {conversation, entry, rev}`). The TOOL layer calls
 * this after its state commit; the server (Task 2) subscribes and fans
 * the event out to the watcher registry + hub. In-process subscribers
 * see every event; a listener that throws is logged, never propagated
 * into the tool.
 */
export function chatSurfaceChanged(event: ChatSurfaceChanged): void {
	for (const listener of chatSurfaceChangedListeners) {
		try {
			listener(event);
		} catch (error) {
			console.error("blocks: surface.changed listener failed:", error);
		}
	}
}

/**
 * Subscribe to chat-surface changes (the test seam and Task 2's server
 * binding point). Returns the unsubscribe.
 */
export function subscribeChatSurfaceChanged(
	listener: ChatSurfaceChangedListener,
): () => void {
	chatSurfaceChangedListeners.add(listener);
	return () => {
		chatSurfaceChangedListeners.delete(listener);
	};
}

/** A tool error: text content the model can read and recover from. */
function toolError(message: string): ToolExecutionResult {
	return { output: [{ type: "text", text: message }], isError: true };
}

/** A plain-object check (the `data` arg arrives as `unknown`). */
function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The show_blocks tool (spec §8.1). */
export const showBlocksTool = defineTool({
	name: "show_blocks",
	description:
		"Show the user an interactive UI (tables, charts, forms, lists) in the conversation. " +
		"The result is the plain-text projection of the surface plus its entryId; keep that entryId to update the surface later. " +
		ACTION_SENTENCE,
	parameters: Type.Object({
		title: Type.String({
			description: "The surface's title, shown in the channel's header.",
		}),
		tree: Type.Unknown({
			description:
				"The block tree {v: 1, root: Block} — the chat subset (no page root, no secret fields; at most 200 blocks).",
		}),
		data: Type.Unknown({
			description:
				"The initial data object the tree's bindings point into (a JSON object).",
		}),
	}),
	async execute(args, api, context) {
		// Validate first (§8.1): an invalid tree appends NOTHING. Handler
		// names are free labels in chat — no `handlers` set.
		const validation = validateTree(args.tree, { placement: "chat" });
		if (!validation.ok) {
			const lines = validation.errors.map(
				(error) => `${error.path}: ${error.message}`,
			);
			return toolError(`show_blocks: the tree is invalid:\n${lines.join("\n")}`);
		}
		if (!isJsonObject(args.data)) {
			return toolError("show_blocks: data must be a JSON object");
		}
		const data = args.data;
		// The data limit (§4.5, chat row) — validateTree covers the tree;
		// the data object gets its own check.
		const dataCheck = validateData(data, "chat");
		if (!dataCheck.ok) {
			return toolError(
				`show_blocks: ${dataCheck.errors
					.map((error) => `${error.path}: ${error.message}`)
					.join("\n")}`,
			);
		}
		const tree = validation.tree;
		// One commit: append the immutable entry and seed the state family
		// (spec §8.2) — a crash between the two cannot strand a block
		// without state.
		const entryId = await api.commit(async (tx) => {
			const entry = await tx.appendEntry(BlocksEntry, api.conversationId, {
				data: {
					title: args.title,
					tree: tree as Tree & JsonObject,
					data,
				},
			});
			const state = await tx.doc(
				BlocksStateDoc,
				api.conversationId,
				String(entry.id),
				String(entry.id),
			);
			state.rev = 0;
			state.data = data;
			state.changes = [];
			state.notedThrough = 0;
			return entry.id;
		}, context);
		return {
			output: [
				{
					type: "text",
					text: `${toText(tree, data, {
						width: PROJECTION_WIDTH,
						locale: PROJECTION_LOCALE,
					})}\nentryId: ${String(entryId)}`,
				},
			],
		};
	},
});

/** The post-update facts the projection and the announcement read. */
interface UpdatedBlock {
	readonly tree: Tree;
	readonly data: JsonObject;
	readonly rev: number;
}

/** The update_blocks tool (spec §8.1). */
export const updateBlocksTool = defineTool({
	name: "update_blocks",
	description:
		"Apply data ops (set/remove/insert/move) to one of this conversation's block surfaces (by its entryId) and see the surface's CURRENT text projection. " +
		"Ops apply to current data — if the user has reordered things since you last looked, index-based ops land on the new indexes. " +
		ACTION_SENTENCE,
	parameters: Type.Object({
		entryId: Type.String({
			description: "The entryId show_blocks returned.",
		}),
		ops: Type.Array(Type.Unknown(), {
			description: "The DataOps to apply, in order.",
		}),
	}),
	async execute(args, api, context) {
		const parsed = parseEntryId(args.entryId);
		if (parsed === undefined) {
			return toolError(
				`update_blocks: entryId ${JSON.stringify(args.entryId)} is not one this conversation has`,
			);
		}
		// Structural op validation (the schema is Unknown per element): each
		// element must carry a known op tag; anything else is a recoverable
		// model error naming the element's index.
		const elements = args.ops as unknown[];
		// SAFETY: the schema admits unknown elements (typebox cannot express
		// the DataOp union without duplicating it); the loop below validates
		// each element's op tag, and applyOps re-validates every path — an
		// element that is not a DataOp shape is a tool error, never a
		// misapplied write.
		const ops = elements as readonly DataOp[];
		for (let index = 0; index < elements.length; index++) {
			const tag = (elements[index] as { op?: unknown } | null)?.op;
			if (
				tag !== "set" &&
				tag !== "remove" &&
				tag !== "insert" &&
				tag !== "move"
			) {
				return toolError(
					`update_blocks: op ${index} is not a DataOp (expected {op: "set"|"remove"|"insert"|"move", …})`,
				);
			}
		}
		// The write: one commit reads the CURRENT state, applies the ops,
		// bumps rev. The tree comes from the entry record — returned only
		// when visible through THIS conversation (fork-aware), which is the
		// same check that makes a foreign id "no such block".
		let updated: UpdatedBlock | undefined;
		try {
			updated = await api.commit(async (tx) => {
				const page = await tx.scanEntries(
					{
						conversationId: api.conversationId,
						minEntryId: parsed,
						maxEntryId: parsed,
					},
					1,
					undefined,
				);
				const record = page.items[0];
				if (record === undefined || !BlocksEntry.is(record)) {
					return undefined;
				}
				const state = await tx.doc(
					BlocksStateDoc,
					api.conversationId,
					String(parsed),
					String(parsed),
				);
				// applyOps throws DataOpError (naming the op index) on a bad
				// path; the throw unwinds the commit BEFORE anything persists
				// — a failed batch leaves no partial write.
				state.data = applyOps(state.data, ops);
				state.rev += 1;
				// Snapshot to plain JSON: chord wraps draft values in tracking
				// proxies that settle when the commit ends — returning the draft
				// value itself would throw "Cannot use a settled overlay" when
				// the projection reads it after commit.
				return {
					tree: record.data.tree as Tree,
					data: JSON.parse(JSON.stringify(state.data)) as JsonObject,
					rev: state.rev,
				};
			}, context);
		} catch (error) {
			if (error instanceof DataOpError) {
				return toolError(
					`update_blocks: op ${error.opIndex} failed: ${error.message}`,
				);
			}
			throw error;
		}
		if (updated === undefined) {
			return toolError(
				`update_blocks: no such block in this conversation (entryId ${JSON.stringify(args.entryId)})`,
			);
		}
		// The change announcement (§8.2): surface.changed to watchers of
		// this conversation's block.
		chatSurfaceChanged({
			type: "surface.changed",
			conversationId: api.conversationId,
			entryId: args.entryId,
			rev: updated.rev,
		});
		return {
			output: [
				{
					type: "text",
					text: toText(updated.tree, updated.data, {
						width: PROJECTION_WIDTH,
						locale: PROJECTION_LOCALE,
					}),
				},
			],
		};
	},
});

/** A numeric entry id (`EntryId` is a branded number; tool args are strings). */
function parseEntryId(value: string): EntryId | undefined {
	if (!/^\d+$/.test(value)) return undefined;
	const id = Number(value);
	return Number.isSafeInteger(id) && id > 0 ? (id as EntryId) : undefined;
}

/** The core `sigrun.blocks` extension: the two tools, installed for every conversation. */
export const blocksToolsExtension = defineExtension({
	name: "sigrun.blocks",
	tools: [showBlocksTool, updateBlocksTool],
});
