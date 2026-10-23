/**
 * Form field chrome (UI-blocks U2 Task 5, spec §5.6): the shared field
 * row (label, value editor line, help, error) and the text editors the
 * simple fields (text, number, date, datetime) drive. The TUI editor is
 * a single editable line: characters insert at the caret, Backspace
 * deletes, arrows move the caret; the caret marker is `▏` (ASCII `|`
 * with ctx.unicode false).
 *
 * The field row renders labels BESIDE fields at regular/wide and ABOVE
 * them at compact (spec §12.3's form row) — the row decides from the
 * render width.
 *
 * Editing keys are spoken directly by the form component (it owns the
 * focus and routes input); the app-level keymaps are untouched (their
 * `surface`-focus keys govern collections, not text editing).
 */

import type { Bindable, Field, JsonValue } from "@sigrun/shared/blocks";
import { bindText, type BlockCtx } from "../context.js";
import { truncate, widthClassOf, wrapPlain } from "../width.js";

/** The caret marker (spec §10.2's degradation rule). */
export function caretGlyph(unicode: boolean): string {
	return unicode ? "▏" : "|";
}

/** The width the label column takes at regular/wide (labels beside). */
export const LABEL_CELLS = 20;

/**
 * A single-line text editor buffer: the value plus the caret. Shared
 * by every text-shaped field (text, number raw, date, datetime,
 * longtext non-code, choice's other text, list item editors).
 */
export class EditBuffer {
	#text: string;
	#caret: number;

	constructor(initial: string) {
		this.#text = initial;
		this.#caret = initial.length;
	}

	get text(): string {
		return this.#text;
	}

	get caret(): number {
		return this.#caret;
	}

	/** Handle one input chunk; returns true when the key was an edit. */
	input(data: string): boolean {
		if (data === "\x1b[D") {
			// Left
			if (this.#caret > 0) this.#caret -= 1;
			return true;
		}
		if (data === "\x1b[C") {
			// Right
			if (this.#caret < this.#text.length) this.#caret += 1;
			return true;
		}
		if (data === "\x7f" || data === "\b") {
			if (this.#caret > 0) {
				this.#text = this.#text.slice(0, this.#caret - 1) + this.#text.slice(this.#caret);
				this.#caret -= 1;
			}
			return true;
		}
		// Printable input only (escape sequences and control keys are the
		// form's navigation, not text).
		if (data.length > 0 && !data.startsWith("\x1b") && !/[\x00-\x1f]/u.test(data)) {
			this.#text = this.#text.slice(0, this.#caret) + data + this.#text.slice(this.#caret);
			this.#caret += data.length;
			return true;
		}
		return false;
	}

	/** The displayed line with the caret marker inserted. */
	render(unicode = true): string {
		return (
			this.#text.slice(0, this.#caret) +
			caretGlyph(unicode) +
			this.#text.slice(this.#caret)
		);
	}
}

/** A field's label/help resolved to text. */
export function fieldLabel(field: Field, ctx: BlockCtx): string {
	return bindText(field.label, ctx) || field.name;
}

/** The value's display text (the editor seed; numbers stringify). */
export function valueText(value: JsonValue): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

/** Render a bindable to text (labels, help). */
export function text(value: Bindable<string> | undefined, ctx: BlockCtx): string {
	return bindText(value, ctx);
}

/**
 * The field-row chrome: label (beside at regular/wide, above at
 * compact), the editor lines, then help and the error (client or the
 * server field error, §5.6) under the field.
 */
export function fieldRowLines(opts: {
	field: Field;
	ctx: BlockCtx;
	width: number;
	/** The editor lines (the focused field's editor shows the caret). */
	editor: readonly string[];
	error?: string;
}): string[] {
	const { field, ctx, width } = opts;
	const label = fieldLabel(field, ctx) + (field.required === true ? " *" : "");
	const help = text(field.help, ctx);
	const lines: string[] = [];
	const beside = widthClassOf(width) !== "compact";
	const labelText = truncate(label, beside ? LABEL_CELLS - 1 : width);
	if (label !== "") {
		if (beside) {
			// Labels beside fields (§12.3): pad the label column, the
			// editor line follows on the same row.
			const first = opts.editor[0] ?? "";
			lines.push(
				truncate(`${labelText.padEnd(LABEL_CELLS)}${first}`, width),
			);
			for (const extra of opts.editor.slice(1)) {
				lines.push(truncate(`${" ".repeat(LABEL_CELLS)}${extra}`, width));
			}
		} else {
			lines.push(ctx.theme.bold(labelText));
			for (const line of opts.editor) lines.push(truncate(`  ${line}`, width));
		}
	} else {
		for (const line of opts.editor) lines.push(truncate(line, width));
	}
	if (help !== "") {
		for (const line of wrapPlain(help, width)) lines.push(ctx.theme.dim(line));
	}
	if (opts.error !== undefined && opts.error !== "") {
		lines.push(ctx.theme.fg("bad")(truncate(opts.error, width)));
	}
	return lines;
}
