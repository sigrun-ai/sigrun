/**
 * The session-meta WIRE types (spec §5) — the client-facing half of
 * `src/server/session-meta.ts` (which owns the document/patch runtime).
 *
 * This module is part of the shared leaf package (`@sigrun/shared`): the
 * tui and webui import these shapes from here, never from server source
 * (the load-bearing decoupling — the tui is a pure client of the wire).
 *
 * PURE module: no imports at all (the views-purity guard enforces this
 * across `shared/src`) — the `import type` below is the sanctioned wire-
 * module exception: sibling-only (`./access.js`), type-only.
 */

import type { Sharing } from "./access.js";

export type { Sharing } from "./access.js";

/**
 * Doc header (from the server module — the runtime semantics live there):
 *
 * One latest-only singleton doc per conversation (kind
 * `"sigrun.session-meta"`): pin/tag/archive flags, the composer draft
 * (survives reloads — `draft.attachments` are workspace-relative paths
 * from the uploads endpoint), the session source, the user-facing session
 * name (T5d), the multi-user `owner` seam, and the §5.9 `sharing` state.
 * `owner` and `source` are SERVER-ONLY: the auth hook stamps the owner at
 * create/fork/import, and a client PATCH carrying either key is a 400
 * `invalid_field`.
 *
 * Server-owned fields (`autoName`, `autoNameAttempts`,
 * `lastActivityAt`, `jobId`, `deliver`) are written by host code only
 * (activity.ts, the A2 auto-namer, fire.ts's job stamp); they are NOT
 * patch surface — the strict validator keeps rejecting them as
 * `invalid_field`.
 */

/** The per-conversation session metadata (spec §5). */
export type SessionMeta = {
	/** Sidebar pin (pinned conversations float to the top). */
	pinned: boolean;
	/** Sidebar tags; a PATCH replaces the array wholesale. */
	tagged: string[];
	/** Archived/hidden from the default sidebar listing. */
	archived: boolean;
	/** The composer draft; survives a reload. */
	draft: { text: string; attachments: string[] };
	/** Who created the session: an interactive user, a cron job, a channel
	 * adapter — a free-form server-owned label (spec §5.9: no longer a
	 * closed enum; never patchable). */
	source: string;
	/**
	 * Multi-user seam (spec §5.9): the caller identity the auth hook
	 * stamped at create/fork/import, read by the listing route and the
	 * access checks. SERVER-ONLY — a PATCH carrying the key is a 400
	 * `invalid_field`.
	 */
	owner?: string;
	/** The user-facing session name; absent = unnamed (T5d). */
	name?: string;
	/**
	 * Server-owned automatic name (the auto-namer writes it, A2); the
	 * listing serves it only while `name` is unset. NEVER patchable — the
	 * strict validator rejects the key as `invalid_field`.
	 */
	autoName?: string;
	/** Server-owned: the auto-namer's attempt count (A2). Never patchable. */
	autoNameAttempts?: number;
	/**
	 * Server-owned: the last activity instant, ISO 8601 (`activity.ts`
	 * stamps it at submission admission and run settlement). Never
	 * patchable — the strict validator rejects the key as `invalid_field`.
	 */
	lastActivityAt?: string;
	/**
	 * Server-owned job stamp (gateway C7, spec §8.0): the id of the job
	 * whose fire created this conversation (`fire.ts` writes it inside the
	 * creating commit). Never patchable — the strict validator rejects
	 * the key as `invalid_field`.
	 */
	jobId?: string;
	/**
	 * Server-owned job delivery targets (gateway C7, spec §8.0): the job
	 * action's `deliver` array, stamped onto the run conversation by
	 * `fire.ts` in the creating commit — the gateway's runSettled delivery
	 * reads it to route the answer to chats. Never patchable — the
	 * strict validator rejects the key as `invalid_field`.
	 */
	deliver?: string[];
	/**
	 * The §5.9 per-resource sharing state; absent = private (owner and
	 * superuser only). Patchable by the OWNER or a superuser (403
	 * otherwise); `sharing: null` clears back to private.
	 */
	sharing?: Sharing;
};

/** A validated PATCH body: present keys apply, `null` clears to default. */
export interface SessionMetaPatch {
	readonly pinned?: boolean | null;
	readonly tagged?: readonly string[] | null;
	readonly archived?: boolean | null;
	readonly draft?: {
		readonly text?: string | null;
		readonly attachments?: readonly string[] | null;
	} | null;
	readonly name?: string | null;
	/**
	 * The §5.9 sharing set/clear (`null` → private). `owner` and `source`
	 * are deliberately ABSENT — the validator rejects them as
	 * `invalid_field`, so a patch type that cannot express them keeps the
	 * apply step honest by construction.
	 */
	readonly sharing?: Sharing | null;
}

/** Why a PATCH body was rejected (the configure endpoint's error contract). */
export type SessionMetaPatchError =
	| { readonly error: "invalid_body" }
	| { readonly error: "invalid_field"; readonly field: string };
