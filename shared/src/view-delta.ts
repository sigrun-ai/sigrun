/**
 * Delta view frames (core hardening W3, spec §7.3 ruling 11): the SSE view
 * stream's incremental frame shape and its pure diff/fold functions, shared
 * by the server (which diffs) and both clients (which fold).
 *
 * The stream keeps `event: snapshot` (the full wire view) on connect and as
 * the fallback; each later revision is a `event: delta` frame carrying only
 * what changed:
 *
 * - `entries.append` / `entries.remove` — the entry list keyed by `id`;
 *   removals plus a pure suffix append are representable, anything else
 *   (a head insert, a reorder — e.g. a compaction's new head marker) makes
 *   {@link diffViews} return `undefined` and the server sends a fresh
 *   snapshot instead;
 * - `docs.set` / `docs.unset` — the changed/removed named documents;
 * - `conversation` / `steer` — present only when they differ.
 *
 * Purity: a shared wire module — `import type` sibling-only (the purity
 * guard in test/views-purity.test.ts); the runtime functions below are
 * dependency-free so both clients (DOM-only webui, NodeNext tui) and the
 * server fold identically.
 */

import type { JsonObject } from "./json.js";
import type {
	ConversationViewWire,
	SteerField,
	ViewConversation,
	ViewEntry,
} from "./views.js";

/** One `event: delta` frame's payload. Absent slots mean "no change". */
export interface ViewDelta {
	readonly entries?: {
		readonly append?: readonly ViewEntry[];
		readonly remove?: readonly number[];
	};
	readonly docs?: {
		readonly set?: Readonly<Record<string, JsonObject>>;
		readonly unset?: readonly string[];
	};
	readonly conversation?: ViewConversation;
	readonly steer?: SteerField;
}

/** Structural equality for the JSON-shaped slots (docs/conversation/steer). */
function jsonEqual(a: unknown, b: unknown): boolean {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Diff two consecutive wire views into a delta, or `undefined` when the
 * change is not representable: entries are keyed by `id`, `remove` is the
 * prev ids absent from next, and AFTER removal prev's remaining ids must be
 * a PREFIX of next's (append-only tail). A head insert or reorder fails the
 * prefix rule → `undefined` → the caller sends a fresh snapshot.
 */
export function diffViews(
	prev: ConversationViewWire,
	next: ConversationViewWire,
): ViewDelta | undefined {
	const delta: {
		entries?: { append?: ViewEntry[]; remove?: number[] };
		docs?: { set?: Record<string, JsonObject>; unset?: string[] };
		conversation?: ViewConversation;
		steer?: SteerField;
	} = {};

	// Entries: removals, then the prefix rule, then the appended suffix.
	const nextIds = new Set(next.entries.map((entry) => entry.id));
	const remove = prev.entries
		.filter((entry) => !nextIds.has(entry.id))
		.map((entry) => entry.id);
	const remaining = prev.entries.filter((entry) => nextIds.has(entry.id));
	const prefix = remaining.every(
		(entry, index) => entry.id === next.entries[index]?.id,
	);
	if (!prefix) return undefined;
	const append = next.entries.slice(remaining.length);
	if (remove.length > 0 || append.length > 0) {
		delta.entries = {};
		if (remove.length > 0) delta.entries.remove = remove;
		if (append.length > 0) delta.entries.append = [...append];
	}

	// Docs: reference-equal first (the common no-op revision), JSON second.
	const docKeys = new Set([
		...Object.keys(prev.docs),
		...Object.keys(next.docs),
	]);
	const set: Record<string, JsonObject> = {};
	const unset: string[] = [];
	for (const key of docKeys) {
		const before = prev.docs[key];
		const after = next.docs[key];
		if (after === undefined) {
			if (before !== undefined) unset.push(key);
			continue;
		}
		if (before === undefined || !jsonEqual(before, after)) set[key] = after;
	}
	if (unset.length > 0 || Object.keys(set).length > 0) {
		delta.docs = {};
		if (unset.length > 0) delta.docs.unset = unset;
		if (Object.keys(set).length > 0) delta.docs.set = set;
	}

	if (!jsonEqual(prev.conversation, next.conversation)) {
		delta.conversation = next.conversation;
	}
	if (!jsonEqual(prev.steer, next.steer)) {
		delta.steer = next.steer;
	}
	return delta;
}

/**
 * Fold a delta into a view: filter removed entry ids, concat the appended
 * suffix, shallow-merge docs (set over, unset out), replace
 * `conversation`/`steer` when present. NEVER mutates `view` — every changed
 * slot is a fresh object/array (unchanged slots keep their references).
 */
export function applyDelta(
	view: ConversationViewWire,
	delta: ViewDelta,
): ConversationViewWire {
	let entries = view.entries;
	if (delta.entries !== undefined) {
		const removed = new Set(delta.entries.remove ?? []);
		entries = [
			...view.entries.filter((entry) => !removed.has(entry.id)),
			...(delta.entries.append ?? []),
		];
	}
	let docs = view.docs;
	if (delta.docs !== undefined) {
		const unset = new Set(delta.docs.unset ?? []);
		const merged: Record<string, JsonObject> = {};
		for (const [key, value] of Object.entries(view.docs)) {
			if (!unset.has(key)) merged[key] = value;
		}
		for (const [key, value] of Object.entries(delta.docs.set ?? {})) {
			merged[key] = value;
		}
		docs = merged;
	}
	return {
		...view,
		entries,
		docs,
		conversation: delta.conversation ?? view.conversation,
		steer: delta.steer ?? view.steer,
	};
}

/** True when every slot is absent or empty (the server skips these frames). */
export function isEmptyDelta(delta: ViewDelta): boolean {
	const entries = delta.entries;
	if (
		entries !== undefined &&
		((entries.append?.length ?? 0) > 0 || (entries.remove?.length ?? 0) > 0)
	) {
		return false;
	}
	const docs = delta.docs;
	if (
		docs !== undefined &&
		(Object.keys(docs.set ?? {}).length > 0 || (docs.unset?.length ?? 0) > 0)
	) {
		return false;
	}
	return delta.conversation === undefined && delta.steer === undefined;
}
