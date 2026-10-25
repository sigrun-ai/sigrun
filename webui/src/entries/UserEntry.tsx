/**
 * UserEntry (B4, UI refresh): a user TURN — the right-aligned bubble
 * (the text rendered as Markdown — B5's bubble variant — plus path
 * markers for uploads, §5 path-parts) with the user's MessageActions (Copy / Edit / Fork from here) beneath. The turn root
 * carries data-turn-kind="user" + data-entry-id for the outline (B5).
 *
 * Task 2c: an EXPANDED input is one entry whose kind replaces `pi.user`
 * (`sigrun.user.expanded`, `data {typed, command}`, the EXPANDED text on
 * `model`). The bubble shows the TYPED text (what the user wrote); a
 * chip names the command and DISCLOSES the admitted text on demand —
 * never by default, or `/skill:greet hej` would fill the transcript
 * with the whole skill body.
 *
 * TurnList owns the fork/edit WIRING (it has the view and client);
 * UserEntry renders and hands the callbacks the entry's joined source
 * text already lives here for Copy.
 */

import { useState } from "react";
import { expandedUserEntry, type ExpandedUserEntryData } from "@sigrun/shared/turns";
import type { ConversationEntryWire } from "../api";
import { Markdown } from "./Markdown";
import { MessageActions } from "./MessageActions";
import { attachmentParts, messageText } from "./content";

/** The narrowed `data` of a `sigrun.blocks.answer` entry (U5 Task 4,
 *  spec §8.4): the block it answers, the action taken, and the surface's
 *  post-edit state. Defined exactly when the entry carries a non-empty
 *  `entryId` and `action`; undefined otherwise. */
export interface BlocksAnswerDataWire {
	readonly entryId: string;
	readonly action: string;
	readonly payload?: unknown;
	readonly state?: unknown;
}

export function blocksAnswerEntry(entry: {
	readonly kind: string;
	readonly data?: unknown;
}): BlocksAnswerDataWire | undefined {
	if (entry.kind !== "sigrun.blocks.answer") return undefined;
	const data = entry.data;
	if (typeof data !== "object" || data === null) return undefined;
	const entryId = (data as { readonly entryId?: unknown }).entryId;
	const action = (data as { readonly action?: unknown }).action;
	if (typeof entryId !== "string" || entryId === "") return undefined;
	if (typeof action !== "string" || action === "") return undefined;
	const payload = (data as { readonly payload?: unknown }).payload;
	const state = (data as { readonly state?: unknown }).state;
	return {
		entryId,
		action,
		...(payload === undefined ? {} : { payload }),
		...(state === undefined ? {} : { state }),
	};
}

/** The title a `sigrun.blocks` entry names (the answer chip's label);
 *  undefined for any other shape. */
export function blocksTitle(data: unknown): string | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const title = (data as { readonly title?: unknown }).title;
	return typeof title === "string" && title !== "" ? title : undefined;
}

/** The entry's ADMITTED message texts joined (the model-facing source —
 *  for an expanded input this is the expanded text the chip reveals). */
function admittedText(entry: ConversationEntryWire): string {
	return (entry.model ?? [])
		.map((message) => messageText(message))
		.filter((text) => text !== "")
		.join("\n\n");
}

/** The entry's user-facing source text — the TYPED command for an
 *  expanded input (Copy/Edit/outline read this: Edit re-sends the
 *  command and the server re-expands), else the admitted text. */
export function userText(entry: ConversationEntryWire): string {
	return expandedUserEntry(entry)?.typed ?? admittedText(entry);
}

/** The disclosure chip under an expanded bubble: names the command,
 *  toggles the admitted (expanded) text. */
function ExpandedChip(props: {
	readonly expanded: ExpandedUserEntryData;
	readonly fullText: string;
}) {
	const [revealed, setRevealed] = useState(false);
	const { expanded, fullText } = props;
	return (
		<div className="entry-expanded">
			<button
				type="button"
				className="entry-expanded-chip"
				aria-expanded={revealed}
				title={revealed ? "Hide the expanded text" : "Show the expanded text"}
				onClick={() => setRevealed(!revealed)}
			>
				expanded from /{expanded.command ?? "…"}
			</button>
			{revealed && (
				<div className="entry-expanded-text">
					<Markdown source={fullText} variant="bubble" />
				</div>
			)}
		</div>
	);
}

export function UserEntry(props: {
	entry: ConversationEntryWire;
	/** The conversation's entries (the answer chip resolves its block's
	 *  title from the `sigrun.blocks` entry it names). */
	entries?: readonly ConversationEntryWire[];
	onFork(): void;
	onEdit(): void;
}) {
	const { entry } = props;
	const expanded = expandedUserEntry(entry);
	// U5 Task 4 (spec §8.4): a block answer IS the user's message, with a
	// chip naming the surface it answered (the `sigrun.blocks` entry's
	// title; the entry id alone when that entry is not in the page).
	const answer = blocksAnswerEntry(entry);
	const answerBlock =
		answer === undefined
			? undefined
			: (props.entries ?? []).find(
					(candidate) =>
						candidate.kind === "sigrun.blocks" &&
						String(candidate.id) === answer.entryId,
				);
	const answerTitle =
		answerBlock === undefined ? undefined : blocksTitle(answerBlock.data);
	return (
		<div
			className="turn turn-user"
			data-turn-kind="user"
			data-entry-id={entry.id}
		>
			<div className="entry-user">
				{expanded !== undefined ? (
					// The expanded turn: the TYPED text is the bubble (R2), the
					// admitted text waits behind the chip. Attachments ride the
					// admitted message's parts either way.
					<div className="entry-user-message">
						<Markdown source={expanded.typed} variant="bubble" />
						{(entry.model ?? []).flatMap((message) =>
							attachmentParts(message).map((part, partIndex) => (
								<span className="entry-attachment" key={partIndex}>
									[{part.type}: {part.path ?? "?"}]
								</span>
							)),
						)}
					</div>
				) : (
					(entry.model ?? []).map((message, index) => (
						<div className="entry-user-message" key={index}>
							<Markdown source={messageText(message)} variant="bubble" />
							{attachmentParts(message).map((part, partIndex) => (
								<span className="entry-attachment" key={partIndex}>
									[{part.type}: {part.path ?? "?"}]
								</span>
							))}
						</div>
					))
				)}
				{expanded !== undefined && (
					<ExpandedChip expanded={expanded} fullText={admittedText(entry)} />
				)}
				{answer !== undefined && (
					<span className="entry-answer-chip" data-answer-entry={answer.entryId}>
						from {answerTitle ?? `entry ${answer.entryId}`}
					</span>
				)}
			</div>
			<MessageActions
				kind="user"
				text={userText(entry)}
				onFork={props.onFork}
				onEdit={props.onEdit}
			/>
		</div>
	);
}
