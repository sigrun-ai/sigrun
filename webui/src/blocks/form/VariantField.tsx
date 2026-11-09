/** A variant field (settings rework §2/§3): its discriminator selects the
 *  visible children; changing options drops every other option's values. */

import type { ReactNode } from "react";
import type { Field, JsonObject, JsonValue, SectionBlock, VariantField } from "@sigrun/shared/blocks";
import { boundString, useSurfaceData } from "../context";
import { BlockView } from "../BlockView";
import { FieldRow, FieldView, type FieldProps } from "./fields";
import { initialValue } from "./values";

export function VariantFieldView(props: FieldProps<VariantField>): ReactNode {
	const { field } = props;
	const data = useSurfaceData();
	const value = typeof props.value === "object" && props.value !== null && !Array.isArray(props.value)
		? props.value as JsonObject
		: {};
	const discriminator = value[field.discriminator];
	const selected = typeof discriminator === "string"
		? discriminator
		: field.options[0]?.id ?? "";
	const option = field.options.find((candidate) => candidate.id === selected) ?? field.options[0];

	const switchTo = (id: string): void => {
		const next = field.options.find((candidate) => candidate.id === id);
		if (next === undefined) return;
		const entry: JsonObject = { [field.discriminator]: id };
		const copy = (children: readonly (Field | SectionBlock)[]): void => {
			for (const child of children) {
				if (child.type === "section") {
					for (const nested of child.children) {
						if ("name" in nested) entry[nested.name] = initialValue(nested, {});
					}
				} else entry[child.name] = initialValue(child, {});
			}
		};
		copy(next.children);
		props.onChange(field.name, entry);
	};
	const change = (name: string, next: JsonValue): void => {
		props.onChange(field.name, { ...value, [field.discriminator]: selected, [name]: next });
	};
	const renderChildren = (children: readonly (Field | SectionBlock)[]): ReactNode => children.map((child, index) => {
		if (child.type === "section") {
			return (
				<div className="blk blk-section" data-block="section" key={index}>
					{child.title !== undefined && <h3 className="blk-section-title">{boundString(data, child.title)}</h3>}
					{child.children.map((nested, nestedIndex) => "name" in nested ? (
						<FieldView
							key={nestedIndex}
							field={nested}
							value={value[nested.name]}
							disabled={props.disabled || nested.disabled === true}
							formBind={props.formBind}
							onChange={change}
						/>
					) : <BlockView key={nestedIndex} block={nested as never} />)}
				</div>
			);
		}
		return (
			<FieldView
				key={index}
				field={child}
				value={value[child.name]}
				disabled={props.disabled || child.disabled === true}
				formBind={props.formBind}
				onChange={change}
			/>
		);
	});

	return (
		<FieldRow field={field} error={props.error}>
			<div className="blk-variant">
				<select
					aria-label={boundString(data, field.label)}
					value={selected}
					disabled={props.disabled}
					onChange={(event) => switchTo(event.target.value)}
				>
					{field.options.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
				</select>
				{option !== undefined && <div className="blk-variant-children">{renderChildren(option.children)}</div>}
			</div>
		</FieldRow>
	);
}
