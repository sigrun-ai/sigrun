/**
 * CompactionEntry (B4, UI refresh): a `pi.compaction` record rendered as
 * the compaction divider — centred "Context compacted" between two rules,
 * no button (the quiet boundary the refresh mockup draws; the reason and
 * summary stay machine-readable in data-reason / the entry itself).
 */

import type { ConversationEntryWire } from "../api";

/** The `pi.compaction` entry's `data` (pi-durable `CompactionEntry`). */
interface CompactionDataWire {
	readonly reason?: string;
}

export function CompactionEntry(props: { entry: ConversationEntryWire }) {
	const { entry } = props;
	const reason = ((entry as { data?: CompactionDataWire }).data ?? {}).reason;
	return (
		<div
			className="turn-compaction"
			data-reason={reason}
			title={reason === undefined ? undefined : `context compacted (${reason})`}
		>
			<span>Context compacted</span>
		</div>
	);
}
