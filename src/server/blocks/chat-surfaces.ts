/**
 * The chat-surface handler (UI-blocks U5 Task 2, spec §8.2/§8.3): core
 * applies a chat block's edits itself — there is no extension handler.
 *
 * - `move` applies a `DataOp.move` to the collection's bound array
 *   (a cross-group move ALSO sets the item's `groupBy` field, spec
 *   §8.3), with the destination resolved exactly like the channel's
 *   optimistic overlay (useSurface.applyMoveOverlay), so the confirmed
 *   result matches what the user saw while the action was in flight;
 * - `edit` (a check) applies a `set` at the item's bound field;
 * - a `turn: false` `submit` writes the form's values at its `bind`.
 *
 * Each applied edit appends one `ChangeRecord` (spec §8.3) whose
 * `summary` comes from {@link summarizeAction} (labels the user saw),
 * bumps the family's `rev`, and announces the change through the
 * Task-1 seam (`chatSurfaceChanged` — the server binds it to the hub).
 * More than {@link MAX_CHANGES} records with `notedThrough` past them
 * are trimmed on the next append (Task 1's `trimChanges`).
 *
 * Ops apply inside ONE conversation commit (a failed batch unwinds
 * before anything persists), and the commit returns only the new `rev`
 * — never a draft value (the chord settle hazard Task 1 documented).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type {
	Action,
	DataOp,
	JsonObject,
	JsonValue,
	Tree,
} from "@sigrun/shared/blocks";
import { applyOps, DataOpError } from "@sigrun/shared/blocks";
import {
	BlocksEntry,
	type BlocksPayload,
} from "../../harness/blocks/entries.js";
import {
	BlocksStateDoc,
	readBlocksState,
	trimChanges,
	type BlocksState,
} from "../../harness/blocks/state.js";
import { chatSurfaceChanged, parseEntryId } from "../../harness/blocks/tools.js";
import { summarizeAction } from "./summaries.js";

/** One located chat block: its immutable payload plus its live state. */
export interface ChatBlock {
	readonly title: string;
	readonly tree: Tree;
	readonly state: BlocksState;
}

/** The handler-labelled node one action name resolves to. */
interface HandlerNode {
	readonly kind: "move" | "check" | "submit";
	readonly node: JsonObject;
}

/** A plain-record check (the tree walk's node shape). */
function isRec(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Locate one chat block: its `sigrun.blocks` entry (visible through
 * THIS conversation — `Conversation.entries` is fork-aware, so a fork
 * sees only blocks whose entries are in its history) plus the state
 * family's current member. `undefined` when the entry id names no
 * block in this conversation.
 */
export async function readChatBlock(
	harness: Harness,
	conversationId: number,
	entryId: string,
): Promise<ChatBlock | undefined> {
	if (!/^\d+$/.test(entryId)) return undefined;
	const conversation = await harness.conversation(
		conversationId as ConversationId,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) return undefined;
	const parsed = parseEntryId(entryId);
	if (parsed === undefined) return undefined;
	const page = await conversation.entries(
		{ minEntryId: parsed, maxEntryId: parsed },
		1,
		undefined,
		BACKGROUND_CONTEXT,
	);
	const found = page.items[0];
	if (found === undefined || found.kind !== BlocksEntry.kind) return undefined;
	const payload = found.data as BlocksPayload;
	const state = await readBlocksState(
		harness,
		conversationId,
		entryId,
		BACKGROUND_CONTEXT,
	);
	if (state === undefined) return undefined;
	return { title: payload.title, tree: payload.tree, state };
}

/**
 * Resolve the tree's handler labels (spec §6.1: handler names are free
 * labels in chat — no `handlers` set at validation) to the node each
 * names: a collection's `onMove`/`onCheck`, a form's `onSubmit`. The
 * LAST declaration wins (matching the channel's own scan direction).
 */
export function resolveChatHandlers(
	tree: Tree,
): Map<string, HandlerNode> {
	const handlers = new Map<string, HandlerNode>();
	const visit = (node: JsonObject): void => {
		if (node.type === "collection") {
			if (typeof node.onMove === "string") {
				handlers.set(node.onMove, { kind: "move", node });
			}
			if (typeof node.onCheck === "string") {
				handlers.set(node.onCheck, { kind: "check", node });
			}
		} else if (node.type === "form" && typeof node.onSubmit === "string") {
			handlers.set(node.onSubmit, { kind: "submit", node });
		}
		const childLists = [
			node.root,
			node.children,
			node.fields,
			node.main,
			node.sidebar,
			node.detail,
		];
		for (const list of childLists) {
			if (Array.isArray(list)) {
				for (const child of list) {
					if (!isRec(child)) continue;
					if (isRec(child.block)) visit(child.block);
					else visit(child);
				}
			} else if (isRec(list)) {
				visit(list);
			}
		}
		if (isRec(node.item)) visit(node.item);
	};
	// SAFETY: the walk reads only the structural record fields (type,
	// children, item, handler props) the wire Tree and the loose
	// JsonObject view agree on; every read is typeof-guarded.
	visit(tree.root as unknown as JsonObject);
	return handlers;
}

/** A `move`/`edit` payload endpoint ({group?, index}). */
function readSpot(value: unknown): { group?: string; index?: number } | undefined {
	if (!isRec(value)) return undefined;
	return {
		...(typeof value.group === "string" ? { group: value.group } : {}),
		...(typeof value.index === "number" ? { index: value.index } : {}),
	};
}

/** Read the value at one data pointer (`/a/0/b`); undefined when absent. */
function dataAt(data: JsonObject, pointer: string): JsonValue | undefined {
	if (pointer === "/" || pointer === "") return data;
	const tokens = pointer.replace(/^\//, "").split("/");
	let node: JsonValue = data;
	for (const token of tokens) {
		if (Array.isArray(node)) {
			if (!/^\d+$/.test(token)) return undefined;
			const index = Number(token);
			if (index >= node.length) return undefined;
			node = node[index] as JsonValue;
		} else if (isRec(node)) {
			const next: JsonValue | undefined = node[token];
			if (next === undefined) return undefined;
			node = next;
		} else {
			return undefined;
		}
	}
	return node;
}

/** The collection's bound-array pointer (`/cards`), when it binds one. */
function itemsPointer(collection: JsonObject): string | undefined {
	const items = collection.items;
	if (!isRec(items)) return undefined;
	const pointer = items.$;
	return typeof pointer === "string" ? pointer : undefined;
}

/** The index of one item id inside its collection's bound array. */
function itemIndexAt(items: readonly JsonValue[], itemId: string): number {
	return items.findIndex(
		(candidate) => isRec(candidate) && candidate.id === itemId,
	);
}

/**
 * The ABSOLUTE array index a group-relative drop lands at, mirroring
 * the channel's overlay math (useSurface.applyMoveOverlay): the
 * `index`-th member of `group` in the POST-REMOVAL array, or the
 * array's end when the index is past the group's members (a lane-end
 * drop). Grouped on `groupBy`; `undefined` when the group is unknown.
 */
function absoluteDropIndex(
	removed: readonly JsonValue[],
	groupBy: string,
	group: string,
	index: number,
): number {
	const members = removed
		.map((entry, position) => ({ entry, position }))
		.filter(({ entry }) => isRec(entry) && entry[groupBy] === group)
		.map(({ position }) => position);
	if (index < members.length) return members[index] ?? removed.length;
	return removed.length;
}

/** The computed ops plus the ChangeRecord's `action` label. */
interface ActionPlan {
	readonly ops: DataOp[];
	readonly actionKind: string;
}

/** Compute one action's ops against the CURRENT data (spec §8.3). */
function planAction(
	handlers: Map<string, HandlerNode>,
	actionName: string,
	payload: JsonValue,
	data: JsonObject,
): ActionPlan | undefined {
	const handler = handlers.get(actionName);
	if (handler === undefined) return undefined;
	const record = isRec(payload) ? payload : {};
	if (handler.kind === "move") {
		const base = itemsPointer(handler.node);
		if (base === undefined) return undefined;
		const itemId = record.itemId;
		if (typeof itemId !== "string") return undefined;
		const items = dataAt(data, base);
		if (!Array.isArray(items)) return undefined;
		const fromIndex = itemIndexAt(items, itemId);
		if (fromIndex < 0) return undefined;
		const to = readSpot(record.to);
		if (to === undefined || to.index === undefined) return undefined;
		const groupBy =
			typeof handler.node.groupBy === "string" ? handler.node.groupBy : undefined;
		// Post-removal resolution (DataOp.move resolves its destination
		// against the post-removal array too, so the two agree).
		const removed = items.filter((_, index) => index !== fromIndex);
		const at =
			groupBy !== undefined && to.group !== undefined
				? absoluteDropIndex(removed, groupBy, to.group, to.index)
				: to.index;
		const ops: DataOp[] = [];
		// A cross-group move sets the groupBy field FIRST (spec §8.3) —
		// the item arrives at the destination already grouped, and the
		// set's index still addresses the pre-move array.
		if (groupBy !== undefined && to.group !== undefined) {
			const current = items[fromIndex];
			if (
				isRec(current) &&
				current[groupBy] !== to.group
			) {
				ops.push({
					op: "set",
					path: `${base}/${fromIndex}/${groupBy}`,
					value: to.group,
				});
			}
		}
		ops.push({ op: "move", from: `${base}/${fromIndex}`, path: `${base}/${at}` });
		return { ops, actionKind: "reorder" };
	}
	if (handler.kind === "check") {
		const field = handler.node.checkable;
		if (typeof field !== "string") return undefined;
		const base = itemsPointer(handler.node);
		if (base === undefined) return undefined;
		const itemId = record.itemId;
		if (typeof itemId !== "string") return undefined;
		const items = dataAt(data, base);
		if (!Array.isArray(items)) return undefined;
		const at = itemIndexAt(items, itemId);
		if (at < 0) return undefined;
		const value = record.value === undefined ? true : record.value;
		return {
			ops: [{ op: "set", path: `${base}/${at}/${field}`, value }],
			actionKind: "edit",
		};
	}
	// submit (turn:false): write the form's values at its bind.
	const bind = handler.node.bind;
	if (typeof bind !== "string") return undefined;
	const values = record.values;
	if (!isRec(values)) return undefined;
	const root = bind === "/" || bind === "" ? "" : bind.replace(/\/$/, "");
	const ops: DataOp[] = [];
	// The bind object itself is created when absent (`set` can create the
	// FINAL member but not intermediate parents) — a form writing at a
	// fresh bind is the normal first-submit case.
	if (root !== "" && dataAt(data, root) === undefined) {
		ops.push({ op: "set", path: root, value: {} });
	}
	for (const name of Object.keys(values)) {
		ops.push({
			op: "set",
			path: `${root}/${name}`,
			value: values[name] as JsonValue,
		});
	}
	return { ops, actionKind: "submit" };
}

/** The `Action` summarizeAction reads for one plan (kind + label). */
function actionFor(actionKind: string, actionName: string): Action {
	if (actionKind === "reorder") return { type: "move", name: actionName };
	if (actionKind === "edit") return { type: "edit", name: actionName };
	return { type: "submit", name: actionName };
}

/** The next change-record seq, monotonic per surface even right after a
 *  trim emptied the array (notedThrough anchors the sequence). */
function nextSeq(changes: readonly { readonly seq: number }[], notedThrough: number): number {
	return Math.max(changes[changes.length - 1]?.seq ?? 0, notedThrough) + 1;
}

/** The applied outcome the route answers (§6.3's accept-with-ops). */
export interface ChatApplied {
	readonly ok: true;
	readonly rev: number;
	readonly ops: DataOp[];
}

/** The reject outcome (§6.3's reject). */
export interface ChatRejected {
	readonly ok: false;
	readonly error: { readonly message: string };
}

export type ChatOutcome = ChatApplied | ChatRejected;

/**
 * Apply one user edit (the core handler, spec §8.3): read the entry
 * (the tree is immutable, so its labels are always current), then —
 * INSIDE ONE conversation commit — read the CURRENT draft state,
 * compute the ops against it (planAction), and write ops + change
 * record + `rev` bump. Planning inside the commit is what keeps an
 * index-addressed op from relocating the WRONG row when a concurrent
 * move (or an agent `update_blocks`) lands between the read and the
 * write: `draft.data` at commit time IS the data the op addresses
 * (Review Focus 3, spec §6.3 convergence), and the summary names the
 * positions/labels the actor saw AT APPLY TIME (draft.data again,
 * never a pre-commit snapshot). A failed op batch unwinds the commit
 * (no partial write) and answers a reject naming the op index.
 * `undefined` outcome means the entry id names no block in this
 * conversation (the route answers 404).
 */
export async function applyChatAction(
	harness: Harness,
	conversationId: number,
	entryId: string,
	by: string,
	actionName: string,
	payload: JsonValue,
): Promise<ChatOutcome | undefined> {
	const conversation = await harness.conversation(
		conversationId as ConversationId,
		BACKGROUND_CONTEXT,
	);
	if (conversation === undefined) return undefined;
	const block = await readChatBlock(harness, conversationId, entryId);
	if (block === undefined) return undefined;
	const handlers = resolveChatHandlers(block.tree);
	if (!handlers.has(actionName)) return undefined;
	let applied: { rev: number; ops: DataOp[] };
	try {
		applied = await conversation.commit(async (tx) => {
			const draft = await tx.doc(
				BlocksStateDoc,
				conversationId as ConversationId,
				entryId,
				entryId,
			);
			// The plan is derived from the DRAFT — the data as of the
			// commit, not the pre-commit snapshot — so every index
			// addresses the row the op is about to move.
			const plan = planAction(handlers, actionName, payload, draft.data);
			if (plan === undefined) {
				// Signal out of the commit (a throw unwinds it); the
				// caller answers the reject.
				return { rev: -1, ops: [] };
			}
			// The summary reads the labels the user saw AT APPLY TIME — the
			// draft's PRE-edit data (the payload's positions are the
			// pre-move ones), so it is computed BEFORE the ops apply.
			const summary = summarizeAction(
				block.tree,
				draft.data,
				actionFor(plan.actionKind, actionName),
				payload,
			);
			// applyOps throws DataOpError on a bad path — the throw unwinds
			// the commit before anything persists.
			draft.data = applyDataOps(draft.data, plan.ops);
			draft.rev += 1;
			draft.changes = [
				...draft.changes,
				{
					seq: nextSeq(draft.changes, draft.notedThrough),
					at: Date.now(),
					by,
					action: plan.actionKind,
					summary,
				},
			];
			// The trim (spec §8.2): once more than MAX_CHANGES accumulate,
			// records at or below notedThrough drop on THIS append.
			trimChanges(draft);
			// Only the rev + ops escape the commit — never a draft value
			// (the chord settle hazard Task 1 documented); rev/ops are the
			// values the route echoes back, plain JSON.
			return { rev: draft.rev, ops: plan.ops };
		}, BACKGROUND_CONTEXT);
	} catch (error) {
		if (error instanceof DataOpError) {
			return {
				ok: false,
				error: { message: `op ${error.opIndex} failed: ${error.message}` },
			};
		}
		throw error;
	}
	if (applied.rev === -1) {
		return { ok: false, error: { message: `unappliable action payload: ${actionName}` } };
	}
	chatSurfaceChanged({
		type: "surface.changed",
		conversationId,
		entryId,
		rev: applied.rev,
	} satisfies Parameters<typeof chatSurfaceChanged>[0]);
	return { ok: true, rev: applied.rev, ops: applied.ops };
}

/** applyOps over a plan's ops. */
function applyDataOps(data: JsonObject, ops: readonly DataOp[]): JsonObject {
	// SAFETY: planAction built every op as a literal DataOp; applyOps
	// re-validates each path and throws DataOpError on anything else.
	return applyOps(data, ops);
}
