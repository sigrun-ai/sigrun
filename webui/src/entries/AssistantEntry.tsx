/**
 * AssistantEntry (Task 22): a `pi.assistant` entry rendered as markdown via
 * react-markdown + remark-gfm (the audit's reusable-asset decision: the
 * renderMd pipeline SHAPE, replaced by a React markdown renderer — hermes's
 * code does not port).
 *
 * Thinking blocks (2026-10-15 quick wins): each message's thinking renders
 * as collapsible {@link ThinkingBlock}s before its text — live (expanded)
 * while the message is a streaming partial, collapsed at rest, hidden
 * entirely under `showThinking: false`. Messages with NOTHING renderable
 * (tool-call-only bubbles) render null — the empty bubble above a tool
 * card was a rendering bug, not content.
 */

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ConversationEntryWire } from "../api";
import { hasRenderableContent, messageText, thinkingTexts } from "./content";
import { ThinkingBlock } from "./ThinkingBlock";

export function AssistantEntry(props: {
	entry: ConversationEntryWire;
	/** Show thinking blocks (the `showThinking` pref; default true). */
	readonly showThinking?: boolean;
	/** The entry is a streaming partial: thinking renders expanded. */
	readonly live?: boolean;
}) {
	const { showThinking = true, live = false } = props;
	const renderable = (props.entry.model ?? []).filter(hasRenderableContent);
	if (renderable.length === 0) return null;
	return (
		<div className="entry entry-assistant">
			{renderable.map((message, index) => (
				<div className="entry-assistant-message" key={index}>
					{showThinking &&
						thinkingTexts(message).map((text, thinkingIndex) => (
							<ThinkingBlock
								key={thinkingIndex}
								text={text}
								live={live}
							/>
						))}
					<Markdown remarkPlugins={[remarkGfm]}>
						{messageText(message)}
					</Markdown>
				</div>
			))}
		</div>
	);
}
