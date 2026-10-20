/**
 * RightPanel (B2, UI refresh): the 280px panel docked right of the chat
 * pane. Pure switching — `mode` picks the node (`outline` or
 * `workspace`), `null` renders nothing. The CONTENT is App-provided: the
 * workspace node is the WorkspaceBrowser, the outline node becomes the
 * OutlinePanel in B5; this component owns only the panel chrome and the
 * `data-panel` hook tests (and the ≤900px overlay CSS) switch on.
 */

import type { ReactNode } from "react";

export type PanelMode = "outline" | "workspace" | "jobs";

export function RightPanel(props: {
	/** The open mode, or null when the panel is closed. */
	readonly mode: PanelMode | null;
	/** The outline panel's content (rendered when mode === "outline"). */
	readonly outline: ReactNode;
	/** The workspace panel's content (rendered when mode === "workspace"). */
	readonly workspace: ReactNode;
	/** The jobs panel's content (rendered when mode === "jobs"). */
	readonly jobs: ReactNode;
}) {
	const { mode, outline, workspace, jobs } = props;
	if (mode === null) return null;
	return (
		<aside
			className="right-panel"
			data-panel={mode}
			aria-label={`${mode} panel`}
		>
			{mode === "outline" ? outline : mode === "jobs" ? jobs : workspace}
		</aside>
	);
}
