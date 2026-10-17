/**
 * Automatic conversation naming (UI refresh Task A2).
 *
 * One background one-shot pi-ai completion after a conversation's first
 * settled ANSWERED run writes `SessionMeta.autoName` — the sidebar's
 * fallback display name, always under a user-set `name`. The call is NOT
 * a pi-durable conversation: it goes straight through `Models
 * .completeSimple` with the system prompt and a user message carrying the
 * run's first input and its answer, thinking off (no `reasoning` option),
 * bounded by an abort signal fired after `timeoutMs`.
 *
 * Naming must never hurt a run (the plan's review focus 1): every skip
 * check runs before the model call, every failure (throw, timeout, an
 * uncleanable response) commits one `autoNameAttempts` bump and logs one
 * line, nothing ever rethrows into the event bus, and attempts stop at
 * {@link NAMING_MAX_ATTEMPTS}. Task-owned conversations (subagent
 * transcripts — `ConversationRecord.owner` set) are never named, and
 * `settings.namingModel: false` disables the feature outright.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	Api,
	AssistantMessage,
	Model,
	Models,
} from "@earendil-works/pi-ai";
import type {
	ConversationId,
	Harness,
	ModelRef,
} from "@earendil-works/pi-durable";
import { parseModelSpec } from "../config.js";
import { SessionMetaDoc } from "../server/session-meta.js";
import type {
	ExtensionRunSettledHandler,
	RunSettledEvent,
} from "./event-bus.js";
import { requireServedModel } from "./providers/index.js";
import type { SettingsFile } from "./settings.js";

/** The one-shot naming prompt (the plan fixes it verbatim). */
export const NAMING_SYSTEM_PROMPT =
	"Write a short title (at most 6 words) for this conversation. Reply with the title only: no quotes, no trailing punctuation.";

/** After this many failed naming attempts a conversation stays unnamed. */
export const NAMING_MAX_ATTEMPTS = 3;

/** Default bound on one naming completion. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Each transcript half of the naming prompt is capped at this length. */
const PROMPT_TEXT_LIMIT = 2_000;

/** The cleaned title's character cap (applied on a word boundary). */
const TITLE_CHAR_LIMIT = 60;

/** The cleaned title's word cap. */
const TITLE_WORD_LIMIT = 6;

/**
 * Scrub a naming response into a display title: trim; drop surrounding
 * quotes/backticks (the pair must match — an inner apostrophe never
 * matches) and a leading `Title:` label; collapse whitespace and newlines
 * to single spaces; strip trailing sentence punctuation; keep the first
 * {@link TITLE_WORD_LIMIT} words; cap at {@link TITLE_CHAR_LIMIT}
 * characters on a word boundary (a single longer word is cut at the cap).
 * `undefined` when nothing remains.
 */
export function cleanTitle(raw: string): string | undefined {
	let text = raw.trim();
	for (;;) {
		const quoted = /^(['"`])([\s\S]*)\1$/.exec(text);
		if (quoted === null) break;
		text = quoted[2]!.trim();
	}
	text = text.replace(/^title:\s*/i, "");
	text = text.replace(/\s+/g, " ").trim();
	text = text.replace(/[.,;:!?]+$/, "").trim();
	if (text === "") return undefined;
	text = text.split(" ").slice(0, TITLE_WORD_LIMIT).join(" ");
	if (text.length > TITLE_CHAR_LIMIT) {
		const slice = text.slice(0, TITLE_CHAR_LIMIT);
		const boundary = slice.lastIndexOf(" ");
		text = boundary > 0 ? slice.slice(0, boundary) : slice;
	}
	return text === "" ? undefined : text;
}

/** The dependencies `createAutoNamer` needs (all but the log are required). */
export interface AutoNamerDeps {
	/** Reads the settled conversation's session meta (skip checks + commits). */
	readonly harness: Harness;
	/** The merged catalog the naming completion dispatches through. */
	readonly models: Models;
	/** Live settings read per run (`namingModel === false` disables). */
	readonly readSettings: () => SettingsFile;
	/** The boot default model — the fallback when `namingModel` is unset. */
	readonly defaultModel: ModelRef;
	/** Task-owned conversations (subagent transcripts) are never named. */
	readonly isTaskOwned: (id: ConversationId) => Promise<boolean>;
	/** Bound on one naming completion; default 20 000ms. */
	readonly timeoutMs?: number;
	/** One line per failed attempt; defaults to `console.error`. */
	readonly log?: (message: string) => void;
}

/** The auto-namer boot registers and tests await. */
export interface AutoNamer {
	/** The `runSettled` handler (registered as `sigrun:auto-name`). */
	readonly runSettled: ExtensionRunSettledHandler;
	/** Resolves when no naming call is in flight. */
	idle(): Promise<void>;
}

/**
 * Create the auto-namer. `runSettled` returns immediately — naming runs in
 * the background on a private chain, one call at a time — so the event
 * bus's hook deadline never bounds a naming completion. `idle()` resolves
 * when the chain is drained (tests await it; boot never does).
 */
export function createAutoNamer(deps: AutoNamerDeps): AutoNamer {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const log = deps.log ?? ((message: string) => console.error(message));
	// The serialized naming chain: each event names after the previous one
	// finished. nameConversation never rejects, so the chain never breaks.
	let tail: Promise<void> = Promise.resolve();
	const runSettled: ExtensionRunSettledHandler = (event) => {
		tail = tail.then(() => nameConversation(event));
	};
	return { runSettled, idle: () => tail };

	/** Name one settled run's conversation; never rethrows. */
	async function nameConversation(event: RunSettledEvent): Promise<void> {
		const id = event.conversationId;
		try {
			if (event.outcome.status !== "answered") return;
			if (deps.readSettings().namingModel === false) return;
			if (await deps.isTaskOwned(id)) return;
			const conversation = await deps.harness.conversation(id, BACKGROUND_CONTEXT);
			if (conversation === undefined) return;
			const meta = await deps.harness.snapshot(SessionMetaDoc, id, BACKGROUND_CONTEXT);
			// An absent doc (never written — reads serve nothing, defaults are
			// free) is an unnamed conversation with zero attempts: name it.
			if (meta?.name !== undefined || meta?.autoName !== undefined) return;
			if ((meta?.autoNameAttempts ?? 0) >= NAMING_MAX_ATTEMPTS) return;
			const settings = deps.readSettings();
			const ref =
				typeof settings.namingModel === "string"
					? parseModelSpec(settings.namingModel, "namingModel")
					: deps.defaultModel;
			const model = requireServedModel(deps.models, ref);
			const title = await completeTitle(model, event.outcome.answer.content, event.inputTexts[0] ?? "");
			if (title === undefined) {
				await recordFailure(id, "the model returned no usable title");
				return;
			}
			// Commit only while both name fields are still absent — a user
			// naming the conversation mid-call wins.
			await conversation.commit(async (tx) => {
				const draft = await tx.doc(SessionMetaDoc, id);
				if (draft.name !== undefined || draft.autoName !== undefined) return;
				draft.autoName = title;
			}, BACKGROUND_CONTEXT);
		} catch (error) {
			try {
				await recordFailure(id, error instanceof Error ? error.message : String(error));
			} catch (commitError) {
				log(
					`auto-name: conversation ${String(id)} could not record a failed attempt: ${
						commitError instanceof Error ? commitError.message : String(commitError)
					}`,
				);
			}
		}
	}

	/** Run the one-shot completion and clean its text; `undefined` = unusable. */
	async function completeTitle(
		model: Model<Api>,
		answerContent: AssistantMessage["content"],
		inputText: string,
	): Promise<string | undefined> {
		const prompt =
			`User: ${inputText.slice(0, PROMPT_TEXT_LIMIT)}\n\n` +
			`Assistant: ${textOf(answerContent).slice(0, PROMPT_TEXT_LIMIT)}`;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error(`the naming call timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref?.();
		});
		let message: AssistantMessage;
		try {
			// The race, not the signal alone, bounds the wait: a provider
			// that ignores the abort must not wedge the chain (the zombie
			// promise is abandoned; Promise.race keeps its rejection handled).
			message = await Promise.race([
				deps.models.completeSimple(
					model,
					{
						systemPrompt: NAMING_SYSTEM_PROMPT,
						messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
					},
					{ signal: controller.signal },
				),
				timedOut,
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
		// An errored or aborted completion is a failure, not a title (the
		// message may still carry text content alongside the error).
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return undefined;
		}
		return cleanTitle(textOf(message.content));
	}

	/** Commit one attempt bump (the fresh count, read inside the commit). */
	async function recordFailure(id: ConversationId, reason: string): Promise<void> {
		const conversation = await deps.harness.conversation(id, BACKGROUND_CONTEXT);
		if (conversation === undefined) return;
		let attempts: number | undefined;
		await conversation.commit(async (tx) => {
			const draft = await tx.doc(SessionMetaDoc, id);
			attempts = (draft.autoNameAttempts ?? 0) + 1;
			draft.autoNameAttempts = attempts;
		}, BACKGROUND_CONTEXT);
		log(
			`auto-name: conversation ${String(id)} attempt ${String(attempts ?? "?")} of ${NAMING_MAX_ATTEMPTS} failed — ${reason}`,
		);
	}
}

/** The text blocks of an assistant message, concatenated. */
function textOf(content: AssistantMessage["content"]): string {
	return content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}
