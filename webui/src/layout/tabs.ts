/**
 * The tab model (tabs+skills Task 1): every web UI view is a TAB on
 * desktop. The rail renders one tab per view; each tab remembers the
 * route it was last seen on (mirrored to sessionStorage under
 * `sigrun.tabs`), so switching back lands where the user left off, and
 * the browser's back/forward walk the tab switches WITH their routes.
 *
 * Pure module — App wires it to the hash router. The route type lives
 * in App.tsx (it owns the router); `tabOfRoute` takes its shape
 * structurally so this module never imports the shell.
 */

/** A route as the router represents it (App.tsx's `Route` union,
 *  mirrored structurally). */
export interface TabRoute {
	readonly kind: "chat" | "settings" | "ext";
	readonly conversationId?: number;
	readonly section?: string;
	readonly slug?: string;
	readonly id?: string;
	readonly params?: Readonly<Record<string, unknown>>;
}

/** One tab per view. Extension views are `ext:<slug>/<id>`; the core
 *  skills/jobs views are their own tabs (they ARE ext routes on the
 *  `core` slug — `tabOfRoute` does the mapping). */
export type TabId =
	| "chats"
	| "skills"
	| "jobs"
	| "settings"
	| `ext:${string}/${string}`;

/** The sessionStorage key the memory mirrors to (a per-session client
 *  preference — a fresh tab opens on the defaults, never localStorage). */
export const TAB_MEMORY_KEY = "sigrun.tabs";

/** The route → tab mapping. The `#/c[/<id>]` hashes are Chats; core
 *  skills/jobs surfaces are their own tabs; every other ext view is
 *  `ext:<slug>/<id>`. */
export function tabOfRoute(route: TabRoute): TabId {
	if (route.kind === "chat") return "chats";
	if (route.kind === "settings") return "settings";
	if (route.slug === "core" && route.id === "skills") return "skills";
	if (route.slug === "core" && route.id === "jobs") return "jobs";
	return `ext:${route.slug ?? ""}/${route.id ?? ""}`;
}

/** A tab's default hash — where a first-ever click lands (before the
 *  tab has ever been seen). The ext default is the params-less route. */
function defaultHash(tab: TabId): string {
	if (tab === "chats") return "#/c";
	if (tab === "skills") return "#/ext/core/skills";
	if (tab === "jobs") return "#/ext/core/jobs";
	if (tab === "settings") return "#/settings";
	const match = /^ext:([^/]+)\/(.+)$/.exec(tab);
	if (match === null) return "#/c";
	return `#/ext/${encodeURIComponent(match[1] ?? "")}/${encodeURIComponent(match[2] ?? "")}`;
}

/** The store seam: resolved per call (tests install the stub before
 *  each render — a module-level snapshot would capture the pre-test
 *  global). Absent → session-only behavior. */
function storage(): Storage | undefined {
	return (globalThis as { sessionStorage?: Storage }).sessionStorage;
}

/**
 * The remembered route per tab. `remember` records the route a tab was
 * last seen on; `routeFor` answers the tab's remembered hash (or its
 * default). Mirrored to sessionStorage so a reload keeps the routes;
 * a missing/garbage store degrades to in-memory defaults.
 */
export class TabMemory {
	readonly #routes: Map<TabId, string>;

	constructor() {
		this.#routes = new Map();
		try {
			const raw = storage()?.getItem(TAB_MEMORY_KEY);
			if (raw === null || raw === undefined) return;
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				return;
			}
			for (const [tab, hash] of Object.entries(parsed)) {
				if (typeof hash === "string") {
					this.#routes.set(tab as TabId, hash);
				}
			}
		} catch {
			// A failing store (private browsing) keeps the defaults.
		}
	}

	/** Record the route a tab was last seen on (every route change). */
	remember(tab: TabId, hash: string): void {
		this.#routes.set(tab, hash);
		try {
			storage()?.setItem(
				TAB_MEMORY_KEY,
				JSON.stringify(Object.fromEntries(this.#routes)),
			);
		} catch {
			// A failing store keeps the memory session-only.
		}
	}

	/** The tab's remembered hash, or its default before any remember. */
	routeFor(tab: TabId): string {
		return this.#routes.get(tab) ?? defaultHash(tab);
	}
}
