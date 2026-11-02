/**
 * Hints by wrapping (curator P9, spec §6.6): the interception that turns
 * a curation-tool call outside a curator run into a review hint instead
 * of a write.
 *
 * WHY WRAPPING, NOT A HOOK: a `beforeTool` hook gets a read-only
 * `HookApi` and cannot commit a hint, and a hook only runs where its
 * extension is selected. Core instead rewrites the registration of every
 * curation tool at load, so the interception travels with the tool into
 * every conversation, whatever its selection, and runs inside
 * `execute` where `api.commit` exists.
 *
 * The wrap oracle is the FEED (`createCurationToolFeed`): a mutable set
 * of curation tool names that starts with the core set (`skill_manage`)
 * and grows as the loader validates each extension's `curationTargets`.
 * Boot wraps the skills extension's tools at its install (the feed's
 * core entries cover `skill_manage`); the loader wraps any of an
 * extension's tools whose names are in the feed right before
 * `registry.install`. The read-side API stays
 * `CurationRegistry.isCurationTool` (A7) — the feed is only the
 * write-side wrap oracle, not the registry.
 *
 * Wrap semantics (`wrapCurationTool`):
 *
 * 1. inside a curator run (`sigrun.curation.run` present) → delegate to
 *    the original, untouched (the gate — `sigrun.curation-gate` — owns
 *    the allow enforcement there);
 * 2. otherwise a MUTATING call never executes. `skill_manage`'s read
 *    actions (`list`/`view`) pass through — they are safe anywhere. The
 *    current run's input submissions (LiveDoc's `run.inputs`) are each
 *    resolved with `authorOfSubmission` and matched against the
 *    conversation owner: owner present AND every input authored by the
 *    owner → append to the `sigrun.curation.hints` doc and answer
 *    "Noted. The curator will review this after your reply."; ANYTHING
 *    else (a non-owner or unattributed input, an ownerless or runless
 *    conversation) → "Not recorded: this is only learned from the
 *    owner's own messages." Neither case executes the original.
 */

import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import { defineDoc, LiveDoc } from "@earendil-works/pi-durable";
import type {
	Conversation,
	JsonObject,
	SubmissionId,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
	Tx,
} from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import type { CurationHint } from "../extension.js";
import { authorOfSubmission } from "./attribution.js";
import { curationRun } from "./run-doc.js";
import { CORE_CURATION_TOOLS } from "./targets.js";
import { SessionMetaDoc } from "../server/session-meta.js";

/** The answer an owner-authored call receives (contract text). */
export const HINT_NOTED_TEXT =
	"Noted. The curator will review this after your reply.";

/** The answer every other call receives (contract text). */
export const HINT_NOT_RECORDED_TEXT =
	"Not recorded: this is only learned from the owner's own messages.";

/** The hints doc's shape: the conversation's pending review hints. */
export type CurationHints = {
	/** Hints in capture order; `takeHints` drains them. */
	hints: CurationHint[];
};

/**
 * The `sigrun.curation.hints` doc (latest-only singleton per
 * conversation): the pending hints the next review of THIS conversation
 * consumes. `fork: "current"` (the session-meta/authors pattern) — a
 * fork review (P6) inherits the parent's pending hints, exactly the
 * transcript it reviews.
 */
export const HintsDoc = defineDoc<CurationHints>({
	kind: "sigrun.curation.hints",
	version: 1,
	scope: "conversation",
	checkpointWhen: () => false,
	history: "latest",
	fork: "current",
	initial: () => ({ hints: [] }),
});

/** `skill_manage`'s read actions — safe anywhere, never intercepted. */
const SKILL_MANAGE_READ_ACTIONS: ReadonlySet<string> = new Set([
	"list",
	"view",
]);

/**
 * Whether one call passes through to the original outside a curator
 * run: only `skill_manage`'s read actions. Every other curation-tool
 * call is a write intent — the target's listed tools ARE its write
 * surface, so the action set needs no per-target spelling.
 */
function passesThrough(tool: string, args: unknown): boolean {
	if (tool !== "skill_manage") return false;
	const action = (args as { readonly action?: unknown } | null)?.action;
	return typeof action === "string" && SKILL_MANAGE_READ_ACTIONS.has(action);
}

/** The conversation owner through any document reader (fail-closed). */
async function ownerOf(
	api: ToolExecutionApi,
	ctx: Context,
): Promise<string | undefined> {
	try {
		return (await api.snapshot(SessionMetaDoc, api.conversationId, ctx))?.owner;
	} catch {
		return undefined;
	}
}

/** The current run's input submission ids (fail-closed to none). */
async function liveInputsOf(
	api: ToolExecutionApi,
	ctx: Context,
): Promise<readonly SubmissionId[]> {
	try {
		return (await api.snapshot(LiveDoc, api.conversationId, ctx))?.run?.inputs ?? [];
	} catch {
		return [];
	}
}

/**
 * Whether `owner` authored EVERY one of the inputs. An input with no
 * author record (the pre-write window, or a caller that records none)
 * resolves `undefined` and fails the check — never a guess. A read
 * failure also fails (fail closed).
 */
async function everyInputOwnerAuthored(
	api: ToolExecutionApi,
	inputs: readonly SubmissionId[],
	owner: string,
	ctx: Context,
): Promise<boolean> {
	for (const input of inputs) {
		let author: string | undefined;
		try {
			author = await authorOfSubmission(api, api.conversationId, input, ctx);
		} catch {
			author = undefined;
		}
		if (author !== owner) return false;
	}
	return true;
}

/** One text tool result. */
function text(text: string): ToolExecutionResult {
	return { output: [{ type: "text", text }] };
}

/**
 * Wrap one curation tool's registration: byte-identical name, schema,
 * description and every other field (the spread keeps each reference) —
 * only `execute` is rewritten, per the wrap semantics in the module
 * doc. Generic so a typed registration comes back typed.
 */
export function wrapCurationTool<Tool extends ToolRegistration>(
	tool: Tool,
): Tool {
	const original = tool.execute;
	const wrapped = {
		...tool,
		async execute(
			args: never,
			api: ToolExecutionApi,
			context: Context,
		): Promise<ToolExecutionResult> {
			// 1. Inside a curator run the original runs untouched (the gate
			//    owns the allow enforcement; the store user is the run's).
			const run = await curationRun(api, api.conversationId, context);
			if (run !== undefined) {
				return original.call(tool, args, api, context);
			}
			// 2. Outside a run: the read actions of `skill_manage` pass
			//    through; every other call is a write intent that never
			//    executes.
			if (passesThrough(tool.name, args)) {
				return original.call(tool, args, api, context);
			}
			const owner = await ownerOf(api, context);
			// No live run means no owner-authored evidence — the hint needs
			// inputs, and every one of them authored by the owner.
			const inputs = await liveInputsOf(api, context);
			const ownerAuthored =
				owner !== undefined &&
				inputs.length > 0 &&
				(await everyInputOwnerAuthored(api, inputs, owner, context));
			if (ownerAuthored) {
				const hint: CurationHint = {
					id: randomUUID(),
					tool: tool.name,
					args: args as JsonObject,
					at: new Date().toISOString(),
				};
				await api.commit(async (tx: Tx) => {
					const doc = await tx.doc(HintsDoc, api.conversationId);
					doc.hints = [...doc.hints, hint];
				}, context);
				return text(HINT_NOTED_TEXT);
			}
			return text(HINT_NOT_RECORDED_TEXT);
		},
	};
	return wrapped as Tool;
}

/**
 * The wrap feed: the mutable set of curation tool names — the core set
 * (`skill_manage`) plus every listed target tool the loader validates.
 * Boot creates the ONE feed and threads it into the loader; the built
 * `CurationRegistry` (A7) is the read-side view, never this set.
 */
export function createCurationToolFeed(): Set<string> {
	return new Set(CORE_CURATION_TOOLS);
}

/**
 * Wrap every curation-tool registration of one extension in place of
 * its install. Identity when the feed is absent or names none of the
 * extension's tools — the untouched object, not a copy, so nothing
 * downstream observes a swap.
 */
export function wrapExtensionCurationTools(
	extension: Extension,
	feed: ReadonlySet<string> | undefined,
): Extension {
	if (feed === undefined) return extension;
	if (!extension.tools?.some((tool) => feed.has(tool.name))) return extension;
	return {
		...extension,
		tools: extension.tools.map((tool) =>
			feed.has(tool.name) ? wrapCurationTool(tool) : tool,
		),
	};
}

/**
 * Read and clear a conversation's hints in ONE commit (the host-side
 * drain): the hints come out exactly once — the review that takes them
 * owns them, and a second take reads empty.
 */
export async function takeHints(
	conversation: Conversation,
	ctx: Context,
): Promise<readonly CurationHint[]> {
	return conversation.commit(async (tx: Tx) => {
		const doc = await tx.doc(HintsDoc, conversation.id);
		// copyJson INSIDE the callback: the draft's values are tracker
		// overlays that die with the commit — the caller reads plain JSON.
		const taken = copyJson(doc.hints) as CurationHint[];
		doc.hints = [];
		return taken;
	}, ctx);
}
