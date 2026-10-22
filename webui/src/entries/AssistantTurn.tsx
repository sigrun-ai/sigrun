/**
 * AssistantTurn (B4, UI refresh): one grouped assistant turn (B1's
 * groupTurns) — the turn's text rendered as Markdown (B5's prose
 * variant), the collapsed ActivityLine beneath it, and the assistant's
 * MessageActions (Copy / Fork from here) with the `<model> · <n> tokens`
 * meta label read from the last assistant message carrying both. The
 * turn root carries data-turn-kind="assistant".
 *
 * View modes (the tool-visibility fix): GROUPED (the original — thinking
 * and tool calls fold under the response via the ActivityLine) and
 * TIMELINE (every block in occurrence order: thinking → tool → text →
 * tool → text…, so a multi-step run reads chronologically and nothing
 * the response references hides under a collapsed line). TurnList owns
 * the mode; a per-turn override would fight the mental model of "how am
 * I reading this conversation today".
 *
 * Live thinking (the streaming fix): while a run is live and no response
 * text has arrived yet, the thinking renders EXPANDED (the user watches
 * the stream); the moment text lands the thinking folds into the
 * ActivityLine with the collapse animation — expanded-then-folding, not
 * collapsed-from-the-start.
 */

import type { ConversationEntryWire, SigrunClient, ToolSlotWire } from "../api";
import type { ToolCall, TimelineEvent } from "@sigrun/shared/turns";
import { ActivityLine } from "./ActivityLine";
import { Markdown } from "./Markdown";
import { MessageActions } from "./MessageActions";
import { ToolRow } from "./ToolResultEntry";

/** The grouped assistant turn TurnList hands down (groupTurns' assistant variant). */
export interface AssistantTurnData {
	readonly entries: readonly ConversationEntryWire[];
	readonly thinking: readonly string[];
	readonly tools: readonly ToolCall[];
	readonly text: string;
	readonly lastEntryId: number;
	readonly timeline: readonly TimelineEvent[];
}

/** `<model> · in N (+cache R) · out N` from the last assistant message
 * carrying usage. Input/cache/output are distinct costs (a cached-heavy
 * turn reads very differently from a fresh-context one); cache legs are
 * omitted when zero so short turns stay quiet. */
function metaLabel(entries: readonly ConversationEntryWire[]): string | undefined {
	let meta: string | undefined;
	for (const entry of entries) {
		for (const message of entry.model ?? []) {
			const model = typeof message.model === "string" ? message.model : undefined;
			const usage = message.usage;
			if (model !== undefined && usage !== undefined) {
				const cache =
					usage.cacheRead > 0 || usage.cacheWrite > 0
					? ` (+cache ${usage.cacheRead}${usage.cacheWrite > 0 ? `+${usage.cacheWrite}w` : ""})`
						: "";
				meta = `${model} · in ${usage.input}${cache} · out ${usage.output}`;
			}
		}
	}
	return meta;
}

export function AssistantTurn(props: {
	conversationId: number;
	turn: AssistantTurnData;
	slots: readonly ToolSlotWire[];
	showThinking: boolean;
	client: SigrunClient;
	onNavigate: (id: number) => void;
	/** The turn carries the streaming partial (a live run). */
	live?: boolean;
	/** Chronological rendering (TurnList's mode): blocks in occurrence order. */
	timeline?: boolean;
}) {
	const {
		conversationId,
		turn,
		slots,
		showThinking,
		client,
		onNavigate,
		live,
		timeline,
	} = props;
	// LIVE turns ALWAYS render in place (timeline-style): blocks stream
	// where they occur — thinking where the model thought, tools where they
	// ran, text where it lands. The previous shape (expanded thinking that
	// FOLDED to the bottom ActivityLine when text arrived) relocated content
	// mid-stream; the user's round-2 ask is in-place interleaving.
	const inPlace = timeline === true || live === true;
	const forkHere = (): void => {
		client
			.fork(conversationId, turn.lastEntryId)
			.then((created) => onNavigate(created.id))
			.catch((cause: unknown) =>
				console.error(`fork from conversation ${conversationId} failed:`, cause),
			);
	};

	if (inPlace) {
		return (
			<div
				className="turn turn-assistant"
				data-turn-kind="assistant"
				data-live={live === true ? "true" : undefined}
			>
				<div className="turn-timeline">
					{turn.timeline.map((event, index) => {
						if (event.kind === "text") {
							return (
								<div className="turn-prose" key={index}>
									<Markdown source={event.text} variant="prose" />
								</div>
							);
						}
						if (event.kind === "thinking") {
							if (!showThinking) return null;
							return (
								<div className="activity-thinking timeline-thinking" key={index}>
									{event.text}
								</div>
							);
						}
						return (
							<ToolRow
								key={`${event.tool.callId}:${index}`}
								tool={event.tool}
								args={toolCallArguments(turn.entries, event.tool.callId)}
								result={turn.entries.find(
									(entry) => entry.id === event.tool.resultEntryId,
								)}
								slot={slots.find((slot) => slot.callId === event.tool.callId)}
							/>
						);
					})}
				</div>
				<MessageActions
					kind="assistant"
					text={turn.text}
					onFork={forkHere}
					meta={metaLabel(turn.entries)}
				/>
			</div>
		);
	}


	return (
		<div className="turn turn-assistant" data-turn-kind="assistant">
			{turn.text !== "" && (
				<div className="turn-prose">
					<Markdown source={turn.text} variant="prose" />
				</div>
			)}
			{(turn.thinking.length > 0 || turn.tools.length > 0) && (
				<ActivityLine
					conversationId={conversationId}
					lastEntryId={turn.lastEntryId}
					thinking={turn.thinking}
					tools={turn.tools}
					entries={turn.entries}
					slots={slots}
					showThinking={showThinking}
					live={props.live}
				/>
			)}
			<MessageActions
				kind="assistant"
				text={turn.text}
				onFork={forkHere}
				meta={metaLabel(turn.entries)}
			/>
		</div>
	);
}

/** The call arguments of one toolCall block, joined from the turn's entries. */
function toolCallArguments(
	entries: readonly ConversationEntryWire[],
	callId: string,
): string | undefined {
	for (const entry of entries) {
		if (entry.kind !== "pi.assistant") continue;
		for (const message of entry.model ?? []) {
			const content = message.content;
			if (typeof content === "string") continue;
			for (const block of content) {
				if (block.type !== "toolCall") continue;
				const call = block as { id?: string; arguments?: unknown };
				if (call.id !== callId) continue;
				if (typeof call.arguments === "string") return call.arguments;
				if (call.arguments !== undefined) return JSON.stringify(call.arguments);
				return undefined;
			}
		}
	}
	return undefined;
}
