/**
 * Rail (tabs+skills Task 1): the 52px rail is the desktop TAB BAR. Every
 * web UI view is a tab — Chats, then the core views `/v1/meta` lists
 * (skills/jobs, Task 4's `coreViewEntries`), then the extension views,
 * a spacer, the health dot, the identity chip, sign-out, and Settings.
 *
 * Tab clicks dispatch `onOpenTab(tab)`; clicking the ACTIVE tab
 * dispatches nothing (no duplicate history entry for a view already
 * showing). Tab glyphs render through the blocks icon set (the
 * extension-declared `icon` name, not the title's first letter).
 *
 * W1 Task 8: the resolved identity renders here — under the token
 * method the user's name sits above the sign-out action; the
 * naive/proxy methods carry no browser-side credential to drop, so
 * they show neither.
 *
 * The health dot collapses the old TopBar's badge row into one quiet
 * indicator: `data-health="ok"` only when every extension is `ok`,
 * `health.memory`/`health.providers` are `ok`, and `health.backup` is not
 * `"degraded"`; anything else is `"degraded"`. The dot's `title` is the
 * hover surface — the extension list ("extensions: none" when empty) and
 * `backup: <status>`.
 */

import type { ReactNode } from "react";
import type { IconName } from "@sigrun/shared/blocks";
import type { MetaResponse, WhoamiResponse } from "../api";
import { Icon } from "../blocks/icons";
import { BlocksIcon, BrandMark, ChatsIcon, LogoutIcon, SettingsIcon } from "./icons";
import {
	coreViewEntries,
	extViewEntries,
	loadRailOrder,
	orderExtViews,
	type ExtViewEntry,
} from "./extViews";
import type { TabId } from "./tabs";

/** ok ⟺ every extension ok, memory/providers ok, backup not degraded. */
function healthOf(meta: MetaResponse): "ok" | "degraded" {
	const extensionsOk = meta.extensions.every(
		(extension) => extension.status === "ok",
	);
	const healthOk =
		meta.health.memory === "ok" &&
		meta.health.providers === "ok" &&
		meta.health.backup !== "degraded";
	return extensionsOk && healthOk ? "ok" : "degraded";
}

function healthTitle(meta: MetaResponse): string {
	const extensions =
		meta.extensions.length === 0
			? "extensions: none"
			: `extensions: ${meta.extensions
					.map((extension) => `${extension.name}: ${extension.status}`)
					.join("; ")}`;
	return `${extensions} · backup: ${meta.health.backup}`;
}

/** One tab button (the rail renders the SAME button for core, ext, and
 *  fixed tabs): active → the class + aria-current, and a dead click. */
function TabButton(props: {
	readonly tab: TabId;
	readonly title: string;
	readonly active: boolean;
	readonly onOpenTab?: (tab: TabId) => void;
	readonly children: React.ReactNode;
	readonly onKeyDown?: (event: {
		readonly altKey: boolean;
		readonly key: string;
		preventDefault(): void;
	}) => void;
}) {
	return (
		<button
			type="button"
			className={props.active ? "rail-btn rail-btn-active" : "rail-btn"}
			data-rail-section={props.tab}
			title={props.title}
			aria-label={props.title.toLowerCase()}
			{...(props.active ? { "aria-current": "page" as const } : {})}
			onClick={() => {
				// Clicking the ACTIVE tab dispatches nothing (no duplicate
				// history entry for the view already showing).
				if (props.active) return;
				props.onOpenTab?.(props.tab);
			}}
			{...(props.onKeyDown === undefined ? {} : { onKeyDown: props.onKeyDown })}
		>
			{props.children}
		</button>
	);
}

export function Rail(props: {
	/** The served `GET /v1/meta` (extensions + health feed the dot; the
	 *  `coreViews` rows feed the skills/jobs tabs). */
	readonly meta: MetaResponse;
	/** The tab the router says is current (default "chats": hosts that
	 *  wire no routing only ever show chats). An explicit `null` is the
	 *  NO-TAB signal (the dev Blocks gallery rides a hash section outside
	 *  the tab router — no tab is active there). */
	readonly activeTab?: TabId | null;
	/** A tab click hands the tab id to the host's router (the hash write
	 *  + the tab memory live there). */
	readonly onOpenTab?: (tab: TabId) => void;
	/** Opens the dev Blocks gallery (U1 Task 6); rendered only when
	 *  `/v1/meta` reports `dev: true`. */
	readonly onOpenGallery?: () => void;
	/** The resolved principal (W1 Task 8): renders the user + sign-out
	 *  under the token method. */
	readonly identity?: WhoamiResponse;
	/** Ends the browser session (App wires logout + the gate flip). */
	readonly onLogout?: () => void;
	/**
	 * The extension surfaces the principal cannot see (access `none`,
	 * §6.5): `slug/id` keys. App discovers them from render-time
	 * responses; a hidden view renders NO rail entry.
	 */
	readonly hiddenExtSurfaces?: readonly string[];
	/**
	 * The rail's ext entries, controlled (App owns the ordering state so a
	 * keyboard reorder re-renders): the full ordered entry list minus the
	 * hidden set. Absent → the rail derives them (declaration order).
	 */
	readonly extViewEntries?: readonly ExtViewEntry[];
	/** Keyboard reorder (Alt+ArrowUp/Down on a focused ext entry): App
	 *  owns the saved-order state. */
	readonly onMoveExtView?: (key: string, delta: -1 | 1) => void;
	/** Bell at the top of the rail (notices Task 6): App passes its
	 *  notices bundle (count + pane toggle + open state). */
	readonly bell?: ReactNode;
}) {
	const { meta, identity, onLogout } = props;
	const { onOpenGallery } = props;
	const browserSession = identity?.method === "token" || identity?.method === "session";
	// undefined → the chats default; null → NO active tab (the gallery).
	const activeTab: TabId | null =
		props.activeTab === undefined ? "chats" : props.activeTab;
	// The extension-view entries (U3 Task 5): after the core entries,
	// in the user's saved order, minus the access-none set. App passes
	// them controlled (a reorder re-renders); the fallback derivation
	// covers hosts that don't wire the state.
	const hidden = new Set(props.hiddenExtSurfaces ?? []);
	const extViews = (
		props.extViewEntries ??
		orderExtViews(extViewEntries(meta.extensions), loadRailOrder())
	).filter((entry) => !hidden.has(`${entry.slug}/${entry.id}`));
	// The core-view tabs (Task 4's `coreViewEntries`): render ONLY when
	// the served meta lists them — a server without core views shows no
	// dead tabs.
	const coreViews = coreViewEntries(meta);
	return (
		<nav className="rail" aria-label="sections">
			{props.bell}
			<span className="rail-brand" title="sigrun">
				<BrandMark />
			</span>
			<TabButton
				tab="chats"
				title="Chats"
				active={activeTab === "chats"}
				onOpenTab={props.onOpenTab}
			>
				<ChatsIcon />
			</TabButton>
			{meta.dev && onOpenGallery !== undefined && (
				<button
					type="button"
					className="rail-btn"
					data-rail-section="blocks"
					title="Blocks"
					aria-label="blocks gallery"
					onClick={onOpenGallery}
				>
					<BlocksIcon />
				</button>
			)}
			{coreViews.map((view) => {
				const tab: TabId = `ext:core/${view.id}`;
				return (
					<TabButton
						key={`core/${view.id}`}
						tab={view.id === "skills" || view.id === "jobs" ? view.id : tab}
						title={view.title}
						active={activeTab === (view.id === "skills" || view.id === "jobs" ? view.id : tab)}
						onOpenTab={props.onOpenTab}
					>
						<Icon name={view.icon as IconName} size={18} />
					</TabButton>
				);
			})}
			{extViews.map((entry: ExtViewEntry) => {
				const tab: TabId = `ext:${entry.slug}/${entry.id}`;
				const active = activeTab === tab;
				return (
					<TabButton
						key={`${entry.slug}/${entry.id}`}
						tab={tab}
						title={entry.title}
						active={active}
						onOpenTab={props.onOpenTab}
						onKeyDown={(event) => {
							// The reorder affordance (a client preference, §7.1):
							// Alt+Arrow moves the entry one slot; App persists.
							if (!event.altKey) return;
							if (event.key === "ArrowUp") {
								event.preventDefault();
								props.onMoveExtView?.(`${entry.slug}/${entry.id}`, -1);
							} else if (event.key === "ArrowDown") {
								event.preventDefault();
								props.onMoveExtView?.(`${entry.slug}/${entry.id}`, 1);
							}
						}}
					>
						<Icon name={entry.icon as IconName} size={18} />
					</TabButton>
				);
			})}
			<span className="rail-spacer" />
			<span
				className="rail-health"
				data-health={healthOf(meta)}
				title={healthTitle(meta)}
			/>
			{browserSession && (
				<span
					className="rail-user"
					data-rail-user={identity.user ?? ""}
					title={
						identity.user === undefined
							? "signed in"
							: `signed in as ${identity.user}`
					}
				>
					{identity.user ?? "—"}
				</span>
			)}
			{browserSession && onLogout !== undefined && (
				<button
					type="button"
					className="rail-btn"
					data-rail-section="logout"
					title="Sign out"
					aria-label="sign out"
					onClick={onLogout}
				>
					<LogoutIcon />
				</button>
			)}
			<TabButton
				tab="settings"
				title="Settings"
				active={activeTab === "settings"}
				onOpenTab={props.onOpenTab}
			>
				<SettingsIcon />
			</TabButton>
		</nav>
	);
}
