/**
 * UserEntry (B4, UI refresh): a `pi.user` TURN — the right-aligned bubble
 * (text parts + path markers for uploads, §5 path-parts) with the user's
 * MessageActions (Copy / Edit / Fork from here) beneath. The turn root
 * carries data-turn-kind="user" + data-entry-id for the outline (B5).
 *
 * TurnList owns the fork/edit WIRING (it has the view and client);
 * UserEntry renders and hands the callbacks the entry's joined source
 * text already lives here for Copy.
 */

import type { ConversationEntryWire } from "../api";
import { MessageActions } from "./MessageActions";
import { attachmentParts, messageText } from "./content";

/** The entry's message texts joined (Copy/Edit operate on this source). */
export function userText(entry: ConversationEntryWire): string {
	return (entry.model ?? [])
		.map((message) => messageText(message))
		.filter((text) => text !== "")
		.join("\n\n");
}

export function UserEntry(props: {
	entry: ConversationEntryWire;
	onFork(): void;
	onEdit(): void;
}) {
	const { entry } = props;
	return (
		<div
			className="turn turn-user"
			data-turn-kind="user"
			data-entry-id={entry.id}
		>
			<div className="entry-user">
				{(entry.model ?? []).map((message, index) => (
					<div className="entry-user-message" key={index}>
						{messageText(message)}
						{attachmentParts(message).map((part, partIndex) => (
							<span className="entry-attachment" key={partIndex}>
								[{part.type}: {part.path ?? "?"}]
							</span>
						))}
					</div>
				))}
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
