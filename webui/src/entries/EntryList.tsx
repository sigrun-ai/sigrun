/**
 * EntryList (Task 22): the chat transcript — renders `view.entries` in
 * array order, dispatching on the `kind` discriminant. Tool cards join the
 * LiveDoc's tool slots (by callId) so a still-running tool renders
 * in-progress. Unknown kinds render a fail-visible fallback naming the kind
 * (a new server-side kind must never vanish silently from the transcript).
 */

import type { ConversationEntryWire, ConversationViewWire } from "../api";
import { messageText } from "./content";
import { AssistantEntry } from "./AssistantEntry";
import { CompactionEntry } from "./CompactionEntry";
import {
	liveGenerationPartial,
	liveToolSlots,
	slotForEntry,
} from "./liveDoc";
import { SystemEntry } from "./SystemEntry";
import { ToolResultEntry } from "./ToolResultEntry";
import { UserEntry } from "./UserEntry";

function Entry(props: {
	entry: ConversationEntryWire;
	view: ConversationViewWire;
	readonly showThinking?: boolean;
}) {
	const { entry, view, showThinking = true } = props;
	switch (entry.kind) {
		case "pi.user":
			return <UserEntry entry={entry} />;
		case "pi.assistant":
			return <AssistantEntry entry={entry} showThinking={showThinking} />;
		case "pi.tool-result":
			return (
				<ToolResultEntry
					entry={entry}
					slot={slotForEntry(entry, liveToolSlots(view))}
				/>
			);
		case "pi.system":
			return <SystemEntry entry={entry} />;
		case "pi.compaction":
			return <CompactionEntry entry={entry} />;
		default:
			return (
				<div className="entry entry-unknown">
					unsupported entry kind: {entry.kind} —{" "}
					{(entry.model ?? [])
						.map((message) => messageText(message))
						.filter((text) => text !== "")
						.join(" ")}
				</div>
			);
	}
}

export function EntryList(props: {
	view: ConversationViewWire;
	/** Show thinking blocks (the `showThinking` pref). Default true. */
	readonly showThinking?: boolean;
}) {
	const { view, showThinking = true } = props;
	// The streaming partial (pi.live.generation.message) renders as a
	// provisional assistant entry after the committed history — live
	// thinking + text, the working indicator in transcript form. The
	// synthetic id is negative so it can never collide with a real entry
	// key; the partial vanishes when the run's generation ends.
	const partial = liveGenerationPartial(view);
	return (
		<div className="entry-list">
			{view.entries.map((entry) => (
				<Entry
					key={entry.id}
					entry={entry}
					view={view}
					showThinking={showThinking}
				/>
			))}
			{partial !== undefined && (
				<AssistantEntry
					entry={{
						id: -1,
						conversationId: view.conversation.id,
						kind: "pi.assistant",
						model: [partial],
					}}
					showThinking={showThinking}
					live
				/>
			)}
		</div>
	);
}
