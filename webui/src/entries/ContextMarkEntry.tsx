/**
 * ContextMarkEntry (sittings, Task 3): a `sigrun.context-mark` record
 * rendered as a divider — the sitting's label centred between two rules,
 * styled like CompactionEntry (the quiet boundary the refresh mockup
 * draws). The mark's `at`/`label` payload is read from the entry's
 * `data` (the shared `ContextMarkData` shape).
 */

import type { ConversationEntryWire } from "../api";

/** The `sigrun.context-mark` entry's `data` payload. */
interface ContextMarkDataWire {
	readonly at?: number;
	readonly label?: string;
}

export function ContextMarkEntry(props: { entry: ConversationEntryWire }) {
	const { entry } = props;
	const data = (entry as { data?: ContextMarkDataWire }).data ?? {};
	const label = data.label ?? "";
	return (
		<div className="turn-compaction">
			<span>{label}</span>
		</div>
	);
}
