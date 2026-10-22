/**
 * TurnList (B4, UI refresh): the turn-grouped transcript. B1's
 * `groupTurns` folds the flat entry list into turns; this component maps
 * each turn to its renderer (user bubble / assistant turn / other record)
 * and owns the action wiring both message kinds share:
 *
 * - Fork from here: `client.fork(conversationId, <fork point>)` — the
 *   user entry id on a user turn, the turn's last entry on an assistant
 *   turn — then `onNavigate(fork.id)`.
 * - Edit (user turns only): find the entry IMMEDIATELY BEFORE the user
 *   entry; if one exists fork at it, else `client.createConversation()`;
 *   then `patchConversationMeta(newId, { draft: { text } })` and
 *   navigate — the composer's draft restore fills the textarea. The
 *   ORIGINAL conversation is never touched.
 *
 * The streaming partial (`pi.live.generation.message`) MERGES into the
 * trailing assistant turn when one exists (its live text and tool calls
 * render under the same activity line), else renders as its own
 * provisional live turn. Unknown kinds stay fail-visible — a new
 * server-side kind never vanishes silently from the transcript.
 */

import type {
	ConversationEntryWire,
	ConversationViewWire,
	MessageWire,
	SigrunClient,
	ToolSlotWire,
} from "../api";
import {
	groupTurns,
	toolPreview,
	type TimelineEvent,
	type ToolCall,
	type Turn,
} from "@sigrun/shared/turns";
import { AssistantTurn } from "./AssistantTurn";
import { CompactionEntry } from "./CompactionEntry";
import { SystemEntry } from "./SystemEntry";
import { UserEntry, userText } from "./UserEntry";
import { messageText, thinkingTexts } from "./content";
import { liveGenerationPartial, liveToolSlots } from "./liveDoc";

/** A synthetic entry id for the streaming partial (never a real id). */
const PARTIAL_ID = -1;

/** The toolCall blocks of a message, to the shared ToolCall shape. */
function toolCallsOf(message: MessageWire): readonly ToolCall[] {
	const content = message.content;
	if (typeof content === "string") return [];
	return content
		.filter((block) => block.type === "toolCall")
		.map((block) => {
			const call = block as { id?: string; name?: string; arguments?: unknown };
			return {
				callId: call.id ?? "",
				name: call.name ?? "",
				preview: toolPreview(call.name ?? "", call.arguments),
				isError: false,
			};
		});
}

/** The streaming partial as its own provisional assistant turn. */
function partialTurn(
	conversationId: number,
	message: MessageWire,
) {
	return {
		entries: [
			{ id: PARTIAL_ID, conversationId, kind: "pi.assistant", model: [message] },
		] as readonly ConversationEntryWire[],
		thinking: thinkingTexts(message),
		tools: toolCallsOf(message),
		text: messageText(message),
		lastEntryId: PARTIAL_ID,
		timeline: partialTimeline(message),
	};
}

/** The partial's chronological events: thinking, then tool calls, then
 * text — the stream's own arrival order. */
function partialTimeline(message: MessageWire) {
	const events: import("@sigrun/shared/turns").TimelineEvent[] = [];
	for (const text of thinkingTexts(message)) {
		events.push({ kind: "thinking", text });
	}
	for (const tool of toolCallsOf(message)) {
		events.push({ kind: "tool", tool });
	}
	const text = messageText(message);
	if (text !== "") events.push({ kind: "text", text });
	return events;
}

export function TurnList(props: {
	view: ConversationViewWire;
	/** Show thinking text inside the activity details (the pref). */
	showThinking: boolean;
	/** Chronological rendering: thinking/tool/text interleaved in
	 * occurrence order instead of folded under the response. */
	timeline?: boolean;
	/** The fork parent (App lifts the conversation rows — B3). */
	parent?: { id: number; name: string };
	onNavigate: (id: number) => void;
	client: SigrunClient;
}) {
	const { view, showThinking, timeline, parent, onNavigate, client } = props;
	const conversationId = view.conversation.id;
	const slots = liveToolSlots(view);
	const partial = liveGenerationPartial(view);
	const turns = groupTurns(view.entries);

	// The streaming partial joins a trailing assistant turn when one exists.
	const trailing = turns[turns.length - 1];
	const merged =
		partial !== undefined &&
		trailing !== undefined &&
		trailing.kind === "assistant";
	if (merged && trailing !== undefined && trailing.kind === "assistant") {
		const text = messageText(partial);
		const newTools = toolCallsOf(partial).filter(
			(call) => !trailing.tools.some((tool) => tool.callId === call.callId),
		);
		turns[turns.length - 1] = {
			...trailing,
			text: trailing.text === "" ? text : `${trailing.text}\n\n${text}`,
			thinking: [...trailing.thinking, ...thinkingTexts(partial)],
			tools: [...trailing.tools, ...newTools],
			// The live timeline follows: streaming thinking/tools append in
			// OCCURRENCE order (they arrived after everything settled so far),
			// and the streaming text lands as the newest segment — the in-place
			// live rendering reads this, not the grouped fields.
			timeline: [
				...trailing.timeline,
				...thinkingTexts(partial).map(
					(partialText): TimelineEvent => ({
						kind: "thinking",
						text: partialText,
					}),
				),
				...newTools.map(
					(tool): TimelineEvent => ({ kind: "tool", tool }),
				),
				...(text === ""
					? []
					: ([{ kind: "text", text }] as const)),
			],
		};
	}

	const forkFrom = (entryId: number): (() => void) => {
		return () => {
			client
				.fork(conversationId, entryId)
				.then((created) => onNavigate(created.id))
				.catch((cause: unknown) =>
					console.error(
						`fork from conversation ${conversationId} failed:`,
						cause,
					),
				);
		};
	};

	return (
		<div className="turn-list">
			{parent !== undefined && (
				<button
					type="button"
					className="turn-lineage"
					onClick={() => onNavigate(parent.id)}
				>
					Forked from {parent.name}
				</button>
			)}
			{turns.map((turn, index) => {
				if (turn.kind === "user") {
					return (
						<UserTurn
							key={turn.entry.id}
							entry={turn.entry}
							view={view}
							client={client}
							conversationId={conversationId}
							onNavigate={onNavigate}
							forkFrom={forkFrom}
						/>
					);
				}
				if (turn.kind === "assistant") {
					return (
						<AssistantTurn
							key={turn.lastEntryId}
							conversationId={conversationId}
							turn={turn}
							slots={slots}
							showThinking={showThinking}
							client={client}
							onNavigate={onNavigate}
							live={merged && index === turns.length - 1}
							timeline={timeline}
						/>
					);
				}
				return (
					<OtherTurn key={turn.entry.id} entry={turn.entry} />
				);
			})}
			{partial !== undefined && !merged && (
				<AssistantTurn
					key={PARTIAL_ID}
					conversationId={conversationId}
					turn={partialTurn(conversationId, partial)}
					slots={slots}
					showThinking={showThinking}
					client={client}
					onNavigate={onNavigate}
					live
				/>
			)}
		</div>
	);
}

/** A user turn: the bubble + actions, with the Edit rule wired here. */
function UserTurn(props: {
	entry: ConversationEntryWire;
	view: ConversationViewWire;
	client: SigrunClient;
	conversationId: number;
	onNavigate: (id: number) => void;
	forkFrom: (entryId: number) => () => void;
}) {
	const { entry, view, client, conversationId, onNavigate, forkFrom } = props;
	// The Edit rule (plan Review Focus 4): fork at the entry immediately
	// BEFORE this user entry; a first message (nothing before it) edits in
	// a fresh conversation instead. Either way the draft patch prefills
	// the composer on arrival; the original conversation is untouched.
	const editHere = (): void => {
		const previous =
			view.entries[view.entries.findIndex((item) => item.id === entry.id) - 1];
		const created =
			previous === undefined
				? client.createConversation()
				: client.fork(conversationId, previous.id);
		created
			.then(async (conversation) => {
				await client.patchConversationMeta(conversation.id, {
					draft: { text: userText(entry) },
				});
				onNavigate(conversation.id);
			})
			.catch((cause: unknown) =>
				console.error("edit-in-new-conversation failed:", cause),
			);
	};
	return (
		<UserEntry
			entry={entry}
			onFork={forkFrom(entry.id)}
			onEdit={editHere}
		/>
	);
}

/** An `other` record: compaction divider, system line, or fail-visible unknown. */
function OtherTurn(props: { entry: ConversationEntryWire }) {
	const { entry } = props;
	const kind =
		entry.kind === "pi.compaction"
			? "compaction"
			: entry.kind === "pi.system"
				? "system"
				: "other";
	return (
		<div className="turn turn-other" data-turn-kind={kind}>
			{entry.kind === "pi.compaction" ? (
				<CompactionEntry entry={entry} />
			) : entry.kind === "pi.system" ? (
				<SystemEntry entry={entry} />
			) : (
				<div className="entry entry-unknown">
					unsupported entry kind: {entry.kind} —{" "}
					{(entry.model ?? [])
						.map((message) => messageText(message))
						.filter((text) => text !== "")
						.join(" ")}
				</div>
			)}
		</div>
	);
}
