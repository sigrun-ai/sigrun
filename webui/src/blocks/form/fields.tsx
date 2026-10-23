/**
 * Form fields (UI-blocks U1 Task 5, spec §5.6): the simple field
 * renderers — text, longtext, number, toggle, date, datetime — and the
 * shared `FieldRow` chrome (label, help, error). Choice, secret, file,
 * list and daterange live in their own modules.
 *
 * Every field is a controlled input whose value lives in the owning
 * form's values state; a field reports edits through `onChange(name,
 * value)`. `access: "read"` disables the control (§6.5); a `disabled`
 * field is disabled regardless.
 */

import type { ReactNode } from "react";
import type {
	DateField,
	DatetimeField,
	Field,
	FieldBase,
	JsonValue,
	LongtextField,
	NumberField,
	TextField,
	ToggleField,
} from "@sigrun/shared/blocks";
import { boundString, useSurfaceData } from "../context";
import { FieldView as ChoiceFieldView } from "./ChoiceField";
import { SecretFieldView } from "./SecretField";
import { FileFieldView } from "./FileField";
import { ListFieldView } from "./ListField";
import { DaterangeFieldView } from "./DaterangeField";

/** What the owning form hands every field renderer. */
export interface FieldProps<F extends Field = Field> {
	readonly field: F;
	readonly value: JsonValue;
	/** The edit report; the form validates/debounces/dispatches. */
	readonly onChange: (name: string, value: JsonValue) => void;
	/** Read access or a disabled field (already ORed by the form). */
	readonly disabled: boolean;
	/** The error under the field (client or server `{error: {field}}`). */
	readonly error?: string;
	/** The form's `bind` (secret resolves its bound status against it). */
	readonly formBind?: string;
}

/** The label/help/error chrome every field shares (spec §5.6). */
export function FieldRow(props: {
	readonly field: FieldBase;
	readonly error?: string;
	readonly children: ReactNode;
}): ReactNode {
	const data = useSurfaceData();
	const label = boundString(data, props.field.label);
	const help = boundString(data, props.field.help);
	return (
		<div className="blk-field" data-field={(props.field as { readonly type?: string }).type} data-name={props.field.name}>
			{label !== "" && (
				<label className="blk-field-label" dir="auto">
					{label}
					{props.field.required === true && <span aria-hidden> *</span>}
				</label>
			)}
			{props.children}
			{help !== "" && (
				<div className="blk-field-help" dir="auto">
					{help}
				</div>
			)}
			{props.error !== undefined && (
				<div className="blk-field-error" role="alert" dir="auto">
					{props.error}
				</div>
			)}
		</div>
	);
}

function TextFieldView(props: FieldProps<TextField>): ReactNode {
	const { field } = props;
	const data = useSurfaceData();
	const type =
		field.kind === "email" ? "email" : field.kind === "url" ? "url" : field.kind === "search" ? "search" : "text";
	return (
		<FieldRow field={field} error={props.error}>
			<input
				type={type}
				dir="auto"
				aria-label={boundString(data, field.label)}
				placeholder={boundString(data, field.placeholder)}
				value={typeof props.value === "string" ? props.value : ""}
				disabled={props.disabled}
				onChange={(event) => props.onChange(field.name, event.target.value)}
			/>
		</FieldRow>
	);
}

function LongtextFieldView(props: FieldProps<LongtextField>): ReactNode {
	const { field } = props;
	const data = useSurfaceData();
	return (
		<FieldRow field={field} error={props.error}>
			<textarea
				dir="auto"
				aria-label={boundString(data, field.label)}
				placeholder={boundString(data, field.placeholder)}
				rows={field.rows ?? 3}
				value={typeof props.value === "string" ? props.value : ""}
				disabled={props.disabled}
				onChange={(event) => props.onChange(field.name, event.target.value)}
			/>
		</FieldRow>
	);
}

function NumberFieldView(props: FieldProps<NumberField>): ReactNode {
	const { field } = props;
	const data = useSurfaceData();
	return (
		<FieldRow field={field} error={props.error}>
			<input
				type="number"
				aria-label={boundString(data, field.label)}
				placeholder={boundString(data, field.placeholder)}
				value={typeof props.value === "number" ? String(props.value) : ""}
				step={field.step}
				min={field.min}
				max={field.max}
				disabled={props.disabled}
				onChange={(event) => {
					const raw = event.target.value;
					props.onChange(field.name, raw === "" ? "" : Number(raw));
				}}
			/>
		</FieldRow>
	);
}

function ToggleFieldView(props: FieldProps<ToggleField>): ReactNode {
	const { field } = props;
	const data = useSurfaceData();
	return (
		<FieldRow field={field} error={props.error}>
			<input
				type="checkbox"
				aria-label={boundString(data, field.label)}
				checked={props.value === true}
				disabled={props.disabled}
				onChange={(event) => props.onChange(field.name, event.target.checked)}
			/>
		</FieldRow>
	);
}

function DateFieldView(props: FieldProps<DateField>): ReactNode {
	const { field } = props;
	const data = useSurfaceData();
	return (
		<FieldRow field={field} error={props.error}>
			<input
				type="date"
				aria-label={boundString(data, field.label)}
				value={typeof props.value === "string" ? props.value : ""}
				min={field.min !== undefined ? String(field.min) : undefined}
				max={field.max !== undefined ? String(field.max) : undefined}
				disabled={props.disabled}
				onChange={(event) => props.onChange(field.name, event.target.value)}
			/>
		</FieldRow>
	);
}

function DatetimeFieldView(props: FieldProps<DatetimeField>): ReactNode {
	const { field } = props;
	const data = useSurfaceData();
	return (
		<FieldRow field={field} error={props.error}>
			<input
				type="datetime-local"
				aria-label={boundString(data, field.label)}
				value={typeof props.value === "string" ? props.value : ""}
				min={field.min !== undefined ? String(field.min) : undefined}
				max={field.max !== undefined ? String(field.max) : undefined}
				disabled={props.disabled}
				onChange={(event) => props.onChange(field.name, event.target.value)}
			/>
		</FieldRow>
	);
}

/** The field dispatch (one component per field type). */
export function FieldView(props: FieldProps): ReactNode {
	const field = props.field;
	switch (field.type) {
		case "text":
			return <TextFieldView {...props} field={field} />;
		case "longtext":
			return <LongtextFieldView {...props} field={field} />;
		case "number":
			return <NumberFieldView {...props} field={field} />;
		case "toggle":
			return <ToggleFieldView {...props} field={field} />;
		case "date":
			return <DateFieldView {...props} field={field} />;
		case "datetime":
			return <DatetimeFieldView {...props} field={field} />;
		case "choice":
			return <ChoiceFieldView {...props} field={field} />;
		case "secret":
			return <SecretFieldView {...props} field={field} />;
		case "file":
			return <FileFieldView {...props} field={field} />;
		case "list":
			return <ListFieldView {...props} field={field} />;
		case "daterange":
			return <DaterangeFieldView {...props} field={field} />;
	}
}
