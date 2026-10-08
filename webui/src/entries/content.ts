/**
 * Message-content helpers shared by the entry renderers (Task 22). §5
 * message content is either a plain string or an array of content blocks
 * (`{type: "text", text}` plus image/file parts); renderers mostly want the
 * concatenated text and the non-text parts (uploads) separately.
 */

import type { ContentBlockWire, MessageWire } from "../api";

/**
 * The message's text: string content as-is, or its text blocks joined with
 * a blank line (markdown paragraph separation). Non-text blocks are skipped
 * (see {@link attachmentParts}).
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

/** The message's non-text blocks (image/file upload parts). */
export function attachmentParts(
	message: MessageWire,
): readonly ContentBlockWire[] {
	const content = message.content;
	if (typeof content === "string") return [];
	return content.filter((block) => block.type !== "text");
}
