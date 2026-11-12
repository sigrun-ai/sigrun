/**
 * ContextMarkEntry (sittings, Task 3): the validated sitting label
 * rendered as a divider, styled like CompactionEntry (the quiet
 * boundary the refresh mockup draws). Grouping owns payload validation;
 * this component only renders the resulting label.
 */

export function ContextMarkEntry(props: { label: string }) {
	return (
		<div className="turn-compaction">
			<span>{props.label}</span>
		</div>
	);
}
