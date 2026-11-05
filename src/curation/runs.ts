/**
 * The curator run driver (curator P6, spec §6.5): the host-side core
 * behind `host.curation.forkReview` and `host.curation.digestRun`.
 *
 * A curator run is ONE submission on ONE internal conversation whose
 * creating commit carries the run doc (`CurationRunDoc` — A6) and the
 * internal marker (`markInternal` — A2), whose agent selects the gate
 * (`sigrun.curation-gate` — A8), and whose every mutating tool call
 * executes under the store-user/run-allow discipline A6/A8 built. This
 * module creates that conversation (a fork of the reviewed parent, or a
 * fresh digest conversation) and DRIVES the run:
 *
 * - aborts at `maxToolCalls` TOOL RESULTS (the budget counts committed
 *   results, not offered calls — a blocked call is free);
 * - aborts at `deadlineMs` (wall clock from the producer's start);
 * - aborts when the caller's `signal` fires;
 * - aborts when the PARENT's owner, sharing, head (reset/compaction)
 *   or admission state changes from the values captured at start —
 *   the review reviews the conversation it saw (→ `cancelled`);
 * - collects `details.curation` from the run's tool results into
 *   `changes` (tool-result order), and the final assistant text into
 *   `text`;
 * - stamps the `reviewId` on every feed entry the run causes — through
 *   the run doc, which A6's tool reads for exactly that stamp.
 *
 * The agent rebuild (fork reviews) follows the cache-parity spike
 * exactly: rebuilt from the parent's STORED `pi.agent` — model,
 * thinkingLevel (explicit), extensions as `{name}` objects plus the
 * gate, tools, modelTools (`agent.modelTools ?? undefined`) — which
 * gives a byte-identical prefix (a section change costs exactly one
 * `pi.system` tail patch and still hits the cache fully).
 *
 * `maxOutputTokens` is an ADVISORY bound: pi-durable 1.4.0 exposes no
 * per-submission output cap (no `maxTokens` on the stream options), so
 * the driver cannot hand it to the provider. It is validated and
 * recorded; the wall-clock and tool-call budgets remain the enforced
 * limits. (Deviation recorded in the A9 report — never silent.)
 */

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentDoc,
	AssistantEntry,
	LiveDoc,
	ToolResultEntry,
} from "@earendil-works/pi-durable";
import type {
	AgentChange,
	CommitPublication,
	Conversation,
	ConversationId,
	Cursor,
	EntryId,
	EntryRecord,
	Harness,
	Registry,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Sharing } from "@sigrun/shared/access";
import type { CurationRunOpts, CurationRunResult } from "../extension.js";
import { ensureRequestId, recordAuthor } from "./attribution.js";
import { isInternal, markInternal } from "./internal.js";
import { curationRun, CurationRunDoc } from "./run-doc.js";
import { CURATION_GATE_EXTENSION } from "./gate.js";
import {
	excludeInteractiveTools,
	withoutInteractive,
} from "../harness/interactive-tools.js";
import { SessionMetaDoc } from "../server/session-meta.js";

/** What the run driver needs from its host. */
export interface CurationRunDeps {
	/** The opened harness (full `Session` access — host-side by design). */
	readonly harness: Harness;
	/** The boot registry (the gate + extension resolution). */
	readonly registry: Registry;
	/**
	 * The loaded extensions' interactive tool names (ask-user Task 3,
	 * spec §6). Only the producers that HIDE tools read it: a digest run's
	 * `init` excludes them from the fresh conversation's stored filter,
	 * and every run's `allow` list loses them with a warning BEFORE
	 * `checkRunOpts` (an all-interactive list still fails the non-empty
	 * check). A fork REVIEW keeps them listed — `rebuildAgentWithGate`
	 * copies the parent's selection for byte-identical prompt prefixes,
	 * and the gate blocks an interactive call instead. Absent on the
	 * test-only hand-built deps (no hiding — the pre-feature behavior).
	 */
	readonly interactiveTools?: ReadonlySet<string>;
}

/** The parent state the driver captures at start (the cancel oracle). */
interface ParentStart {
	readonly owner: string | undefined;
	readonly sharing: Sharing | undefined;
	readonly head: EntryId | undefined;
	/** Whether a run was live at start (the admission state). */
	readonly busy: boolean;
}

/** The classification of why a run stopped early. */
type StopReason =
	| { readonly kind: "deadline" }
	| { readonly kind: "signal" }
	| { readonly kind: "maxToolCalls" }
	| { readonly kind: "parent"; readonly what: string };

/** The target-id resolver for collected changes (the host installs it). */
let targetOfTool: (tool: string) => string = (tool) =>
	tool === "skill_manage" ? "sigrun.skills" : `tool:${tool}`;

/** The host installs the registry-backed resolver (the qualified ids). */
export function setChangeTargetResolver(
	resolver: (tool: string) => string,
): void {
	targetOfTool = resolver;
}

/** Validate the shared RunOpts invariants (the producers' fail-loud gate). */
export function checkRunOpts(opts: CurationRunOpts): void {
	if (opts.allow.length === 0) {
		throw new Error(
			"a curator run requires a non-empty allow list — the gate's block message names the allowed tools",
		);
	}
	if (opts.maxToolCalls < 1) {
		throw new Error("maxToolCalls must be at least 1");
	}
	if (opts.maxOutputTokens < 1) {
		throw new Error("maxOutputTokens must be at least 1");
	}
	if (opts.deadlineMs < 1) {
		throw new Error("deadlineMs must be at least 1");
	}
	if (opts.reviewId === "") {
		throw new Error("reviewId must not be empty");
	}
}

/** A `{name}` object (the AgentChange member spelling for extensions/tools). */
function named(name: string): { name: string } {
	return { name };
}

/** SAFETY: pi-durable's applyChange reads only `item.name` from each member
 * of an extensions/tools/modelTools array (harness/agent.js `names()`), so a
 * bare `{name}` object satisfies every field the store ever reads; the cast
 * only bridges the compile-time ToolRegistration shape. */
function namedTools(names: readonly string[]): readonly ToolRegistration[] {
	// SAFETY: cast — the store reads only `name` (see the comment above).
	return names.map(named) as unknown as readonly ToolRegistration[];
}

/**
 * The cache-parity agent rebuild: the parent's stored `pi.agent` with
 * the gate appended to the extension selection. Every field is rebuilt
 * from the STORED state (the spike's recipe) — model, thinkingLevel
 * (explicit), extensions as `{name}` objects (plus the gate), tools,
 * modelTools — so the fork's prompt prefix is byte-identical to the
 * parent's except the gate's (hooks-only, no sections) contribution.
 */
export function rebuildAgentWithGate(
	stored: Readonly<Record<string, unknown>> | undefined,
): AgentChange {
	const gate = named(CURATION_GATE_EXTENSION);
	const extensions = stored?.extensions;
	let rebuiltExtensions: AgentChange["extensions"];
	if (extensions === undefined || extensions === null) {
		// An unset selection follows the host default; an {add} edit adds
		// the gate WITHOUT pinning the default (a pin would freeze a
		// later default change into this run).
		rebuiltExtensions = { add: [gate] };
	} else if (Array.isArray(extensions)) {
		rebuiltExtensions = [
			...(extensions as string[]).map(named),
			gate,
		];
	} else {
		const edit = extensions as { add?: string[]; remove?: string[] };
		rebuiltExtensions = {
			...(edit.add === undefined
				? {}
				: { add: [...edit.add.map(named), gate] }),
			...(edit.remove === undefined
				? {}
				: { remove: edit.remove.map(named) }),
		};
	}
	const tools = stored?.tools;
	const modelTools = stored?.modelTools;
	return {
		...(stored?.model === undefined || stored?.model === null
			? {}
			: { model: stored.model as AgentChange["model"] }),
		...(stored?.thinkingLevel === undefined || stored?.thinkingLevel === null
			? {}
			: {
					thinkingLevel: stored.thinkingLevel as AgentChange["thinkingLevel"],
				}),
		extensions: rebuiltExtensions,
		...(tools === undefined || tools === null
			? {}
			: Array.isArray(tools)
				? { tools: namedTools(tools as string[]) }
				: {
						tools: {
							remove: namedTools((tools as { remove: string[] }).remove),
						},
					}),
		...(modelTools === undefined || modelTools === null
			? {}
			: Array.isArray(modelTools)
				? { modelTools: namedTools(modelTools as string[]) }
				: {
						modelTools: {
							...((modelTools as { remove?: string[] }).remove === undefined
								? {}
								: {
										remove: namedTools(
											(modelTools as { remove?: string[] }).remove!,
										),
									}),
							...((modelTools as { add?: string[] }).add === undefined
								? {}
								: {
										add: namedTools((modelTools as { add?: string[] }).add!),
									}),
						},
					}),
	};
}

/** The parent's captured state (the cancel oracle's start values). */
async function captureParent(
	harness: Harness,
	id: ConversationId,
	ctx: Context,
): Promise<ParentStart> {
	const meta = await harness.snapshot(SessionMetaDoc, id, ctx);
	const conversation = await harness.conversation(id, ctx);
	const newest = conversation === undefined
		? undefined
		: await newestEntry(conversation, ctx);
	let busy = false;
	try {
		const live = await harness.snapshot(LiveDoc, id, ctx);
		busy = live?.run !== undefined;
	} catch {
		busy = false;
	}
	return {
		owner: meta?.owner,
		sharing: meta?.sharing,
		head: newest,
		busy,
	};
}

/** The text blocks of one assistant entry's message, joined. */
function assistantText(entry: EntryRecord): string {
	let text = "";
	for (const message of entry.model ?? []) {
		if (message.role !== "assistant") continue;
		// SAFETY: an assistant entry's model array is `[AssistantMessage]`
		// (pi-durable's entries contract); the structural read below only
		// touches role/content, which every Message variant carries.
		const content = (message as { content: unknown }).content;
		if (typeof content === "string") {
			text += content;
			continue;
		}
		for (const block of (content as { type: string; text?: string }[])) {
			if (block.type === "text" && typeof block.text === "string") {
				text += block.text;
			}
		}
	}
	return text;
}

/** Whether `id` is strictly after `anchor` in the session's ascending id order. */
function isAfter(id: EntryId, anchor: EntryId | undefined): boolean {
	if (anchor === undefined) return true;
	return id > anchor;
}

/** A stable comparison key for the sharing state. */
function sharingKey(sharing: Sharing | undefined): string {
	return sharing === undefined ? "" : JSON.stringify(sharing);
}

/** The newest visible entry of one conversation, or undefined. */
async function newestEntry(
	conversation: Conversation,
	ctx: Context,
): Promise<EntryId | undefined> {
	const page = await conversation.entries({}, 1, undefined, ctx);
	return page.items[0]?.id;
}

/** The failed/"not eligible" shape. */
function notEligible(why: string): CurationRunResult {
	return {
		status: "failed",
		text: "",
		changes: [],
		error: `not eligible: ${why}`,
	};
}

/** The result of one stopped run, classified. */
function stoppedResult(reason: StopReason): CurationRunResult {
	switch (reason.kind) {
		case "deadline":
			return {
				status: "deadline",
				text: "",
				changes: [],
				error: "the run exceeded its deadline",
			};
		case "signal":
			return {
				status: "cancelled",
				text: "",
				changes: [],
				error: "the caller's signal fired",
			};
		case "maxToolCalls":
			return {
				status: "cancelled",
				text: "",
				changes: [],
				error: "the run exceeded its maxToolCalls budget",
			};
		case "parent":
			return {
				status: "cancelled",
				text: "",
				changes: [],
				error: `the parent changed under review: ${reason.what}`,
			};
	}
}

/**
 * Drive one curator run: submit `opts.instruction` on the prepared run
 * conversation and supervise it to settlement under the RunOpts bounds.
 * `prepare` resolves the run conversation (fork or fresh); `parent`
 * (fork reviews) is watched for drift.
 */
export async function driveRun(
	deps: CurationRunDeps,
	prepare: () => Promise<Conversation>,
	opts: CurationRunOpts,
	parent?: ConversationId,
): Promise<CurationRunResult> {
	const { harness } = deps;
	// The stop lane: one promise; the first cause to fire aborts the run
	// and classifies the result.
	let stopped: StopReason | undefined;
	let releaseStop: (() => void) | undefined;
	const stoppedPromise = new Promise<void>((resolve) => {
		releaseStop = resolve;
	});
	const stop = (reason: StopReason): void => {
		if (stopped !== undefined) return;
		stopped = reason;
		releaseStop?.();
	};
	const timer = setTimeout(
		() => stop({ kind: "deadline" }),
		opts.deadlineMs,
	);
	const onAbort = () => stop({ kind: "signal" });
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	// The commit watcher: publications carry the entry/submission/doc
	// records; two watches run in ONE listener — (a) this run's tool
	// results (the maxToolCalls budget), and (b) the PARENT's drift.
	// Both are synchronous reads of the publication's own changes (the
	// subscribeCommits listener contract: no blocking, no Session calls).
	//
	// Parent drift, precisely: an ENTRY change on the parent beyond the
	// start-captured head (a reset/compaction marker or a newly admitted
	// run's user entry — "the conversation was reset or compacted" /
	// "a new run was admitted"), a SUBMISSION change on the parent (the
	// admission state moving), or a SESSION-META DOCUMENT change on the
	// parent (owner or sharing). Entry ids ascend, so `id > start.head`
	// is the beyond-the-captured-head test; a document change reads the
	// kind alone (the read of the value is still the publication's own
	// committed record — no Session API).
	let toolResults = 0;
	// The parent's start state, captured BEFORE the fork exists (the
	// fork's own creating commit touches the parent's nothing — a fork
	// writes only the NEW conversation's rows).
	const start =
		parent === undefined
			? undefined
			: await captureParent(harness, parent, BACKGROUND_CONTEXT);
	// The run conversation's id — bound after `prepare` resolves; the
	// watcher below reads it live so the budget count starts at the
	// run's FIRST tool result and never sees the parent's own rows.
	let runId: ConversationId | undefined;
	let watcher: (() => void) | undefined;
	const watch = (): void => {
		watcher?.();
		watcher = harness.subscribeCommits((publication: CommitPublication) => {
			for (const change of publication.changes) {
				if (change.type === "entry") {
					if (
						runId !== undefined &&
						change.value.conversationId === runId &&
						change.value.kind === ToolResultEntry.kind
					) {
						toolResults += 1;
						if (toolResults >= opts.maxToolCalls) {
							stop({ kind: "maxToolCalls" });
						}
					}
					if (parent !== undefined && start !== undefined) {
						if (
							change.value.conversationId === parent &&
							change.value.id !== start.head &&
							isAfter(change.value.id, start.head)
						) {
							stop({
								kind: "parent",
								what:
									change.value.kind === "pi.reset"
										? "the conversation was reset or compacted"
										: "a new run was admitted",
								});
						}
					}
					continue;
				}
				if (parent === undefined || start === undefined) continue;
				if (change.type === "submission") {
					if (change.value.conversationId === parent) {
						stop({ kind: "parent", what: "a new run was admitted" });
					}
					continue;
				}
				if (change.type === "document") {
					if (
						change.conversationId === parent &&
						change.record.kind === "sigrun.session-meta" &&
						change.value !== null
					) {
						// Compare the COMMITTED VALUE's owner/sharing fields —
						// the activity stamper writes `lastActivityAt` on the
						// same doc after every settle (a benign change that
						// must never cancel a review). SAFETY: the value is
						// the adopted JSON revision; the structural read
						// touches two optional fields only.
						const value = change.value as {
							owner?: string;
							sharing?: Sharing;
						};
						if (
							value.owner !== start.owner ||
							sharingKey(value.sharing) !== sharingKey(start.sharing)
						) {
							stop({
								kind: "parent",
								what: "the parent's owner or sharing changed",
							});
						}
					}
				}
			}
		});
	};
	watch();
	const cleanup = (): void => {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		watcher?.();
		watcher = undefined;
	};
	try {
		const conversation = await prepare();
		runId = conversation.id;
		// The run's instruction is an input like any other (the A1 pin
		// applies): it carries a requestId and records the curated user as
		// its author on both keys, so the run's own transcript attributes
		// consistently with user submissions.
		// The run's user (the creating commit wrote the run doc): the
		// instruction is submitted on their behalf, so it records them as
		// author on both keys exactly like a user input (A1's pin).
		const run = await curationRun(
			harness,
			conversation.id,
			BACKGROUND_CONTEXT,
		);
		const requestId = ensureRequestId();
		if (run?.user !== undefined) {
			await recordAuthor(conversation, { requestId }, run.user, BACKGROUND_CONTEXT);
		}
		const submission = await conversation.submit(
			{ type: "input", content: opts.instruction, requestId },
			BACKGROUND_CONTEXT,
		);
		if (run?.user !== undefined) {
			await recordAuthor(
				conversation,
				{ submissionId: submission.id },
				run.user,
				BACKGROUND_CONTEXT,
			);
		}
		// Race the settlement against the stop lane. The wait's own
		// context is never cancelled (the run conversation gets a real
		// abort below instead), so an aborted settlement can only mean the
		// stop lane fired first.
		const settled = await Promise.race([
			submission.wait(BACKGROUND_CONTEXT).then(
				(record) => ({ record }),
				() => undefined,
			),
			stoppedPromise.then(() => undefined),
		]);
		if (settled === undefined) {
			// The stop lane won (or the wait itself failed): abort the run
			// conversation, then classify. The abort withdraws the queued
			// input and marks the live task; the internal conversation is
			// never listed, so nothing else observes the partial run.
			await conversation.abort(BACKGROUND_CONTEXT).catch(() => undefined);
			return stoppedResult(stopped ?? { kind: "deadline" });
		}
		const record = settled.record;
		if (record.status === "unanswered") {
			return {
				status: "failed",
				text: "",
				changes: [],
				error: `the run ended unanswered: ${record.reason}`,
			};
		}
		const changes = await collectChanges(conversation);
		const text = await answerText(conversation, record.answer);
		return { status: "completed", text, changes };
	} catch (error) {
		return {
			status: "failed",
			text: "",
			changes: [],
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		cleanup();
	}
}

/** Collect the run's `details.curation` changes, in entry order. */
/** Scan bound for collectChanges' cursor walk (a broken cursor loops, a count does not). */
const COLLECT_SCAN_LIMIT = 10_000;
async function collectChanges(
	conversation: Conversation,
): Promise<
	readonly {
		readonly changeId: string;
		readonly summary: string;
		readonly target: string;
	}[]
> {
	const changes: {
		changeId: string;
		summary: string;
		target: string;
	}[] = [];
	// Cursor-complete walk (the A9 ruling): a run with more tool results
	// than one page loses nothing — pages until exhaustion, bounded so
	// a cursor bug cannot loop forever.
	let cursor: Cursor | undefined;
	let scanned = 0;
	for (;;) {
		const page = await conversation.entries(
			{ order: "ascending" },
			500,
			cursor,
			BACKGROUND_CONTEXT,
		);
		for (const entry of page.items) {
			scanned += 1;
			if (entry.kind !== ToolResultEntry.kind) continue;
			for (const message of entry.model ?? []) {
				if (message.role !== "toolResult") continue;
				const details = message.details as
					| { readonly curation?: { changeId?: unknown; summary?: unknown } }
					| undefined;
				const curation = details?.curation;
				if (
					curation === undefined ||
					typeof curation.changeId !== "string" ||
					typeof curation.summary !== "string"
				) {
					continue;
				}
				changes.push({
					changeId: curation.changeId,
					summary: curation.summary,
					target: targetOfTool(message.toolName),
				});
			}
		}
		if (page.next === undefined || page.items.length === 0) break;
		if (scanned >= COLLECT_SCAN_LIMIT) {
			console.warn(
				`curation: collectChanges hit the ${COLLECT_SCAN_LIMIT}-entry scan guard — the run's change list is a PREFIX (later changes are unreported)`,
			);
			break;
		}
		cursor = page.next;
	}
	return changes;
}

/** The run's answer entry text (the settlement's answer, or ""). */
async function answerText(
	conversation: Conversation,
	answer: EntryId | undefined,
): Promise<string> {
	if (answer === undefined) return "";
	// The answer entry is an assistant entry: read it through the
	// conversation's own entry query (maxEntryId lands the answer).
	const page = await conversation.entries(
		{ maxEntryId: answer },
		1,
		undefined,
		BACKGROUND_CONTEXT,
	);
	const entry = page.items[0];
	if (entry === undefined || entry.id !== answer) return "";
	void AssistantEntry;
	return assistantText(entry);
}

/**
 * The fork-review producer: eligibility checks, the fork with the
 * cache-parity agent rebuild, and the run doc in the creating commit.
 * Returns the failed/"not eligible" shape without creating anything
 * when the parent refuses.
 */
export async function forkReviewRun(
	deps: CurationRunDeps,
	id: ConversationId,
	opts: CurationRunOpts,
): Promise<CurationRunResult> {
// Ask-user Task 3: the allow list loses interactive tools BEFORE the
// non-empty check (an all-interactive list still fails loudly, with
// the strip warning logged first). Fork reviews KEEP them listed
// (cache parity) — the gate blocks a call instead.
const allow = withoutInteractive(
opts.allow,
deps.interactiveTools ?? new Set(),
console.warn,
"fork review",
);
checkRunOpts({ ...opts, allow });
const { harness } = deps;
const parent = await harness.conversation(id, BACKGROUND_CONTEXT);
	if (parent === undefined) {
		return notEligible("the conversation does not exist");
	}
	if (await isInternal(harness, id, BACKGROUND_CONTEXT)) {
		return notEligible("the conversation is internal");
	}
	const meta = await harness.snapshot(SessionMetaDoc, id, BACKGROUND_CONTEXT);
	const owner = meta?.owner;
	if (owner === undefined) {
		return notEligible("the conversation has no owner");
	}
	const newest = await newestEntry(parent, BACKGROUND_CONTEXT);
	if (newest === undefined) {
		return notEligible("the conversation has no history to review");
	}
	// The model must be able to emit tool calls: a resolved agent with a
	// model and a non-empty offered tool set. (pi-ai exposes no
	// per-model "supports tools" flag; an empty offered set is the
	// honest proxy — the model has nothing to call.)
	const agent = await parent.agent(BACKGROUND_CONTEXT);
	if (agent.model === undefined) {
		return notEligible("the conversation has no model");
	}
	if (agent.tools.length === 0) {
		return notEligible("the conversation's model has no tools to call");
	}
	// SAFETY: AgentDoc's stored state is the JsonObject mirror of
	// pi-durable's AgentState (typed names/arrays); the record is only
	// ever read field-by-field below through the same casts
	// rebuildAgentWithGate applies, so the widening is read-only.
	const stored = (await harness.snapshot(
		AgentDoc,
		id,
		BACKGROUND_CONTEXT,
	)) as unknown as Readonly<Record<string, unknown>> | undefined;
	const fork = await parent.fork(
		newest,
		{
			ownership: { kind: "ownerless" },
			agent: rebuildAgentWithGate(stored),
			init: async (tx, forkId) => {
				await markInternal(tx, forkId, owner);
				const doc = await tx.doc(CurationRunDoc, forkId);
				doc.user = owner;
				doc.reviewId = opts.reviewId;
				doc.allow = [...allow];
				doc.parent = id as number;
				// The fork's copied meta carries the parent's sharing; an
				// internal run is nobody's shared copy (A2's invisibility
				// makes the key inert, but the doc should not carry a
				// stale sharing set either). SAFETY: the tracked-draft
				// write pattern mutates through a structural view; deleting
				// the optional key is the same patch forkOp's own reset
				// applies.
				const forkMeta = await tx.doc(SessionMetaDoc, forkId);
				if (forkMeta.sharing !== undefined) {
					// SAFETY: cast — the structural view above (comment says why).
					delete (forkMeta as unknown as { sharing?: Sharing }).sharing;
				}
			},
		},
		BACKGROUND_CONTEXT,
	);
	return await driveRun(deps, async () => fork, opts, id);
}

/**
 * The digest-run producer: a fresh internal conversation owned by
 * `user`, model = `opts.model` ?? the server default, selection =
 * default + gate, same run doc and driver.
 */
export async function digestRunRun(
	deps: CurationRunDeps,
	user: string,
	opts: CurationRunOpts & { input: string; model?: string },
	defaultModel: { readonly provider: string; readonly modelId: string },
	defaultAgent: () => AgentChange,
): Promise<CurationRunResult> {
	const allow = withoutInteractive(
		opts.allow,
		deps.interactiveTools ?? new Set(),
		console.warn,
		"digest run",
	);
	checkRunOpts({ ...opts, allow });
	const { harness } = deps;
	const conversation = await harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: {
				...defaultAgent(),
				model: opts.model === undefined
					? defaultModel
					: parseModel(opts.model, defaultModel),
				// The gate rides the DEFAULT selection (an {add} edit, never
				// a pin — a digest has no parent selection to inherit).
				extensions: { add: [named(CURATION_GATE_EXTENSION)] },
			},
			init: async (tx, id) => {
				await markInternal(tx, id, user);
				// Ask-user Task 3: the digest conversation's fresh agent
				// selection loses the interactive tools (the tool is never
				// listed, so the model never tries).
				await excludeInteractiveTools(tx, id, deps.interactiveTools ?? new Set());
				const doc = await tx.doc(CurationRunDoc, id);
				doc.user = user;
				doc.reviewId = opts.reviewId;
				doc.allow = [...allow];
			},
		},
		BACKGROUND_CONTEXT,
	);
	return await driveRun(
		deps,
		async () => conversation,
		{ ...opts, instruction: opts.input },
	);
}

/**
 * Parse `provider/model` (the wire grammar), falling back to the
 * default when the string has no provider part.
 */
function parseModel(
	model: string,
	defaultModel: { readonly provider: string; readonly modelId: string },
): { readonly provider: string; readonly modelId: string } {
	const slash = model.indexOf("/");
	if (slash <= 0) return defaultModel;
	return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}
