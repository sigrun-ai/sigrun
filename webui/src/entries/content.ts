/**
 * Message-content helpers shared by the entry renderers (Task 22). §5
 * message content is either a plain string or an array of content blocks
 * (`{type: "text", text}` plus image/file parts); renderers mostly want the
 * concatenated text and the non-text parts (uploads) separately.
 */

import type { ContentBlockWire, MessageWire } from "../api";

/**
 * The message's text: string content as-is, or its text blocks joined with
 * a blank line (markdown paragraph separation). Thinking blocks are NOT
 * text — they render separately (see {@link thinkingTexts}); non-text
 * blocks are skipped here (see {@link attachmentParts}).
 */
export function messageText(message: MessageWire): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter(
			(block) => block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text as string)
		.join("\n\n");
}

/**
 * The message's thinking texts, in content order (pi-ai ThinkingContent
 * blocks). Empty for string content — a bare string can't carry thinking.
 */
export function thinkingTexts(message: MessageWire): readonly string[] {
	const content = message.content;
	if (typeof content === "string") return [];
	return content
		.filter(
			(block) =>
				block.type === "thinking" && typeof block.thinking === "string",
		)
		.map((block) => block.thinking as string);
}

/**
 * Whether the message carries anything worth rendering: non-blank text or
 * non-blank thinking. A tool-call-only assistant message (the bubble above
 * a tool card) renders NOTHING — the tool card itself is the entry's
 * visible form.
 */
export function hasRenderableContent(message: MessageWire): boolean {
	return (
		messageText(message).trim() !== "" ||
		thinkingTexts(message).some((text) => text.trim() !== "")
	);
}

/** The message's non-text blocks (image/file upload parts). */
export function attachmentParts(
	message: MessageWire,
): readonly ContentBlockWire[] {
	const content = message.content;
	if (typeof content === "string") return [];
	return content.filter((block) => block.type !== "text");
}
