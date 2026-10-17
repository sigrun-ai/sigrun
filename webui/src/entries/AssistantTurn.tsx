/**
 * AssistantTurn (B4, UI refresh): one grouped assistant turn (B1's
 * groupTurns) — the turn's text (plain pre-wrap in B4; the Markdown
 * renderer lands in B5), the collapsed ActivityLine beneath it, and the
 * assistant's MessageActions (Copy / Fork from here) with the
 * `<model> · <n> tokens` meta label read from the last assistant message
 * carrying both. The turn root carries data-turn-kind="assistant".
 */

import type { ConversationEntryWire, SigrunClient, ToolSlotWire } from "../api";
import type { ToolCall } from "../../../src/shared/turns.js";
import { ActivityLine } from "./ActivityLine";
import { MessageActions } from "./MessageActions";

/** The grouped assistant turn TurnList hands down (groupTurns' assistant variant). */
export interface AssistantTurnData {
	readonly entries: readonly ConversationEntryWire[];
	readonly thinking: readonly string[];
	readonly tools: readonly ToolCall[];
	readonly text: string;
	readonly lastEntryId: number;
}

/** `<model> · <n> tokens` from the last assistant message with both. */
function metaLabel(entries: readonly ConversationEntryWire[]): string | undefined {
	let meta: string | undefined;
	for (const entry of entries) {
		for (const message of entry.model ?? []) {
			const model = typeof message.model === "string" ? message.model : undefined;
			const tokens = message.usage?.totalTokens;
			if (model !== undefined && typeof tokens === "number") {
				meta = `${model} · ${tokens} tokens`;
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
}) {
	const { conversationId, turn, slots, showThinking, client, onNavigate } = props;
	const forkHere = (): void => {
		client
			.fork(conversationId, turn.lastEntryId)
			.then((created) => onNavigate(created.id))
			.catch((cause: unknown) =>
				console.error(`fork from conversation ${conversationId} failed:`, cause),
			);
	};
	return (
		<div className="turn turn-assistant" data-turn-kind="assistant">
			{turn.text !== "" && <div className="turn-prose">{turn.text}</div>}
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
