/**
 * Turn grouping (Task B1, UI refresh): fold a flat pi-durable entry
 * list into the renderable turns both clients draw.
 *
 * PURE module: no imports at all (test/views-purity.test.ts enforces
 * this). The entry/message/block types below are deliberately LOOSE
 * (`role: string`, `content: string | readonly TurnBlock[]`) so both
 * clients' wire types fit structurally — a shared import would defeat
 * the single-source rule.
 *
 * Grouping: consecutive `pi.assistant` and `pi.tool-result` entries
 * form ONE assistant turn; a `pi.user` entry is its own turn; every
 * other kind (compaction records, summaries) is an `other` turn. A
 * user or other entry also ENDS the assistant run.
 *
 * Task 2c: an EXPANDED input (`/skill:name`, a prompt template) is
 * placed as ONE entry whose kind REPLACES `pi.user` —
 * {@link EXPANDED_USER_KIND}, with `data {typed, command}` and the
 * EXPANDED text on `model` (pi-durable's `SubmissionDraft.entry`).
 * The grouping classifies it as a user turn (the renderers show the
 * TYPED text with a chip); the server-side twin of the kind constant
 * is `EXPANDED_ENTRY_KIND` in `src/commands/expand.ts`.
 */

/** The user-entry kind an expanded `/skill:` or template input is placed
 *  as (see the module doc); grouping treats it exactly like `pi.user`. */
export const EXPANDED_USER_KIND = "sigrun.user.expanded";

export interface TurnBlock {
	readonly type: string;
	readonly text?: string;
	readonly thinking?: string;
	readonly id?: string;
	readonly name?: string;
	readonly arguments?: unknown;
}

export interface TurnMessage {
	readonly role: string;
	readonly content: string | readonly TurnBlock[];
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly isError?: boolean;
}

export interface TurnEntry {
	readonly id: number;
	readonly kind: string;
	readonly model?: readonly TurnMessage[];
	/** The entry's kind-specific JSON payload — `sigrun.user.expanded`'s
	 *  `{typed, command}` (see {@link expandedUserEntry}). */
	readonly data?: unknown;
}

/** The narrowed `data` of a {@link EXPANDED_USER_KIND} entry: what the
 *  user TYPED (the bubble's text) and the command that expanded. */
export interface ExpandedUserEntryData {
	readonly typed: string;
	readonly command?: string;
}

/** Narrow one entry to its expanded-user `data` — defined exactly when
 *  the kind is {@link EXPANDED_USER_KIND} and `typed` is a non-empty
 *  string; undefined for every other shape (a plain `pi.user`, missing
 *  or malformed data). */
export function expandedUserEntry(
	entry: { readonly kind: string; readonly data?: unknown },
): ExpandedUserEntryData | undefined {
	if (entry.kind !== EXPANDED_USER_KIND) return undefined;
	const data = entry.data;
	if (typeof data !== "object" || data === null) return undefined;
	const typed = (data as { readonly typed?: unknown }).typed;
	if (typeof typed !== "string" || typed === "") return undefined;
	const command = (data as { readonly command?: unknown }).command;
	return typeof command === "string" && command !== ""
		? { typed, command }
		: { typed };
}

export interface ToolCall {
	readonly callId: string;
	readonly name: string;
	readonly preview: string;
	readonly resultEntryId?: number;
	readonly isError: boolean;
}

export type Turn<E extends TurnEntry> =
	| { readonly kind: "user"; readonly entry: E }
	| {
			readonly kind: "assistant";
			readonly entries: readonly E[];
			readonly thinking: readonly string[];
			readonly tools: readonly ToolCall[];
			readonly text: string;
			readonly lastEntryId: number;
			/** The turn's blocks in OCCURRENCE order — the chronological
			 * view interleaves thinking / tool calls / text exactly as they
			 * happened, instead of folding everything under the final text
			 * (the grouped view's shape). Text blocks CONSECUTIVE in the
			 * stream merge into one segment (multi-block answers read as one). */
			readonly timeline: readonly TimelineEvent[];
		}
	| { readonly kind: "other"; readonly entry: E };

/** One chronological segment of an assistant turn. */
export type TimelineEvent =
	| { readonly kind: "thinking"; readonly text: string }
	| { readonly kind: "tool"; readonly tool: ToolCall }
	| { readonly kind: "text"; readonly text: string };

/** Assembly-time ToolCall: the readonly fields fill in as results arrive. */
interface PendingToolCall {
	callId: string;
	name: string;
	preview: string;
	resultEntryId?: number;
	isError: boolean;
}

/** Assembly-time assistant turn. */
interface PendingTurn<E extends TurnEntry> {
	entries: E[];
	thinking: string[];
	tools: PendingToolCall[];
	texts: string[];
	timeline: TimelineEvent[];
}

/** The assistant text blocks of one message, in order. */
function blocks(message: TurnMessage): readonly TurnBlock[] {
	return typeof message.content === "string" ? [] : message.content;
}

export function groupTurns<E extends TurnEntry>(entries: readonly E[]): Turn<E>[] {
	const turns: Turn<E>[] = [];
	let pending: PendingTurn<E> | null = null;

	const flush = (): void => {
		if (pending === null) return;
		// Merge consecutive text segments for the timeline (a multi-block
		// answer reads as one run of prose, not N chopped paragraphs).
		const timeline: TimelineEvent[] = [];
		for (const event of pending.timeline) {
			const last = timeline[timeline.length - 1];
			if (
				event.kind === "text" &&
				last !== undefined &&
				last.kind === "text"
			) {
				timeline[timeline.length - 1] = {
					kind: "text",
					text: `${last.text}\n\n${event.text}`,
				};
				continue;
			}
			timeline.push(event);
		}
		turns.push({
			kind: "assistant",
			entries: pending.entries,
			thinking: pending.thinking,
			tools: pending.tools,
			text: pending.texts.join("\n\n"),
			lastEntryId: pending.entries[pending.entries.length - 1]!.id,
			timeline,
		});
		pending = null;
	};

	for (const entry of entries) {
		if (entry.kind === "pi.assistant" || entry.kind === "pi.tool-result") {
			pending ??= {
				entries: [],
				thinking: [],
				tools: [],
				texts: [],
				timeline: [],
			};
			pending.entries.push(entry);
			if (entry.kind === "pi.assistant") {
				for (const message of entry.model ?? []) {
					for (const block of blocks(message)) {
						if (block.type === "text" && block.text !== undefined) {
							pending.texts.push(block.text);
							pending.timeline.push({ kind: "text", text: block.text });
						} else if (
							block.type === "thinking" &&
							block.thinking !== undefined
						) {
							pending.thinking.push(block.thinking);
							pending.timeline.push({
								kind: "thinking",
								text: block.thinking,
							});
						} else if (block.type === "toolCall") {
							const call: PendingToolCall = {
								callId: block.id ?? "",
								name: block.name ?? "",
								preview: toolPreview(block.name ?? "", block.arguments),
								isError: false,
							};
							pending.tools.push(call);
							pending.timeline.push({ kind: "tool", tool: call });
						}
					}
				}
			} else {
				for (const message of entry.model ?? []) {
					if (message.toolCallId === undefined) continue;
					const tool = pending.tools.find(
						(candidate) =>
							candidate.callId === message.toolCallId &&
							candidate.resultEntryId === undefined,
					);
					if (tool !== undefined) {
						tool.resultEntryId = entry.id;
						tool.isError = message.isError === true;
					}
				}
			}
			continue;
		}

		flush();
		if (entry.kind === "pi.user" || entry.kind === EXPANDED_USER_KIND) {
			turns.push({ kind: "user", entry });
		} else {
			turns.push({ kind: "other", entry });
		}
	}
	flush();
	return turns;
}

/** Which argument each known tool previews, by tool name. */
const PREVIEW_ARGUMENT: Readonly<Record<string, string>> = {
	bash: "command",
	read: "path",
	write: "path",
	edit: "path",
	ls: "path",
	find: "path",
	grep: "pattern",
};

const PREVIEW_MAX = 80;

export function toolPreview(name: string, args: unknown): string {
	const candidate = previewArgument(name, args);
	if (candidate === undefined) return "";
	const firstLine = candidate.split("\n", 1)[0]!;
	return firstLine.length > PREVIEW_MAX
		? `${firstLine.slice(0, PREVIEW_MAX)}…`
		: firstLine;
}

/**
 * The FULL argument a tool's preview shows, uncut — the transcript's
 * copy-command action copies it verbatim: the same name-keyed argument
 * the preview selects, before its first-line/80-char truncation.
 * Undefined when the arguments carry no previewable string.
 */
export function previewArgument(
	name: string,
	args: unknown,
): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return undefined;
	}
	const record = args as Record<string, unknown>;
	const key = PREVIEW_ARGUMENT[name];
	const candidate =
		key === undefined
			? Object.values(record).find((value) => typeof value === "string")
			: record[key];
	return typeof candidate === "string" && candidate.length > 0
		? candidate
		: undefined;
}

/**
 * The collapsed activity line under an assistant turn: thinking and
 * tool COUNTS only — the entry wire carries no per-block timing, so
 * durations are never shown (plan deviation, Task D records it).
 */
export function activityLabel(turn: {
	thinking: readonly string[];
	tools: readonly ToolCall[];
}): string {
	const parts: string[] = [];
	if (turn.thinking.length > 0) parts.push("Thinking");
	if (turn.tools.length > 0) {
		parts.push(`${turn.tools.length} ${turn.tools.length === 1 ? "tool" : "tools"}`);
	}
	return parts.join(" · ");
}
