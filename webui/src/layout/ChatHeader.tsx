/**
 * ChatHeader (B2, UI refresh): the 48px header over the chat pane.
 *
 * - The conversation title, click → an inline rename input (Enter saves
 *   through `onRename` and closes after it resolves, Esc cancels).
 * - The Outline / Workspace panel toggles (`aria-pressed`; App closes the
 *   panel when the active mode is clicked again).
 * - The `⋯` menu: Export, Compact, Rename, Archive — each forwarding its
 *   App-owned action (Rename reuses the inline input).
 * - The narrow-viewport drawer toggle (CSS shows it ≤900px only, where
 *   the rail + sidebar collapse into the drawer).
 */

import { useState } from "react";
import { MenuIcon, MoreIcon, OutlineIcon, WorkspaceIcon } from "./icons";
import type { PanelMode } from "./RightPanel";

export type { PanelMode } from "./RightPanel";

export function ChatHeader(props: {
	/** The conversation's display title (the rename input's start value). */
	readonly title: string;
	/** The open panel mode, or null when closed (drives aria-pressed). */
	readonly panel: PanelMode | null;
	/** Panel toggle: App maps a click on the active mode to close. */
	readonly onPanel: (mode: PanelMode) => void;
	/** Persist a rename; resolves when the write landed. */
	readonly onRename: (name: string) => Promise<void>;
	readonly onExport: () => void;
	readonly onCompact: () => void;
	readonly onArchive: () => void;
	/** Whether the narrow-viewport drawer is open (aria-expanded only). */
	readonly drawerOpen: boolean;
	/** Toggle the narrow-viewport drawer (rail + sidebar). */
	readonly onToggleDrawer: () => void;
}) {
	const {
		title,
		panel,
		onPanel,
		onRename,
		onExport,
		onCompact,
		onArchive,
		drawerOpen,
		onToggleDrawer,
	} = props;
	const [renaming, setRenaming] = useState(false);
	const [draft, setDraft] = useState(title);
	const [menuOpen, setMenuOpen] = useState(false);

	const beginRename = () => {
		setDraft(title);
		setRenaming(true);
		setMenuOpen(false);
	};
	const cancelRename = () => setRenaming(false);
	const commitRename = () => {
		const name = draft.trim();
		if (name === "" || name === title) {
			setRenaming(false);
			return;
		}
		void onRename(name).then(
			() => setRenaming(false),
			() => setRenaming(false),
		);
	};

	const runMenuAction = (action: () => void) => () => {
		setMenuOpen(false);
		action();
	};

	return (
		<header className="chat-header">
			<button
				type="button"
				className="icon-btn chat-menu-toggle"
				title="Conversations"
				aria-label="open conversations"
				aria-expanded={drawerOpen}
				onClick={onToggleDrawer}
			>
				<MenuIcon />
			</button>
			{renaming ? (
				<input
					className="chat-title-input"
					value={draft}
					aria-label="conversation name"
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") commitRename();
						else if (event.key === "Escape") cancelRename();
					}}
				/>
			) : (
				<button
					type="button"
					className="chat-title"
					title={title}
					onClick={beginRename}
				>
					{title}
				</button>
			)}
			<span className="chat-header-spacer" />
			<button
				type="button"
				className="icon-btn"
				data-panel="outline"
				title="Outline"
				aria-label="outline"
				aria-pressed={panel === "outline"}
				onClick={() => onPanel("outline")}
			>
				<OutlineIcon />
			</button>
			<button
				type="button"
				className="icon-btn"
				data-panel="workspace"
				title="Workspace files"
				aria-label="workspace"
				aria-pressed={panel === "workspace"}
				onClick={() => onPanel("workspace")}
			>
				<WorkspaceIcon />
			</button>
			<span className="chat-menu-slot">
				<button
					type="button"
					className="icon-btn"
					title="More (export, compact, rename, archive)"
					aria-label="more actions"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					onClick={() => setMenuOpen((open) => !open)}
				>
					<MoreIcon />
				</button>
				{menuOpen && (
					<div className="chat-menu" role="menu">
						<button
							type="button"
							role="menuitem"
							data-menu-action="export"
							onClick={runMenuAction(onExport)}
						>
							Export
						</button>
						<button
							type="button"
							role="menuitem"
							data-menu-action="compact"
							onClick={runMenuAction(onCompact)}
						>
							Compact
						</button>
						<button
							type="button"
							role="menuitem"
							data-menu-action="rename"
							onClick={runMenuAction(beginRename)}
						>
							Rename
						</button>
						<button
							type="button"
							role="menuitem"
							data-menu-action="archive"
							onClick={runMenuAction(onArchive)}
						>
							Archive
						</button>
					</div>
				)}
			</span>
		</header>
	);
}
