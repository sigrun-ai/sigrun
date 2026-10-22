/**
 * Shared conversation operations (core hardening W5 Task 5, spec §9.5):
 * the ONE implementation of create/submit/list/read-meta that BOTH the
 * HTTP routes (src/server/routes/conversations.ts,
 * routes/submissions.ts) and the extension host bridge
 * (src/server/host-bridge.ts) run — extracted from the route bodies so
 * an extension driving a conversation in-process gets identical
 * behavior by construction: content-part resolution, the served-model
 * check, activity stamping, and the durable listing are never
 * re-implemented.
 *
 * Each op is a pure `(ctx, …) → result` function over the shared
 * `ServerContext`. Client-error vocabulary: a validation failure throws
 * {@link ConversationOpError} (the routes' 400 bodies); the submit
 * path's `UnservedModelError` propagates for the route (and the bridge
 * caller) to map — the same split the inline route bodies had.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	Conversation,
	ConversationId,
	Cursor,
	InputSubmissionDraft,
	Submission,
	SubmissionRecord,
} from "@earendil-works/pi-durable";
import {
	accessOf,
	isSharing,
	type AccessPrincipal,
	type Sharing,
} from "@sigrun/shared/access";
import { touchActivity } from "../harness/activity.js";
import { UnservedModelError } from "../harness/providers/index.js";
import { resolveServedModelRefreshing } from "../harness/providers/refresh.js";
import { parseSubmissionInput, resolveParts } from "./content-parts.js";
import {
	CommandUsageError,
	expandInput,
	EXPANDED_ENTRY_KIND,
	type ExpansionResult,
} from "../commands/expand.js";
import type { ServerContext } from "./context.js";
import {
	conversationEnv,
	readView,
	SCAN_PAGE_SIZE,
	storeAgentChange,
	WHEN_BUSY_MODES,
	type WhenBusyMode,
} from "./helpers.js";
import {
	DEFAULT_SESSION_META,
	SessionMetaDoc,
	type SessionMeta,
} from "./session-meta.js";
import type {
	ConversationCreateResponse,
	ConversationSummary,
} from "./views.js";

/**
 * One client error from a conversation op: the exact 400 body the routes
 * serve (`{error: "invalid_input"}`, `{error: "invalid_field", field}`),
 * so the HTTP route maps it verbatim and the bridge caller sees the
 * same fail-loud vocabulary.
 */
export class ConversationOpError extends Error {
	constructor(
		readonly body: { readonly error: string; readonly field?: string },
	) {
		super(body.error);
		this.name = "ConversationOpError";
	}
}

/** The §7.1 ceiling for `?waitMs` — a positive integer at most this. */
const WAIT_MS_MAX = 60_000;

/**
 * Race `submission.wait` against a `waitMs` timer (§7.1): the wait winning
 * returns the settled record; the timer winning returns whichever record is
 * CURRENT (mid-run). The losing wait's eventual rejection is never left
 * unhandled.
 */
async function waitForSubmission(
	submission: Submission,
	waitMs: number,
): Promise<SubmissionRecord> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<true>((resolve) => {
			timer = setTimeout(() => resolve(true), waitMs);
		});
		const wait = submission.wait(BACKGROUND_CONTEXT);
		const winner = await Promise.race([wait, timeout]);
		if (winner !== true) {
			return winner;
		}
		// The timer won: hand back the CURRENT record; a late rejection of
		// the abandoned wait must not surface as unhandled.
		void wait.catch(() => undefined);
		return await submission.status(BACKGROUND_CONTEXT);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** What a create stamps onto the fresh conversation's session-meta doc. */
export interface CreateConversationInput {
	/** The owner stamp (spec §5.9): the identity that acts on the session. */
	readonly owner?: string;
	/** The §5.9 sharing state the session starts with (validated). */
	readonly sharing?: Sharing;
	/** The user-facing name (a create-time `name`). */
	readonly name?: string;
	/**
	 * Who created the session (spec §9.5): `"user"` for HTTP creates; the
	 * host bridge defaults it to the calling extension's slug.
	 */
	readonly source?: string;
}

/**
 * Create one conversation the server-create way: ownerless ownership, the
 * boot default model plus the store's agent settings (re-read per create),
 * then — when ANY stamp field is present — ONE commit writing them onto
 * the session-meta doc. Returns the create-response shape `{id, view}`.
 */
export async function createConversationOp(
	ctx: ServerContext,
	input: CreateConversationInput = {},
): Promise<ConversationCreateResponse> {
	const { opened } = ctx;
	// Validate FIRST — a rejected input never touches storage.
	if (input.owner !== undefined && typeof input.owner !== "string") {
		throw new ConversationOpError({ error: "invalid_field", field: "owner" });
	}
	if (input.sharing !== undefined && !isSharing(input.sharing)) {
		throw new ConversationOpError({ error: "invalid_field", field: "sharing" });
	}
	if (input.name !== undefined && typeof input.name !== "string") {
		throw new ConversationOpError({ error: "invalid_field", field: "name" });
	}
	if (input.source !== undefined && typeof input.source !== "string") {
		throw new ConversationOpError({ error: "invalid_field", field: "source" });
	}
	const conversation = await opened.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			// A conversation with no agent model cannot generate (no_model):
			// server-created conversations start on the boot default model,
			// like the root conversation, and carry the store's
			// defaultTools/perModelThinking — re-read per create, so PATCHes
			// reach new conversations without a restart.
			agent: storeAgentChange(opened, opened.defaultModel),
		},
		BACKGROUND_CONTEXT,
	);
	// Creation IS activity: stamp lastActivityAt now, or the sidebar's
	// recency sort puts a never-submitted conversation at the BOTTOM of
	// "Earlier" (epoch(undefined) = 0) until its first submission lands —
	// a new conversation must appear at the top from the moment it exists.
	// The optional input stamps ride the SAME commit (one write, not two).
	await conversation.commit(async (tx) => {
		const draft = await tx.doc(SessionMetaDoc, conversation.id);
		draft.lastActivityAt = opened.now().toISOString();
		if (input.owner !== undefined) draft.owner = input.owner;
		// Copy-on-assignment (the tracker requires alias-free roots):
		// the people-scope array is cloned; the closed scopes spread.
		if (input.sharing !== undefined) {
			draft.sharing =
				input.sharing.scope === "people"
					? {
							scope: "people",
							users: [...input.sharing.users],
							level: input.sharing.level,
						}
					: { ...input.sharing };
		}
		if (input.name !== undefined) draft.name = input.name;
		if (input.source !== undefined) draft.source = input.source;
	}, BACKGROUND_CONTEXT);
	const view = await readView(conversation);
	return { id: conversation.id, view };
}

/** The submit op's options (validated inside, in the route's order). */
export interface SubmitOpOptions {
	readonly requestId?: string;
	/** The raw `whenBusy` value (validated against pi-durable's union). */
	readonly whenBusy?: unknown;
	/** The raw `?waitMs` value (validated against the §7.1 ceiling). */
	readonly waitMs?: unknown;
}

/**
 * Submit one input the route way: content-part resolution against the
 * conversation's live workspace env, the §2/§3 served-model check
 * (refresh-on-miss, `UnservedModelError` propagates to the caller),
 * `whenBusy`/`waitMs` validation, admission, the activity stamp, and the
 * §7.1 record — at admission when no `waitMs` is given, else the bounded
 * settlement race.
 */
export async function submitOp(
	ctx: ServerContext,
	conversation: Conversation,
	input: unknown,
	opts: SubmitOpOptions = {},
): Promise<SubmissionRecord> {
	const { opened } = ctx;
	const parsed = parseSubmissionInput(input);
	if (!parsed.ok) {
		throw new ConversationOpError({ error: "invalid_input" });
	}
	// Spec §2/§3 binding contract: a conversation pinned to an unserved
	// model fails explicitly AT SUBMIT — 4xx with the available ids —
	// never a silent fallback, and never a settled no_model run surfaced
	// only later. Resolution goes through the refresh-on-miss wrapper:
	// ONE bounded refresh of the named provider + re-resolve on the miss,
	// so a model gained upstream since the last interval tick is
	// immediately usable; still absent → the UnservedModelError carrying
	// the catalog (the route maps it to 400 unserved_model).
	const agent = await conversation.agent(BACKGROUND_CONTEXT);
	if (agent.model !== undefined) {
		await resolveServedModelRefreshing(opened.models, agent.model);
	}
	// `waitMs` (§7.1) is the opt-in bounded settlement wait for scripts —
	// a positive integer ≤ 60 000; anything else is a fail-loud client
	// error BEFORE anything is admitted.
	let waitMs: number | undefined;
	if (opts.waitMs !== undefined) {
		const parsedWait =
			typeof opts.waitMs === "number" ? opts.waitMs : Number(opts.waitMs);
		if (
			!Number.isInteger(parsedWait) ||
			parsedWait <= 0 ||
			parsedWait > WAIT_MS_MAX
		) {
			throw new ConversationOpError({ error: "invalid_field", field: "waitMs" });
		}
		waitMs = parsedWait;
	}
	// `whenBusy` is the steer affordance (spec §7 item 3) — validate it
	// against pi-durable's union and pass it through; unknown values are a
	// client error, never a silent default.
	const whenBusy = opts.whenBusy;
	if (
		whenBusy !== undefined &&
		(typeof whenBusy !== "string" || !WHEN_BUSY_MODES.includes(whenBusy))
	) {
		throw new ConversationOpError({ error: "invalid_field", field: "whenBusy" });
	}
	// Resolve path-parts to inline content NOW, against the live
	// workspace: missing paths become explicit error parts; other
	// workspace failures throw — fail-loud. Command expansion (Task 2c)
	// runs BEFORE this: a text part starting with `/` that names a skill
	// or prompt template is rewritten into the text the model sees, and
	// the submission's entry carries what the user TYPED (the transcript's
	// `sigrun.user.expanded` entry). Non-`/` inputs, `/command` inputs,
	// and unknown skills pass through untouched — every channel and the
	// HTTP API behave identically because this is the one admission path.
	// A MALFORMED command line (an unterminated quote in template args) is
	// ordinary user input: it maps to the same `invalid_input` 400 shape
	// `parseSubmissionInput` uses, never a 500. Anything else expansion
	// throws is a genuine bug and still falls through as one.
	const env = await conversationEnv(opened, conversation);
	let expansion: ExpansionResult;
	try {
		expansion = await expandInput(
			parsed.parts,
			opened.commandExpansion,
			env,
			BACKGROUND_CONTEXT,
		);
	} catch (error) {
		if (error instanceof CommandUsageError) {
			throw new ConversationOpError({ error: "invalid_input" });
		}
		throw error;
	}
	const content = await resolveParts(expansion.parts, env, BACKGROUND_CONTEXT);
	const draft: InputSubmissionDraft = {
		type: "input",
		content,
		...(opts.requestId === undefined ? {} : { requestId: opts.requestId }),
		...(whenBusy === undefined ? {} : { whenBusy: whenBusy as WhenBusyMode }),
		...(expansion.typed === undefined
			? {}
			: {
					entry: {
						kind: EXPANDED_ENTRY_KIND,
						data: {
							typed: expansion.typed,
							...(expansion.command === undefined
								? {}
								: { command: expansion.command }),
						},
					},
				}),
	};
	// The submit pass-through is retired (§6.7): the memory seam's
	// runSettled owns capture, so submissions admit directly.
	const submission = await conversation.submit(draft, BACKGROUND_CONTEXT);
	// Admission stamps activity: the sidebar's activity sort must move the
	// moment a prompt lands — before the run settles.
	await touchActivity(
		opened.harness,
		conversation.id,
		opened.now,
		BACKGROUND_CONTEXT,
	);
	// §7.1: the record AT ADMISSION (queued or placed), or — with a
	// validated `waitMs` — the bounded settlement race.
	return waitMs === undefined
		? await submission.status(BACKGROUND_CONTEXT)
		: await waitForSubmission(submission, waitMs);
}

/** The list filters (the HTTP query shape + the bridge's `owner`). */
export interface ListConversationsFilters {
	/** `mine=true`: only rows whose owner is the CALLER. */
	readonly mine?: boolean;
	/** Only rows owned by this user (the bridge's filter). */
	readonly owner?: string;
	/** `archived=true|false` (absent = all). */
	readonly archivedOnly?: boolean;
}

/**
 * List conversations the durable way: the storage scan is authoritative
 * (conversations this process never created all list), the listing is
 * PER-CALLER (`accessOf` against each row's session-meta snapshot — hidden
 * is absent, §5.9), and every row is lean by construction (scan record +
 * meta snapshot alone, no per-row view read). The caller is the resolved
 * principal; the host bridge passes its own trusted view (see
 * host-bridge.ts).
 */
export async function listConversationsOp(
	ctx: ServerContext,
	caller: AccessPrincipal,
	filters: ListConversationsFilters = {},
): Promise<ConversationSummary[]> {
	const { opened, rootId } = ctx;
	const conversations: ConversationSummary[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await opened.storage.scanConversations(
			{ order: "ascending" },
			SCAN_PAGE_SIZE,
			cursor,
			BACKGROUND_CONTEXT,
		);
		for (const record of page.items) {
			// The session-meta owner rides the summary when stamped (defaults
			// serve nothing — no owner key when unset), and so do the sidebar
			// fields: the display name, the activity stamp, the archive/pin
			// flags, and the create source (spec §9.5).
			const meta = await opened.harness.snapshot(
				SessionMetaDoc,
				record.id,
				BACKGROUND_CONTEXT,
			);
			const access = accessOf(caller, meta ?? {});
			// Hidden is absent from the list (spec §5.9).
			if (access === "none") continue;
			// The archived filter (absent = all).
			if (
				filters.archivedOnly !== undefined &&
				(meta?.archived ?? false) !== filters.archivedOnly
			) {
				continue;
			}
			// `mine`: the caller's own rows (owner === caller.user).
			if (filters.mine === true && meta?.owner !== caller.user) continue;
			// The owner filter (the bridge's shape — any named owner).
			if (filters.owner !== undefined && meta?.owner !== filters.owner) {
				continue;
			}
			const name = meta?.name ?? meta?.autoName;
			conversations.push({
				id: record.id,
				root: record.id === rootId,
				access,
				...(meta?.sharing === undefined ? {} : { sharing: meta.sharing }),
				...(meta?.owner === undefined ? {} : { owner: meta.owner }),
				...(name === undefined ? {} : { name }),
				...(meta?.source === undefined ? {} : { source: meta.source }),
				...(meta?.lastActivityAt === undefined
					? {}
					: { lastActivityAt: meta.lastActivityAt }),
				// Fork lineage from the durable record (the scan page item);
				// a root or plainly created conversation has none.
				...(record.parent === undefined
					? {}
					: {
							parent: {
								id: record.parent.conversationId,
								at: record.parent.at,
							},
						}),
				archived: meta?.archived ?? false,
				pinned: meta?.pinned ?? false,
			});
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return conversations;
}

/**
 * Read one conversation's session meta: the committed snapshot, or the
 * defaults when the doc was never written. A read NEVER materializes the
 * doc (defaults are free; a write-per-read would churn a doc revision on
 * every sidebar poll).
 */
export async function readMetaOp(
	opened: ServerContext["opened"],
	id: ConversationId,
): Promise<SessionMeta> {
	return (
		(await opened.harness.snapshot(SessionMetaDoc, id, BACKGROUND_CONTEXT)) ??
		DEFAULT_SESSION_META
	);
}
