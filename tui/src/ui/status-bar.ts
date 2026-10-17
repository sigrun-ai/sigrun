/**
 * The status bar (Task C1, UI refresh): exactly one rendered line —
 * left: the mode chip on the accent background + the conversation name;
 * right: `model · thinking · ctx N%`, then the hint keys. A transient
 * `message` (4 s, timer-based) replaces the hints — stream notices ride
 * here. Narrow-width policy: drop hints first, then thinking; model and
 * ctx are the two facts that never drop (what model, how full).
 *
 * A pi-tui `Component` (`render(width): string[]`, one line) — mounting
 * is the launcher's layout job (basis 1), not this component's.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { TuiTheme } from "../theme.js";

export interface StatusBarState {
	/** The mode chip text (e.g. "attach"); absent → no chip. */
	readonly mode?: string;
	readonly conversation: string;
	readonly model?: string;
	/** The thinking indicator label (e.g. "thinking"); absent → dropped. */
	readonly thinking?: string;
	/** 0-100; absent → no ctx segment. */
	readonly contextPct?: number;
	readonly hints: readonly string[];
	/** Transient notice; replaces the hints for 4 s. */
	readonly message?: string;
}

export interface StatusBarOptions {
	readonly theme: TuiTheme;
	/** The message lifetime (ms); defaults to 4000. Tests may pin it. */
	readonly messageMs?: number;
}

const MESSAGE_MS = 4000;
const SEPARATOR = " · ";

/** Build the right cluster: model · thinking · ctx N%, then hints. */
function rightCluster(state: StatusBarState): string {
	const parts: string[] = [];
	if (state.model !== undefined) parts.push(state.model);
	if (state.thinking !== undefined) parts.push(state.thinking);
	if (state.contextPct !== undefined) parts.push(`ctx ${Math.round(state.contextPct)}%`);
	const head = parts.join(SEPARATOR);
	const tail = state.message ?? state.hints.join(" ");
	return tail === "" ? head : `${head}${SEPARATOR}${tail}`;
}

/** The narrow-width right cluster: thinking (and hints) dropped. */
function rightClusterCompact(state: StatusBarState): string {
	const parts: string[] = [];
	if (state.model !== undefined) parts.push(state.model);
	if (state.contextPct !== undefined) parts.push(`ctx ${Math.round(state.contextPct)}%`);
	return parts.join(SEPARATOR);
}

export class StatusBar implements Component {
	private readonly theme: TuiTheme;
	private readonly messageMs: number;
	private state: StatusBarState;
	private messageTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: StatusBarOptions, init?: Partial<StatusBarState>) {
		this.theme = options.theme;
		this.messageMs = options.messageMs ?? MESSAGE_MS;
		this.state = { conversation: "", hints: [], ...init };
	}

	/** Replace the state wholesale (the whole line is derived each render). */
	public set(state: StatusBarState): void {
		this.state = state;
		if (state.message !== undefined) {
			this.armMessageExpiry();
		}
	}

	private armMessageExpiry(): void {
		if (this.messageTimer !== undefined) clearTimeout(this.messageTimer);
		this.messageTimer = setTimeout(() => {
			this.messageTimer = undefined;
			const { message: _message, ...rest } = this.state;
			this.state = rest;
		}, this.messageMs);
	}

	/** No cached rendering state — the line is derived each render. */
	public invalidate(): void {}

	public render(width: number): string[] {
		const left = this.renderLeft();
		const full = `${left}  ${this.theme.fg("muted")(rightCluster(this.state))}`;
		if (visibleWidth(full) <= width) return [full];
		const compact = `${left}  ${this.theme.fg("muted")(rightClusterCompact(this.state))}`;
		if (visibleWidth(compact) <= width) return [compact];
		// Still too narrow: truncate the compact line to the width.
		return [truncateToWidth(compact, width, "…", true)];
	}

	private renderLeft(): string {
		const conversation = this.theme.fg("text")(this.state.conversation);
		if (this.state.mode === undefined || this.state.mode === "") {
			return conversation;
		}
		const chip = this.theme.bg("accent")(this.theme.bold(this.state.mode));
		return `${chip} ${conversation}`;
	}
}
