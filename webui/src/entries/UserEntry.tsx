/**
 * UserEntry (Task 22): a `pi.user` entry — the user's text parts, plus path
 * markers for the non-text parts (uploaded images/files, §5 path-parts).
 */

import type { ConversationEntryWire } from "../api";
import { attachmentParts, messageText } from "./content";

export function UserEntry(props: { entry: ConversationEntryWire }) {
	return (
		<div className="entry entry-user">
			{props.entry.model?.map((message, index) => (
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
	);
}
