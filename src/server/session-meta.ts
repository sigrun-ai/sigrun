/**
 * The session-meta document (spec §5): conversation-scoped sidebar state.
 *
 * One latest-only singleton doc per conversation (kind
 * `"sigrun.session-meta"`): pin/tag/archive flags, the composer draft
 * (survives reloads — `draft.attachments` are workspace-relative paths from
 * the uploads endpoint), the session source, and the multi-user `owner`
 * seam (spec §5: "exists in schema from day 1; the flow does not" —
 * present, unused in v1).
 *
 * Docs are standalone tokens: `defineDoc` needs no registry install (the
 * approvals policy doc in `sigrun-approvals-work/src/approvals.ts` is the
 * reference pattern). Reads serve `DEFAULT_SESSION_META` when the doc was
 * never written; only a PATCH materializes it — a read that wrote would
 * churn a doc revision on every sidebar poll, and defaults are free.
 *
 * PATCH semantics (spec §5: "PATCH is a MERGE; explicit `null` CLEARS a
 * field"): each top-level key shallow-sets; `tagged` REPLACES wholesale
 * (arrays never merge element-wise); `draft` sub-merges its own fields;
 * `null` resets the field to its default value — `owner: null` removes the
 * key entirely. The merge runs as a read-modify-write inside ONE
 * `Conversation.commit` callback, so concurrent patches cannot lose each
 * other's fields (the mutation line serializes commits).
 */

import type { Draft } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";

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
	 * Multi-user seam (spec §5): present, unused in v1 — PATCH accepts it,
	 * GET serves it, nothing reads it.
	 */
	owner?: string;
};

/** What a never-written doc — and every explicit `null` clear — means. */
export const DEFAULT_SESSION_META: SessionMeta = {
	pinned: false,
	tagged: [],
	archived: false,
	draft: { text: "", attachments: [] },
	source: "user",
};

/** The per-conversation session-meta document (latest-only singleton). */
export const SessionMetaDoc = defineDoc<SessionMeta>({
	kind: "sigrun.session-meta",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	// Defensive copy (the approvals-policy pattern): the tracker takes
	// alias-free ownership of the root, so the shared DEFAULT constant must
	// never become a tracked value.
	initial: () => ({
		...DEFAULT_SESSION_META,
		tagged: [...DEFAULT_SESSION_META.tagged],
		draft: {
			...DEFAULT_SESSION_META.draft,
			attachments: [...DEFAULT_SESSION_META.draft.attachments],
		},
	}),
});

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
}

/** Why a PATCH body was rejected (the configure endpoint's error contract). */
export type SessionMetaPatchError =
	| { readonly error: "invalid_body" }
	| { readonly error: "invalid_field"; readonly field: string };

/**
 * Validate a PATCH body strictly (mirroring the configure endpoint):
 * non-object/array/empty → `invalid_body`; an unknown top-level key →
 * `invalid_field` naming the key; an unknown `draft` sub-key →
 * `invalid_field` naming `draft.<key>`; wrong value types → `invalid_body`;
 * `source` accepts only `"user"|"cron"` (anything else names the field).
 * `null` is valid everywhere (it is the clear operator, not a type error).
 */
export function validateSessionMetaPatch(
	body: unknown,
): SessionMetaPatch | SessionMetaPatchError {
	if (
		body === undefined ||
		body === null ||
		typeof body !== "object" ||
		Array.isArray(body)
	) {
		return { error: "invalid_body" };
	}
	const record = body as Record<string, unknown>;
	// A patch that changes nothing is a client error, not a no-op (the
	// configure endpoint's rule — fail loud).
	if (Object.keys(record).length === 0) {
		return { error: "invalid_body" };
	}
	const patch: {
		pinned?: boolean | null;
		tagged?: readonly string[] | null;
		archived?: boolean | null;
		draft?: {
			text?: string | null;
			attachments?: readonly string[] | null;
		} | null;
		source?: "user" | "cron" | null;
		owner?: string | null;
	} = {};
	for (const key of Object.keys(record)) {
		const value = record[key];
		switch (key) {
			case "pinned":
			case "archived": {
				if (value !== null && typeof value !== "boolean") {
					return { error: "invalid_body" };
				}
				if (key === "pinned") patch.pinned = value;
				else patch.archived = value;
				break;
			}
			case "tagged": {
				if (value === null) {
					patch.tagged = null;
					break;
				}
				if (
					!Array.isArray(value) ||
					value.some((tag) => typeof tag !== "string")
				) {
					return { error: "invalid_body" };
				}
				patch.tagged = value;
				break;
			}
			case "draft": {
				if (value === null) {
					patch.draft = null;
					break;
				}
				if (typeof value !== "object" || Array.isArray(value)) {
					return { error: "invalid_body" };
				}
				const sub: {
					text?: string | null;
					attachments?: readonly string[] | null;
				} = {};
				for (const subKey of Object.keys(value as Record<string, unknown>)) {
					const subValue = (value as Record<string, unknown>)[subKey];
					switch (subKey) {
						case "text":
							if (subValue !== null && typeof subValue !== "string") {
								return { error: "invalid_body" };
							}
							sub.text = subValue;
							break;
						case "attachments":
							if (
								subValue !== null &&
								(!Array.isArray(subValue) ||
									subValue.some((path) => typeof path !== "string"))
							) {
								return { error: "invalid_body" };
							}
							sub.attachments = subValue;
							break;
						default:
							return { error: "invalid_field", field: `draft.${subKey}` };
					}
				}
				// An empty draft sub-object changes nothing — the same client-error
				// rule the top-level empty body gets (fail-loud consistency).
				if (Object.keys(sub).length === 0) {
					return { error: "invalid_body" };
				}
				patch.draft = sub;
				break;
			}
			case "source": {
				if (value === null) {
					patch.source = null;
				} else if (value === "user" || value === "cron") {
					patch.source = value;
				} else {
					// A known key with a value outside its enum names the field
					// (the configure endpoint's rule for a bad `thinking` level).
					return { error: "invalid_field", field: "source" };
				}
				break;
			}
			case "owner": {
				if (value !== null && typeof value !== "string") {
					return { error: "invalid_body" };
				}
				patch.owner = value;
				break;
			}
			default:
				return { error: "invalid_field", field: key };
		}
	}
	return patch;
}

/**
 * Apply a validated patch to a session-meta draft (the merge/clear table):
 *
 * - `null` resets the field to its `DEFAULT_SESSION_META` value;
 *   `owner: null` removes the key entirely.
 * - non-null values shallow-set; `tagged` replaces wholesale.
 * - `draft: null` resets the whole draft; a draft object sub-merges: a
 *   sub-key present sets (or `null`-clears) that sub-field, absent sub-keys
 *   keep the stored value.
 *
 * Array/object values are copied on assignment: the tracker requires
 * alias-free roots, and the wire body must never become tracked state.
 */
export function applySessionMetaPatch(
	draft: Draft<SessionMeta>,
	patch: SessionMetaPatch,
): void {
	if (patch.pinned !== undefined) draft.pinned = patch.pinned ?? false;
	if (patch.archived !== undefined) draft.archived = patch.archived ?? false;
	if (patch.tagged !== undefined) {
		draft.tagged = patch.tagged === null ? [] : [...patch.tagged];
	}
	if (patch.source !== undefined) draft.source = patch.source ?? "user";
	if (patch.owner !== undefined) {
		if (patch.owner === null) delete draft.owner;
		else draft.owner = patch.owner;
	}
	if (patch.draft !== undefined) {
		if (patch.draft === null) {
			draft.draft = { text: "", attachments: [] };
		} else {
			if (patch.draft.text !== undefined) {
				draft.draft.text = patch.draft.text ?? "";
			}
			if (patch.draft.attachments !== undefined) {
				draft.draft.attachments =
					patch.draft.attachments === null ? [] : [...patch.draft.attachments];
			}
		}
	}
}
