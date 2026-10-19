/**
 * The session-meta WIRE types (spec §5) — the client-facing half of
 * `src/server/session-meta.ts` (which owns the document/patch runtime).
 *
 * This module is part of the shared leaf package (`@sigrun/shared`): the
 * tui and webui import these shapes from here, never from server source
 * (the load-bearing decoupling — the tui is a pure client of the wire).
 *
 * PURE module: no imports at all (the views-purity guard enforces this
 * across `shared/src`).
 *
 * Doc header (from the server module — the runtime semantics live there):
 *
 * One latest-only singleton doc per conversation (kind
 * `"sigrun.session-meta"`): pin/tag/archive flags, the composer draft
 * (survives reloads — `draft.attachments` are workspace-relative paths
 * from the uploads endpoint), the session source, the user-facing session
 * name (T5d), and the multi-user `owner` seam (spec §5: "exists in schema
 * from day 1; the flow does not" — written by the auth hook at
 * create/fork/import and read by the listing route; still no interactive
 * flow in v1).
 *
 * Server-owned fields (`autoName`, `autoNameAttempts`,
 * `lastActivityAt`) are written by host code only (activity.ts, the A2
 * auto-namer); they are NOT patch surface — the strict validator keeps
 * rejecting them as `invalid_field`.
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
	/** Who created the session: interactive use or a cron job. */
	source: "user" | "cron";
	/**
	 * Multi-user seam (spec §5): PATCH accepts it, GET serves it, the auth
	 * hook writes it (create/fork/import), and the listing route reads it
	 * — there is no interactive flow around it in v1 beyond that plumbing.
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
	readonly source?: "user" | "cron" | null;
	readonly owner?: string | null;
	readonly name?: string | null;
}

/** Why a PATCH body was rejected (the configure endpoint's error contract). */
export type SessionMetaPatchError =
	| { readonly error: "invalid_body" }
	| { readonly error: "invalid_field"; readonly field: string };
