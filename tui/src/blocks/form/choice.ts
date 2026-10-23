/**
 * The choice field (UI-blocks U2 Task 5, spec §5.6 — the port of U1's
 * `ChoiceField.tsx` value rules): single value = the selected id; multi
 * = the ids; `allowOther` adds a free-text row whose value is
 * `{other: text}` (single) or the ids plus `{other: text}` as the last
 * element (multi). The TUI shows the focused option's `preview`
 * markdown BELOW the options (§5.6's TUI note) at every width. An
 * `allowOther` field appends a final "Type something" row; typing on it
 * edits the free text.
 *
 * v1 degradation note: `preview` renders via wrapPlain (plain wrapped
 * text), not the markdown renderer — the preview stays one small
 * dim block under the options.
 */

import type { ChoiceField, ChoiceOption, JsonObject, JsonValue } from "@sigrun/shared/blocks";
import { bindRaw, type BlockCtx } from "../context.js";
import { truncate, wrapPlain } from "../width.js";
import { EditBuffer } from "./fields.js";

/** The `allowOther` row label (spec §5.6; overridable via its label). */
export const OTHER_ROW_DEFAULT = "Type something";

/** The selected id list of a multi value (strings only — a trailing
 *  `{other}` object is not an id). */
export function optionIdList(value: JsonValue): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

/** The free text of an `{other}` value (single) or a trailing `{other}`
 *  element (multi). */
export function otherText(value: JsonValue): string {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const other = (value as { other?: JsonValue }).other;
		if (typeof other === "string") return other;
	}
	if (Array.isArray(value)) {
		const last = value[value.length - 1];
		if (typeof last === "object" && last !== null && !Array.isArray(last)) {
			const other = (last as { other?: JsonValue }).other;
			if (typeof other === "string") return other;
		}
	}
	return "";
}

/** Resolve the option list (literal or binding). */
export function choiceOptions(field: ChoiceField, ctx: BlockCtx): readonly ChoiceOption[] {
	const resolved: unknown = bindRaw(field.options, ctx);
	if (!Array.isArray(resolved)) return [];
	// The wire contract (§5.6) declares ChoiceOption entries; a malformed
	// entry renders as its raw label text, never a throw.
	return resolved as readonly ChoiceOption[];
}

/** The per-field choice state: the option cursor and the other-text
 *  editor (value round-trips through the owning form's values). */
export class ChoiceState {
	cursor = 0;
	other: EditBuffer = new EditBuffer("");
}

/** The number of rows a choice renders: options plus the other row. */
export function choiceRowCount(field: ChoiceField, ctx: BlockCtx): number {
	return choiceOptions(field, ctx).length + (field.allowOther !== undefined ? 1 : 0);
}

/** Render the option rows plus the preview of the focused option. */
export function choiceLines(opts: {
	field: ChoiceField;
	ctx: BlockCtx;
	width: number;
	value: JsonValue;
	state: ChoiceState;
	focused: boolean;
}): string[] {
	const { field, ctx, width, value, state, focused } = opts;
	const options = choiceOptions(field, ctx);
	const multi = field.multi === true;
	const ids = optionIdList(value);
	const other = otherText(value);
	const singleSelected = typeof value === "string" ? value : "";
	const singleOther =
		typeof value === "object" && value !== null && !Array.isArray(value);
	const unicode = ctx.unicode;
	const lines: string[] = [];
	const radioOn = unicode ? "(*)" : "(*)";
	const radioOff = "( )";
	const checkOn = unicode ? "[x]" : "[x]";
	const checkOff = "[ ]";

	options.forEach((option, index) => {
		const cursor = focused && index === state.cursor ? "> " : "  ";
		const box = multi
			? ids.includes(option.id)
				? checkOn
				: checkOff
			: singleSelected === option.id
				? radioOn
				: radioOff;
		const label = bindRaw(option.label, ctx);
		const text = typeof label === "string" ? label : option.id;
		const recommended = option.recommended === true ? (unicode ? " ★" : " *") : "";
		let line = `${cursor}${box} ${text}${recommended}`;
		const description = bindRaw(option.description, ctx);
		if (typeof description === "string" && description !== "") {
			line += ctx.theme.dim(` — ${description}`);
		}
		lines.push(truncate(line, width));
	});
	if (field.allowOther !== undefined) {
		const index = options.length;
		const cursor = focused && index === state.cursor ? "> " : "  ";
		const selected = multi ? other !== "" : singleOther;
		const box = multi ? (selected ? checkOn : checkOff) : selected ? radioOn : radioOff;
		const rowLabel = field.allowOther.label ?? OTHER_ROW_DEFAULT;
		const typed = selected ? other : focused && index === state.cursor ? state.other.text : "";
		lines.push(truncate(`${cursor}${box} ${rowLabel}: ${typed}`, width));
	}
	// Preview BELOW the options (§5.6's TUI note) while an option is focused.
	const focusedOption = options[state.cursor];
	if (focused && focusedOption?.preview !== undefined && focusedOption.preview !== "") {
		for (const line of wrapPlain(focusedOption.preview, Math.max(1, width - 2))) {
			lines.push(ctx.theme.dim(`  ${line}`));
		}
	}
	return lines;
}

/** The choice value after pressing Enter/Space on `row` (the option
 *  cursor). Returns the next value, or `undefined` when the row is the
 *  other row (text typing handles it) or nothing changed. */
export function choiceActivate(
	field: ChoiceField,
	ctx: BlockCtx,
	value: JsonValue,
	row: number,
): JsonValue | undefined {
	const options = choiceOptions(field, ctx);
	const multi = field.multi === true;
	if (row >= options.length) return undefined; // the other row
	const option = options[row];
	if (option === undefined) return undefined;
	if (!multi) return option.id;
	const current = optionIdList(value);
	const other = otherText(value);
	const otherPart: JsonValue[] = other !== "" ? [{ other } as JsonObject] : [];
	if (current.includes(option.id)) {
		return [...current.filter((id) => id !== option.id), ...otherPart];
	}
	return [...current, option.id, ...otherPart];
}

/** The choice value after the other text changed (empty text clears). */
export function choiceSetOther(field: ChoiceField, value: JsonValue, textValue: string): JsonValue {
	const multi = field.multi === true;
	if (!multi) {
		return textValue === "" ? "" : ({ other: textValue } as JsonObject);
	}
	const current = optionIdList(value);
	return textValue.trim() === ""
		? [...current]
		: [...current, { other: textValue } as JsonObject];
}

/** The review-line text of a choice value (the stepper's review step). */
export function choiceValueText(field: ChoiceField, ctx: BlockCtx, value: JsonValue): string {
	const options = choiceOptions(field, ctx);
	const labelOf = (id: string): string => {
		const option = options.find((candidate) => candidate.id === id);
		const label = option === undefined ? undefined : bindRaw(option.label, ctx);
		return typeof label === "string" && label !== "" ? label : id;
	};
	if (field.multi === true) {
		const parts = optionIdList(value).map(labelOf);
		const other = otherText(value);
		if (other !== "") parts.push(other);
		return parts.join(", ");
	}
	if (typeof value === "string") return value === "" ? "" : labelOf(value);
	const other = otherText(value);
	return other;
}

/** Keep the cursor inside the row count. */
export function clampChoiceCursor(field: ChoiceField, ctx: BlockCtx, state: ChoiceState): void {
	const count = choiceRowCount(field, ctx);
	if (state.cursor >= count) state.cursor = Math.max(0, count - 1);
	if (state.cursor < 0) state.cursor = 0;
}
