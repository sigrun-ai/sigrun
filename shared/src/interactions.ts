/**
 * The interaction seam TYPES (spec: docs/approval-ux-seams.md): the
 * channel-neutral record shapes for "this conversation is waiting on a
 * human decision", written by extensions through the host context and
 * answered by channels through one generic route.
 *
 * The CANONICAL type declarations live here (the shared leaf package);
 * `src/harness/interactions.ts` imports them (type-only) for the doc
 * definitions and validation runtime. The records ride the §5 wire
 * AS-IS (envelope + body + details — never projected), so these shapes
 * are the channel contract too (see `@sigrun/shared/views`).
 *
 * Layering (strict envelope / closed primitives / opaque details):
 *
 * - envelope: kind, callId, status, timestamps, answer — load-bearing for
 *   joining tool slots and lifecycle arbitration. Strictly validated.
 * - body: composed ONLY from the closed primitives (text, options,
 *   fields, diff). Structurally validated; unknown body keys quarantine.
 * - details: opaque extension-owned JSON. Never interpreted.
 */

import type { JsonObject } from "./json.js";

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
