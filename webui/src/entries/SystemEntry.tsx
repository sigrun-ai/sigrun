/**
 * SystemEntry (Task 22): a `pi.system` entry rendered as a muted system
 * line (the text of its messages, joined).
 */

import type { ConversationEntryWire } from "../api";
import { messageText } from "./content";

export function SystemEntry(props: { entry: ConversationEntryWire }) {
	return (
		<div className="entry entry-system">
			{(props.entry.model ?? [])
				.map((message) => messageText(message))
				.filter((text) => text !== "")
				.join(" ")}
		</div>
	);
}
