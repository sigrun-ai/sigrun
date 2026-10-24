/**
 * The interaction seam (spec: docs/approval-ux-seams.md; the block
 * mapping: docs/superpowers/specs/2026-10-19-sigrun-ui-blocks-design.md
 * §9.1): core-owned, channel-neutral records for "this conversation is
 * waiting on a human decision", written by extensions through the host
 * context and answered by channels through one generic route.
 *
 * SPLIT (build-and-webui Task 1): the canonical TYPE declarations live in
 * the `@sigrun/shared` package (`shared/src/interactions.ts` — the records
 * ride the §5 wire as-is, so the shapes ARE the channel contract);
 * this module owns the docs, validation, and index RUNTIME, importing the
 * types (type-only — no runtime dependency on the built package).
 *
 * Layering (strict envelope / block-tree body / opaque details):
 *
 * - envelope: kind, callId, status, timestamps, answer — load-bearing for
 *   joining tool slots and lifecycle arbitration. Strictly validated.
 * - body: a block tree (placement `interaction` — a root `form` whose
 *   submit is the answer). Validated with `validateTree`; legacy-shaped
 *   bodies FAIL with paths (ruling 16 — no compatibility layer).
 * - details: opaque extension-owned JSON. Never interpreted.
 *
 * Answer transport: the generic route commits `answer` into the record.
 * First-answer-wins is enforced INSIDE the commit (the mutation line
 * serializes commits), mirroring the gated-doc-family pattern.
 * Resolution semantics (what allow/deny mean) stay extension-owned: the
 * extension reads the record through `api.snapshot` in its own poll loop.
 *
 * Enumerability: pi-durable's conversation view mounts only its five
 * built-in docs (dist/harness/view.js `MOUNTED`), and family docs are
 * excluded even there, so pending interactions need an index. The
 * `InteractionsIndexDoc` (session singleton) lists pending callIds per
 * conversation; every seed/answer/expire commit maintains it. Channels
 * read the list route, which snapshots the index and then the records.
 */

import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type {
	ConversationDocFamilyToken,
	ConversationId,
	JsonObject,
} from "@earendil-works/pi-durable";
import type {
	InteractionAnswer,
	InteractionRecord,
} from "@sigrun/shared/interactions";
import { validateTree } from "../blocks/validate.js";

export type {
	InteractionAnswer,
	InteractionRecord,
	InteractionStatus,
} from "@sigrun/shared/interactions";

/**
 * The stored record's `body`: the JSON mirror of `@sigrun/shared`'s
 * `Tree`. Identical at runtime — `validateInteraction` gates every write
 * through `validateTree` — but expressed structurally, because the wire
 * type's `body?: Tree` carries block interfaces (no implicit index
 * signature) and cannot satisfy pi-durable's `T extends JsonObject`
 * doc-family constraint.
 */
export type StoredTree = { readonly v: number; readonly root: JsonObject };

/**
 * The interaction record as the doc family stores it: the public wire
 * record with `body` mirrored (see `StoredTree`). Readers cast back to
 * `InteractionRecord` through {@link asInteractionRecord} — one spelling
 * of the cast, at one place.
 */
export type StoredInteractionRecord = Omit<InteractionRecord, "body"> & {
	readonly body?: StoredTree;
};

/**
 * Narrow a stored record to the public wire record. SAFETY: the two
 * shapes are identical at runtime — a stored body passed `validateTree`
 * (placement `interaction`) at write time, and a validated tree IS the
 * JSON the mirror describes; the cast only restores the type-level
 * naming `JsonObject`-erasure removed.
 */
export function asInteractionRecord(
	value: Readonly<StoredInteractionRecord>,
): Readonly<InteractionRecord> {
	// SAFETY: see the doc comment — the mirror differs only in the erased
	// body's structural naming; a validated tree is that JSON.
	return value as unknown as Readonly<InteractionRecord>;
}

/**
 * Widen the public wire record to the stored shape (the seed path's
 * `Object.assign` input). SAFETY: same runtime shape as
 * `asInteractionRecord` — the body was validated as a tree moments
 * before this cast in `validateInteraction`.
 */
export function asStoredInteractionRecord(
	value: Readonly<InteractionRecord>,
): Readonly<StoredInteractionRecord> {
	// SAFETY: see the doc comment — the mirror differs only in the erased
	// body's structural naming; a validated tree is that JSON.
	return value as unknown as Readonly<StoredInteractionRecord>;
}

/** The interaction record doc family: one record per callId, per conversation. */
export const InteractionDoc: ConversationDocFamilyToken<
	StoredInteractionRecord,
	string
> = defineDocFamily<StoredInteractionRecord, string>({
	kind: "sigrun.interaction",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	family: true,
	initial: (callId: string) => ({
		kind: "",
		callId,
		status: "pending",
		createdAt: 0,
	}),
});

/**
 * The pending index (session singleton): conversationId -> pending callIds.
 * Maintained by the same commits that seed/answer records; the list route
 * snapshots this instead of scanning storage (family enumeration is not
 * exposed through Harness, and the conversation view mounts no extension
 * docs).
 */
export type InteractionsIndex = {
	/** Pending callIds keyed by conversationId (numeric string). */
	readonly pending: Record<string, string[]>;
}

export const InteractionsIndexDoc = defineDoc<InteractionsIndex>({
	kind: "sigrun.interactions.index",
	version: 1,
	scope: "session",
	initial: () => ({ pending: {} }),
});

/** Terminal statuses: answering one of these is a no-op (first wins).
 * Exported for the event bus (W3 Task 4): the `interaction.pending` /
 * `interaction.settled` host-event split derives from the SAME set — one
 * definition, never two. */
export const TERMINAL: ReadonlySet<string> = new Set([
	"answered",
	"skipped",
	"expired",
	"cancelled",
]);

/**
 * Structural validation of one interaction record: the envelope's own
 * checks, then the body tree through `validateTree({placement:
 * "interaction"})`. Returns the error text (with the tree paths) or null.
 */
export function validateInteraction(value: unknown): string | null {
	if (typeof value !== "object" || value === null) {
		return "interaction record must be an object";
	}
	const r = value as Record<string, unknown>;
	if (typeof r.kind !== "string" || r.kind.length === 0) {
		return "kind must be a non-empty string";
	}
	if (typeof r.callId !== "string" || r.callId.length === 0) {
		return "callId must be a non-empty string";
	}
	if (typeof r.status !== "string" || !TERMINAL.has(r.status)) {
		if (r.status !== "pending") return `unknown status ${String(r.status)}`;
	}
	if (typeof r.createdAt !== "number") {
		return "createdAt must be a number";
	}
	if (r.expiresAt !== undefined && typeof r.expiresAt !== "number") {
		return "expiresAt must be a number";
	}
	if (r.settledAt !== undefined && typeof r.settledAt !== "number") {
		return "settledAt must be a number";
	}
	if (r.answer !== undefined) {
		const problem = validateAnswer(r.answer);
		if (problem !== null) return problem;
	}
	if (r.answeredBy !== undefined && r.answeredBy !== "human" && r.answeredBy !== "extension") {
		return "answeredBy must be 'human' or 'extension'";
	}
	if (r.body !== undefined) {
		// Ruling 16 (no compatibility layer): legacy-shaped bodies (objects
		// keyed text/options/fields/diff rather than {v, root}) fail HERE,
		// with the path — a tree is {v, root}.
		const result = validateTree(r.body, { placement: "interaction" });
		if (!result.ok) {
			const first = result.errors[0];
			if (first === undefined) return "body must be a block tree";
			// The tree-relative path joins the record's field ("body.root…")
			// so the error names where the record is wrong, not just the tree.
			return `body is not a valid interaction tree: body.${first.path} ${first.message}`;
		}
	}
	return null;
}

/**
 * An answer is `{values}` ONLY (ruling 20): every field's value under its
 * name. The legacy `{ids, text}` (and the string/number/boolean-only
 * `values`) are rejected — no compatibility layer.
 */
export function validateAnswer(value: unknown): string | null {
	if (typeof value !== "object" || value === null) {
		return "answer must be an object";
	}
	const a = value as Record<string, unknown>;
	const known = new Set(["values"]);
	const unknownKey = Object.keys(a).find((k) => !known.has(k));
	if (unknownKey !== undefined) {
		return `answer.${unknownKey} is not a valid field (an answer is {values})`;
	}
	if (a.values === undefined) {
		return "answer.values is required";
	}
	if (typeof a.values !== "object" || a.values === null || Array.isArray(a.values)) {
		return "answer.values must be an object";
	}
	return null;
}

/**
 * Add one conversation's pending callIds to the index (inside the caller's
 * commit; the draft is tracked, so mutation is the write).
 */
export function indexPending(
	draft: { pending: Record<string, readonly string[]> },
	conversationId: ConversationId,
	callId: string,
): void {
	const key = String(conversationId);
	const current = draft.pending[key] ?? [];
	if (!current.includes(callId)) {
		draft.pending[key] = [...current, callId];
	}
}

/** Remove one conversation's callId from the index (idempotent). */
export function indexSettled(
	draft: { pending: Record<string, readonly string[]> },
	conversationId: ConversationId,
	callId: string,
): void {
	const key = String(conversationId);
	const current = draft.pending[key];
	if (current === undefined) return;
	const next = current.filter((id) => id !== callId);
	if (next.length === 0) {
		const { [key]: _drop, ...rest } = draft.pending;
		draft.pending = rest;
	} else if (next.length !== current.length) {
		draft.pending[key] = next;
	}
}

/** A JSON value that is structurally valid in an answer's `values`. */
function isJsonValue(value: unknown): boolean {
	if (value === null) return true;
	const t = typeof value;
	if (t === "string" || t === "number" || t === "boolean") return true;
	if (t !== "object") return false;
	if (Array.isArray(value)) return value.every(isJsonValue);
	for (const child of Object.values(value as Record<string, unknown>)) {
		if (!isJsonValue(child)) return false;
	}
	return true;
}

/**
 * The committed answer for one record, or `undefined` when the record was
 * already terminal (first-answer-wins: the caller must NOT overwrite).
 * The draft is mutated in place — this runs inside the caller's commit.
 */
export function applyAnswer(
	draft: StoredInteractionRecord,
	answer: InteractionAnswer,
	answeredBy: "human" | "extension",
	now: number,
	answeredByUser?: string,
): boolean {
	if (draft.status !== "pending") return false;
	const values: Record<string, JsonValue> = {};
	for (const [key, value] of Object.entries(answer.values ?? {})) {
		// A host caller's answer was validated ({values: JsonObject}); this
		// copy is the belt that keeps the stored record JSON-safe.
		if (!isJsonValue(value)) continue;
		values[key] = value;
	}
	// SAFETY: the draft's declared shape is readonly; the doc family's
	// tracked-draft write pattern mutates through a structural record view
	// (every key below exists on the stored record by construction).
	const mutable = draft as unknown as Record<string, unknown>;
	mutable.answer = { values };
	mutable.answeredBy = answeredBy;
	// The answering USER rides alongside the actor class (spec §5.9): who
	// answered matters to every participant a conversation is shared with.
	if (answeredByUser !== undefined) mutable.answeredByUser = answeredByUser;
	mutable.status = "answered";
	mutable.settledAt = now;
	return true;
}

/** Narrow an unvalidated route body to `{values: JsonObject}`, or null. */
export function answerFromBody(body: unknown): { values: JsonObject } | null {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return null;
	}
	const b = body as Record<string, unknown>;
	for (const key of Object.keys(b)) {
		if (key !== "values") return null;
	}
	const values = b.values;
	if (typeof values !== "object" || values === null || Array.isArray(values)) {
		return null;
	}
	for (const value of Object.values(values as Record<string, unknown>)) {
		if (!isJsonValue(value)) return null;
	}
	return { values: values as JsonObject };
}
