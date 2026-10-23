/**
 * The secret field (UI-blocks U1 Task 5, spec §5.6/§15): write-only.
 * It NEVER renders a value — only the bound status: `set (stored)`,
 * `set (env)`, or `not set`. The submitted value is exactly what the
 * user typed this session (an untouched secret submits its initial
 * value only when the data carries one, which for a write-only field
 * is never — so an untouched secret submits nothing meaningful).
 */

import type { ReactNode } from "react";
import type { SecretField } from "@sigrun/shared/blocks";
import { bound, boundString, useSurfaceData } from "../context";
import { FieldRow, type FieldProps } from "./fields";

/** The status text, from the field's bound status (spec §5.6). */
function statusText(status: unknown): string {
	if (status === "stored") return "set (stored)";
	if (status === "env") return "set (env)";
	return "not set";
}

export function SecretFieldView(props: FieldProps<SecretField>): ReactNode {
	const { field } = props;
	const data = useSurfaceData();
	// The bound value is the STATUS string, not the secret (§15: a
	// secret is text everywhere; the channel never receives it back).
	const status = bound<string>(data, { $: field.name });
	const typed = typeof props.value === "string" ? props.value : "";
	return (
		<FieldRow field={field} error={props.error}>
			<div className="blk-secret">
				<span className="blk-secret-status" data-status={typeof status === "string" ? status : "unset"}>
					{statusText(status)}
				</span>
				<input
					type="password"
					dir="auto"
					aria-label={boundString(data, field.label)}
					placeholder={boundString(data, field.placeholder)}
					autoComplete="new-password"
					value={typed}
					disabled={props.disabled}
					onChange={(event) => props.onChange(field.name, event.target.value)}
				/>
			</div>
		</FieldRow>
	);
}
