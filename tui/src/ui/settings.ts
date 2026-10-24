/**
 * The TUI Settings view (UI-blocks U4 Task 4, spec §13.4): the settings
 * panel's terminal twin — the section list from `GET
 * /v1/settings/sections` as a picker (the search IS the picker's fuzzy
 * filter: typing "naming" filters the index to General → Naming model;
 * picking it opens the section's form), each section rendered as a
 * block form ({@link SurfaceState} + {@link SurfaceView} over the
 * section's `/v1/ext/<slug>/surfaces/<id>` mount — ONE renderer across
 * core and extensions, the same code path the webui's SurfaceView
 * runs).
 *
 * Scope rulings (plan Task 4):
 * - **Interface** (client prefs) has no TUI-local state yet — the view
 *   renders it as its (empty) surface form; the prefs live in the
 *   webui's localStorage by design (§13.4's "client-side" ruling).
 * - **Providers** (the §7.6 credential flows) renders as its settings
 *   surface form; the per-provider readiness rows and the write-only
 *   credential editor are the webui's cove — the credential routes
 *   stay reachable through the API, and the TUI does not render the
 *   readiness list (a TUI cove is the follow-up).
 * - **Extensions**: an extension WITHOUT a declared settings section
 *   keeps its raw-JSON reachability as a NOTICE in the section list
 *   (one line naming its `/v1/extensions/<slug>/settings` routes —
 *   the raw JSON editor is the webui's cove).
 *
 * The pending-restart callout (§13.2/§13.3) renders above the section
 * body: the keys the General section's `meta` block carries, with the
 * Restart action when the server is supervised AND the session is an
 * admin (the app's `restart()` runs the §13.3 flow), otherwise the
 * text "Restart sigrun to apply".
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { JsonObject } from "@sigrun/shared/blocks";
import { filterSettingsIndex } from "@sigrun/shared/views";
import type {
	SettingsSectionEntry,
	SettingsSectionIndexEntry,
	SigrunClient,
} from "../api.js";
import { SurfaceState } from "../blocks/surface.js";
import { SurfaceView } from "../blocks/surface-view.js";
import { createExtSurfaceTransport } from "../blocks/ext-transport.js";
import type { TuiTheme } from "../theme.js";
import { openPicker, type PickerItem } from "./picker.js";

// The index filter is `@sigrun/shared`'s (U4 Task 4 round-2) — ONE
// implementation across the channels; the re-export keeps the view's
// pre-round-2 import surface.
export { filterSettingsIndex };

/** The settings view (the app's `/settings` mount). */
export class SettingsView implements Component {
	readonly #client: SigrunClient;
	readonly #tui: TUI;
	readonly #theme: TuiTheme;
	readonly #unicode: boolean;
	/** The app's restart action (§13.3) — the callout's Restart. */
	readonly #onRestart: () => Promise<void>;
	readonly #onClose: () => void;

	#sections: readonly SettingsSectionEntry[] = [];
	#index: readonly SettingsSectionIndexEntry[] = [];
	#error: string | undefined;
	/** The open section's surface (undefined = the section list). */
	#surface: { readonly state: SurfaceState; readonly view: SurfaceView; readonly id: string } | undefined;
	/** Section-less loaded extensions (the raw-JSON notice lines). */
	#sectionlessExtensions: readonly string[] = [];
	/** The pending-restart block (the General section's `meta`). */
	#pendingRestart: readonly string[] = [];
	#supervised = false;
	/** Admin defaults FALSE (the routes are admin-gated — an unknown
	 *  principal must not see the Restart affordance). */
	#admin = false;

	constructor(
		client: SigrunClient,
		options: {
			readonly tui: TUI;
			readonly theme: TuiTheme;
			readonly unicode: boolean;
			readonly onRestart: () => Promise<void>;
			readonly onClose: () => void;
		},
	) {
		this.#client = client;
		this.#tui = options.tui;
		this.#theme = options.theme;
		this.#unicode = options.unicode;
		this.#onRestart = options.onRestart;
		this.#onClose = options.onClose;
	}

	/** Load the sections list + the admin/supervised flags. */
	async load(): Promise<void> {
		try {
			const [sections, whoami, meta, extensions] = await Promise.all([
				this.#client.listSettingsSections(),
				this.#client.whoami().catch(() => undefined),
				this.#client.getBootMeta().catch(() => undefined),
				this.#client.listExtensions().catch(() => undefined),
			]);
			this.#sections = sections.sections;
			this.#index = sections.index;
			this.#admin = whoami?.admin === true;
			this.#supervised = meta?.supervised === true;
			// Section-less loaded extensions (the raw-JSON notice lines):
			// every listed extension whose slug declares NO settings section.
			const withSections = new Set(
				sections.sections.filter((entry) => entry.slug !== "core").map((entry) => entry.slug),
			);
			this.#sectionlessExtensions = (extensions?.extensions ?? [])
				.map((extension) => extension.name)
				.filter((name) => !withSections.has(name));
		} catch (cause: unknown) {
			this.#error = cause instanceof Error ? cause.message : String(cause);
		}
		this.#tui.requestRender();
	}

	/** The open section's id (undefined = the section list; tests read it). */
	get openSectionId(): string | undefined {
		return this.#surface?.id;
	}

	/** The pending-restart keys the General section's meta carried. */
	get pendingRestart(): readonly string[] {
		return this.#pendingRestart;
	}

	/** The section picker (the search: the picker's fuzzy filter is the
	 *  index query — typing "naming" filters to the Naming model row). */
	openSearch(): void {
		const items: PickerItem<SettingsSectionIndexEntry>[] = this.#index.map(
			(entry) => ({
				label: entry.label,
				detail: `${entry.slug === "core" ? "" : `${entry.slug} · `}${entry.sectionId}`,
				value: entry,
			}),
		);
		openPicker(this.#tui, items, {
			title: "Settings",
				onPick: (entry) => {
				const section = this.#sections.find(
					(candidate) =>
						candidate.slug === entry.slug && candidate.id === entry.sectionId,
				);
				if (section !== undefined) void this.openSection(section, entry.key);
			},
		});
	}

	/** Open one section (mount its surface). When a search hit carries
	 *  `focusKey`, the matching field takes the focus after load (the
	 *  search's resolve half — "naming" lands on the naming model row). */
	async openSection(section: SettingsSectionEntry, focusKey?: string): Promise<void> {
		this.#surface?.state.dispose();
		const token = this.#client.token;
		const user = this.#client.user;
		const transport = createExtSurfaceTransport({
			slug: section.slug,
			id: section.id,
			baseUrl: this.#baseUrl(),
			...(token === undefined ? {} : { token }),
			...(user === undefined ? {} : { user }),
			fetch: this.#client.fetch,
		});
		const state = new SurfaceState(transport.transport);
		const view = new SurfaceView(state, {
			theme: this.#theme,
			unicode: this.#unicode,
		});
		this.#surface = { state, view, id: section.id };
		state.onChange(() => {
			// The core sections' meta block feeds the callout (the
			// pendingRestart diff lands on EVERY core section's meta — a
			// save in Advanced flips the callout without reopening).
			if (section.slug === "core") {
				const meta = state.view.data.meta;
				if (
					typeof meta === "object" &&
					meta !== null &&
					!Array.isArray(meta) &&
					Array.isArray((meta as JsonObject).pendingRestart)
				) {
					this.#pendingRestart = (
						(meta as JsonObject).pendingRestart as unknown[]
					).filter((key): key is string => typeof key === "string");
					// The surface's `supervised` is authoritative for the
					// callout once the section loaded (the load() value is
					// the fallback for an unopened General).
					const supervised = (meta as JsonObject).supervised;
					if (typeof supervised === "boolean") this.#supervised = supervised;
				}
			}
			this.#tui.requestRender();
		});
		await state.load();
		if (focusKey !== undefined) view.focusField(focusKey);
		this.#tui.requestRender();
	}

	/** Back to the section list (Esc). Returns true when a section was open. */
	closeSection(): boolean {
		if (this.#surface === undefined) return false;
		this.#surface.state.dispose();
		this.#surface = undefined;
		this.#tui.requestRender();
		return true;
	}

	/** The callout's Restart action (the app wires it). */
	async restart(): Promise<void> {
		await this.#onRestart();
	}

	/** The transport's base URL (the client's — the client owns it). */
	#baseUrl(): string {
		return this.#client.baseUrl;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(truncateToWidth(this.#theme.bold("Settings"), width));
		if (this.#error !== undefined) {
			lines.push(truncateToWidth(this.#theme.fg("bad")(`error: ${this.#error}`), width));
			return lines;
		}
		// The pending-restart callout (§13.2/§13.3): the keys, plus the
		// Restart affordance when supervised + admin.
		if (this.#pendingRestart.length > 0) {
			lines.push(
				truncateToWidth(
					this.#theme.fg("warn")(
						`Restart sigrun to apply: ${this.#pendingRestart.join(", ")}`,
					),
					width,
				),
			);
			if (this.#supervised && this.#admin) {
				lines.push(
					truncateToWidth(
						this.#theme.dim("press ctrl+r to restart now"),
						width,
					),
				);
			}
		}
		if (this.#surface === undefined) {
			// The section list (the picker's items carry the search).
			if (this.#sections.length === 0) {
				lines.push(truncateToWidth(this.#theme.dim("loading…"), width));
				return lines;
			}
			lines.push(
				truncateToWidth(
					this.#theme.dim("/ to search · Enter opens · Esc closes"),
					width,
				),
			);
			for (const section of this.#sections) {
				lines.push(
					truncateToWidth(
						`  ${section.title}${section.slug === "core" ? "" : `  (${section.slug})`}`,
						width,
					),
				);
			}
			// Extensions WITHOUT a declared section keep their raw-JSON
			// routes reachable (the docblock's ruling): one notice line
			// per section-less extension naming its routes.
			for (const slug of this.#sectionlessExtensions) {
				// A plain (unstyled) line: the dim theme's escape codes would
				// break substring matching against the wire contract, and the
				// notice is informational, not chrome.
				lines.push(
					truncateToWidth(
						`  ${slug}: no settings section — raw JSON at GET/PUT /v1/extensions/${slug}/settings`,
						width,
					),
				);
			}
			return lines;
		}
		// The open section: its surface view renders below the callout.
		lines.push(...this.#surface.view.render(width));
		return lines;
	}

	handleInput(data: string): void {
		if (this.#surface !== undefined) {
			// The restart affordance is ctrl+r — a bare "r" is ordinary
			// text in a focused editor field and must type through.
			if (data === "\x12" && this.#supervised && this.#admin && this.#pendingRestart.length > 0) {
				void this.restart();
				return;
			}
			this.#surface.view.handleInput?.(data);
			return;
		}
	}

	dispose(): void {
		this.#surface?.state.dispose();
		this.#surface = undefined;
		this.#onClose();
	}

	invalidate(): void {
		this.#surface?.view.invalidate();
	}
}
