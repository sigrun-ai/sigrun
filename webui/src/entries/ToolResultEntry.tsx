/**
 * ToolResultEntry (Task 22): a `pi.tool-result` entry rendered as an
 * expandable tool card. Collapsed shows the tool name + status; expanded
 * shows the output. When the matching LiveDoc tool slot (joined by
 * `toolCallId === callId`) is running, the card renders in-progress and the
 * slot's streaming output wins over the committed entry body.
 */

import { useState } from "react";
import type { ConversationEntryWire, ToolSlotWire } from "../api";
import { messageText } from "./content";

export function ToolResultEntry(props: {
	entry: ConversationEntryWire;
	/** The matching live tool slot, when the tool is still live. */
	slot?: ToolSlotWire;
}) {
	const [expanded, setExpanded] = useState(false);
	const message =
		props.entry.model.find((candidate) => candidate.role === "toolResult") ??
		props.entry.model[0];
	const name = props.slot?.name ?? message?.toolName ?? "tool";
	const status = props.slot?.status ?? "done";
	const running = status === "running";
	const output =
		props.slot?.output ?? (message === undefined ? "" : messageText(message));
	const className = running
		? "entry entry-tool entry-tool-running"
		: "entry entry-tool";
	return (
		<div className={className}>
			<button
				type="button"
				className="tool-card-header"
				aria-expanded={expanded}
				onClick={() => setExpanded((value) => !value)}
			>
				<span className="tool-card-name">{name}</span>
				<span className="tool-card-status">
					{running ? "running…" : status}
				</span>
			</button>
			{expanded && <pre className="tool-card-output">{output}</pre>}
		</div>
	);
}
