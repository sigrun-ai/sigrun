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
import { liveToolSlots, slotForEntry } from "./liveDoc";
import { SystemEntry } from "./SystemEntry";
import { ToolResultEntry } from "./ToolResultEntry";
import { UserEntry } from "./UserEntry";

function Entry(props: {
	entry: ConversationEntryWire;
	view: ConversationViewWire;
}) {
	const { entry, view } = props;
	switch (entry.kind) {
		case "pi.user":
			return <UserEntry entry={entry} />;
		case "pi.assistant":
			return <AssistantEntry entry={entry} />;
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

export function EntryList(props: { view: ConversationViewWire }) {
	return (
		<div className="entry-list">
			{props.view.entries.map((entry) => (
				<Entry key={entry.id} entry={entry} view={props.view} />
			))}
		</div>
	);
}
