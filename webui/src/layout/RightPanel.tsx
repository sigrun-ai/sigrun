/**
 * RightPanel (todo Task 2): the 280px panel docked right of the chat
 * pane. Pure switching over ONE selection key (panelSelection.ts):
 * `selection` picks the node (`outline`, `workspace`, `notices`, or an
 * `ext:` key → `extContent`), `null` renders nothing — an installed
 * panel extension alone NEVER opens the panel. The CONTENT is
 * App-provided; this component owns only the panel chrome and the
 * `data-panel` hook tests (and the ≤900px overlay CSS) switch on.
 *
 * The in-panel tab strip is GONE: extension panels are header toggles
 * now (ChatHeader), one selection model for core and ext panes alike.
 */

import type { ReactNode } from "react";
import type { PanelKey } from "./panelSelection";

export function RightPanel(props: {
	/** The open selection, or null when the panel is closed. */
	readonly selection: PanelKey | null;
	/** The outline panel's content (rendered when selection === "outline"). */
	readonly outline: ReactNode;
	/** The workspace panel's content (rendered when selection === "workspace"). */
	readonly workspace: ReactNode;
	/** The notices pane's content (rendered when selection === "notices";
	 *  the pane is chrome — never persisted, never auto-opened). */
	readonly notices: ReactNode;
	/** The open extension panel's content (rendered for an `ext:` selection). */
	readonly extContent?: ReactNode;
}) {
	const { selection, outline, workspace, notices, extContent } = props;
	if (selection === null) return null;
	const isExt = selection.startsWith("ext:");
	return (
		<aside
			className="right-panel"
			data-panel={isExt ? "ext" : selection}
			aria-label={`${isExt ? "extension" : selection} panel`}
		>
			{isExt
				? (extContent ?? null)
				: selection === "outline"
					? outline
					: selection === "notices"
						? notices
						: workspace}
		</aside>
	);
}
