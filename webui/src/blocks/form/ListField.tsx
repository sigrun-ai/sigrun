/**
 * The list field (UI-blocks U1 Task 5, spec §5.6): a repeatable group —
 * `item` describes the fields of ONE entry; the value is an array of
 * entry values. Add/remove honour `min`/`max`; `reorder` shows
 * up/down controls (keyboard-reachable, no pointer dependency).
 */

import type { ReactNode } from "react";
import type { JsonValue, ListField } from "@sigrun/shared/blocks";
import { FieldRow, FieldView, type FieldProps } from "./fields";

function entries(value: JsonValue): readonly JsonValue[] {
	return Array.isArray(value) ? value : [];
}

export function ListFieldView(props: FieldProps<ListField>): ReactNode {
	const { field } = props;
	const values = entries(props.value);
	const min = field.min ?? 0;
	const max = field.max;
	const canAdd = !props.disabled && (max === undefined || values.length < max);
	const canRemove = !props.disabled && values.length > min;
	const canReorder = !props.disabled && field.reorder === true;

	const write = (next: readonly JsonValue[]): void =>
		props.onChange(field.name, [...next]);
	const update = (index: number, entry: JsonValue): void =>
		write(values.map((value, at) => (at === index ? entry : value)));
	const remove = (index: number): void =>
		write(values.filter((_, at) => at !== index));
	const move = (index: number, delta: number): void => {
		const target = index + delta;
		if (target < 0 || target >= values.length) return;
		const next = [...values];
		const [entry] = next.splice(index, 1);
		next.splice(target, 0, entry as JsonValue);
		write(next);
	};
	const add = (): void => {
		// A new entry starts at the item field's empty value.
		write([...values, ""]);
	};

	return (
		<FieldRow field={field} error={props.error}>
			<div className="blk-list" data-min={min} data-max={max}>
				{values.map((entry, index) => (
					<div className="blk-list-entry" key={index}>
						<FieldView
							field={{ ...field.item, name: `${field.name}.${index}` } as typeof field.item}
							value={entry}
							disabled={props.disabled}
							onChange={(_name, value) => update(index, value)}
						/>
						<div className="blk-list-controls">
							{canReorder && (
								<>
									<button
										type="button"
										aria-label={`move entry ${index + 1} up`}
										disabled={index === 0}
										onClick={() => move(index, -1)}
									>
										↑
									</button>
									<button
										type="button"
										aria-label={`move entry ${index + 1} down`}
										disabled={index === values.length - 1}
										onClick={() => move(index, 1)}
									>
										↓
									</button>
								</>
							)}
							<button
								type="button"
								aria-label={`remove entry ${index + 1}`}
								disabled={!canRemove}
								onClick={() => remove(index)}
							>
								Remove
							</button>
						</div>
					</div>
				))}
				<button type="button" disabled={!canAdd} onClick={add}>
					Add
				</button>
			</div>
		</FieldRow>
	);
}
