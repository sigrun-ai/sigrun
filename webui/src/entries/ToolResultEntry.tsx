/**
 * ToolRow (B4, UI refresh): ONE tool call inside the expanded
 * ActivityLine — the anti-goal ruling is that tool calls are NOT
 * first-class transcript cards; they live in the collapsed activity line.
 * A row shows its glyph (✓ settled / ✗ error / spinner running / · no
 * result yet), the tool name, and the preview in mono; expanding reveals
 * the call arguments (JSON) and the result output (first 20 lines,
 * "Show more" for the rest), with the edit result's line-coloured diff
 * view (Task 1d) and Copy command / Copy output actions.
 *
 * A running live slot (joined by callId) wins: spinner glyph, streaming
 * output over the settled entry's body.
 */

import { useState } from "react";
import type {
	ConversationEntryWire,
	MessageWire,
	ToolSlotWire,
} from "../api";
import { previewArgument, type ToolCall } from "../../../src/shared/turns.js";
import { copyText } from "./MessageActions";
import { messageText } from "./content";

/** How many output lines render before the "Show more" button. */
const OUTPUT_MAX_LINES = 20;

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

/** Line-coloured rendering of one diff (see {@link diffOf}). */
function DiffView(props: { diff: string }) {
	return (
		<pre className="tool-row-diff">
			{props.diff.split("\n").map((line, index) => (
				<span key={index} className={diffLineClass(line)}>
					{line + "\n"}
				</span>
			))}
		</pre>
	);
}

export function ToolRow(props: {
	/** The grouped turn's tool call (callId, name, preview, result state). */
	tool: ToolCall;
	/** The call's arguments (the JSON the row expands to; Copy command's source). */
	args: unknown;
	/** The settled result entry, when the call has one. */
	result?: ConversationEntryWire;
	/** The matching live tool slot, when the tool is still live. */
	slot?: ToolSlotWire;
}) {
	const { tool, args, result, slot } = props;
	const [expanded, setExpanded] = useState(false);
	const [outputLimit, setOutputLimit] = useState(OUTPUT_MAX_LINES);

	const running = slot?.status === "running";
	const settled = resultMessage(result);
	const output =
		slot?.output ?? (settled === undefined ? "" : messageText(settled));
	// A live slot has no committed details yet; the diff view reads the
	// settled entry only.
	const diff = slot === undefined ? diffOf(settled) : undefined;
	const command = previewArgument(tool.name, args);
	const lines = output.split("\n");
	const shown = lines.slice(0, outputLimit).join("\n");

	return (
		<div
			className="tool-row"
			data-error={tool.isError || undefined}
			data-running={running || undefined}
		>
			<div className="tool-row-head">
				<button
					type="button"
					className="tool-row-toggle"
					aria-expanded={expanded}
					onClick={() => setExpanded((value) => !value)}
				>
					{running ? (
						<span className="tool-row-spinner" aria-label="running" />
					) : tool.isError ? (
						<span className="tool-row-glyph" data-glyph="error">
							✗
						</span>
					) : result !== undefined ? (
						<span className="tool-row-glyph" data-glyph="ok">
							✓
						</span>
					) : (
						<span className="tool-row-glyph" data-glyph="pending">·</span>
					)}
					<span className="tool-row-name">{slot?.name ?? tool.name}</span>
					<span className="tool-row-preview">{tool.preview}</span>
				</button>
				<div className="tool-row-actions">
					{command !== undefined && (
						<button
							type="button"
							className="message-action"
							onClick={() => copyText(command)}
						>
							Copy command
						</button>
					)}
					{output !== "" && (
						<button
							type="button"
							className="message-action"
							onClick={() => copyText(output)}
						>
							Copy output
						</button>
					)}
				</div>
			</div>
			{expanded && (
				<div className="tool-row-detail">
					{args !== undefined && (
						<pre className="tool-row-args">{JSON.stringify(args, null, 2)}</pre>
					)}
					{shown !== "" && <pre className="tool-row-output">{shown}</pre>}
					{lines.length > outputLimit && (
						<button
							type="button"
							className="tool-row-more"
							onClick={() => setOutputLimit((limit) => limit + OUTPUT_MAX_LINES)}
						>
							Show more
						</button>
					)}
					{diff !== undefined && <DiffView diff={diff} />}
				</div>
			)}
		</div>
	);
}

/** The toolResult-role message of a settled result entry, if any. */
function resultMessage(
	entry: ConversationEntryWire | undefined,
): MessageWire | undefined {
	if (entry === undefined) return undefined;
	return (
		(entry.model ?? []).find((candidate) => candidate.role === "toolResult") ??
		(entry.model ?? [])[0]
	);
}
