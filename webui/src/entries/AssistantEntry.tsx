/**
 * AssistantEntry (Task 22): a `pi.assistant` entry rendered as markdown via
 * react-markdown + remark-gfm (the audit's reusable-asset decision: the
 * renderMd pipeline SHAPE, replaced by a React markdown renderer — hermes's
 * code does not port).
 */

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ConversationEntryWire } from "../api";
import { messageText } from "./content";

export function AssistantEntry(props: { entry: ConversationEntryWire }) {
	return (
		<div className="entry entry-assistant">
			{props.entry.model?.map((message, index) => (
				<div className="entry-assistant-message" key={index}>
					<Markdown remarkPlugins={[remarkGfm]}>
						{messageText(message)}
					</Markdown>
				</div>
			))}
		</div>
	);
}
