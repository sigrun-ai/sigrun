/**
 * A searchable dropdown (combobox) for choice fields with many options.
 * Replaces the `<select>` branch of ChoiceField: a text input with
 * role="combobox" filters options by case-insensitive substring matching
 * (every whitespace-separated term must match label or id), ArrowUp/Down
 * move the highlight, Enter picks, Escape closes. Multi-select shows
 * removable chips and keeps the list open after a pick. `allowOtherLabel`
 * adds a trailing "Use \"<text>\"" option when the typed text matches no
 * option exactly.
 */

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useDismiss } from "../../useDismiss";

export interface ComboboxOption {
	readonly id: string;
	readonly label: string;
}

export function Combobox(props: {
	readonly label: string;
	readonly options: readonly ComboboxOption[];
	readonly multi: boolean;
	readonly value: string | readonly string[];
	readonly placeholder?: string;
	readonly disabled?: boolean;
	readonly allowOtherLabel?: string;
	readonly onChange: (value: string | readonly string[] | { other: string }) => void;
}): ReactNode {
	const { label, options, multi, value, placeholder, disabled, allowOtherLabel, onChange } = props;
	const [text, setText] = useState("");
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const rootRef = useRef<HTMLDivElement | null>(null);
	useDismiss(open, () => setOpen(false), rootRef);

	const selectedIds = multi
		? (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [])
		: typeof value === "string" && value !== "" ? [value] : [];

	const filtered = options.filter((option) => {
		if (text.trim() === "") return true;
		const terms = text.trim().toLowerCase().split(/\s+/);
		const haystack = `${option.label} ${option.id}`.toLowerCase();
		return terms.every((term) => haystack.includes(term));
	});

	const showOther = allowOtherLabel !== undefined && text.trim() !== "" &&
		!options.some((o) => o.label === text.trim() || o.id === text.trim());
	const totalItems = filtered.length + (showOther ? 1 : 0);

	function openMenu(): void {
		setHighlight(0);
		setOpen(true);
	}

	function pickOption(id: string): void {
		if (multi) {
			onChange([...selectedIds, id]);
		} else {
			onChange(id);
			setOpen(false);
		}
		setText("");
	}

	function pickOther(): void {
		const trimmed = text.trim();
		if (multi) {
			onChange([...selectedIds, { other: trimmed }] as readonly string[]);
		} else {
			onChange({ other: trimmed });
			setOpen(false);
		}
		setText("");
	}

	function removeChip(id: string): void {
		onChange(selectedIds.filter((v) => v !== id));
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (!open) {
			if (
				event.key === "Enter" ||
				event.key === " " ||
				event.key === "ArrowDown" ||
				event.key === "ArrowUp"
			) {
				event.preventDefault();
				openMenu();
			}
			return;
		}
		switch (event.key) {
			case "Escape":
				event.preventDefault();
				setOpen(false);
				break;
			case "ArrowDown":
				event.preventDefault();
				setHighlight((h) => (h + 1) % totalItems);
				break;
			case "ArrowUp":
				event.preventDefault();
				setHighlight((h) => (h - 1 + totalItems) % totalItems);
				break;
			case "Enter":
				event.preventDefault();
				if (highlight < filtered.length) {
					const opt = filtered[highlight];
					if (opt !== undefined) pickOption(opt.id);
				} else if (showOther) {
					pickOther();
				}
				break;
			case "Tab":
				setOpen(false);
				break;
			default:
				break;
		}
	}

	return (
		<div className="blk-combobox" ref={rootRef}>
			{multi && selectedIds.length > 0 && (
				<div className="blk-combobox-chips">
					{selectedIds.map((id) => {
						const opt = options.find((o) => o.id === id);
						return (
							<span key={id} className="blk-combobox-chip">
								<span className="blk-combobox-chip-label">{opt?.label ?? id}</span>
								<button
									type="button"
									className="blk-combobox-chip-remove"
									aria-label={`Remove ${opt?.label ?? id}`}
									disabled={disabled}
									onClick={() => removeChip(id)}
								>
									×
								</button>
							</span>
						);
					})}
				</div>
			)}
			<input
				type="text"
				role="combobox"
				aria-label={label}
				aria-expanded={open}
				aria-haspopup="listbox"
				aria-autocomplete="list"
				aria-activedescendant={
					open && totalItems > 0 ? `blk-combobox-option-${highlight}` : undefined
				}
				placeholder={placeholder ?? ""}
				value={text}
				disabled={disabled}
				onChange={(event) => {
					setText(event.target.value);
					if (!open) openMenu();
				}}
				onFocus={() => {
					if (!open) openMenu();
				}}
				onKeyDown={onKeyDown}
			/>
			{open && totalItems > 0 && (
				<ul className="blk-combobox-menu" role="listbox" aria-label={label}>
					{filtered.map((option, index) => (
						<li
							key={option.id}
							id={`blk-combobox-option-${index}`}
							role="option"
							aria-selected={selectedIds.includes(option.id)}
							data-highlighted={index === highlight || undefined}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => pickOption(option.id)}
						>
							{option.label}
						</li>
					))}
					{showOther && (
						<li
							id={`blk-combobox-option-${filtered.length}`}
							role="option"
							data-highlighted={highlight === filtered.length || undefined}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => pickOther()}
						>
							{`Use "${text.trim()}"`}
						</li>
					)}
				</ul>
			)}
		</div>
	);
}
