/**
 * The extension-view rail entries (UI-blocks U3 Task 5, spec §7.1): one
 * entry per extension `view` surface, ordered by the user's saved rail
 * order (`localStorage sigrun.railOrder`), unknown entries last in
 * declaration order. Access-none filtering happens in the APP (per
 * §6.5 the none rule is render-time, not list-time) — this module is the
 * pure ordering/derivation, so the rail component stays declarative.
 */

/** The extension row the rail/panel registration needs: the meta
 *  response's per-extension shape (name + status + surfaces rows). The
 *  full ExtensionInfoWire (with interactionKinds/ambientKeys/workers) is
 *  the /v1/extensions route's row; the rail reads the META row so the
 *  shell never fetches twice. */
export interface ExtensionSurfaceRow {
	readonly name: string;
	readonly status: string;
	readonly surfaces?: readonly {
		readonly id: string;
		readonly title: string;
		readonly icon: string;
		readonly placement: "view" | "panel";
	}[];
}

/** One extension-view rail entry (the rail renders one button per entry). */
export interface ExtViewEntry {
	/** The extension slug (`/v1/ext/<slug>/`). */
	readonly slug: string;
	/** The surface id within the extension. */
	readonly id: string;
	/** The declared title (the button's label/tooltip). */
	readonly title: string;
	/** The declared icon name (the button's glyph). */
	readonly icon: string;
}

/** The localStorage key the saved order rides (a client preference). */
export const RAIL_ORDER_KEY = "sigrun.railOrder";

/** The composite key one entry orders by (`slug/id` — a view id is
 *  unique within its extension). */
export function entryKey(entry: ExtViewEntry): string {
	return `${entry.slug}/${entry.id}`;
}

/**
 * The flat list of extension VIEW surfaces over the extensions response
 * (views only — panels register on the right panel, not the rail).
 */
export function extViewEntries(
	extensions: readonly ExtensionSurfaceRow[],
): ExtViewEntry[] {
	const entries: ExtViewEntry[] = [];
	for (const extension of extensions) {
		if (extension.status !== "ok") continue;
		for (const surface of extension.surfaces ?? []) {
			if (surface.placement !== "view") continue;
			entries.push({
				slug: extension.name,
				id: surface.id,
				title: surface.title,
				icon: surface.icon,
			});
		}
	}
	return entries;
}

/** The flat list of extension PANEL surfaces (the right panel's tabs). */
export function extPanelEntries(
	extensions: readonly ExtensionSurfaceRow[],
): ExtViewEntry[] {
	const entries: ExtViewEntry[] = [];
	for (const extension of extensions) {
		if (extension.status !== "ok") continue;
		for (const surface of extension.surfaces ?? []) {
			if (surface.placement !== "panel") continue;
			entries.push({
				slug: extension.name,
				id: surface.id,
				title: surface.title,
				icon: surface.icon,
			});
		}
	}
	return entries;
}

/**
 * The localStorage seam: resolved lazily per call (tests install a stub
 * before EACH test — a module-level snapshot would capture the pre-test
 * global). Absent → session-only behavior.
 */
function storage(): Storage | undefined {
	return (globalThis as { localStorage?: Storage }).localStorage;
}

/** A minimal in-memory store for hosts without localStorage (tests). */
export function memoryStorage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() { return map.size; },
		clear: () => map.clear(),
		getItem: (key) => map.get(key) ?? null,
		key: (index) => [...map.keys()][index] ?? null,
		removeItem: (key) => { map.delete(key); },
		setItem: (key, value) => { map.set(key, value); },
	};
}

/** Load the saved order (absent/garbage → the empty list: declaration order). */
export function loadRailOrder(): readonly string[] {
	try {
		const raw = storage()?.getItem(RAIL_ORDER_KEY);
		if (raw === null || raw === undefined) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

/** Persist the order (a failing store keeps it session-only). */
export function saveRailOrder(order: readonly string[]): void {
	try {
		storage()?.setItem(RAIL_ORDER_KEY, JSON.stringify(order));
	} catch {
		// private browsing: session-only
	}
}

/**
 * Order the entries by the saved key order; unknown keys (new views)
 * append in declaration order; stale keys (removed views) drop out.
 */
export function orderExtViews(
	entries: readonly ExtViewEntry[],
	saved: readonly string[],
): ExtViewEntry[] {
	const byKey = new Map(entries.map((entry) => [entryKey(entry), entry]));
	const ordered: ExtViewEntry[] = [];
	const used = new Set<string>();
	for (const key of saved) {
		const entry = byKey.get(key);
		if (entry !== undefined && !used.has(key)) {
			ordered.push(entry);
			used.add(key);
		}
	}
	for (const entry of entries) {
		if (!used.has(entryKey(entry))) ordered.push(entry);
	}
	return ordered;
}
