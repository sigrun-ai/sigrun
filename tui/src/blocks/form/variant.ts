/** A variant's discriminator chooses the visible nested fields. Changing
 *  options keeps only the new option's discriminator and default values. */

import type { JsonObject, JsonValue, VariantField } from "@sigrun/shared/blocks";
import { truncate } from "../width.js";
import { defaultEntry } from "./values.js";

export class VariantFieldState {
	cursor = 0;
	open = true;
}

export function variantSelected(field: VariantField, value: JsonValue): string {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		const selected = (value as JsonObject)[field.discriminator];
		if (typeof selected === "string") return selected;
	}
	return field.options[0]?.id ?? "";
}

export function variantOption(
	field: VariantField,
	value: JsonValue,
): VariantField["options"][number] | undefined {
	const selected = variantSelected(field, value);
	return field.options.find((option) => option.id === selected) ?? field.options[0];
}

export function switchVariant(field: VariantField, id: string): JsonObject | undefined {
	const option = field.options.find((candidate) => candidate.id === id);
	if (option === undefined) return undefined;
	return { [field.discriminator]: id, ...defaultEntry(option.children) };
}

export function variantLines(opts: {
	field: VariantField;
	value: JsonValue;
	state: VariantFieldState;
	focused: boolean;
	width: number;
}): string[] {
	const { field, value, state, focused, width } = opts;
	const selected = variantSelected(field, value);
	return field.options.map((option, index) => {
		const cursor = focused && index === state.cursor ? "> " : "  ";
		const radio = option.id === selected ? "(*)" : "( )";
		return truncate(`${cursor}${radio} ${option.label}`, width);
	});
}

export function variantHintLine(width: number): string {
	return truncate("  Enter select/edit · Esc back", width);
}

