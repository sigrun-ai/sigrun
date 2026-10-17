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
 */

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
	  }
	| { readonly kind: "other"; readonly entry: E };

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
		turns.push({
			kind: "assistant",
			entries: pending.entries,
			thinking: pending.thinking,
			tools: pending.tools,
			text: pending.texts.join("\n\n"),
			lastEntryId: pending.entries[pending.entries.length - 1]!.id,
		});
		pending = null;
	};

	for (const entry of entries) {
		if (entry.kind === "pi.assistant" || entry.kind === "pi.tool-result") {
			pending ??= { entries: [], thinking: [], tools: [], texts: [] };
			pending.entries.push(entry);
			if (entry.kind === "pi.assistant") {
				for (const message of entry.model ?? []) {
					for (const block of blocks(message)) {
						if (block.type === "text" && block.text !== undefined) {
							pending.texts.push(block.text);
						} else if (block.type === "thinking" && block.thinking !== undefined) {
							pending.thinking.push(block.thinking);
						} else if (block.type === "toolCall") {
							pending.tools.push({
								callId: block.id ?? "",
								name: block.name ?? "",
								preview: toolPreview(block.name ?? "", block.arguments),
								isError: false,
							});
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
		if (entry.kind === "pi.user") {
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
	let candidate: unknown = undefined;
	if (typeof args === "object" && args !== null && !Array.isArray(args)) {
		const record = args as Record<string, unknown>;
		const key = PREVIEW_ARGUMENT[name];
		if (key !== undefined) {
			candidate = record[key];
		} else {
			candidate = Object.values(record).find(
				(value) => typeof value === "string",
			);
		}
	}
	if (typeof candidate !== "string" || candidate.length === 0) return "";
	const firstLine = candidate.split("\n", 1)[0]!;
	return firstLine.length > PREVIEW_MAX
		? `${firstLine.slice(0, PREVIEW_MAX)}…`
		: firstLine;
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
