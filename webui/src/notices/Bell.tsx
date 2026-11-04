/**
 * Bell (notices Task 6): the rail's notices toggle — the bell glyph with
 * a count badge (the badge is the pile's size, hidden when empty). The
 * shell owns the pane state; a click toggles it. `data-active` marks the
 * open state for styling and tests.
 */

import type { ReactNode } from "react";

export function Bell(props: {
	/** The pile size — the badge's number (0 renders no badge). */
	readonly count: number;
	/** Whether the notices pane is open (aria-pressed). */
	readonly active?: boolean;
	/** Toggle the notices pane. */
	readonly onToggle?: () => void;
}): ReactNode {
	return (
		<button
			type="button"
			className="rail-btn rail-bell"
			data-rail-section="notices"
			title="Notices"
			aria-label="notices"
			aria-pressed={props.active === true}
			data-active={props.active === true ? "" : undefined}
			onClick={() => props.onToggle?.()}
		>
			🔔
			{props.count > 0 && (
				<span className="rail-bell-badge" data-bell-count={props.count}>
					{props.count}
				</span>
			)}
		</button>
	);
}
