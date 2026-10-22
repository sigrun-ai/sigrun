/**
 * ActivityLine (B4, UI refresh): the collapsed activity summary under an
 * assistant turn — `Thinking · N tools` (+ `· N failed`), always collapsed
 * by default, ALSO during live runs. Open state persists in
 * sessionStorage keyed `sigrun.activity.<conversationId>.<lastEntryId>`
 * (the key rides the LAST entry, so a growing run is a new key until it
 * settles). Expanded: the thinking texts (italic faint; omitted when
 * showThinking is false) then one ToolRow per tool call.
 */

import { useEffect, useState } from "react";
import type { ConversationEntryWire, ToolSlotWire } from "../api";
import { activityLabel, type ToolCall } from "@sigrun/shared/turns";
import { ToolRow } from "./ToolResultEntry";

function storage(): Storage | undefined {
	return (globalThis as { sessionStorage?: Storage }).sessionStorage;
}

/** The persisted open state for this turn's activity line. */
function readOpen(conversationId: number, lastEntryId: number): boolean {
	try {
		return storage()?.getItem(activityKey(conversationId, lastEntryId)) === "1";
	} catch {
		return false;
	}
}

function activityKey(conversationId: number, lastEntryId: number): string {
	return `sigrun.activity.${conversationId}.${lastEntryId}`;
}

export function ActivityLine(props: {
	conversationId: number;
	/** The grouped turn's last entry id (the persistence key's tail). */
	lastEntryId: number;
	/** The turn's thinking texts (B1's groupTurns). */
	thinking: readonly string[];
	/** The turn's tool calls (B1's groupTurns). */
	tools: readonly ToolCall[];
	/** The turn's entries — a tool's result entry is joined by callId. */
	entries: readonly ConversationEntryWire[];
	/** The live tool slots (the running-state join + streaming output). */
	slots: readonly ToolSlotWire[];
	/** Show the thinking text expanded (the showThinking pref). */
	showThinking: boolean;
	/** A run is live right now (the trailing partial's turn). */
	live?: boolean;
	/** The turn is in live-thinking mode: AssistantTurn renders the
	 * thinking expanded above, so the line's label drops the Thinking
	 * count until the fold-in. */
	hideThinkingCount?: boolean;
}) {
	const {
		conversationId,
		lastEntryId,
		thinking,
		tools,
		entries,
		slots,
		showThinking,
		live,
		hideThinkingCount,
	} = props;
	const [open, setOpen] = useState(() => readOpen(conversationId, lastEntryId));
	// A different key (a new run growing past this turn) re-collapses.
	useEffect(() => {
		setOpen(readOpen(conversationId, lastEntryId));
	}, [conversationId, lastEntryId]);
	const label = activityLabel({
		thinking: hideThinkingCount === true ? [] : thinking,
		tools,
	});
	if (label === "") return null;
	const failed = tools.filter((tool) => tool.isError).length;
	const toggle = (): void => {
		setOpen((value) => {
			const next = !value;
			try {
				const key = activityKey(conversationId, lastEntryId);
				if (next) storage()?.setItem(key, "1");
				else storage()?.removeItem(key);
			} catch {
				// a failing store (blocked storage) keeps the line usable
			}
			return next;
		});
	};
	return (
		<div className="activity-line">
			<button
				type="button"
				className="activity-toggle"
				aria-expanded={open}
				data-live={live || undefined}
				onClick={toggle}
			>
				{live && <span className="activity-spinner" aria-hidden="true" />}
				<span className="activity-label">{label}</span>
				{failed > 0 && (
					<span className="activity-failed"> · {failed} failed</span>
				)}
			</button>
			{open && (
				<div className="activity-body">
					{showThinking &&
						thinking.map((text, index) => (
							<div className="activity-thinking" key={index}>
								{text}
							</div>
						))}
					{tools.map((tool, index) => (
						<ToolRow
							key={`${tool.callId}:${index}`}
							tool={tool}
							args={toolCallArguments(entries, tool.callId)}
							result={entries.find((entry) => entry.id === tool.resultEntryId)}
							slot={slots.find((slot) => slot.callId === tool.callId)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

/** The call arguments of one toolCall block, joined from the turn's entries. */
function toolCallArguments(
	entries: readonly ConversationEntryWire[],
	callId: string,
): unknown {
	for (const entry of entries) {
		for (const message of entry.model ?? []) {
			const content = message.content;
			if (typeof content === "string") continue;
			for (const block of content) {
				if (
					block.type === "toolCall" &&
					(block as { id?: string }).id === callId
				) {
					return (block as { arguments?: unknown }).arguments;
				}
			}
		}
	}
	return undefined;
}
