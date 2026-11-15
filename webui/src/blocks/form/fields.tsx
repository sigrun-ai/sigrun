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

import { useLayoutEffect, useRef, type ReactNode } from "react";
import {
	resolvePointer,
	type DateField,
	type DatetimeField,
	type Field,
	type FieldBase,
	type JsonValue,
	type LongtextField,
	type NumberField,
	type TextField,
	type ToggleField,
} from "@sigrun/shared/blocks";
import { boundString, useSurfaceData } from "../context";
import { FieldView as ChoiceFieldView } from "./ChoiceField";
import { SecretFieldView } from "./SecretField";
import { FileFieldView } from "./FileField";
import { ListFieldView } from "./ListField";
import { DaterangeFieldView } from "./DaterangeField";
import { EntriesFieldView } from "./EntriesField";
import { VariantFieldView } from "./VariantField";
import { watchLongtextHeight } from "./longtextHeight";

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
	/** A toggle carries its label beside its checkbox instead. */
	readonly labelInline?: boolean;
}): ReactNode {
	const data = useSurfaceData();
	const label = boundString(data, props.field.label);
	const help = boundString(data, props.field.help);
	return (
		<div className="blk-field" data-field={(props.field as { readonly type?: string }).type} data-name={props.field.name}>
			{props.labelInline === true ? (
				<>
					{props.children}
					{help !== "" && (
						<div className="blk-field-help" dir="auto">
							{help}
						</div>
					)}
				</>
			) : (
				<>
					{label !== "" && (
						<label className="blk-field-label" dir="auto">
							{label}
							{props.field.required === true && <span aria-hidden> *</span>}
						</label>
					)}
					{help !== "" && (
						<div className="blk-field-help" dir="auto">
							{help}
						</div>
					)}
					{props.children}
				</>
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
	const textarea = useRef<HTMLTextAreaElement>(null);
	const value = typeof props.value === "string" ? props.value : "";
	useLayoutEffect(() => {
		const element = textarea.current;
		if (element === null) return;
		return watchLongtextHeight(element, field.fill === true);
	}, [field.fill, value]);
	return (
		<FieldRow field={field} error={props.error}>
			<textarea
				ref={textarea}
				dir="auto"
				aria-label={boundString(data, field.label)}
				className={field.fill === true ? "blk-longtext-fill" : undefined}
				placeholder={boundString(data, field.placeholder)}
				rows={field.rows ?? 3}
				value={value}
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
	const label = boundString(data, field.label);
	return (
		<FieldRow field={field} error={props.error} labelInline>
			<label className="blk-toggle">
				<input
					type="checkbox"
					aria-label={label}
					checked={props.value === true}
					disabled={props.disabled}
					onChange={(event) => props.onChange(field.name, event.target.checked)}
				/>
				<span className="blk-field-label" dir="auto">
					{label}
					{field.required === true && <span aria-hidden> *</span>}
				</span>
			</label>
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

/** The raw system value becomes the user's initial override on uncheck:
 *  a toggle inverts it (false when absent), a list copies it ([] when
 *  absent), anything else takes it verbatim ("" when absent). */
function rawSeed(field: Field, raw: JsonValue | undefined): JsonValue {
	if (field.type === "toggle") return raw === undefined ? false : !raw;
	if (field.type === "list" || field.type === "entries") {
		return Array.isArray(raw) ? [...raw] : [];
	}
	return raw === undefined ? "" : raw;
}

/** Personal override chrome: the "Use system setting" checkbox wraps the
 *  control. Checked (value null) → disabled control showing the system
 *  display text; unchecked → the control holds the user's override. */
function InheritRow(props: FieldProps): ReactNode {
	const { field } = props;
	const data = useSurfaceData();
	const inherit = field.inherit;
	if (inherit === undefined) return null;
	const system = boundString(data, inherit.system);
	const checked = props.value === null;
	// The displayed control value: the raw system value when inherited.
	let display: JsonValue = props.value;
	if (checked) {
		const raw = resolve(inherit.raw);
		if (field.type === "toggle") display = raw === true;
		else if (field.type === "list" || field.type === "entries") display = Array.isArray(raw) ? raw : [];
		else display = raw ?? "";
	}
	const toggle = (next: boolean): void => {
		if (next) {
			props.onChange(field.name, null);
			return;
		}
		props.onChange(field.name, rawSeed(field, resolve(inherit.raw)));
	};
	function resolve(binding: { readonly $: string }): JsonValue | undefined {
		return resolvePointer(data.data, binding.$) as JsonValue | undefined;
	}
	return (
		<>
			<label>
				<input
					type="checkbox"
					className="blk-field-inherit"
					checked={checked}
					onChange={(event) => toggle(event.target.checked)}
				/>{" "}
				Use system setting ({system})
			</label>
			<FieldViewField {...props} field={field} value={display} disabled={props.disabled || checked} />
		</>
);
}

/** The field dispatch (one component per field type). */
export function FieldView(props: FieldProps): ReactNode {
		if (props.field.inherit !== undefined) return <InheritRow {...props} />;
		return <FieldViewField {...props} />;
}

function FieldViewField(props: FieldProps): ReactNode {
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
		case "entries":
			return <EntriesFieldView {...props} field={field} />;
		case "variant":
			return <VariantFieldView {...props} field={field} />;
	}
}
