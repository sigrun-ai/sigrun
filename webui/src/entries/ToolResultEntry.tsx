/**
 * ToolResultEntry (Task 22): a `pi.tool-result` entry rendered as an
 * expandable tool card. Collapsed shows the tool name + status; expanded
 * shows the output. When the matching LiveDoc tool slot (joined by
 * `toolCallId === callId`) is running, the card renders in-progress and the
 * slot's streaming output wins over the committed entry body.
 *
 * Task 1d: an edit result carries the applied diff in its `details` field
 * (`{ diff, patch, firstChangedLine }` — pi-durable's display format:
 * `+<line> …` added, `-<line> …` removed, ` <line> …` context). When a
 * string `diff` is present, the expanded card renders it as a line-colored
 * diff view instead of relying on the plain text body.
 */

import { useState } from "react";
import type { ConversationEntryWire, ToolSlotWire } from "../api";
import { messageText } from "./content";

/** The diff string of a tool result's `details`, when it carries one. */
function diffOf(message: { details?: unknown } | undefined): string | undefined {
	if (typeof message?.details !== "object" || message.details === null) {
		return undefined;
	}
	const diff = (message.details as { diff?: unknown }).diff;
	return typeof diff === "string" ? diff : undefined;
}

/** The line class of one diff line (pi-durable's display format prefixes). */
function diffLineClass(line: string): string {
	if (line.startsWith("+")) return "diff-line-add";
	if (line.startsWith("-")) return "diff-line-del";
	return "diff-line-ctx";
}

/** Line-colored rendering of one diff (see {@link diffOf}). */
function DiffView(props: { diff: string }) {
	return (
		<pre className="tool-card-diff">
			{props.diff.split("\n").map((line, index) => (
				<span key={index} className={diffLineClass(line)}>
					{line + "\n"}
				</span>
			))}
		</pre>
	);
}

export function ToolResultEntry(props: {
	entry: ConversationEntryWire;
	/** The matching live tool slot, when the tool is still live. */
	slot?: ToolSlotWire;
}) {
	const [expanded, setExpanded] = useState(false);
	const entryModel = props.entry.model ?? [];
	const message =
		entryModel.find((candidate) => candidate.role === "toolResult") ??
		entryModel[0];
	const name = props.slot?.name ?? message?.toolName ?? "tool";
	const status = props.slot?.status ?? "done";
	const running = status === "running";
	const output =
		props.slot?.output ?? (message === undefined ? "" : messageText(message));
	// A live slot has no committed details yet; the diff view reads the
	// settled entry only.
	const diff =
		props.slot === undefined ? diffOf(message) : undefined;
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
			{expanded && (
				<>
					{output !== "" && <pre className="tool-card-output">{output}</pre>}
					{diff !== undefined && <DiffView diff={diff} />}
				</>
			)}
		</div>
	);
}
