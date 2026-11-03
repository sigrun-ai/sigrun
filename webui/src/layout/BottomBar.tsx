/**
 * BottomBar (tabs+skills Task 2): the ≤900px tab bar — Chats, then the
 * core Skills/Jobs slots (only while the served meta lists them), then
 * More, whose sheet lists the extension views and Settings. More carries
 * `aria-current` while the active tab is an ext tab or settings.
 *
 * The component takes the entries App already derives (core views +
 * ext views); the Skills/Jobs slots render only when those entries
 * include the core skills/jobs ids, so a server without core views
 * shows no dead tabs (the rail's core-view rule).
 */

import { useState } from "react";
import type { IconName } from "@sigrun/shared/blocks";
import { Icon } from "../blocks/icons";
import type { ExtViewEntry } from "./extViews";
import { ChatsIcon, LogoutIcon, MoreIcon, SettingsIcon } from "./icons";
import type { TabId } from "./tabs";

/** The bar's core-view slots: the entry id → the tab id it opens. */
function coreTabOf(id: string): TabId | null {
	if (id === "skills" || id === "jobs") return id;
	return null;
}

/** One bar slot: an icon button with its label under the glyph. */
function BarButton(props: {
	readonly tab: string;
	readonly title: string;
	readonly active: boolean;
	readonly onPress: () => void;
	readonly children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			className={
				props.active ? "bottom-bar-btn bottom-bar-btn-active" : "bottom-bar-btn"
			}
			data-tab={props.tab}
			aria-label={props.title.toLowerCase()}
			{...(props.active ? { "aria-current": "page" as const } : {})}
			onClick={(event) => {
				event.preventDefault();
				// The rail's rule: clicking the ACTIVE tab dispatches nothing
				// (no duplicate history entry for the view already showing).
				// The More toggle excepts itself — it opens/closes the sheet
				// rather than navigating.
				if (props.active && props.tab !== "more") return;
				props.onPress();
			}}
		>
			{props.children}
			<span className="bottom-bar-label">{props.title}</span>
		</button>
	);
}

/**
 * The ≤900px bottom bar. `extViews` is App's full ordered view-entry
 * list (core entries first); the bar splits it into the core skills/jobs
 * slots (rendered on the bar) and the rest (listed in the More sheet
 * ahead of Settings). `onTab` is the host's tab navigation (the same
 * seam the rail's clicks ride).
 */
export function BottomBar(props: {
	readonly active: TabId;
	readonly extViews: readonly ExtViewEntry[];
	readonly onTab: (tab: TabId) => void;
	/** Ends the browser session (App passes the rail's logout closure);
	 *  present → the More sheet carries a Sign out row after Settings.
	 *  The rail (the desktop sign-out affordance) hides at ≤900px, so
	 *  the phone layout needs this seam (review fix). */
	readonly onSignOut?: () => void;
}) {
	const [sheetOpen, setSheetOpen] = useState(false);
	const core = new Map<string, ExtViewEntry>();
	const sheetViews: ExtViewEntry[] = [];
	for (const entry of props.extViews) {
		if (entry.slug === "core" && coreTabOf(entry.id) !== null) {
			core.set(entry.id, entry);
		} else {
			sheetViews.push(entry);
		}
	}
	// More is current while the active tab is anything the bar does not
	// carry: an ext tab (core or extension) or settings.
	const moreCurrent =
		props.active === "settings" || props.active.startsWith("ext:");
	const pick = (tab: TabId) => () => {
		setSheetOpen(false);
		props.onTab(tab);
	};
	return (
		<>
			<nav className="bottom-bar" aria-label="sections">
				<BarButton
					tab="chats"
					title="Chats"
					active={props.active === "chats"}
					onPress={() => props.onTab("chats")}
				>
					<ChatsIcon />
				</BarButton>
				{(["skills", "jobs"] as const).map((id) => {
					const entry = core.get(id);
					if (entry === undefined) return null;
					return (
						<BarButton
							key={id}
							tab={id}
							title={entry.title}
							active={props.active === id}
							onPress={() => props.onTab(id)}
						>
							<Icon name={entry.icon as IconName} size={18} />
						</BarButton>
					);
				})}
				<BarButton
					tab="more"
					title="More"
					active={moreCurrent}
					onPress={() => setSheetOpen((open) => !open)}
				>
					<MoreIcon />
				</BarButton>
			</nav>
			{sheetOpen && (
				<div
					className="bottom-sheet-backdrop"
					onClick={() => setSheetOpen(false)}
				>
					<div
						className="bottom-sheet"
						role="dialog"
						aria-label="More views"
						onClick={(event) => event.stopPropagation()}
					>
						{sheetViews.map((entry) => {
							const tab: TabId = `ext:${entry.slug}/${entry.id}`;
							return (
								<button
									key={`${entry.slug}/${entry.id}`}
									type="button"
									className="bottom-sheet-item"
									aria-label={entry.title.toLowerCase()}
									onClick={pick(tab)}
								>
									<Icon name={entry.icon as IconName} size={18} />
									<span>{entry.title}</span>
								</button>
							);
						})}
						<button
							type="button"
							className="bottom-sheet-item"
							aria-label="settings"
							onClick={pick("settings")}
						>
							<SettingsIcon />
							<span>Settings</span>
						</button>
						{props.onSignOut !== undefined && (
							<button
								type="button"
								className="bottom-sheet-item"
								aria-label="sign out"
								onClick={() => {
									setSheetOpen(false);
									props.onSignOut?.();
								}}
							>
								<LogoutIcon />
								<span>Sign out</span>
							</button>
						)}
					</div>
				</div>
			)}
		</>
	);
}
