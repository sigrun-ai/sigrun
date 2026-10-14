/**
 * The interaction seam (spec: docs/approval-ux-seams.md): core-owned,
 * channel-neutral records for "this conversation is waiting on a human
 * decision", written by extensions through the host context and answered
 * by channels through one generic route.
 *
 * Layering (strict envelope / closed primitives / opaque details):
 *
 * - envelope: kind, callId, status, timestamps, answer — load-bearing for
 *   joining tool slots and lifecycle arbitration. Strictly validated.
 * - body: composed ONLY from the closed primitives (text, options,
 *   fields, diff). Structurally validated; unknown body keys quarantine.
 * - details: opaque extension-owned JSON. Never interpreted.
 *
 * Answer transport: the generic route commits `answer` into the record.
 * First-answer-wins is enforced INSIDE the commit (the mutation line
 * serializes commits), mirroring the approvals doc-family pattern.
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
import type { ConversationId } from "@earendil-works/pi-durable";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";

/** Lifecycle of one interaction record (spec statuses). */
export type InteractionStatus =
	| "pending"
	| "answered"
	| "skipped"
	| "expired"
	| "cancelled";

/** One choice in the `options` primitive. */
export type InteractionOption = {
	readonly id: string;
	readonly label: string;
	/** Second line under the label (pi-advisor presets, rpiv options). */
	readonly description?: string;
	/** Channel-schemed color/severity hint: "danger" | "warn" | "ok" | "neutral". */
	readonly tone?: "danger" | "warn" | "ok" | "neutral";
	/** Pre-selected by the extension's recommendation (pi-interview conviction). */
	readonly recommended?: boolean;
}

/** One light-form field in the `fields` primitive. */
export type InteractionField = {
	readonly name: string;
	readonly type: "string" | "number" | "boolean" | "secret";
	readonly label?: string;
	readonly required?: boolean;
}

/** The `diff` primitive: before/after content, optionally path-scoped. */
export type InteractionDiff = {
	readonly before: string;
	readonly after: string;
	readonly path?: string;
	readonly lang?: string;
}

/**
 * The interaction body: ONLY these four keys, each built only from the
 * closed primitives. Everything else belongs in `details`.
 */
export type InteractionBody = {
	/** Prose prompt body (markdown). */
	readonly text?: string;
	readonly options?: InteractionOption[];
	readonly fields?: InteractionField[];
	readonly diff?: InteractionDiff;
}

/** What an answer may carry: chosen ids, form values, and/or free text. */
export type InteractionAnswer = {
	readonly ids?: string[];
	readonly values?: Readonly<Record<string, string | number | boolean>>;
	readonly text?: string;
}

/** The strict envelope + closed-primitive body of one interaction. */
export type InteractionRecord = {
	/** Extension-declared kind id (e.g. "gating.confirm", "questions.form"). */
	readonly kind: string;
	/** Stable join key to the pi.live tool slot (`ToolCall.id`). */
	readonly callId: string;
	readonly status: InteractionStatus;
	/** Epoch ms when seeded. */
	readonly createdAt: number;
	/** Epoch ms after which channels may show it as expired. */
	readonly expiresAt?: number;
	/** Epoch ms when a terminal status landed. */
	readonly settledAt?: number;
	readonly answer?: InteractionAnswer;
	/** Who answered: "human" via the route, or the extension itself. */
	readonly answeredBy?: "human" | "extension";
	readonly body?: InteractionBody;
	/** Opaque extension-owned payload; rendered collapsed, never interpreted. */
	readonly details?: JsonObject;
}

/** The interaction record doc family: one record per callId, per conversation. */
export const InteractionDoc = defineDocFamily<InteractionRecord, string>({
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

/** Terminal statuses: answering one of these is a no-op (first wins). */
const TERMINAL: ReadonlySet<string> = new Set([
	"answered",
	"skipped",
	"expired",
	"cancelled",
]);

const TONES: ReadonlySet<string> = new Set([
	"danger",
	"warn",
	"ok",
	"neutral",
]);

const FIELD_TYPES: ReadonlySet<string> = new Set([
	"string",
	"number",
	"boolean",
	"secret",
]);

/** Structural validation of one interaction record. Returns the error text or null. */
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
	const body = r.body;
	if (body !== undefined) {
		if (typeof body !== "object" || body === null) {
			return "body must be an object";
		}
		const b = body as Record<string, unknown>;
		const known = new Set(["text", "options", "fields", "diff"]);
		const unknownKey = Object.keys(b).find((k) => !known.has(k));
		if (unknownKey !== undefined) {
			return `body.${unknownKey} is outside the closed primitives (move it to details)`;
		}
		if (b.text !== undefined && typeof b.text !== "string") {
			return "body.text must be a string";
		}
		if (b.options !== undefined) {
			if (!Array.isArray(b.options)) return "body.options must be an array";
			for (const o of b.options) {
				const problem = validateOption(o);
				if (problem !== null) return problem;
			}
		}
		if (b.fields !== undefined) {
			if (!Array.isArray(b.fields)) return "body.fields must be an array";
			for (const f of b.fields) {
				const problem = validateField(f);
				if (problem !== null) return problem;
			}
		}
		if (b.diff !== undefined) {
			const problem = validateDiff(b.diff);
			if (problem !== null) return problem;
		}
	}
	return null;
}

function validateAnswer(value: unknown): string | null {
	if (typeof value !== "object" || value === null) {
		return "answer must be an object";
	}
	const a = value as Record<string, unknown>;
	const known = new Set(["ids", "values", "text"]);
	const unknownKey = Object.keys(a).find((k) => !known.has(k));
	if (unknownKey !== undefined) return `answer.${unknownKey} is not a valid field`;
	if (a.ids !== undefined && !Array.isArray(a.ids)) {
		return "answer.ids must be an array of strings";
	}
	if (Array.isArray(a.ids) && a.ids.some((id) => typeof id !== "string")) {
		return "answer.ids must be an array of strings";
	}
	if (a.values !== undefined) {
		if (typeof a.values !== "object" || a.values === null) {
			return "answer.values must be an object";
		}
		const bad = Object.entries(a.values as Record<string, unknown>).find(
			([, v]) => typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean",
		);
		if (bad !== undefined) {
			return `answer.values.${bad[0]} must be string, number, or boolean`;
		}
	}
	if (a.text !== undefined && typeof a.text !== "string") {
		return "answer.text must be a string";
	}
	return null;
}

function validateOption(value: unknown): string | null {
	if (typeof value !== "object" || value === null) return "option must be an object";
	const o = value as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) return "option.id must be a non-empty string";
	if (typeof o.label !== "string" || o.label.length === 0) {
		return "option.label must be a non-empty string";
	}
	if (o.description !== undefined && typeof o.description !== "string") {
		return "option.description must be a string";
	}
	if (o.tone !== undefined && !TONES.has(String(o.tone))) {
		return `option.tone must be one of danger|warn|ok|neutral (got ${String(o.tone)})`;
	}
	if (o.recommended !== undefined && typeof o.recommended !== "boolean") {
		return "option.recommended must be a boolean";
	}
	return null;
}

function validateField(value: unknown): string | null {
	if (typeof value !== "object" || value === null) return "field must be an object";
	const f = value as Record<string, unknown>;
	if (typeof f.name !== "string" || f.name.length === 0) {
		return "field.name must be a non-empty string";
	}
	if (typeof f.type !== "string" || !FIELD_TYPES.has(f.type)) {
		return `field.type must be one of string|number|boolean|secret (got ${String(f.type)})`;
	}
	if (f.label !== undefined && typeof f.label !== "string") {
		return "field.label must be a string";
	}
	if (f.required !== undefined && typeof f.required !== "boolean") {
		return "field.required must be a boolean";
	}
	return null;
}

function validateDiff(value: unknown): string | null {
	if (typeof value !== "object" || value === null) return "diff must be an object";
	const d = value as Record<string, unknown>;
	if (typeof d.before !== "string") return "diff.before must be a string";
	if (typeof d.after !== "string") return "diff.after must be a string";
	if (d.path !== undefined && typeof d.path !== "string") return "diff.path must be a string";
	if (d.lang !== undefined && typeof d.lang !== "string") return "diff.lang must be a string";
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

/**
 * The committed answer for one record, or `undefined` when the record was
 * already terminal (first-answer-wins: the caller must NOT overwrite).
 * The draft is mutated in place — this runs inside the caller's commit.
 */
export function applyAnswer(
	draft: InteractionRecord,
	answer: InteractionAnswer,
	answeredBy: "human" | "extension",
	now: number,
): boolean {
	if (draft.status !== "pending") return false;
	const clean: Record<string, JsonValue> = {};
	if (answer.ids !== undefined) clean.ids = [...answer.ids];
	if (answer.values !== undefined) clean.values = { ...answer.values };
	if (answer.text !== undefined) clean.text = answer.text;
	const mutable = draft as unknown as Record<string, unknown>;
	mutable.answer = clean;
	mutable.answeredBy = answeredBy;
	mutable.status = "answered";
	mutable.settledAt = now;
	return true;
}
