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
import { configure } from "@earendil-works/pi-durable";
import type {
	Conversation,
	ConversationId,
	Cursor,
	EntryId,
	Extension,
	InputSubmissionDraft,
	ModelRef,
	Submission,
	SubmissionRecord,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	accessOf,
	isSharing,
	type AccessPrincipal,
	type Sharing,
} from "@sigrun/shared/access";
import { extname } from "node:path";
import { touchActivity } from "../harness/activity.js";
import { UnservedModelError } from "../harness/providers/index.js";
import { resolveServedModelRefreshing } from "../harness/providers/refresh.js";
import { isSuperuser, type Principal } from "./auth/principal.js";
import { isConfinedPath, parseSubmissionInput, resolveParts } from "./content-parts.js";
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
	THINKING_LEVELS,
	WHEN_BUSY_MODES,
	type WhenBusyMode,
} from "./helpers.js";
import {
	applySessionMetaPatch,
	DEFAULT_SESSION_META,
	SessionMetaDoc,
	validateSessionMetaPatch,
	type SessionMeta,
} from "./session-meta.js";
import type {
	AbortResponse,
	CompactResponse,
	ConfigureResponse,
	ConversationCreateResponse,
	ConversationSummary,
} from "./views.js";

/**
 * One client error from a conversation op: the exact body the routes
 * serve (`{error: "invalid_input"}`, `{error: "invalid_field", field}`)
 * plus the HTTP status it maps to — 400 for the validation vocabulary,
 * 404 for `no_active_submission`, 403 for the sharing gate — so one
 * route-side mapping (`reply.code(err.status).send(err.body)`) covers
 * every op error, and the bridge caller sees the same fail-loud
 * vocabulary.
 */
export class ConversationOpError extends Error {
	readonly status: number;

	constructor(
		readonly body: { readonly error: string; readonly field?: string },
		status = 400,
	) {
		super(body.error);
		this.name = "ConversationOpError";
		this.status = status;
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
	/**
	 * The conversation's pinned agent selection (gateway C4): names
	 * resolved against the registry snapshot — `extensions` maps onto
	 * `AgentChange.extensions`, `tools` onto `AgentChange.tools` (the
	 * ENABLED-tool filter; the store's `modelTools` narrowing from
	 * storeAgentChange still applies alongside). An unknown name is a
	 * fail-loud `invalid_field` (`agent.extensions` / `agent.tools`).
	 */
	readonly agent?: {
		readonly extensions?: readonly string[];
		readonly tools?: readonly string[];
	};
}

/**
 * Validate + resolve the `agent` selection (gateway C4): shape first
 * (an object whose members are string arrays — non-object →
 * `invalid_field` `agent`, a non-array member or non-string entry →
 * `invalid_field` naming `agent.<member>`), then names against the
 * registry snapshot (`extension(name)` for extensions; `tools()`
 * entries' `tool` for tools — `AgentChange.tools` takes
 * ToolRegistration OBJECTS, not names). An unknown name throws
 * `invalid_field` naming `agent.<member>`.
 */
function resolveAgentSelection(
	ctx: ServerContext,
	agent: NonNullable<CreateConversationInput["agent"]>,
): { extensions?: readonly Extension[]; tools?: readonly ToolRegistration[] } {
	const snapshot = ctx.opened.registry.snapshot();
	const resolved: {
		extensions?: readonly Extension[];
		tools?: readonly ToolRegistration[];
	} = {};
	if (agent.extensions !== undefined) {
		const extensions: Extension[] = [];
		for (const name of agent.extensions) {
			const extension = snapshot.extension(name);
			if (extension === undefined) {
				throw new ConversationOpError({
					error: "invalid_field",
					field: "agent.extensions",
				});
			}
			extensions.push(extension);
		}
		resolved.extensions = extensions;
	}
	if (agent.tools !== undefined) {
		// Tools may repeat across extensions (RegistrySnapshot.tools); a
		// name selects the FIRST registered tool with that name — the same
		// resolution `resolveAgent`'s composed map applies.
		const byName = new Map<string, ToolRegistration>();
		for (const entry of snapshot.tools()) {
			if (!byName.has(entry.tool.name)) byName.set(entry.tool.name, entry.tool);
		}
		const tools: ToolRegistration[] = [];
		for (const name of agent.tools) {
			const tool = byName.get(name);
			if (tool === undefined) {
				throw new ConversationOpError({
					error: "invalid_field",
					field: "agent.tools",
				});
			}
			tools.push(tool);
		}
		resolved.tools = tools;
	}
	return resolved;
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
	// The agent selection (gateway C4): shape fail-loud first, then name
	// resolution against the registry snapshot (unknown names throw).
	if (input.agent !== undefined) {
		if (
			typeof input.agent !== "object" ||
			input.agent === null ||
			Array.isArray(input.agent)
		) {
			throw new ConversationOpError({ error: "invalid_field", field: "agent" });
		}
		for (const member of ["extensions", "tools"] as const) {
			const value = input.agent[member];
			if (value === undefined) continue;
			if (
				!Array.isArray(value) ||
				value.some((name) => typeof name !== "string")
			) {
				throw new ConversationOpError({
					error: "invalid_field",
					field: `agent.${member}`,
				});
			}
		}
	}
	const selection =
		input.agent === undefined
			? undefined
			: resolveAgentSelection(ctx, input.agent);
	const conversation = await opened.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			// A conversation with no agent model cannot generate (no_model):
			// server-created conversations start on the boot default model,
			// like the root conversation, and carry the store's
			// defaultTools/perModelThinking — re-read per create, so PATCHes
			// reach new conversations without a restart. The C4 `agent`
			// selection rides alongside: `extensions`/`tools` pin the stored
			// filters by name while the store's `modelTools` narrowing still
			// applies (both come from storeAgentChange + the spread).
			agent: {
				...storeAgentChange(opened, opened.defaultModel),
				...(selection?.extensions === undefined
					? {}
					: { extensions: selection.extensions }),
				...(selection?.tools === undefined ? {} : { tools: selection.tools }),
			},
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
		// the people-scope arrays are cloned; the closed scopes spread.
		if (input.sharing !== undefined) {
			draft.sharing =
				input.sharing.scope === "people"
					? {
							scope: "people",
							users: [...input.sharing.users],
							...(input.sharing.groups === undefined
								? {}
								: { groups: [...input.sharing.groups] }),
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

/**
 * Configure one conversation's model and/or thinking level (the
 * configure route's body, verbatim): EXACTLY `model` + `thinking` — any
 * other key is `invalid_field`; a body changing neither is
 * `invalid_body`; `model` is `"provider/modelId"` split on the FIRST
 * `/` (a modelId may itself contain slashes) with both parts non-empty;
 * `thinking` must be a pi-ai level. A model change re-applies the
 * store's `perModelThinking` override for the NEW model unless the
 * request pins `thinking` (the store is the deployment default, the
 * explicit field the caller's win — re-read here so a PATCH reaches
 * later configures). Returns the configured surface projection
 * (`{model?, thinkingLevel}`).
 */
export async function configureOp(
	ctx: ServerContext,
	conversation: Conversation,
	body: { readonly model?: unknown; readonly thinking?: unknown },
): Promise<ConfigureResponse> {
	const { opened } = ctx;
	if (
		body === undefined ||
		body === null ||
		typeof body !== "object" ||
		Array.isArray(body)
	) {
		throw new ConversationOpError({ error: "invalid_body" });
	}
	const record = body as Record<string, unknown>;
	const unknownKey = Object.keys(record).find(
		(key) => key !== "model" && key !== "thinking",
	);
	if (unknownKey !== undefined) {
		throw new ConversationOpError({
			error: "invalid_field",
			field: unknownKey,
		});
	}
	const model = record.model;
	const thinking = record.thinking;
	if (model === undefined && thinking === undefined) {
		// A configure that changes nothing is a client error, not a no-op.
		throw new ConversationOpError({ error: "invalid_body" });
	}
	let parsedModel: ModelRef | undefined;
	if (model !== undefined) {
		if (typeof model !== "string" || !model.includes("/")) {
			throw new ConversationOpError({ error: "invalid_field", field: "model" });
		}
		const slash = model.indexOf("/");
		const provider = model.slice(0, slash);
		const modelId = model.slice(slash + 1);
		if (provider.length === 0 || modelId.length === 0) {
			throw new ConversationOpError({ error: "invalid_field", field: "model" });
		}
		parsedModel = { provider, modelId };
	}
	if (
		thinking !== undefined &&
		(typeof thinking !== "string" || !THINKING_LEVELS.includes(thinking))
	) {
		throw new ConversationOpError({ error: "invalid_field", field: "thinking" });
	}
	// perModelThinking: a model change re-applies the store's override for
	// the NEW model unless the request pins `thinking` — the map is the
	// deployment default, the explicit field the caller's win.
	const storeThinking = storeThinkingFor(opened, parsedModel);
	await conversation.configure(
		{
			...(parsedModel === undefined ? {} : { model: parsedModel }),
			...(thinking !== undefined
				? { thinkingLevel: thinking as ModelThinkingLevel }
				: storeThinking === undefined
					? {}
					: { thinkingLevel: storeThinking as ModelThinkingLevel }),
		},
		BACKGROUND_CONTEXT,
	);
	// Read the agent back and project the configured surface only —
	// resolved extensions/tools/sections stay server-side.
	const agent = await conversation.agent(BACKGROUND_CONTEXT);
	return {
		...(agent.model === undefined ? {} : { model: agent.model }),
		thinkingLevel: agent.thinkingLevel,
	};
}

/** The store's per-model thinking override for `model` (re-read per call). */
function storeThinkingFor(
	opened: ServerContext["opened"],
	model: ModelRef | undefined,
): string | undefined {
	if (model === undefined) return undefined;
	return opened.settings.read().perModelThinking?.[
		`${model.provider}/${model.modelId}`
	];
}

/**
 * Withdraw/settle the conversation's active submission (the abort
 * route's body, verbatim): `inspect()` is the read-only union of placed
 * run inputs and queued inbox items (all conversations); filtered to
 * this conversation, the LOWEST id is the active one — anything queued
 * behind a busy conversation was admitted later and has a higher id.
 * Nothing active is the 404 `no_active_submission`; a `not_found` abort
 * result (the record vanished between inspect and abort) is the same
 * honest answer. `already_placed`/`settled` still report which state
 * the submission was found in (abort is idempotent).
 */
export async function abortOp(
	ctx: ServerContext,
	conversation: Conversation,
): Promise<AbortResponse> {
	const { opened } = ctx;
	const inspection = await opened.harness.inspect(BACKGROUND_CONTEXT);
	// Lowest live id = oldest admitted = the placed run input over later-
	// queued inbox items. reduce() with a first-element seed is ordering-
	// independent (a future pi-durable inspect() ordering change cannot
	// silently target the wrong submission); empty → undefined.
	const active = inspection.submissions
		.filter((s) => s.conversationId === conversation.id)
		.reduce<(typeof inspection.submissions)[number] | undefined>(
			(min, s) => (min === undefined || s.id < min.id ? s : min),
			undefined,
		);
	if (active === undefined) {
		throw new ConversationOpError({ error: "no_active_submission" }, 404);
	}
	const result = await opened.harness.abortSubmission(
		active.id,
		BACKGROUND_CONTEXT,
		conversation.id,
	);
	// `not_found` means the submission's record vanished between `inspect`
	// and `abort` — the conversation is no longer busy, so the honest answer
	// is the same as nothing-active.
	if (result === "not_found") {
		throw new ConversationOpError({ error: "no_active_submission" }, 404);
	}
	return { result, submissionId: active.id };
}

/**
 * Admit one manual compaction (the compact route's op): `instructions`
 * is validated here — a non-string is `invalid_field`, an empty string
 * reads as none (the route's normalization) — and `Conversation.compact`
 * creates the conversation-owned durable task with `reason: "manual"`:
 * it compacts even when idle and places its summary through a write
 * submission. Manual compaction ignores the policy's `enabled`; the
 * task id is handed back (the SSE stream carries the `pi.compaction`
 * entry when the summary lands). Returns the admit shape `{taskId}`;
 * the caller owns the 202.
 */
export async function compactOp(
	ctx: ServerContext,
	conversation: Conversation,
	instructions?: unknown,
): Promise<CompactResponse> {
	// The route's instructions validation, moved in: the HTTP caller's
	// raw value and the host's typed value take the SAME check (host
	// inputs are typed, but the op still validates).
	if (instructions !== undefined && typeof instructions !== "string") {
		throw new ConversationOpError({
			error: "invalid_field",
			field: "instructions",
		});
	}
	const normalized = instructions === "" ? undefined : instructions;
	const taskId = await conversation.compact(
		normalized,
		BACKGROUND_CONTEXT,
	);
	return { taskId };
}

/** The fork op's options (the `at`/`owner` the route body carries). */
export interface ForkOpOptions {
	/** The LAST entry id the fork keeps (validated against the parent). */
	readonly at?: unknown;
	/**
	 * The fork's owner stamp (the route passes the principal's user; the
	 * host passes its own). `undefined` REMOVES the owner key (the
	 * header-less caller's behavior).
	 */
	readonly owner?: string;
}

/**
 * Fork one conversation's history at a visible entry (the fork route's
 * body, verbatim): absent `at` defaults to the newest entry (400
 * `empty_conversation` when the parent has no history at all); an
 * explicit `at` must be an id the parent actually had (400
 * `invalid_field` — never a silent empty fork). The fork inherits the
 * parent's agent model (falling back to the boot default like create),
 * and ONE commit resets the copied meta: name/autoName/attempts/sharing
 * dropped, the owner re-stamped from `opts.owner` (undefined = the key
 * removed), the autoName seeded `"<source> (fork)"` when the source had
 * a display name, and activity stamped so the fork sorts where it
 * happened. Returns the create shape `{id, view}`.
 */
export async function forkOp(
	ctx: ServerContext,
	conversation: Conversation,
	opts: ForkOpOptions = {},
): Promise<ConversationCreateResponse> {
	const { opened } = ctx;
	// The route's `at` type check, verbatim: absent body = newest entry;
	// a present `at` must be a number (the host's typed EntryId passes).
	if (opts.at !== undefined && typeof opts.at !== "number") {
		throw new ConversationOpError({ error: "invalid_field", field: "at" });
	}
	let at: number | undefined = opts.at;
	if (at === undefined) {
		// The entries query is newest-first: the first item of the first
		// page is the newest entry. An empty page means there is nothing
		// to fork — the parent conversation has no history at all.
		const page = await conversation.entries(
			{},
			1,
			undefined,
			BACKGROUND_CONTEXT,
		);
		if (page.items.length === 0) {
			throw new ConversationOpError({ error: "empty_conversation" });
		}
		at = page.items[0].id;
	} else {
		// Validate `at` against the parent's own history: `fork()` accepts
		// any EntryId, but an id this conversation never had is a client
		// error, not a silent empty fork.
		const page = await conversation.entries(
			{ maxEntryId: at as EntryId },
			1,
			undefined,
			BACKGROUND_CONTEXT,
		);
		const newest = page.items[0];
		if (newest === undefined || newest.id !== at) {
			throw new ConversationOpError({ error: "invalid_field", field: "at" });
		}
	}
	// The fork inherits the parent's agent model — read the resolved
	// agent, fall back to the boot default like create.
	const agent = await conversation.agent(BACKGROUND_CONTEXT);
	const fork = await conversation.fork(
		at as EntryId,
		{
			ownership: { kind: "ownerless" },
			agent: { model: agent.model ?? opened.defaultModel },
		},
		BACKGROUND_CONTEXT,
	);
	// The fork's sidebar identity: the copied meta doc carries the
	// source's name/autoName and the namer's attempt count; ONE commit
	// drops all three (a fork is a new conversation, not the source's
	// name — and it starts naming-fresh: inheriting an exhausted attempt
	// count would make the fork forever unnameable), re-seeds it with
	// "<source display name> (fork)" as its AUTO name when the source
	// had one, and stamps activity so the fresh fork sorts where it
	// happened. §5.9 (Review Focus 3): the doc copied the source's
	// `owner` and `sharing` (fork: "current") — the SAME commit resets
	// them: a fork is the FORKER's private copy (owner = the caller,
	// sharing deleted; an ownerless caller means no owner at all — the
	// key is removed).
	const sourceMeta = await opened.harness.snapshot(
		SessionMetaDoc,
		conversation.id,
		BACKGROUND_CONTEXT,
	);
	const sourceName = sourceMeta?.name ?? sourceMeta?.autoName;
	await fork.commit(async (tx) => {
		// A relative source cwd belongs to the source owner's workspace.
		// Do not let a fork by someone else silently retarget it into theirs.
		if (sourceMeta?.owner !== opts.owner) {
			await configure(tx, fork.id, { cwd: null });
		}
		const draft = await tx.doc(SessionMetaDoc, fork.id);
		delete draft.name;
		delete draft.autoName;
		delete draft.autoNameAttempts;
		delete draft.sharing;
		if (opts.owner === undefined) delete draft.owner;
		else draft.owner = opts.owner;
		if (sourceName !== undefined) draft.autoName = `${sourceName} (fork)`;
		draft.lastActivityAt = opened.now().toISOString();
	}, BACKGROUND_CONTEXT);
	const view = await readView(fork);
	return { id: fork.id, view };
}

/** The patch-meta op's options: the sharing gate's principal. */
export interface PatchMetaOpOptions {
	/**
	 * The HTTP caller's principal: when given, a `sharing` patch
	 * additionally requires the OWNER or a superuser (§5.9 — write access
	 * granted by a share must not let a recipient re-share). The host
	 * passes none (trusted in-process code).
	 */
	readonly principal?: Principal;
}

/**
 * Patch one conversation's session meta (the meta PATCH route's body,
 * verbatim): validate FIRST (a rejected patch never touches the doc),
 * then — when a principal is given and the patch carries `sharing` —
 * the owner-or-superuser gate (403 `forbidden`), then the
 * read-modify-write merge inside ONE commit callback (concurrent
 * patches cannot lose each other's fields; the mutation line
 * serializes commits). The response is a FRESH post-commit snapshot —
 * reading a newly-SET nested draft value trips chord's settled-overlay
 * rule, so the reply must never read the mutated draft.
 */
export async function patchMetaOp(
	ctx: ServerContext,
	conversation: Conversation,
	body: unknown,
	opts: PatchMetaOpOptions = {},
): Promise<SessionMeta> {
	const { opened } = ctx;
	// Validate FIRST — a rejected patch never touches the doc.
	const validated = validateSessionMetaPatch(body);
	if ("error" in validated) {
		throw new ConversationOpError(validated);
	}
	// §5.9: `sharing` additionally requires the OWNER or a superuser —
	// write access (granted by a share) must not let a recipient re-share
	// the resource. Host callers pass no principal (trusted).
	if (opts.principal !== undefined && validated.sharing !== undefined) {
		const meta = await opened.harness.snapshot(
			SessionMetaDoc,
			conversation.id,
			BACKGROUND_CONTEXT,
		);
		const isOwner =
			opts.principal.user !== undefined &&
			opts.principal.user === meta?.owner;
		if (!isOwner && !isSuperuser(opts.principal)) {
			throw new ConversationOpError({ error: "forbidden" }, 403);
		}
	}
	// Read-modify-write inside ONE commit: tx.doc materializes the doc
	// (initial()) when absent and the patch mutates the tracked draft.
	await conversation.commit(async (tx) => {
		const draft = await tx.doc(SessionMetaDoc, conversation.id);
		applySessionMetaPatch(draft, validated);
	}, BACKGROUND_CONTEXT);
	// The response is a FRESH snapshot, not a draft projection (see the
	// doc comment).
	return (
		(await opened.harness.snapshot(
			SessionMetaDoc,
			conversation.id,
			BACKGROUND_CONTEXT,
		)) ?? DEFAULT_SESSION_META
	);
}

// ─── Upload + raw read (gateway C4b — the files routes' ops) ───────────────

/**
 * The one upload-name rule (gateway C4b): no `/` or `\`, not `.` or
 * `..`, non-empty. The single validator BOTH upload routes and the host
 * `conversations.upload` op share — the routes pre-validate with it to
 * keep their exact `{error: "invalid_body"}` wire bodies while the op
 * throws the host-side `invalid_field` `name` vocabulary.
 */
export function validUploadName(name: string): boolean {
	return (
		name.length > 0 &&
		!name.includes("/") &&
		!name.includes("\\") &&
		name !== "." &&
		name !== ".."
	);
}

/**
 * The extension→mime map (spec §7.8): the common workspace-file
 * extensions a client renders inline; an absent extension serves
 * `application/octet-stream`. The KEY is the LOWERCASE extension
 * including the dot (the lookup lowercases, so `Photo.PNG` maps too).
 * One map for the raw route AND the host `readFile` op (its `mime`
 * field) — never two.
 */
export const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
	[".svg", "image/svg+xml"],
	[".pdf", "application/pdf"],
	[".txt", "text/plain"],
	[".md", "text/markdown"],
	[".json", "application/json"],
	[".html", "text/html"],
	[".css", "text/css"],
	[".js", "text/javascript"],
]);

/**
 * Write one upload into the conversation's upload namespace (gateway
 * C4b, the raw-upload/base64 routes' shared core): validates the NAME
 * (the one rule — a bad name throws `invalid_field` `name`; the routes
 * pre-validate with `validUploadName` to keep their `invalid_body`
 * bodies byte-identical), writes `uploads/<conversationId>/<name>`
 * through the conversation's workspace env (correct for remote
 * workspaces), and returns the path exactly as a content part takes it.
 * A failed env write is a server-side fault: fail loud.
 */
export async function uploadOp(
	ctx: ServerContext,
	conversation: Conversation,
	file: { readonly name: string; readonly mime?: string; readonly bytes: Uint8Array },
): Promise<{ readonly path: string }> {
	if (!validUploadName(file.name)) {
		throw new ConversationOpError({ error: "invalid_field", field: "name" });
	}
	// `mime` is validated (never persisted — the workspace write is the
	// file's own bytes; a content part carries its own mime) because JS
	// extensions cross this signature untyped at runtime: the op is the
	// host caller's only validation point, like compactOp's instructions.
	if (file.mime !== undefined && typeof file.mime !== "string") {
		throw new ConversationOpError({ error: "invalid_field", field: "mime" });
	}
	// v1 namespaces uploads per conversation (workspaces are static and
	// shared in v1, so un-namespaced names would clobber across
	// conversations).
	const path = `uploads/${conversation.id}/${file.name}`;
	const env = await conversationEnv(ctx.opened, conversation);
	const written = await env.writeFile(path, file.bytes, BACKGROUND_CONTEXT);
	if (!written.ok) {
		throw written.error;
	}
	return { path };
}

/**
 * Read one workspace file raw (gateway C4b, the files/raw route's op):
 * the route's confinement + cap vocabulary as op errors — non-confined/
 * empty/`.`/directory → `invalid_path` (400), absent → `not_found`
 * (404), over `server.maxFileReadBytes` → `too_large` (413; the HTTP
 * route keeps its own `file_too_large` + `maxBytes` body). The read is
 * `readBinaryFile` (the op buffers — the host caller wants the bytes;
 * the ROUTE keeps its chunked streaming through `readFileMetaOp`'s env
 * so it never buffers) with the extension-derived mime from the shared
 * map (unknown extensions read as `application/octet-stream`, the raw
 * route's own default — one behavior, never two).
 */
export async function readFileOp(
	ctx: ServerContext,
	conversation: Conversation,
	path: string,
): Promise<{ readonly bytes: Uint8Array; readonly mime?: string }> {
	const { env, mime } = await readFileMetaOp(ctx, conversation, path);
	const read = await env.readBinaryFile(path, BACKGROUND_CONTEXT);
	if (!read.ok) {
		if (read.error.code === "not_found") {
			throw new ConversationOpError({ error: "not_found" }, 404);
		}
		throw read.error;
	}
	return { bytes: read.value, mime };
}

/**
 * The raw-read pre-checks (gateway C4b): the shared validation BOTH the
 * `files/raw` route and the host `readFileOp` run — the content route's
 * confinement rule (`isConfinedPath`; empty and `.` rejected too), the
 * directory rejection, and the `server.maxFileReadBytes` cap — plus the
 * size/mime the caller needs to serve the file and the conversation env
 * it serves through (one env build per read, never two). The route maps
 * `too_large` onto its own `file_too_large` + `maxBytes` body; every
 * other op error maps 1:1 onto the route's existing responses.
 */
export async function readFileMetaOp(
	ctx: ServerContext,
	conversation: Conversation,
	path: string,
): Promise<{
	readonly env: ExecutionEnv;
	readonly size: number;
	readonly mime: string;
}> {
	if (!isConfinedPath(path) || path.length === 0 || path === ".") {
		throw new ConversationOpError({ error: "invalid_path" });
	}
	const env = await conversationEnv(ctx.opened, conversation);
	const info = await env.fileInfo(path, BACKGROUND_CONTEXT);
	if (!info.ok) {
		if (info.error.code === "not_found") {
			throw new ConversationOpError({ error: "not_found" }, 404);
		}
		throw info.error;
	}
	if (info.value.kind === "directory") {
		throw new ConversationOpError({ error: "invalid_path" });
	}
	if (info.value.size > ctx.config.maxFileReadBytes) {
		throw new ConversationOpError({ error: "too_large" }, 413);
	}
	return {
		env,
		size: info.value.size,
		mime: MIME_BY_EXTENSION.get(extname(path).toLowerCase()) ?? "application/octet-stream",
	};
}
