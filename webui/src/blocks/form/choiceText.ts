/**
 * The choice value's display text for the stepper review (§7.2 of the
 * ask-user design): option LABELS, not raw ids — single → the option
 * label, multi → labels joined ", ", an "other" value → its text, bare,
 * last in multi. Literal options only; bound options fall back to ids.
 * Unanswered (absent, "", [], {other: ""}) → undefined.
 */

import type { ChoiceField, ChoiceOption, JsonValue } from "@sigrun/shared/blocks";

/** The literal options of a choice (bound options fall back to ids). */
function literalOptions(field: ChoiceField): readonly ChoiceOption[] {
	return Array.isArray(field.options) ? field.options : [];
}

/** The "other" text of a value ("" when none); multi carries it as
 *  the last entry (matching ChoiceField). */
function otherText(value: JsonValue | undefined): string {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const other = (value as { other?: JsonValue }).other;
		return typeof other === "string" ? other : "";
	}
	if (Array.isArray(value)) {
		const last = value[value.length - 1];
		if (typeof last === "object" && last !== null && !Array.isArray(last)) {
			const other = (last as { other?: JsonValue }).other;
			return typeof other === "string" ? other : "";
		}
	}
	return "";
}

/** The selected option ids of a multi value (skips the "other" entry). */
function optionIdList(value: JsonValue | undefined): readonly string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

/** The review text of a choice value; undefined while unanswered. */
export function choiceValueText(
	field: ChoiceField,
	value: JsonValue | undefined,
): string | undefined {
	const options = literalOptions(field);
	const labelOf = (id: string): string => {
		const option = options.find((candidate) => candidate.id === id);
		const label = option?.label;
		return typeof label === "string" && label !== "" ? label : id;
	};
	if (field.multi === true) {
		const parts = optionIdList(value).map(labelOf);
		const other = otherText(value);
		if (other !== "") parts.push(other);
		return parts.length === 0 ? undefined : parts.join(", ");
	}
	if (typeof value === "string") return value === "" ? undefined : labelOf(value);
	const other = otherText(value);
	return other === "" ? undefined : other;
}
