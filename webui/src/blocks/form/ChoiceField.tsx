/**
 * The choice field (UI-blocks U1 Task 5, spec §5.6): single value = the
 * selected id; multi = the ids; `allowOther` adds a free-text row whose
 * value is `{other: text}` (single) or the ids plus `{other: text}` as
 * the last element (multi). A focused option's `preview` markdown shows
 * BESIDE the options at regular width and wider, BELOW at compact
 * (§12.3 — the channel picks the layout by width class). The channel
 * picks radio buttons (few options), a select (many options) or a list
 * by option count and width.
 */

import { useState, type ReactNode } from "react";
import type { ChoiceField, ChoiceOption, JsonValue } from "@sigrun/shared/blocks";
import { bound, boundString, useSurfaceData } from "../context";
import { useWidthClass } from "../width";
import { MarkdownBlockView } from "../content";
import { FieldRow, type FieldProps } from "./fields";

/** Few options render as radio buttons / checkboxes; many collapse to
 *  a `<select>` (§5.6's "by option count"). */
const RADIO_MAX = 5;

/** The `allowOther` row id marker (never a real option id — options are
 *  server-defined and the value shape proves it). */
const OTHER_ID = "__other__";

function optionIdList(value: JsonValue): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

function otherText(value: JsonValue): string {
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

/** The choice field renderer (exported as `FieldView` for the fields
 *  dispatch). */
export function FieldView(props: FieldProps<ChoiceField>): ReactNode {
	const { field } = props;
	const data = useSurfaceData();
	const widthClass = useWidthClass();
	const options = bound(data, field.options) ?? [];
	const multi = field.multi === true;
	const allowOther = field.allowOther !== undefined;
	const label = boundString(data, field.label);
	const [focused, setFocused] = useState<string | null>(null);

	const selectedSingle = typeof props.value === "string" ? props.value : "";
	const selectedIds = optionIdList(props.value);
	const other = otherText(props.value);
	const otherSelected = multi ? otherText(props.value) !== "" : typeof props.value === "object" && props.value !== null && !Array.isArray(props.value);

	const setSingle = (id: string): void => props.onChange(field.name, id);
	const setOtherSingle = (text: string): void =>
		props.onChange(field.name, text === "" ? "" : { other: text });
	const toggleMulti = (id: string): void => {
		const current = optionIdList(props.value);
		const otherPart = other !== "" ? [{ other }] : [];
		if (current.includes(id)) {
			props.onChange(field.name, [...current.filter((v) => v !== id), ...otherPart]);
		} else {
			props.onChange(field.name, [...current, id, ...otherPart]);
		}
	};
	const setOtherMulti = (text: string): void => {
		const current = optionIdList(props.value);
		props.onChange(
			field.name,
			text === "" ? [...current] : [...current, { other: text }],
		);
	};

	const previewFor: ChoiceOption | undefined = options.find(
		(option) => option.id === focused && option.preview !== undefined,
	);
	const previewLayout = widthClass === "compact" ? "below" : "beside";

	const body = (
		<>
			{options.length <= RADIO_MAX ? (
				<div className="blk-choice-options" role={multi ? "group" : "radiogroup"} aria-label={label}>
					{options.map((option) => {
						const optionLabel = boundString(data, option.label);
						const checked = multi ? selectedIds.includes(option.id) : selectedSingle === option.id;
						return (
							<label
								key={option.id}
								className="blk-choice-option"
								data-recommended={option.recommended === true || undefined}
								data-tone={option.tone}
								dir="auto"
							>
								<input
									type={multi ? "checkbox" : "radio"}
									name={field.name}
									value={option.id}
									checked={checked}
									disabled={props.disabled}
									onFocus={() => setFocused(option.id)}
									onChange={() => (multi ? toggleMulti(option.id) : setSingle(option.id))}
								/>
								<span className="blk-choice-label" dir="auto">
									{optionLabel}
								</span>
								{option.description !== undefined && (
									<span className="blk-choice-description" dir="auto">
										{boundString(data, option.description)}
									</span>
								)}
							</label>
						);
					})}
				</div>
			) : (
				<select
					aria-label={label}
					multiple={multi}
					disabled={props.disabled}
					value={multi ? [...selectedIds] : selectedSingle}
					onFocus={() => setFocused(null)}
					onChange={(event) => {
						if (multi) {
							const picked = Array.from(event.target.selectedOptions).map((o) => o.value);
							const otherPart = other !== "" ? [{ other }] : [];
							props.onChange(field.name, [...picked, ...otherPart]);
						} else {
							setSingle(event.target.value);
						}
					}}
				>
					{!multi && <option value="" />}
					{options.map((option) => (
						<option key={option.id} value={option.id}>
							{boundString(data, option.label)}
						</option>
					))}
				</select>
			)}
			{allowOther && (
				<div className="blk-choice-other">
					{multi && (
						<input
							type="checkbox"
							aria-label={`${label} other`}
							checked={otherSelected}
							disabled={props.disabled}
							onChange={(event) =>
								event.target.checked
									? setOtherMulti(other === "" ? " " : other)
									: props.onChange(field.name, [...selectedIds])
							}
						/>
					)}
					{(!multi && otherSelected) || multi ? null : null}
					<input
						type="text"
						dir="auto"
						aria-label={`${label} other text`}
						placeholder={field.allowOther?.label ?? "Type something"}
						value={other}
						disabled={props.disabled}
						onFocus={() => setFocused(null)}
						onChange={(event) =>
							multi ? setOtherMulti(event.target.value) : setOtherSingle(event.target.value)
						}
					/>
				</div>
			)}
		</>
	);

	return (
		<FieldRow field={field} error={props.error}>
			<div className="blk-choice" data-preview={previewFor !== undefined ? previewLayout : undefined}>
				<div className="blk-choice-main">{body}</div>
				{previewFor !== undefined && previewFor.preview !== undefined && (
					<div className="blk-choice-preview" data-layout={previewLayout}>
						<MarkdownBlockView block={{ text: previewFor.preview }} />
					</div>
				)}
			</div>
		</FieldRow>
	);
}
