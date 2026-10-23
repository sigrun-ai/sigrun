/**
 * The simple content blocks (UI-blocks spec §5.3): `markdown`,
 * `fields`, `stat`, `callout`, `diff`, `details`.
 *
 * - `markdown` rides pi-tui's `Markdown` (the same renderer as chat)
 *   with the TuiTheme-mapped markdown theme.
 * - `fields` aligns labels by display width.
 * - `stat` is `label: value unit` plus an optional caption line (its
 *   `sparkline` becomes a real drawing in Task 2).
 * - `callout` leads with the tone marker (colour + the NO_COLOR
 *   fallback), its body renders as markdown, and its actions render as
 *   `[1] label` buttons with the confirm flow and the OSC 52 copy.
 * - `diff` reuses the interaction diff renderer (blocks/diff.ts).
 * - `details` is one collapsed JSON line (the TUI's existing details
 *   primitive; a later task may add an expandable pretty view).
 */

import { Markdown, hyperlink, getCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";
import { formatValue } from "@sigrun/shared/blocks";
import type {
	Action,
	ActionButton,
	Block,
	CalloutBlock,
	Confirm,
	DetailsBlock,
	DiffBlock,
	FieldsBlock,
	IconName,
	MarkdownBlock,
	StatBlock,
	Tone,
} from "@sigrun/shared/blocks";
import type { TuiTheme } from "../theme.js";
import { bindRaw, bindText, bindTone, type BlockCtx } from "./context.js";
import { truncate } from "./width.js";
import { iconGlyph } from "./icons.js";
import { toneFg, toneMarker } from "./tones.js";
import { blockDiff, diffLines } from "./diff.js";
import { Lines } from "./layout.js";
import { copyToTerminal } from "../clipboard.js";

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

/** `markdown`: the same renderer as chat. */
export function renderMarkdown(block: MarkdownBlock, ctx: BlockCtx): Component {
	return new Markdown(bindText(block.text, ctx), 0, 0, markdownTheme(ctx.theme));
}

/** One `fields` row read off its binding. */
interface FieldRow {
	label: string;
	value: string;
	tone?: Tone;
	icon?: IconName;
}

/** Read `fields.rows` into label/value/tone/icon rows (each slot binds). */
function fieldRows(block: FieldsBlock, ctx: BlockCtx): FieldRow[] {
	const raw = bindRaw(block.rows, ctx);
	if (!Array.isArray(raw)) return [];
	const rows: FieldRow[] = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record: Record<string, unknown> = entry;
		const label = bindText(record.label, ctx);
		const value = formatValue(
			(bindRaw(record.value, ctx) ?? null) as Parameters<typeof formatValue>[0],
			undefined,
			ctx.locale,
		);
		const tone = bindRaw(record.tone, ctx);
		const icon = bindRaw(record.icon, ctx);
		rows.push({
			label,
			value,
			tone: tone === undefined ? undefined : bindTone(tone, ctx),
			icon: icon === undefined ? undefined : (icon as IconName),
		});
	}
	return rows;
}

/** `fields`: `label: value` rows, labels aligned by display width. */
export function renderFields(block: FieldsBlock, ctx: BlockCtx): Component {
	return new Lines(() => {
		const rows = fieldRows(block, ctx);
		const labelWidth = Math.max(
			0,
			...rows.map((row) => visibleWidth(row.label)),
		);
		return rows.map((row) => {
			const padded = row.label + " ".repeat(Math.max(0, labelWidth - visibleWidth(row.label)));
			const text =
				row.tone === undefined ? row.value : toneFg(ctx.theme, row.tone)(row.value);
			const glyph = row.icon === undefined ? "" : `${iconGlyph(row.icon, false)} `;
			return `${ctx.theme.dim(padded)}  ${glyph}${text}`;
		});
	});
}

/** `stat`: `label: value unit` plus an optional caption line. */
export function renderStat(block: StatBlock, ctx: BlockCtx): Component {
	return new Lines((width) => {
		const value = formatValue(
			(bindRaw(block.value, ctx) ?? null) as Parameters<typeof formatValue>[0],
			block.format,
			ctx.locale,
		);
		const unit = bindText(block.unit, ctx);
		const text = unit === "" ? value : `${value} ${unit}`;
		const tone = bindRaw(block.tone, ctx);
		const toneName = tone === undefined ? undefined : bindTone(tone, ctx);
		const icon = bindRaw(block.icon, ctx);
		const label = bindText(block.label, ctx);
		const head =
			typeof icon === "string" ? `${iconGlyph(icon as IconName, false)} ${label}` : label;
		const painted = toneName === undefined ? text : toneFg(ctx.theme, toneName)(text);
		const out = [truncate(`${ctx.theme.dim(`${head}:`)} ${painted}`, width)];
		const caption = bindText(block.caption, ctx);
		if (caption !== "") out.push(ctx.theme.dim(caption));
		return out;
	});
}

/** `details`: one collapsed JSON line. */
export function renderDetails(block: DetailsBlock): Component {
	return new Lines(() => [JSON.stringify(block.value)]);
}

/** `diff`: the interaction diff renderer (blocks/diff.ts). */
export function renderDiff(block: DiffBlock): Component {
	return new Lines(() => diffLines(blockDiff(block)));
}

/** The actions a block offers: read access keeps the view-only kinds
 * (§6.5 — copy/open/navigate never edit or answer; twin of the webui's
 * `isViewOnly`). */
export function visibleActions(
	actions: readonly ActionButton[] | undefined,
	ctx: BlockCtx,
): ActionButton[] {
	if (ctx.access === "read") {
		return (actions ?? []).filter(
			(button) =>
				button.action.type === "copy" ||
				button.action.type === "open" ||
				button.action.type === "navigate",
		);
	}
	return [...(actions ?? [])];
}

/** The URL schemes an `open` action may carry (§15: https/http/mailto). */
const OPEN_SCHEMES: ReadonlySet<string> = new Set(["https", "http", "mailto"]);

/** Clean an `open` URL the way a browser would, then allowlist the scheme. */
function openUrl(url: string): string {
	const cleaned = url
		.replace(/[\t\n\r]/g, "")
		.replace(/[\u0000-\u0020]+$/, "")
		.replace(/^[\u0000-\u0020]+/, "");
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned)?.[1];
	if (scheme === undefined) return "";
	return OPEN_SCHEMES.has(scheme.toLowerCase()) ? cleaned : "";
}

/** `open`: channel-local (§6.2 view-only) — print the URL as an OSC 8
 * hyperlink when the terminal supports them, else as plain text. */
function runOpen(button: ActionButton, action: { readonly url: string }, ctx: BlockCtx): void {
	const url = openUrl(action.url);
	if (url === "") return; // disallowed scheme: nothing opens, nothing dispatches
	const terminal = ctx.terminal ?? { write: (data: string): boolean => process.stdout.write(data) };
	const label = bindText(button.label, ctx);
	const shown = getCapabilities().hyperlinks
		? hyperlink(label, url)
		: `${label} — ${url}`;
	terminal.write(`${shown}\n`);
}

/** Run a button's action (copy/open resolve locally; the rest dispatch). */
function runAction(button: ActionButton, ctx: BlockCtx): void {
	const action = button.action;
	if (action.type === "copy") {
		const raw = bindRaw(action.text, ctx);
		const text = typeof raw === "string" ? raw : "";
		copyToTerminal(
			ctx.terminal ?? { write: (data: string): boolean => process.stdout.write(data) },
			text,
		);
		return;
	}
	if (action.type === "open") {
		runOpen(button, action, ctx);
		return;
	}
	ctx.dispatch(action, null);
}

/** A confirm gate standing in front of a button's dispatch (§6.1). */
interface ConfirmState {
	readonly confirm: Confirm;
	readonly action: Action;
}

/**
 * `callout`: tone-marked title, wrapped markdown body, action buttons.
 * `handleInput` picks a button by digit; a `confirm` action gates its
 * dispatch behind a `y/N` prompt (anything but `y`/`Y` cancels and
 * dispatches nothing).
 */
export class CalloutComponent implements Component {
	readonly #block: CalloutBlock;
	readonly #ctx: BlockCtx;
	#confirm: ConfirmState | undefined;

	constructor(block: CalloutBlock, ctx: BlockCtx) {
		this.#block = block;
		this.#ctx = ctx;
	}

	render(width: number): string[] {
		const theme = this.#ctx.theme;
		const tone = bindTone(this.#block.tone, this.#ctx);
		const title = bindText(this.#block.title, this.#ctx);
		const lines: string[] = [
			truncate(`${toneFg(theme, tone)(toneMarker(tone))} ${title}`, width),
		];
		const body = bindText(this.#block.body, this.#ctx);
		if (body !== "") {
			// The body is markdown (§5.3); ride the same renderer as chat.
			lines.push(
				...new Markdown(body, 0, 0, markdownTheme(theme)).render(width),
			);
		}
		if (this.#confirm !== undefined) {
			const { confirm, action } = this.#confirm;
			const label =
				confirm.confirmLabel ??
				(action.type === "restart" ? "Restart" : "Confirm");
			lines.push("");
			lines.push(
				truncate(
					`${toneFg(theme, confirm.tone ?? "warn")(toneMarker(confirm.tone ?? "warn"))} ${confirm.title}`,
					width,
				),
			);
			if (confirm.body !== undefined && confirm.body !== "") {
				lines.push(
					...new Markdown(confirm.body, 0, 0, markdownTheme(theme)).render(width),
				);
			}
			lines.push(truncate(`${label}? y/N`, width));
			return lines;
		}
		const actions = visibleActions(this.#block.actions, this.#ctx);
		if (actions.length > 0) {
			lines.push("");
			lines.push(
				truncate(
					actions
						.map((button, index) => `[${index + 1}] ${bindText(button.label, this.#ctx)}`)
						.join("  "),
					width,
				),
			);
		}
		return lines;
	}

	handleInput(data: string): void {
		if (this.#confirm !== undefined) {
			const { action } = this.#confirm;
			this.#confirm = undefined;
			if (data === "y" || data === "Y") this.#ctx.dispatch(action, null);
			return;
		}
		const actions = visibleActions(this.#block.actions, this.#ctx);
		const button = actions[Number(data) - 1];
		if (button === undefined) return;
		const action = button.action;
		if (
			(action.type === "submit" || action.type === "restart") &&
			action.confirm !== undefined
		) {
			this.#confirm = { confirm: action.confirm, action };
			return;
		}
		runAction(button, this.#ctx);
	}

	invalidate(): void {
		// Stateless render; the confirm gate is the only mutable state.
	}
}

/** Render a Task-1 content block by type; the caller routes unknowns. */
export function renderContent(block: Block, ctx: BlockCtx): Component | undefined {
	switch (block.type) {
		case "markdown":
			return renderMarkdown(block, ctx);
		case "fields":
			return renderFields(block, ctx);
		case "stat":
			return renderStat(block, ctx);
		case "details":
			return renderDetails(block);
		case "diff":
			return renderDiff(block);
		case "callout":
			return new CalloutComponent(block, ctx);
		default:
			return undefined;
	}
}
