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
 * The literal that replaces a `secret` field's value in every STORED answer
 * (Review Focus 4, U6 Task 2): the stored record, every HTTP read, and the
 * wire only ever carry this marker. The extension receives the true value
 * exactly once, transiently, through the host-side read (the delivery
 * table below).
 */
export const SECRET_MASK = "[secret]";

/**
 * The transient full-answer delivery table (supervisor ruling, U6 Task 2):
 * in-memory, runtime-owned, keyed (conversationId, callId). A `secret`
 * field's value never lands in the stored record — the answer commit
 * writes the MASK into the record and records the TRUE answer here, and
 * the extension-only read path (`host.snapshotInteraction`) merges the true
 * values back once, then deletes the entry (one-shot delivery; the
 * extension is expected to persist the secret in its own scoped stores).
 * The table is deliberately NOT durable: a crash between the answer commit
 * and the extension's poll loses the value and the human re-answers — the
 * safe failure mode (a raw secret must never survive a restart in the DB).
 */
class SecretDeliveries {
	/** conversationId|callId → the true answer, waiting for one read. */
	readonly #pending = new Map<string, InteractionAnswer>();

	/** Record the true answer for one settled interaction (answer path). */
	record(
		conversationId: ConversationId,
		callId: string,
		answer: InteractionAnswer,
	): void {
		this.#pending.set(`${String(conversationId)}|${callId}`, answer);
	}

	/**
	 * Take the delivery once, if present: the true answer, then delete.
	 * Returns `undefined` when nothing was recorded (no secret, or already
	 * delivered, or swept).
	 */
	take(
		conversationId: ConversationId,
		callId: string,
	): InteractionAnswer | undefined {
		const key = `${String(conversationId)}|${callId}`;
		const answer = this.#pending.get(key);
		if (answer !== undefined) this.#pending.delete(key);
		return answer;
	}

	/** Drop the entry without reading it (settle/expiry sweep — no leak). */
	sweep(conversationId: ConversationId, callId: string): void {
		this.#pending.delete(`${String(conversationId)}|${callId}`);
	}
}

/** The session-singleton delivery table (one per boot). */
const secretDeliveries = new SecretDeliveries();

/**
 * The names of the `secret` fields in an interaction's form tree: every
 * `field` node with `type: "secret"`, from the root form and its sections.
 * Used by the answer path to strip values before they land in the record.
 */
function secretFieldNames(body: unknown): ReadonlySet<string> {
	const names = new Set<string>();
	if (typeof body !== "object" || body === null) return names;
	const root = (body as { root?: unknown }).root;
	if (typeof root !== "object" || root === null) return names;
	const walk = (nodes: readonly unknown[] | undefined): void => {
		if (!Array.isArray(nodes)) return;
		for (const node of nodes) {
			if (typeof node !== "object" || node === null) continue;
			const field = node as { type?: unknown; name?: unknown; children?: unknown };
			if (field.type === "secret" && typeof field.name === "string") {
				names.add(field.name);
			} else if (field.type === "section") {
				walk(field.children as readonly unknown[] | undefined);
			}
		}
	};
	walk((root as { children?: unknown }).children as readonly unknown[] | undefined);
	return names;
}

/**
 * The committed answer for one record, or `undefined` when the record was
 * already terminal (first-answer-wins: the caller must NOT overwrite).
 * The draft is mutated in place — this runs inside the caller's commit.
 *
 * Review Focus 4: when the interaction's form carries `secret` fields, the
 * stored answer's values for those names are replaced by
 * {@link SECRET_MASK} and the TRUE answer is recorded in the delivery
 * table for the extension's one-shot read (`opts.conversationId` — the
 * table is keyed (conversation, callId), and only the caller knows the
 * conversation; omitting it skips the delivery).
 */
export function applyAnswer(
	draft: StoredInteractionRecord,
	answer: InteractionAnswer,
	answeredBy: "human" | "extension",
	now: number,
	answeredByUser?: string,
	opts?: { readonly conversationId?: ConversationId },
): boolean {
	if (draft.status !== "pending") return false;
	// Review Focus 4: the SECRET rule. The tree's secret field names decide
	// which values never persist: the stored copy carries the MASK, the
	// true copy rides the one-shot delivery table (extension-only read).
	const secrets = secretFieldNames(draft.body);
	const values: Record<string, JsonValue> = {};
	let hasSecret = false;
	for (const [key, value] of Object.entries(answer.values ?? {})) {
		// A host caller's answer was validated ({values: JsonObject}); this
		// copy is the belt that keeps the stored record JSON-safe.
		if (!isJsonValue(value)) continue;
		if (secrets.has(key)) {
			hasSecret = true;
			values[key] = SECRET_MASK;
		} else {
			values[key] = value;
		}
	}
	if (hasSecret && opts?.conversationId !== undefined) {
		secretDeliveries.record(opts.conversationId, draft.callId, {
			values: answer.values,
		});
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

/**
 * Take one interaction's secret delivery (the extension-only read path):
 * the TRUE answer when a secret was answered and never yet read — the
 * entry is deleted by this very read (one-shot). The HTTP GETs NEVER call
 * this: only `host.snapshotInteraction` merges it back.
 */
export function takeSecretDelivery(
	conversationId: ConversationId,
	callId: string,
): InteractionAnswer | undefined {
	return secretDeliveries.take(conversationId, callId);
}

/**
 * Drop one interaction's unread secret delivery without reading it (the
 * settle/expiry sweep: terminal transitions the extension never polled
 * must not leave raw values in the table).
 */
export function sweepSecretDelivery(
	conversationId: ConversationId,
	callId: string,
): void {
	secretDeliveries.sweep(conversationId, callId);
}

/**
 * The stored-answer projection of an input answer (the route's response
 * body): the values with every secret-field name replaced by
 * {@link SECRET_MASK} — EXACTLY what `applyAnswer` writes, computed
 * without a commit so the route can project it after the commit without
 * re-reading the mutated draft (the chord settled-overlay rule).
 */
export function maskedAnswerValues(
	body: unknown,
	answer: { readonly values: Readonly<Record<string, JsonValue>> },
): { values: Record<string, JsonValue> } {
	const secrets = secretFieldNames(body);
	const values: Record<string, JsonValue> = {};
	for (const [key, value] of Object.entries(answer.values ?? {})) {
		values[key] = secrets.has(key) ? SECRET_MASK : value;
	}
	return { values };
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
