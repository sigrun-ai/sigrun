/**
 * The conversation pane (Task 6; restyled in C2, UI refresh): renders a
 * `ConversationViewWire`'s entries as TURNS (B1's `groupTurns`) instead
 * of raw entries — a user turn is the accent `▎` bar on every line, an
 * assistant turn is prose plus ONE collapsible activity line
 * (`▸ Thinking · 2 tools`; `▾` when open) that unfolds into the thinking
 * text and `✓ tool  preview` rows (`✗` error, `·` no result yet — the
 * wire carries no per-tool running marker, so `·` covers pending too).
 * `pi.compaction` renders the centred `── context compacted ──` divider. The `[tool]`/`[thinking]` tags of
 * the entry-era pane are gone.
 *
 * Task 2c: an EXPANDED input (`/skill:name`, a prompt template) is one
 * entry (`sigrun.user.expanded`, `data {typed, command}`, the expanded
 * text on `model`) that groups as a USER turn — the body is the TYPED
 * command with a dim `▸ expanded from /name` chip line that folds the
 * full admitted text open/closed (closed by default).
 *
 * Focus (the C3 action layer's seam): `focusIndex` names the focused
 * turn (`undefined` = none — the ScrollView follows the end), the
 * focused turn's FIRST line carries the `surface2` background and a `›`
 * gutter marker; `lineRangeOf` reports the turn's line offsets from the
 * last render for `ScrollView.scrollTo`; `textOf`/`entryIdOf` are the
 * copy payload and wire identity of a turn.
 *
 * Mouse (additive — the pane is fully keyboard-usable): each activity
 * line is a `MouseRegion` whose left click toggles the fold; a click on
 * a turn's body sets the focus to that turn.
 *
 * The SSE contract (Task 4): every snapshot/frame is a FULL revision, so
 * {@link showView} REPLACES the rendered state wholesale. Folds and
 * focus are keyed by turn INDEX within the latest view — a replacement
 * re-derives the turns and keeps the index-based state (the action
 * layer owns re-targeting when the structure shifts).
 *
 * Unknown entry kinds render a fail-visible fallback naming the kind
 * (the webui's rule — a new server-side kind must never vanish silently).
 *
 * Error/notice lines (Task 7): the composer surfaces its immediate
 * failures as `[error]`/`[notice]` rows. They are NOT stream state, so
 * {@link showView}'s wholesale replacement preserves them (fix wave F4:
 * the shell discards them on every conversation swap via
 * {@link ConversationPane.clearNotices}).
 */

import {
	Container,
	Markdown,
	MouseRegion,
	Text,
	type Component,
	type MarkdownTheme,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	activityLabel,
	expandedUserEntry,
	groupTurns,
	type Turn,
} from "@sigrun/shared/turns";
import type { SurfaceTransport } from "@sigrun/shared/blocks";
import { plainTuiTheme, type TuiTheme } from "../theme.js";
import type { ConversationViewWire } from "../api.js";
import { SurfaceState } from "../blocks/surface.js";
import { SurfaceView } from "../blocks/surface-view.js";

/** One §5 message's structural shape (B1's `TurnMessage` + content parts). */
interface MessageShape {
	readonly role: string;
	readonly content:
		| string
		| readonly {
				readonly type: string;
				readonly text?: string;
				readonly thinking?: string;
				readonly path?: string;
				readonly id?: string;
				readonly name?: string;
				readonly arguments?: unknown;
		  }[];
	readonly toolCallId?: string;	readonly toolName?: string;
	readonly isError?: boolean;
}

/** One §5 entry's structural shape (kind + optional model messages). */
export interface EntryShape {
	readonly id: number;
	readonly kind: string;
	readonly model?: readonly MessageShape[];
	/** The entry's kind-specific JSON payload — an expanded input's
	 *  `{typed, command}` (see `expandedUserEntry`). */
	readonly data?: unknown;
}

export interface ConversationPaneOptions {
	/** The token theme; defaults to the plain (identity) fallback. */
	readonly theme?: TuiTheme;
	/**
	 * U5 Task 4 (spec §8.2): the chat-block surface attach seam — one
	 * `sigrun.blocks` timeline event mounts the block's `SurfaceView`
	 * (the TUI's component host) over the transport this seam returns
	 * (the app's `ChatSurfaceHub`-backed attach). Absent, the pane
	 * renders the fail-visible placeholder (the unknown-kind rule).
	 */
	readonly attachChatTransport?: (
		conversationId: number,
		entryId: string,
	) => SurfaceTransport;
}

/**
 * The message's text: string content as-is, or its text blocks joined
 * with a blank line (the webui `messageText` rule, mirrored).
 */
function messageText(message: MessageShape): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (content === undefined) return "";
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n\n");
}

/** The message's non-text/non-thinking parts (uploads), as path markers. */
function attachmentMarkers(message: MessageShape): readonly string[] {
	const content = message.content;
	if (typeof content === "string" || content === undefined) return [];
	return content
		.filter((block) => block.type !== "text" && block.type !== "thinking")
		.map((block) => `[${block.type ?? "part"}: ${block.path ?? "?"}]`);
}

/** A turn's fallback body (an `other` kind's text), if any. */
function entryText(entry: EntryShape): string {
	return (entry.model ?? [])
		.map((message) => messageText(message))
		.filter((part) => part !== "")
		.join(" ");
}

/** A user entry's model-facing text (message texts + upload markers) — the
 *  plain-turn body, and the EXPANDED text an expanded turn's chip reveals. */
function userModelText(entry: EntryShape): string {
	const parts = (entry.model ?? []).flatMap((message) => [
		messageText(message),
		...attachmentMarkers(message),
	]);
	return parts.filter((part) => part !== "").join("\n");
}

/** The markdown theme rides the TuiTheme's token colours. */
function markdownTheme(theme: TuiTheme): MarkdownTheme {
	return {
		heading: (text) => theme.bold(theme.fg("accent")(text)),
		link: theme.fg("accent"),
		linkUrl: theme.dim,
		code: theme.fg("code"),
		codeBlock: theme.fg("code"),
		codeBlockBorder: theme.fg("border"),
		quote: theme.italic,
		quoteBorder: theme.fg("border"),
		hr: theme.fg("border"),
		listBullet: theme.fg("accent"),
		bold: theme.bold,
		italic: theme.italic,
		strikethrough: (text) => text,
		underline: (text) => text,
	};
}

/** Pad/centre the compaction divider to the render width. */
function compactionLine(theme: TuiTheme): Component {
	return new (class implements Component {
		render(width: number): string[] {
			const label = "── context compacted ──";
			const pad = Math.max(0, Math.floor((width - label.length) / 2));
			return [theme.dim(`${" ".repeat(pad)}${label}`)];
		}
		invalidate(): void {}
	})();
}

/** One composer-surfaced line: `error` for failures, `notice` for outcomes. */
interface PaneNotice {
	readonly kind: "error" | "notice";
	readonly text: string;
}

function noticeComponent(notice: PaneNotice): Component {
	return new Text(`[${notice.kind}] ${notice.text}`, 0, 0);
}

/** The notice backlog cap (fix wave A5 — most recent win). */
const MAX_NOTICES = 10;

/**
 * A one-line render slot whose text is painted by the owner each frame
 * (pi-tui's `Text` drops whitespace-only text and caches by content —
 * neither fits a line whose text changes under a `MouseRegion`).
 */
class RenderSlot implements Component {
	paint: (width: number) => string = () => "";
	render(width: number): string[] {
		return [this.paint(width)];
	}
	invalidate(): void {}
}

/** The folded note row's summary (spec §8.3): collapsed to this line;
 *  opening the turn's fold reveals the note text beneath it. */
export const NOTE_SUMMARY = "UI changes sent to the agent";

/** The blocks entry's title from its payload (the answer chip's label). */
function blocksTitleOf(data: unknown): string | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const title = (data as { readonly title?: unknown }).title;
	return typeof title === "string" && title !== "" ? title : undefined;
}

/** The answer entry's block entry id (spec §8.4's `data.entryId`). */
function answerEntryIdOf(data: unknown): string | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const entryId = (data as { readonly entryId?: unknown }).entryId;
	return typeof entryId === "string" && entryId !== "" ? entryId : undefined;
}

/** The blank separator between turns. */
const TURN_GAP = 1;

/** One mounted turn: its components plus the recorded line span. */
interface MountedTurn {
	/** The turn's first line index from the last render (incl. marker). */
	start: number;
	/** The first line index AFTER the turn (the next turn's gap line). */
	end: number;
	/** Components belonging to the turn, in render order. */
	readonly components: readonly Component[];
	/** Lines each component contributed at the last render. */
	readonly heights: number[];
}

export class ConversationPane implements Component {
	readonly #container = new Container();
	readonly #theme: TuiTheme;
	readonly #markdownTheme: MarkdownTheme;
	/** The chat-block attach seam (U5 Task 4; absent = placeholder). */
	readonly #attachChatTransport:
		| ((conversationId: number, entryId: string) => SurfaceTransport)
		| undefined;
	readonly #notices: PaneNotice[] = [];
	/** The notices' mounted components, aligned with `#notices`. */
	readonly #noticeComponents: Component[] = [];

	#turns: readonly Turn<EntryShape>[] = [];
	/** The open view's conversation id (the chat-block attach's address). */
	#conversationId = 0;
	#focus: number | undefined;
	/** Fold state by turn index (assistant turns only fold). */
	readonly #open = new Set<number>();
	/** Line spans from the last render, aligned with `#turns`. */
	#ranges: { start: number; end: number }[] = [];
	/** The mounted turn records, aligned with `#turns`. */
	#mounted: MountedTurn[] = [];

	constructor(options?: ConversationPaneOptions) {
		this.#theme = options?.theme ?? plainTuiTheme();
		this.#markdownTheme = markdownTheme(this.#theme);
		this.#attachChatTransport = options?.attachChatTransport;
	}

	/** The current view's turns (B1 grouping), in render order. */
	turns(): readonly Turn<EntryShape>[] {
		return this.#turns;
	}


	/** The focused turn index; `undefined` = none (follow the end). */
	get focusIndex(): number | undefined {
		return this.#focus;
	}

	/** Focus a turn (or clear with `undefined`); repaints the marker. */
	setFocus(index: number | undefined): void {
		if (index !== undefined && (index < 0 || index >= this.#turns.length)) {
			return;
		}
		if (index === this.#focus) return;
		this.#focus = index;
		this.#container.invalidate();
	}

	/** Open/close an assistant turn's activity fold — or an expanded user
	 *  turn's chip disclosure (Task 2c: the full admitted text hides behind
	 *  the `expanded from /name` line, same fold state, same seam). */
	toggleFold(index: number): void {
		const turn = this.#turns[index];
		if (turn === undefined) return;
		const foldable =
			turn.kind === "assistant" ||
			(turn.kind === "user" && expandedUserEntry(turn.entry) !== undefined);
		if (!foldable) return;
		if (this.#open.has(index)) {
			this.#open.delete(index);
		} else {
			this.#open.add(index);
		}
		this.#rebuild();
	}

	/**
	 * The turn's line offsets from the last render (for
	 * `ScrollView.scrollTo`): `start` is the turn's first line, `end` the
	 * first line after it. Undefined before a render or out of range.
	 */
	lineRangeOf(index: number): { start: number; end: number } | undefined {
		return this.#ranges[index];
	}

	/** The turn's markdown source (the copy payload). */
	textOf(index: number): string {
		const turn = this.#turns[index];
		if (turn === undefined) return "";
		switch (turn.kind) {
			case "user": {
				// An expanded turn copies the TYPED command (what the user
				// wrote — re-submitting it re-expands server-side).
				const expanded = expandedUserEntry(turn.entry);
				if (expanded !== undefined) return expanded.typed;
				return userModelText(turn.entry);
			}
			case "assistant":
				return turn.text;
			case "other":
				return entryText(turn.entry);
		}
	}

	/** The turn's wire identity: the user entry id / assistant lastEntryId. */
	entryIdOf(index: number): number {
		const turn = this.#turns[index];
		if (turn === undefined) return -1;
		switch (turn.kind) {
			case "user":
				return turn.entry.id;
			case "assistant":
				return turn.lastEntryId;
			case "other":
				return turn.entry.id;
		}
	}

	/**
	 * Replace the pane with the projection of `wire` (the SSE rule: a full
	 * revision replaces; a reconnect's snapshot subsumes missed frames).
	 * Composer notices are not stream state: they re-render after the
	 * turns.
	 */
	showView(wire: ConversationViewWire): void {
		this.#conversationId = wire.conversation.id;
		this.#turns = groupTurns(wire.entries as readonly EntryShape[]);
		if (this.#focus !== undefined && this.#focus >= this.#turns.length) {
			this.#focus = undefined;
		}
		this.#rebuild();
	}

	/** Append an `[error]` line (a failed composer action's surface). */
	showError(text: string): void {
		this.#appendNotice({ kind: "error", text });
	}

	/** Append a `[notice]` line (an outcome, e.g. an abort that settled). */
	showNotice(text: string): void {
		this.#appendNotice({ kind: "notice", text });
	}

	/**
	 * Discard all composer-surfaced lines (fix wave F4): the shell calls
	 * this on every conversation swap so a stale error never renders in
	 * the new conversation.
	 */
	clearNotices(): void {
		if (this.#notices.length === 0) return;
		this.#notices.length = 0;
		for (const component of this.#noticeComponents.splice(0)) {
			this.#container.removeChild(component);
		}
		this.#container.invalidate();
	}

	#appendNotice(notice: PaneNotice): void {
		this.#notices.push(notice);
		const component = noticeComponent(notice);
		this.#noticeComponents.push(component);
		this.#container.addChild(component);
		while (this.#notices.length > MAX_NOTICES) {
			this.#notices.shift();
			const oldest = this.#noticeComponents.shift();
			if (oldest === undefined) break;
			this.#container.removeChild(oldest);
		}
		this.#container.invalidate();
	}

	/** Rebuild the container from the current turns + folds + notices. */
	#rebuild(): void {
		this.#container.clear();
		this.#noticeComponents.length = 0;
		this.#mounted = this.#turns.map((turn, index) =>
			this.#mountTurn(turn, index),
		);
		for (const mounted of this.#mounted) {
			for (const component of mounted.components) {
				this.#container.addChild(component);
			}
			this.#container.addChild(new RenderSlot()); // turn gap
		}
		for (const notice of this.#notices) {
			const component = noticeComponent(notice);
			this.#noticeComponents.push(component);
			this.#container.addChild(component);
		}
		this.#container.invalidate();
	}

	/** Project one turn into its components (mouse regions included). */
	#mountTurn(turn: Turn<EntryShape>, index: number): MountedTurn {
		const components: Component[] = [];
		const focusThis = (): TuiMouseEventResult => {
			this.setFocus(index);
			return { handled: true };
		};
		const body = (component: Component): Component =>
			new MouseRegion(component, (event) =>
				event.type === "click" && event.button === "left"
					? focusThis()
					: undefined,
			);
		switch (turn.kind) {
			case "user": {
				const expanded = expandedUserEntry(turn.entry);
				if (expanded !== undefined) {
					// The expanded turn (Task 2c): the TYPED command is the body
					// (the accent bar still marks it a user turn); a dim chip line
					// folds the full admitted text — closed by default, or
					// `/skill:greet hej` would dump the whole skill body.
					components.push(
						body(new Markdown(expanded.typed, 0, 0, this.#markdownTheme)),
					);
					const slot = new RenderSlot();
					slot.paint = () =>
						this.#theme.dim(
							`${this.#open.has(index) ? "▾" : "▸"} expanded from /${expanded.command ?? "…"}`,
						);
					components.push(
						new MouseRegion(slot, (event) => {
							if (event.type === "click" && event.button === "left") {
								this.toggleFold(index);
								return { handled: true };
							}
							return undefined;
						}),
					);
					if (this.#open.has(index)) {
						for (const line of userModelText(turn.entry).split("\n")) {
							components.push(
								new Text(this.#theme.dim(line), 0, 0),
							);
						}
					}
					break;
				}
				const text = this.textOf(index);
				if (text !== "") {
					components.push(body(new Markdown(text, 0, 0, this.#markdownTheme)));
				}
				// U5 Task 4 (spec §8.4): a block answer is a user turn whose
				// chip names the surface it answered (`from <title>` — the
				// `sigrun.blocks` entry's title, else its entry id).
				if (turn.entry.kind === "sigrun.blocks.answer") {
					const answerEntryId = answerEntryIdOf(turn.entry.data);
					const title = this.#turns
						.map((candidate) =>
							candidate.kind === "assistant"
								? candidate.entries.find(
										(entry) =>
											entry.kind === "sigrun.blocks" &&
											String(entry.id) === answerEntryId,
									)
								: undefined,
						)
						.map((entry) =>
							entry === undefined ? undefined : blocksTitleOf(entry.data),
						)
						.find((candidate) => candidate !== undefined);
					components.push(
						new Text(
							this.#theme.dim(
								`from ${title ?? `entry ${answerEntryId ?? "?"}`}`,
							),
							0,
							0,
						),
					);
				}
				break;
			}
			case "assistant": {
				if (turn.text.trim() !== "") {
					components.push(
						body(new Markdown(turn.text, 0, 0, this.#markdownTheme)),
					);
				}
				// U5 Task 4: the chat-block surfaces render INLINE, OUTSIDE
				// the folded activity line (the surface is the turn's visible
				// artifact, never hidden behind the fold). Each mounts a
				// SurfaceView over the attach seam's transport (the hub's
				// onChanged refreshes it when another viewer edits the block).
				for (const event of turn.timeline) {
					if (event.kind !== "blocks") continue;
					const attach = this.#attachChatTransport;
					if (attach === undefined) {
						components.push(
							new Text(
								this.#theme.dim(
									`[blocks entry ${event.entryId} — no chat transport]`,
								),
								0,
								0,
							),
						);
						continue;
					}
					const state = new SurfaceState(
						attach(this.#conversationId, String(event.entryId)),
					);
					void state.load();
					state.onChange(() => this.#container.invalidate());
					components.push(
						new SurfaceView(state, {
							theme: this.#theme,
							unicode: true,
						}),
					);
				}
				const notes = turn.timeline.filter((event) => event.kind === "note");
				const label = activityLabel(turn);
				const summaryParts = [
					...(label === "" ? [] : [label]),
					...(notes.length > 0
						? [
								notes.length === 1
									? NOTE_SUMMARY
									: `${notes.length}× ${NOTE_SUMMARY}`,
							]
						: []),
				];
				if (summaryParts.length > 0) {
					// The slot renders one line; the fold marker + label are
					// painted per frame (the fold state changes after mount, and
					// a Text's content cache would pin the stale marker).
					const slot = new RenderSlot();
					slot.paint = () =>
						this.#theme.dim(
							`${this.#open.has(index) ? "▾" : "▸"} ${summaryParts.join(" · ")}`,
						);
					components.push(
						new MouseRegion(slot, (event) => {
							if (event.type === "click" && event.button === "left") {
								this.toggleFold(index);
								return { handled: true };
							}
							return undefined;
						}),
					);
					if (this.#open.has(index)) {
						for (const thinking of turn.thinking) {
							if (thinking.trim() === "") continue;
							components.push(
								new Text(this.#theme.dim(this.#theme.italic(thinking)), 0, 0),
							);
						}
						for (const tool of turn.tools) {
							const glyph = tool.isError
								? "✗"
								: tool.resultEntryId === undefined
									? "·"
									: "✓";
							const preview =
								tool.preview === "" ? "" : `  ${tool.preview}`;
							const row = `${glyph} ${tool.name}${preview}`;
							components.push(
								new Text(
									tool.isError ? this.#theme.fg("muted")(row) : row,
									0,
									0,
								),
							);
						}
						// The note texts ride the SAME fold (the note row's
						// disclosure): opening the fold reveals the notes
						// the turn admitted, in timeline order.
						for (const event of turn.timeline) {
							if (event.kind !== "note") continue;
							const entry = turn.entries.find(
								(candidate) => candidate.id === event.entryId,
							);
							const text =
								entry === undefined ? "" : entryText(entry);
							for (const line of text.split("\n")) {
								if (line.trim() === "") continue;
								components.push(
									new Text(this.#theme.dim(line), 0, 0),
								);
							}
						}
					}
				}
				break;
			}
			case "other": {
				if (turn.entry.kind === "pi.compaction") {
					components.push(compactionLine(this.#theme));
					break;
				}
				const text = entryText(turn.entry);
				if (turn.entry.kind === "pi.system") {
					if (text !== "") components.push(new Text(text, 0, 0));
				} else {
					// Fail visible (the webui rule): name the kind plus any text.
					const suffix = text === "" ? "" : ` — ${text}`;
					components.push(
						new Text(
							`unsupported entry kind: ${turn.entry.kind}${suffix}`,
							0,
							0,
						),
					);
				}
				break;
			}
		}
		return { start: 0, end: 0, components, heights: [] };
	}

	render(width: number): string[] {
		const lines = this.#container.render(width);
		this.#recordRanges(lines, width);
		return this.#decorate(lines, width);
	}

	/**
	 * Record each turn's line span from the render: every turn is followed
	 * by one blank gap line (see `#rebuild`), so heights + TURN_GAP walk
	 * the offsets deterministically.
	 */
	#recordRanges(_lines: string[], width: number): void {
		const ranges: { start: number; end: number }[] = [];
		let offset = 0;
		for (const [index, mounted] of this.#mounted.entries()) {
			let height = 0;
			mounted.heights.length = 0;
			for (const component of mounted.components) {
				const componentHeight = component.render(width).length;
				mounted.heights.push(componentHeight);
				height += componentHeight;
			}
			mounted.start = offset;
			mounted.end = offset + height;
			ranges.push({ start: mounted.start, end: mounted.end });
			offset += height + TURN_GAP;
		}
		this.#ranges = ranges;
	}

	/**
	 * Apply the focus + user-bar chrome: the focused turn's FIRST line
	 * gets the `surface2` background and the `›` gutter marker; every line
	 * of a user turn carries the accent `▎` bar. The two are independent —
	 * a focused user turn's first line composes `› ▎ …` on surface2.
	 */
	#decorate(lines: string[], width: number): string[] {
		const out = [...lines];
		for (const [index, mounted] of this.#mounted.entries()) {
			const turn = this.#turns[index];
			if (turn === undefined) continue;
			const focused = index === this.#focus;
			const bar =
				turn.kind === "user"
					? `${this.#theme.fg("accent")("▎")} `
					: "";
			for (let line = mounted.start; line < mounted.end; line++) {
				const original = out[line] ?? "";
				if (line === mounted.start && focused) {
					const marked = `› ${bar}${original}`;
					out[line] = this.#theme.bg("surface2")(
						marked + " ".repeat(Math.max(0, width - marked.length)),
					);
				} else if (turn.kind === "user") {
					out[line] = `${bar}${original}`;
				} else if (focused) {
					out[line] = `  ${original}`;
				}
			}
		}
		return out;
	}

	invalidate(): void {
		this.#container.invalidate();
	}
}
