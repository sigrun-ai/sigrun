/**
 * The interaction seam TYPES (spec: docs/approval-ux-seams.md; the block
 * mapping: docs/superpowers/specs/2026-10-19-sigrun-ui-blocks-design.md
 * §9.1): the channel-neutral record shapes for "this conversation is
 * waiting on a human decision", written by extensions through the host
 * context and answered by channels through one generic route.
 *
 * The CANONICAL type declarations live here (the shared leaf package);
 * `src/harness/interactions.ts` imports them (type-only) for the doc
 * definitions and validation runtime. The records ride the §5 wire
 * AS-IS (envelope + body + details — never projected), so these shapes
 * are the channel contract too (see `@sigrun/shared/views`).
 *
 * Layering (strict envelope / block-tree body / opaque details):
 *
 * - envelope: kind, callId, status, timestamps, answer — load-bearing for
 *   joining tool slots and lifecycle arbitration. Strictly validated.
 * - body: a block tree (placement `interaction` — a root `form` whose
 *   submit is the answer). Validated by `validateTree`; the legacy
 *   `text`/`options`/`fields`/`diff` primitives are REJECTED (ruling 16:
 *   no compatibility layer).
 * - details: opaque extension-owned JSON. Never interpreted.
 */

import type { Tree } from "./blocks/index.js";
import type { JsonObject, JsonValue } from "./json.js";

/** Lifecycle of one interaction record (spec statuses). */
export type InteractionStatus =
	| "pending"
	| "answered"
	| "skipped"
	| "expired"
	| "cancelled";

/**
 * What an answer carries (ruling 20): every field's value under its
 * name — a `choice` value is its option id (or ids when `multi`), a
 * `choice` with `allowOther` carries `{other: "…"}`.
 */
export type InteractionAnswer = {
	readonly values: Readonly<Record<string, JsonValue>>;
}

/** The strict envelope + block-tree body of one interaction. */
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
	/**
	 * The answering principal's directory username (spec §5.9): stamped by
	 * the answer route from `request.principal.user` — host-assigned, never
	 * model-asserted. Absent on the naive single-operator path (no user).
	 */
	readonly answeredByUser?: string;
	/**
	 * The interaction body: a block tree (placement `interaction` — a
	 * root `form` whose `submit` is the answer). Legacy-shaped bodies
	 * fail validation (ruling 16).
	 */
	readonly body?: Tree;
	/** Opaque extension-owned payload; rendered collapsed, never interpreted. */
	readonly details?: JsonObject;
}
