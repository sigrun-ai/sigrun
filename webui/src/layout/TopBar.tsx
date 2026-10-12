/**
 * TopBar (Task 25): the header over the three-panel shell.
 *
 * - The sigrun brand.
 * - The extension-set badge (spec §6.1 "Surface visibility"): the enabled
 *   extension set rendered from `GET /v1/meta` (`extensions[].name`), a
 *   read-only per-deployment view. A QUARANTINED extension (boot-failed,
 *   `extensions[].status`) renders distinctly — the badge goes to the
 *   degraded style and the name carries a ⚠ marker.
 * - The degraded-health badges: `health.backup` anything-but-configured
 *   renders `backup: <status>` (the unconfigured-backup badge, core spec
 *   §4.3); `memory` / `providers` render when `degraded`.
 * - The theme controls (toggle + accent picker) on the right.
 * - The settings gear (Task 8c): opens the SettingsPanel over
 *   `GET/PATCH /v1/settings`.
 */

import { useState } from "react";
import type { MetaResponse, SigrunClient } from "../api";
import { SettingsPanel } from "../settings/SettingsPanel";
import { ThemeControls } from "../theme/ThemeControls";
import type { ThemeState } from "../theme/useTheme";

/** One health badge, derived from the meta's health block. */
interface HealthBadge {
	readonly key: string;
	readonly label: string;
}

function healthBadges(meta: MetaResponse): readonly HealthBadge[] {
	const badges: HealthBadge[] = [];
	if (meta.health.backup !== "configured") {
		badges.push({ key: "backup", label: `backup: ${meta.health.backup}` });
	}
	if (meta.health.memory === "degraded") {
		badges.push({ key: "memory", label: "memory: degraded" });
	}
	if (meta.health.providers === "degraded") {
		badges.push({ key: "providers", label: "providers: degraded" });
	}
	return badges;
}

export function TopBar(props: {
	meta: MetaResponse;
	theme: ThemeState;
	client: SigrunClient;
}) {
	const { meta, theme, client } = props;
	const [settingsOpen, setSettingsOpen] = useState(false);
	const quarantined = meta.extensions.filter(
		(extension) => extension.status !== "ok",
	);
	const extensionText =
		meta.extensions.length === 0
			? "ext: none"
			: `ext: ${meta.extensions
					.map((extension) =>
						extension.status === "ok"
							? extension.name
							: `${extension.name} ⚠`,
					)
					.join(" · ")}`;
	const extensionTitle = meta.extensions
		.map((extension) => `${extension.name}: ${extension.status}`)
		.join("; ");
	return (
		<header className="top-bar">
			<span className="brand">sigrun</span>
			<span
				className={
					quarantined.length > 0
						? "badge badge-extensions badge-degraded"
						: "badge badge-extensions"
				}
				title={`Extensions from GET /v1/meta — ${extensionTitle}`}
			>
				{extensionText}
			</span>
			{healthBadges(meta).map((badge) => (
				<span
					key={badge.key}
					className="badge badge-degraded"
					title="health from GET /v1/meta"
				>
					{badge.label}
				</span>
			))}
			<span className="spacer" />
			<ThemeControls theme={theme} />
			<button
				type="button"
				className="settings-gear"
				title="settings"
				aria-label="settings"
				onClick={() => setSettingsOpen(true)}
			>
				⚙
			</button>
			{settingsOpen && (
				<SettingsPanel
					client={client}
					onClose={() => setSettingsOpen(false)}
				/>
			)}
		</header>
	);
}
