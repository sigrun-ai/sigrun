/**
 * The user notices surface (notices Task 8): the per-user notice list in
 * the TUI — an inline line between the ambient chrome and the composer,
 * and a centred overlay with the full pile.
 *
 * - The INLINE LINE shows the current conversation's newest notice
 *   (a notice carrying this conversationId), falling back to the newest
 *   app-wide notice (no conversationId). Zero height when empty.
 * - The OVERLAY lists every notice as a plain-text card: tone marker,
 *   title, body, buttons, age (no emoji — the TUI avoids double-width
 *   glyphs). Arrows move over the action rows, Enter runs the selected
 *   action, `d` dismisses its notice, Esc/q/C-g closes.
 *
 * Action semantics mirror the webui's `useNotices.run`: `navigate`
 * routes through {@link NoticeChrome.onNavigate} then dismisses, `open`
 * prints the URL through {@link NoticeChrome.onOpenUrl} (the TUI cannot
 * open a browser — the URL is the hand-off) then dismisses, and
 * `extension` POSTs the action route and surfaces the response's
 * `message`/`error` through {@link NoticeChrome.onResult}.
 *
 * Freshness (W3 Task 4's idiom): the app kicks on `notice.changed`
 * host events and on the events-stream hello (a reconnect heals the
 * list). Fetch failures are QUIET (best-effort chrome).
 */

import { Key, matchesKey, type Component, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import type { CoreTarget, Tone } from "@sigrun/shared/blocks";
import type { SigrunClient, UserNotice, UserNoticeAction } from "../api.js";
import { truncate } from "../blocks/width.js";
import { plainTuiTheme, type TuiTheme } from "../theme.js";

/** A compact relative age ("2 min", "1 h", "just now"). */
export function relativeAge(at: string, now = Date.now()): string {
	const then = Date.parse(at);
	if (Number.isNaN(then)) return "";
	const seconds = Math.max(0, Math.floor((now - then) / 1000));
	if (seconds < 45) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} h`;
	return `${Math.floor(hours / 24)} d`;
}

/** The plain-text tone marker (ASCII only — no double-width glyphs). */
function toneMark(tone: Tone | undefined): string {
	switch (tone) {
		case "bad":
			return "[!]";
		case "warn":
			return "[?]";
		case "good":
			return "[+]";
		case "info":
			return "[i]";
		case "accent":
			return "[*]";
		default:
			return "[-]";
	}
}

export interface NoticeOverlayOptions {
	/** Fires on close so the app can clear its overlayOpen flag. */
	readonly onClose?: () => void;
}

/** One selectable row: an action of a notice (undefined = dismiss-only). */
interface OverlayRow {
	readonly notice: UserNotice;
	readonly action: UserNoticeAction | undefined;
}

/** The overlay component (mounted through `tui.showOverlay`). */
class NoticesOverlay implements Component {
	readonly #chrome: NoticeChrome;
	readonly #options: NoticeOverlayOptions;
	#overlay: OverlayHandle | undefined;
	/** The selected row index into {@link rows}. */
	#index = 0;

	constructor(chrome: NoticeChrome, options: NoticeOverlayOptions) {
		this.#chrome = chrome;
		this.#options = options;
	}

	setOverlay(overlay: OverlayHandle): void {
		this.#overlay = overlay;
	}

	/** The flattened action rows (the chrome's list, newest first). */
	get rows(): readonly OverlayRow[] {
		const rows: OverlayRow[] = [];
		for (const notice of this.#chrome.notices) {
			const actions = notice.actions ?? [];
			if (actions.length === 0) {
				rows.push({ notice, action: undefined });
			} else {
				for (const action of actions) rows.push({ notice, action });
			}
		}
		return rows;
	}

	#close(): void {
		this.#overlay?.hide();
		this.#options.onClose?.();
	}

	#runSelected(): void {
		const row = this.rows[this.#index];
		if (row === undefined || row.action === undefined) return;
		void this.#chrome.run(row.notice, row.action);
	}

	#dismissSelected(): void {
		const row = this.rows[this.#index];
		if (row === undefined) return;
		void this.#chrome.dismiss(row.notice.id);
		if (this.#index > 0) this.#index -= 1;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q" || data === "\x07") {
			this.#close();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "up")) {
			this.#index = Math.max(0, this.#index - 1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "down")) {
			this.#index = Math.min(this.rows.length - 1, this.#index + 1);
			return;
		}
		if (matchesKey(data, Key.enter) || data === "\r") {
			this.#runSelected();
			return;
		}
		if (data === "d") {
			this.#dismissSelected();
			return;
		}
		// Every other key is consumed: the overlay is modal.
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const rows = this.rows;
		let rowIndex = 0;
		lines.push(`notices (${rows.length}) — enter run · d dismiss · esc close`);
		for (const notice of this.#chrome.notices) {
			const age = relativeAge(notice.at);
			lines.push(
				`${toneMark(notice.tone)} ${notice.title}${age === "" ? "" : ` · ${age}`}`,
			);
			if (notice.body !== undefined && notice.body !== "") {
				lines.push(`  ${notice.body}`);
			}
			const actions = notice.actions ?? [];
			if (actions.length === 0) {
				lines.push(`${rowIndex === this.#index ? "> " : "  "}(dismiss)`);
				rowIndex += 1;
			} else {
				for (const action of actions) {
					lines.push(`${rowIndex === this.#index ? "> " : "  "}${action.label}`);
					rowIndex += 1;
				}
			}
		}
		if (this.#chrome.notices.length === 0) lines.push("no notices");
		return lines.map((line) => truncate(line, width));
	}

	invalidate(): void {}
}

export class NoticeChrome implements Component {
	readonly #client: SigrunClient;
	readonly #theme: TuiTheme;

	#notices: readonly UserNotice[] = [];
	#conversationId: number | undefined;
	/** Monotonic fetch generation: a stale fetch never lands. */
	#gen = 0;

	/** Rendered-state changes (the app repaints + repaints the count). */
	onChanged?: () => void;
	/** An action result's text (the app shows it as a pane notice). */
	onResult?: (text: string) => void;
	/** An `open` action's URL (the app prints it — the TUI has no browser). */
	onOpenUrl?: (url: string) => void;
	/** A `navigate` action's core target (the app routes it). */
	onNavigate?: (target: CoreTarget) => void;

	constructor(client: SigrunClient, options: { theme?: TuiTheme } = {}) {
		this.#client = client;
		this.#theme = options.theme ?? plainTuiTheme();
	}

	/** The latest served notices (newest first). */
	get notices(): readonly UserNotice[] {
		return this.#notices;
	}

	/**
	 * The inline line's notice: the newest notice scoped to the current
	 * conversation, else the newest app-wide notice, else undefined.
	 */
	inlineNotice(): UserNotice | undefined {
		const scoped = this.#notices.find(
			(one) => one.conversationId !== undefined && one.conversationId === this.#conversationId,
		);
		if (scoped !== undefined) return scoped;
		return this.#notices.find((one) => one.conversationId === undefined);
	}

	/** The current conversation (the inline line's scope). */
	setConversation(id: number | undefined): void {
		if (id === this.#conversationId) return;
		this.#conversationId = id;
		this.#changed();
	}

	/** Refetch (`notice.changed`, a reconnect hello). Quiet on failure. */
	kick(): void {
		void this.refresh();
	}

	/** The list GET (quiet: a failed fetch keeps the last list). */
	async refresh(): Promise<void> {
		const gen = ++this.#gen;
		let list;
		try {
			list = await this.#client.listNotices();
		} catch {
			return; // quiet: keep the last pile
		}
		if (gen !== this.#gen) return; // stale
		this.#notices = list.notices;
		this.#changed();
	}

	/** Dismiss one notice (204); the list refetches after the write. */
	async dismiss(id: string): Promise<void> {
		await this.#client.dismissNotice(id).catch(() => undefined);
		await this.refresh();
	}

	/** Dismiss the inline line's notice (the dismiss key). */
	async dismissNewest(): Promise<void> {
		const newest = this.inlineNotice();
		if (newest === undefined) return;
		await this.dismiss(newest.id);
	}

	/**
	 * Run one notice action (the webui's `useNotices.run` semantics):
	 * `navigate` routes then dismisses; `open` prints the URL then
	 * dismisses; `extension` POSTs the action route, surfaces the
	 * result text, and refetches (a server-side clear is then visible).
	 */
	async run(notice: UserNotice, action: UserNoticeAction): Promise<void> {
		if (action.kind === "navigate") {
			this.onNavigate?.(action.target);
			await this.dismiss(notice.id);
			return;
		}
		if (action.kind === "open") {
			this.onOpenUrl?.(action.url);
			await this.dismiss(notice.id);
			return;
		}
		try {
			const response = await this.#client.runNoticeAction(notice.id, action.id);
			if (response.ok && response.navigate !== undefined) {
				this.onNavigate?.(response.navigate);
			}
			const text = response.ok ? response.message : response.error.message;
			if (text !== undefined) this.onResult?.(text);
		} catch (cause) {
			// A rejected POST (404 stale card, 409 unavailable, network) is a
			// user-facing outcome: the notice stays on the server; the pile
			// heals to the truth on the refetch below.
			this.onResult?.(cause instanceof Error ? cause.message : String(cause));
		}
		await this.refresh();
	}

	/** Open the centred overlay (Enter runs, d dismisses, Esc closes). */
	openOverlay(tui: TUI, options: NoticeOverlayOptions = {}): void {
		const overlay = new NoticesOverlay(this, options);
		const handle = tui.showOverlay(overlay, {
			anchor: "center",
			width: "60%",
			maxHeight: "60%",
		});
		overlay.setOverlay(handle);
	}

	#changed(): void {
		this.onChanged?.();
	}

	/** The inline line: one row, or zero height without an inline notice. */
	render(width: number): string[] {
		const newest = this.inlineNotice();
		if (newest === undefined) return [];
		const age = relativeAge(newest.at);
		const line = `${toneMark(newest.tone)} ${newest.title}${age === "" ? "" : ` · ${age}`}`;
		return [truncate(this.#theme.fg("muted")(line), width)];
	}

	invalidate(): void {
		// Stateless render: the line assembles from the current list.
	}
}
