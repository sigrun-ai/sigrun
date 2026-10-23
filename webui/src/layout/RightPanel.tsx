/**
 * RightPanel (B2, UI refresh): the 280px panel docked right of the chat
 * pane. Pure switching — `mode` picks the node (`outline` or
 * `workspace`), `null` renders nothing. The CONTENT is App-provided: the
 * workspace node is the WorkspaceBrowser, the outline node becomes the
 * OutlinePanel in B5; this component owns only the panel chrome and the
 * `data-panel` hook tests (and the ≤900px overlay CSS) switch on.
 */

import type { ReactNode } from "react";
import type { ExtViewEntry } from "./extViews";

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
	/**
	 * UI-blocks U3 Task 5: the extension PANEL surfaces — one tab per
	 * declared panel. The ACTIVE ext panel renders through `extContent`
	 * (App's one registration keeps this component pure switching).
	 */
	readonly extPanels?: readonly ExtViewEntry[];
	/** The open extension panel's `slug/id` key (App state). */
	readonly activeExtPanel?: string | null;
	/** The open extension panel's content. */
	readonly extContent?: ReactNode;
	/** Opens an extension panel tab. */
	readonly onOpenExtPanel?: (slug: string, id: string) => void;
}) {
	const { mode, outline, workspace, jobs } = props;
	const extPanels = props.extPanels ?? [];
	// U3 Task 5: extension panel tabs keep the panel OPEN (the strip is
	// the registration surface); a core-mode panel with no ext panels
	// still closes on mode null as before.
	if (mode === null && props.extContent === undefined && extPanels.length === 0) {
		return null;
	}
	return (
		<aside
			className="right-panel"
			data-panel={props.extContent !== undefined ? "ext" : mode}
			aria-label={`${props.extContent !== undefined ? "extension" : mode} panel`}
		>
			{extPanels.length > 0 && (
				<div className="right-panel-tabs" role="tablist">
					{extPanels.map((panel) => (
						<button
							key={`${panel.slug}/${panel.id}`}
							type="button"
							role="tab"
							className="right-panel-tab"
							data-panel-tab={`ext:${panel.slug}/${panel.id}`}
							title={panel.title}
							aria-selected={
								props.activeExtPanel === `${panel.slug}/${panel.id}`
							}
							onClick={() => props.onOpenExtPanel?.(panel.slug, panel.id)}
						>
							{panel.title}
						</button>
					))}
				</div>
			)}
			{props.extContent !== undefined
				? props.extContent
				: mode === null
					? null
					: mode === "outline"
						? outline
						: mode === "jobs"
							? jobs
							: workspace}
		</aside>
	);
}
