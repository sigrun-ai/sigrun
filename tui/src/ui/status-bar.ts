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
 *
 * Mouse (Task C3, additive to ctrl+p/ctrl+t): a left click on the right
 * cluster's MODEL segment fires {@link StatusBar.onModelClick} (the model
 * picker), one on the THINKING segment fires
 * {@link StatusBar.onThinkingClick} (the cycle). The hit ranges mirror
 * render()'s full/compact fallback, so a narrowed bar never mis-hits a
 * dropped segment.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
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
	/**
	 * The vim `:` command line (C4): rendered after `message` and NOT
	 * subject to the flash TTL — it persists for the whole command mode
	 * (a slow typist must never lose the line mid-edit).
	 */
	readonly commandLine?: string;
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
	const tail = state.commandLine ?? state.message ?? state.hints.join(" ");
	return tail === "" ? head : `${head}${SEPARATOR}${tail}`;
}

/** The narrow-width right cluster: thinking (and hints) dropped. */
function rightClusterCompact(state: StatusBarState): string {
	const parts: string[] = [];
	if (state.model !== undefined) parts.push(state.model);
	if (state.contextPct !== undefined) parts.push(`ctx ${Math.round(state.contextPct)}%`);
	if (state.commandLine !== undefined) parts.push(state.commandLine);
	return parts.join(SEPARATOR);
}

export class StatusBar implements Component {
	/** Click sink for the right cluster's model segment (the picker). */
	public onModelClick: (() => void) | undefined;
	/** Click sink for the right cluster's thinking segment (the cycle). */
	public onThinkingClick: (() => void) | undefined;
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

	/** The current state (the app's flash/config snapshot reads it). */
	public getState(): StatusBarState {
		return this.state;
	}

	private armMessageExpiry(): void {
		if (this.messageTimer !== undefined) clearTimeout(this.messageTimer);
		this.messageTimer = setTimeout(() => {
			this.messageTimer = undefined;
			const { message: _message, ...rest } = this.state;
			this.state = rest;
		}, this.messageMs);
	}

	/**
	 * The mouse surface: dispatch a left click on the model / thinking
	 * segment; everything else (the left side, ctx, hints, other buttons)
	 * passes through.
	 */
	public handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		for (const range of this.segmentRanges(event.width)) {
			if (event.x < range.start || event.x >= range.end) continue;
			const sink = range.kind === "model" ? this.onModelClick : this.onThinkingClick;
			if (sink === undefined) return undefined;
			sink();
			return { handled: true };
		}
		return undefined;
	}

	/**
	 * The model/thinking segments' cell ranges under render()'s layout:
	 * the full right cluster, or the compact fallback (thinking dropped).
	 * The truncated-compact case keeps the compact offsets — cells past
	 * the width cannot be clicked anyway.
	 */
	private segmentRanges(
		width: number,
	): readonly { kind: "model" | "thinking"; start: number; end: number }[] {
		const leftWidth = visibleWidth(this.renderLeft());
		const useFull = leftWidth + 2 + visibleWidth(rightCluster(this.state)) <= width;
		const parts: { kind: "model" | "thinking" | "ctx"; text: string }[] = [];
		if (this.state.model !== undefined) parts.push({ kind: "model", text: this.state.model });
		if (useFull && this.state.thinking !== undefined)
			parts.push({ kind: "thinking", text: this.state.thinking });
		if (this.state.contextPct !== undefined)
			parts.push({ kind: "ctx", text: `ctx ${Math.round(this.state.contextPct)}%` });
		const ranges: { kind: "model" | "thinking"; start: number; end: number }[] = [];
		let cursor = leftWidth + 2;
		for (const part of parts) {
			const end = cursor + visibleWidth(part.text);
			if (part.kind !== "ctx") ranges.push({ kind: part.kind, start: cursor, end });
			cursor = end + visibleWidth(SEPARATOR);
		}
		return ranges;
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
