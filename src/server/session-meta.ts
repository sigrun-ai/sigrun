/**
 * The session-meta document (spec §5): conversation-scoped sidebar state.
 *
 * SPLIT (build-and-webui Task 1): the WIRE types (`SessionMeta`,
 * `SessionMetaPatch`, `SessionMetaPatchError`) live in the
 * `@sigrun/shared` package (`shared/src/session-meta.ts` — the canonical
 * declarations both clients import); this module owns the document and
 * patch RUNTIME and re-exports the types for server-side importers.
 *
 * One latest-only singleton doc per conversation (kind
 * `"sigrun.session-meta"`): pin/tag/archive flags, the composer draft
 * (survives reloads — `draft.attachments` are workspace-relative paths from
 * the uploads endpoint), the session source, the user-facing session name
 * (T5d), and the multi-user `owner` seam (spec §5: "exists in schema from
 * day 1; the flow does not" — written by the auth hook at create/fork/
 * import and read by the listing route; still no interactive flow in v1).
 *
 * Docs are standalone tokens: `defineDoc` needs no registry install (a
 * gated extension's policy doc is the reference pattern). Reads serve `DEFAULT_SESSION_META` when the doc was
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
 *
 * Server-owned fields (`autoName`, `autoNameAttempts`,
 * `lastActivityAt`, `jobId`, `deliver`) are written by host code only
 * (activity.ts, the A2 auto-namer, fire.ts's job stamp); they are NOT
 * patch surface — the strict validator keeps rejecting them as
 * `invalid_field`.
 */

import type { Draft } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";
import { isSharing, type Sharing } from "@sigrun/shared/access";
import type {
	SessionMeta,
	SessionMetaPatch,
	SessionMetaPatchError,
} from "@sigrun/shared/session-meta";

export type {
	SessionMeta,
	SessionMetaPatch,
	SessionMetaPatchError,
} from "@sigrun/shared/session-meta";

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
	checkpointWhen: () => false,
	history: "latest",
	fork: "current",
	// Defensive copy (the alias-free-ownership pattern): the tracker takes
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

/**
 * Validate a PATCH body strictly (mirroring the configure endpoint):
 * non-object/array/empty → `invalid_body`; an unknown top-level key →
 * `invalid_field` naming the key; an unknown `draft` sub-key →
 * `invalid_field` naming `draft.<key>`; wrong value types → `invalid_body`.
 * `null` is valid everywhere (it is the clear operator, not a type error).
 *
 * Server-only keys (spec §5.9): a patch carrying `owner` or `source` is a
 * 400 `invalid_field` EVEN when the value would once have been valid —
 * `owner` moves via the auth hook alone, and `source` is server-owned.
 * `sharing` is validated via `isSharing` (a malformed shape names the
 * field).
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
		name?: string | null;
		sharing?: Sharing | null;
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
			case "source":
			case "owner":
			case "jobId":
			case "deliver": {
				// Server-only (spec §5.9 + gateway C7): the KEY itself is the
				// client error, whatever the value — even a `null` clear. The
				// job stamp fields move with the fire (fire.ts's creating
				// commit) and the delivery targets ride the job spec, never a
				// meta patch.
				return { error: "invalid_field", field: key };
			}
			case "sharing": {
				if (value === null) {
					patch.sharing = null;
					break;
				}
				if (!isSharing(value)) {
					return { error: "invalid_field", field: "sharing" };
				}
				patch.sharing = value;
				break;
			}
			case "name": {
				if (value !== null && typeof value !== "string") {
					return { error: "invalid_body" };
				}
				patch.name = value;
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
 *   `name: null` and `sharing: null` remove the key entirely.
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
	// `sharing` clears the same way as `name`: absent = private, and it is
	// not in DEFAULT_SESSION_META, so the clear target is key removal.
	if (patch.sharing !== undefined) {
		if (patch.sharing === null) delete draft.sharing;
		else if (patch.sharing.scope === "people") {
			draft.sharing = {
				scope: "people",
				users: [...patch.sharing.users],
				...(patch.sharing.groups === undefined
					? {}
					: { groups: [...patch.sharing.groups] }),
				level: patch.sharing.level,
			};
		} else if (patch.sharing.scope === "household") {
			draft.sharing = { scope: "household", level: patch.sharing.level };
		} else {
			draft.sharing = { scope: "private" };
		}
	}
	// `name` clears the same way: absent = unnamed.
	if (patch.name !== undefined) {
		if (patch.name === null) delete draft.name;
		else draft.name = patch.name;
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
