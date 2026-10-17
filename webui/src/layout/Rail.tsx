/**
 * Rail (B2, UI refresh): the 52px section rail — the brand mark, the one
 * active **Chats** entry, a spacer, the health dot, and the Settings
 * button (the settings dialog itself stays App-owned; B7 restyles it).
 *
 * The health dot collapses the old TopBar's badge row into one quiet
 * indicator: `data-health="ok"` only when every extension is `ok`,
 * `health.memory`/`health.providers` are `ok`, and `health.backup` is not
 * `"degraded"`; anything else is `"degraded"`. The dot's `title` is the
 * hover surface — the extension list ("extensions: none" when empty) and
 * `backup: <status>`.
 */

import type { MetaResponse } from "../api";
import { BrandMark, ChatsIcon, SettingsIcon } from "./icons";

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
}) {
	const { meta, onOpenSettings } = props;
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
			<span className="rail-spacer" />
			<span
				className="rail-health"
				data-health={healthOf(meta)}
				title={healthTitle(meta)}
			/>
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
