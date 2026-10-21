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
	onFork(): void;
	onEdit(): void;
}) {
	const { entry } = props;
	const expanded = expandedUserEntry(entry);
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
