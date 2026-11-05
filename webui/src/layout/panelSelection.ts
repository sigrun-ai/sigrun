/**
 * panelSelection (todo Task 2): the ONE right-panel selection model.
 * Pure — no React; the only storage is the two load/save helpers at the
 * bottom (localStorage key "sigrun.panel", the pre-existing key).
 *
 * The selection is a single key: a core pane ("outline" | "workspace" |
 * "notices") or an extension panel ("ext:<slug>/<id>"). Clicking the
 * active key closes the panel; a stored key for a removed extension
 * panel resolves to closed.
 *
 * The notices pane is CHROME, not state (notices Task 6's behaviour,
 * unchanged): it is never persisted and never restored — a reload
 * reopens the last REAL panel.
 */

import type { ExtViewEntry } from "./extViews";
import { entryKey } from "./extViews";

export type PanelKey =
	| "outline"
	| "workspace"
	| "notices"
	| `ext:${string}/${string}`;

/** The extension panel's selection key (`ext:<slug>/<id>`). */
export function extPanelKey(slug: string, id: string): PanelKey {
	return `ext:${slug}/${id}`;
}

/** The localStorage key the persisted selection rides. */
export const PANEL_STORAGE_KEY = "sigrun.panel";

function storage(): Storage | undefined {
	return (globalThis as { localStorage?: Storage }).localStorage;
}

/**
 * Parse a stored/raw key. null, "none", garbage, and "notices" → null:
 * "notices" is chrome (never restorable) and "none" is the stored
 * closed sentinel. Anything else must be a core pane or an ext key.
 */
export function parsePanelKey(raw: string | null): PanelKey | null {
	if (raw === null) return null;
	if (raw === "outline" || raw === "workspace") return raw;
	if (raw.startsWith("ext:")) {
		const parts = raw.slice("ext:".length).split("/");
		if (parts.length === 2 && parts[0] !== "" && parts[1] !== "") {
			return raw as PanelKey;
		}
		return null;
	}
	// "none", "notices", garbage → closed.
	return null;
}

/** Clicking the active key closes the panel; any other key switches. */
export function togglePanel(
	current: PanelKey | null,
	clicked: PanelKey,
): PanelKey | null {
	return current === clicked ? null : clicked;
}

/**
 * Gate the selection on the panels actually installed: an ext key whose
 * panel is not in `available` resolves to closed (a removed panel never
 * pins the panel open); core keys pass through.
 */
export function resolvePanel(
	key: PanelKey | null,
	available: readonly ExtViewEntry[],
): PanelKey | null {
	if (key === null || !key.startsWith("ext:")) return key;
	const wanted = key.slice("ext:".length);
	return available.some((entry) => entryKey(entry) === wanted) ? key : null;
}

/** Load the persisted selection (garbage/absent → null). "notices" is
 *  never returned (chrome, not state). */
export function loadPanelKey(): PanelKey | null {
	try {
		return parsePanelKey(storage()?.getItem(PANEL_STORAGE_KEY) ?? null);
	} catch {
		return null;
	}
}

/** Persist the selection (null stores the "none" sentinel; a failing
 *  store keeps it session-only). "notices" is NEVER written — the pane
 *  is chrome; the store keeps whatever the last real selection was. */
export function savePanelKey(key: PanelKey | null): void {
	if (key === "notices") return;
	try {
		storage()?.setItem(PANEL_STORAGE_KEY, key ?? "none");
	} catch {
		// private browsing: session-only
	}
}
