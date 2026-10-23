/**
 * The file field (UI-blocks U1 Task 5, spec §5.6): validates `accept`
 * (MIME patterns) and `maxBytes` before dispatching `onUpload` with the
 * picked files as `{name, size, type}` descriptors (the bytes ride the
 * surface's upload route, §7.2 — the form's job is the pre-check and
 * the dispatch). A file failing a check shows its error under the
 * field and dispatches nothing.
 */

import { useRef, useState, type ReactNode } from "react";
import type { FileField } from "@sigrun/shared/blocks";
import { boundString, useSurfaceActions, useSurfaceData } from "../context";
import { FieldRow, type FieldProps } from "./fields";

/** Whether a file's MIME type matches the accept patterns
 *  (comma-separated: `image/*`, `image/png`, `.png`). */
export function acceptsMime(accept: string | undefined, file: { type: string; name: string }): boolean {
	if (accept === undefined || accept.trim() === "") return true;
	return accept.split(",").some((raw) => {
		const pattern = raw.trim();
		if (pattern === "") return false;
		if (pattern.startsWith(".")) return file.name.endsWith(pattern);
		if (pattern.endsWith("/*")) return file.type.startsWith(pattern.slice(0, -1));
		return file.type === pattern;
	});
}

interface FileLike {
	readonly name: string;
	readonly size: number;
	readonly type: string;
}

export function FileFieldView(props: FieldProps<FileField>): ReactNode {
	const { field } = props;
	const data = useSurfaceData();
	const actions = useSurfaceActions();
	const [localError, setLocalError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const label = boundString(data, field.label);

	const pick = (files: readonly FileLike[]): void => {
		const accepted: FileLike[] = [];
		for (const file of files) {
			if (!acceptsMime(field.accept, file)) {
				setLocalError(`${file.name}: not an accepted type`);
				return;
			}
			if (field.maxBytes !== undefined && file.size > field.maxBytes) {
				setLocalError(`${file.name} is larger than ${field.maxBytes} bytes`);
				return;
			}
			accepted.push(file);
		}
		setLocalError(null);
		props.onChange(
			field.name,
			accepted.map((file) => ({ name: file.name, size: file.size, type: file.type })),
		);
		actions.dispatch(
			{ type: "submit", name: field.onUpload, turn: false },
			{
				field: field.name,
				files: accepted.map((file) => ({ name: file.name, size: file.size, type: file.type })),
			},
		);
		if (inputRef.current !== null) inputRef.current.value = "";
	};

	const error = localError ?? props.error;
	return (
		<FieldRow field={field} error={error}>
			<input
				ref={inputRef}
				type="file"
				aria-label={label}
				accept={field.accept}
				multiple={field.multi === true}
				disabled={props.disabled}
				onChange={(event) => {
					const list = event.target.files;
					pick(list === null ? [] : Array.from(list) as FileLike[]);
				}}
			/>
		</FieldRow>
	);
}
