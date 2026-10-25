/**
 * Rail (B2, UI refresh): the 52px section rail — the brand mark, the one
 * active **Chats** entry, a spacer, the health dot, and the Settings
 * button (the settings dialog itself stays App-owned; B7 restyles it).
 *
 * W1 Task 8: the resolved identity renders here — under the token
 * method the user's name sits above the sign-out action (a session
 * cookie is a thing you can END); the naive/proxy methods carry no
 * browser-side credential to drop, so they show neither.
 *
 * The health dot collapses the old TopBar's badge row into one quiet
 * indicator: `data-health="ok"` only when every extension is `ok`,
 * `health.memory`/`health.providers` are `ok`, and `health.backup` is not
 * `"degraded"`; anything else is `"degraded"`. The dot's `title` is the
 * hover surface — the extension list ("extensions: none" when empty) and
 * `backup: <status>`.
 */

import type { MetaResponse, WhoamiResponse } from "../api";
import { BlocksIcon, BrandMark, ChatsIcon, LogoutIcon, SettingsIcon } from "./icons";
import {
	extViewEntries,
	loadRailOrder,
	moveExtView,
	orderExtViews,
	type ExtViewEntry,
} from "./extViews";

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

export function Rail(props: {
	/** The served `GET /v1/meta` (extensions + health feed the dot). */
	readonly meta: MetaResponse;
	/** Opens the settings dialog (App owns the dialog). */
	readonly onOpenSettings: () => void;
	/** Opens the dev Blocks gallery (U1 Task 6); rendered only when
	 *  `/v1/meta` reports `dev: true`. */
	readonly onOpenGallery?: () => void;
	/** The resolved principal (W1 Task 8): renders the user + sign-out
	 *  under the token method. */
	readonly identity?: WhoamiResponse;
	/** Ends the browser session (App wires logout + the gate flip). */
	readonly onLogout?: () => void;
	/**
	 * UI-blocks U3 Task 5: opens an extension VIEW (slug, id). Absent
	 * in hosts that don't wire the route (the entries render inert).
	 */
	readonly onOpenExtView?: (slug: string, id: string) => void;
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
}) {
	const { meta, onOpenSettings, identity, onLogout } = props;
	const { onOpenGallery } = props;
	const browserSession = identity?.method === "token" || identity?.method === "session";
	// The extension-view entries (U3 Task 5): after the core entries,
	// in the user's saved order, minus the access-none set. App passes
	// them controlled (a reorder re-renders); the fallback derivation
	// covers hosts that don't wire the state.
	const hidden = new Set(props.hiddenExtSurfaces ?? []);
	const extViews = (
		props.extViewEntries ??
		orderExtViews(extViewEntries(meta.extensions), loadRailOrder())
	).filter((entry) => !hidden.has(`${entry.slug}/${entry.id}`));
	return (
		<nav className="rail" aria-label="sections">
			<span className="rail-brand" title="sigrun">
				<BrandMark />
			</span>
			<button
				type="button"
				className="rail-btn rail-btn-active"
				data-rail-section="chats"
				title="Chats"
				aria-current="page"
			>
				<ChatsIcon />
			</button>
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
			{extViews.map((entry: ExtViewEntry) => (
				<button
					key={`${entry.slug}/${entry.id}`}
					type="button"
					className="rail-btn"
					data-rail-section={`ext:${entry.slug}/${entry.id}`}
					title={entry.title}
					aria-label={entry.title}
					onClick={() => props.onOpenExtView?.(entry.slug, entry.id)}
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
					{entry.title.slice(0, 1)}
				</button>
			))}
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
			<button
				type="button"
				className="rail-btn"
				data-rail-section="settings"
				title="Settings"
				aria-label="settings"
				onClick={onOpenSettings}
			>
				<SettingsIcon />
			</button>
		</nav>
	);
}
