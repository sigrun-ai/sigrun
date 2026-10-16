/**
 * The conversation pane (Task 6): renders a `ConversationViewWire`'s
 * entries top-to-bottom in pi's idiom — user prompts, assistant markdown,
 * thinking blocks as `[thinking] …` lines, tool calls as compact
 * `[tool] name` rows, compaction entries as `[compaction]` rows.
 *
 * The SSE contract (Task 4): every snapshot/frame is a FULL revision, so
 * {@link showView} REPLACES the rendered state wholesale — nothing here
 * accumulates across frames.
 *
 * The pane is a static projection of the current view (rendered through
 * pi-tui's `Markdown`/`Text` components); it is NOT a `ScrollView` — on the
 * main screen the terminal owns scrollback (pi's idiom), and viewport
 * layouts are alt-screen-only. pi-tui components carry their own render
 * caching; the pane invalidates its children on replacement.
 *
 * Unknown entry kinds render a fail-visible fallback naming the kind (the
 * webui's rule — a new server-side kind must never vanish silently).
 *
 * Error/notice lines (Task 7): the composer surfaces its immediate failures
 * (a 400 on the submit POST, an abort racing settlement, an unknown slash
 * command) as `[error]`/`[notice]` rows. They are NOT stream state, so
 * {@link showView}'s wholesale replacement preserves them — they re-render
 * after the entries until the shell discards them (fix wave F4: the shell
 * discards them on every conversation swap via {@link ConversationPane.clearNotices}
 * — a notice is per-conversation context and must never bleed across a swap).
 */

import {
	Container,
	Markdown,
	Text,
	type Component,
	type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { ConversationViewWire } from "../api.js";

/** One §5 message's structural shape (the parts the pane reads). */
interface MessageShape {
	readonly role?: string;
	readonly content?:
		| string
		| readonly {
				readonly type?: string;
				readonly text?: string;
				readonly thinking?: string;
				readonly path?: string;
		  }[];
	readonly toolName?: string;
}

/** One §5 entry's structural shape (kind + optional model messages). */
interface EntryShape {
	readonly id: number;
	readonly kind: string;
	readonly model?: readonly MessageShape[];
}

/** No-color theme: the shell pins structure; styling is a later task. */
function plainMarkdownTheme(): MarkdownTheme {
	const identity = (text: string): string => text;
	return {
		heading: identity,
		link: identity,
		linkUrl: identity,
		code: identity,
		codeBlock: identity,
		codeBlockBorder: identity,
		quote: identity,
		quoteBorder: identity,
		hr: identity,
		listBullet: identity,
		bold: identity,
		italic: identity,
		strikethrough: identity,
		underline: identity,
	};
}

/**
 * The message's text: string content as-is, or its text blocks joined with
 * a blank line (the webui `messageText` rule, mirrored — the tui workspace
 * shares the server's types directly, so a narrower shape is enough).
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

/** The message's thinking texts, in content order. */
function thinkingTexts(message: MessageShape): readonly string[] {
	const content = message.content;
	if (typeof content === "string" || content === undefined) return [];
	return content
		.filter(
			(block) => block.type === "thinking" && typeof block.thinking === "string",
		)
		.map((block) => block.thinking as string);
}

/** The message's non-text/non-thinking parts (uploads), as path markers. */
function attachmentMarkers(message: MessageShape): readonly string[] {
	const content = message.content;
	if (typeof content === "string" || content === undefined) return [];
	return content
		.filter((block) => block.type !== "text" && block.type !== "thinking")
		.map((block) => `[${block.type ?? "part"}: ${block.path ?? "?"}]`);
}

/** First line only: thinking blocks and tool outputs are compact rows. */
function firstLine(text: string): string {
	const line = text.split("\n", 1)[0] ?? "";
	return line.trim();
}

/**
 * Project one entry into its pane components. Entries with nothing
 * renderable (a tool-call-only assistant bubble) project to nothing —
 * the webui's AssistantEntry rule: an empty bubble was a rendering bug.
 */
function entryComponents(entry: EntryShape, theme: MarkdownTheme): Component[] {
	const components: Component[] = [];
	switch (entry.kind) {
		case "pi.user": {
			for (const message of entry.model ?? []) {
				const text = messageText(message);
				const markers = attachmentMarkers(message);
				const body = [text, ...markers].filter((part) => part !== "").join("\n");
				if (body !== "") {
					components.push(new Markdown(body, 0, 0, theme));
				}
			}
			return components;
		}
		case "pi.assistant": {
			for (const message of entry.model ?? []) {
				for (const thinking of thinkingTexts(message)) {
					if (thinking.trim() !== "") {
						components.push(
							new Text(`[thinking] ${firstLine(thinking)}`, 0, 0),
						);
					}
				}
				const text = messageText(message);
				if (text.trim() !== "") {
					components.push(new Markdown(text, 0, 0, theme));
				}
			}
			return components;
		}
		case "pi.tool-result": {
			const message = (entry.model ?? [])[0];
			const name = message?.toolName ?? "tool";
			const summary = firstLine(messageText(message ?? {}));
			const row =
				summary === "" ? `[tool] ${name}` : `[tool] ${name} — ${summary}`;
			components.push(new Text(row, 0, 0));
			return components;
		}
		case "pi.compaction": {
			components.push(new Text("[compaction]", 0, 0));
			return components;
		}
		case "pi.system": {
			const text = (entry.model ?? [])
				.map((message) => messageText(message))
				.filter((part) => part !== "")
				.join(" ");
			if (text !== "") components.push(new Text(text, 0, 0));
			return components;
		}
		default: {
			// Fail visible (the webui rule): name the kind plus any text.
			const text = (entry.model ?? [])
				.map((message) => messageText(message))
				.filter((part) => part !== "")
				.join(" ");
			const suffix = text === "" ? "" : ` — ${text}`;
			components.push(
				new Text(`unsupported entry kind: ${entry.kind}${suffix}`, 0, 0),
			);
			return components;
		}
	}
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

export class ConversationPane implements Component {
	readonly #container = new Container();
	readonly #theme = plainMarkdownTheme();
	readonly #notices: PaneNotice[] = [];
	/** The notices' mounted components, aligned with `#notices`. */
	readonly #noticeComponents: Component[] = [];

	/**
	 * Replace the pane with the projection of `wire` (the SSE rule: a full
	 * revision replaces; a reconnect's snapshot subsumes missed frames).
	 * Composer notices are not stream state: they re-render after the entries.
	 */
	showView(wire: ConversationViewWire): void {
		this.#container.clear();
		this.#noticeComponents.length = 0;
		for (const entry of wire.entries as readonly EntryShape[]) {
			for (const component of entryComponents(entry, this.#theme)) {
				this.#container.addChild(component);
			}
		}
		for (const notice of this.#notices) {
			const component = noticeComponent(notice);
			this.#noticeComponents.push(component);
			this.#container.addChild(component);
		}
		this.#container.invalidate();
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
	 * the new conversation. The notice ROWS are dropped immediately too
	 * (fix wave A6): a swap is the discarding moment, and the new
	 * conversation's fresh snapshot may not land for a beat — the swap
	 * installs an empty view of the target conversation (id, no entries)
	 * so the pane shows a clean, correctly-addressed blank until its
	 * snapshot arrives.
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
		// Cap the backlog (fix wave A5): keep the 10 most recent, dropping
		// the oldest silently — both the array and its rendered row.
		while (this.#notices.length > MAX_NOTICES) {
			this.#notices.shift();
			const oldest = this.#noticeComponents.shift();
			if (oldest === undefined) break; // array is the source of truth
			this.#container.removeChild(oldest);
		}
		this.#container.invalidate();
	}

	render(width: number): string[] {
		return this.#container.render(width);
	}

	invalidate(): void {
		this.#container.invalidate();
	}
}
