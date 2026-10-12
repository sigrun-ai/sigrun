/**
 * CompactionEntry (Task 4, pi parity): a `pi.compaction` summary entry —
 * the manual-compact affordance's visible result. Rendered as a system-style
 * line naming the compaction reason plus the summary text (the entry's
 * model is the wrapped user message upstream writes).
 */

import type { ConversationEntryWire } from "../api";
import { messageText } from "./content";

/** The `pi.compaction` entry's `data` (pi-durable `CompactionEntry`). */
interface CompactionDataWire {
	readonly reason?: string;
}

export function CompactionEntry(props: { entry: ConversationEntryWire }) {
	const { entry } = props;
	const reason = ((entry as { data?: CompactionDataWire }).data ?? {})
		.reason;
	const text = (entry.model ?? [])
		.map((message) => messageText(message))
		.filter((line) => line !== "")
		.join(" ");
	return (
		<div className="entry entry-compaction" data-reason={reason}>
			<span className="entry-compaction-label">
				{reason === "manual"
					? "Compacted (manual)"
					: reason === undefined
						? "Compacted"
						: `Compacted (${reason})`}
			</span>
			{text !== "" && <span> {text}</span>}
		</div>
	);
}