/**
 * ModelPicker (B6): the composer toolbar's model pill — a popover list over
 * the §5 catalog (`GET /v1/models`). Picking delegates to the caller's
 * `onPick` (the composer's `configure(conversationId, {model: id})` — the
 * picker never configures itself, so error display and the previous
 * selection stay the composer's).
 *
 * THE PICKER CONVENTION (spec §6.1, binding): a picker renders ONLY when
 * its list has more than one item — a single-model deployment hides the
 * picker (the single model stays current, so the ring still reads its
 * ledger entry).
 *
 * Keyboard (the combobox-lite pattern the slash menu uses): the toggle
 * holds focus; Enter/Space/ArrowDown opens, ArrowUp/ArrowDown move the
 * highlight (aria-activedescendant names it), Enter picks, Escape closes.
 * Outside-click + Esc close the popover too (useDismiss, B7 polish).
 */

import { useRef, useState } from "react";
import type { ModelEntry } from "../api";
import { useDismiss } from "../useDismiss";

export function ModelPicker(props: {
	/** The catalog (the §5 picker fields — no provider internals). */
	readonly models: readonly ModelEntry[];
	/** The current model id (`provider/modelId`), or null when unknown. */
	readonly current: string | null;
	readonly disabled: boolean;
	/**
	 * Apply a model id — the caller's `configure` call. MUST NOT reject: the
	 * caller owns error display (the composer's alert strip) and keeps its
	 * previous selection on failure.
	 */
	onPick: (id: string) => Promise<void>;
}) {
	const { models, current, disabled, onPick } = props;
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const pickerSlot = useRef<HTMLSpanElement | null>(null);
	useDismiss(open, () => setOpen(false), pickerSlot);

	// The picker convention (see the module comment).
	if (models.length <= 1) return null;

	const currentEntry = models.find((m) => m.id === current);
	const currentName = currentEntry?.name ?? current ?? "model";
	/** The highlight's home row: the current model when it's in the list. */
	const currentRow = Math.max(
		0,
		models.findIndex((m) => m.id === current),
	);

	function openMenu(): void {
		setHighlight(currentRow);
		setOpen(true);
	}

	async function pick(id: string): Promise<void> {
		setOpen(false);
		await onPick(id);
	}

	function onKeyDown(event: {
		readonly key: string;
		preventDefault(): void;
	}): void {
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
				setHighlight((h) => (h + 1) % models.length);
				break;
			case "ArrowUp":
				event.preventDefault();
				setHighlight((h) => (h - 1 + models.length) % models.length);
				break;
			case "Enter":
			case " ":
				event.preventDefault();
				void pick(models[highlight]?.id ?? models[0]!.id);
				break;
			case "Tab":
				setOpen(false);
				break;
			default:
				break;
		}
	}

	return (
		<span className="composer-picker" ref={pickerSlot}>
			<button
				type="button"
				className="composer-pill"
				data-picker="model"
				title={`Model: ${currentName}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-activedescendant={
					open ? `composer-model-option-${highlight}` : undefined
				}
				disabled={disabled}
				onClick={() => (open ? setOpen(false) : openMenu())}
				onKeyDown={onKeyDown}
			>
				{currentName}
				<span className="composer-pill-caret" aria-hidden="true">
					▾
				</span>
			</button>
			{open && (
				<ul className="composer-picker-menu" role="listbox" aria-label="models">
					{models.map((model, index) => (
						<li
							key={model.id}
							id={`composer-model-option-${index}`}
							role="option"
							aria-selected={model.id === current}
							data-model-id={model.id}
							data-highlighted={index === highlight || undefined}
							onMouseDown={(event) => {
								// Keep the toggle's focus (the highlight is
								// keyboard state, not a second focus target).
								event.preventDefault();
							}}
							onClick={() => void pick(model.id)}
						>
							{model.id === current && (
								<span className="composer-picker-check" aria-hidden="true">
									✓
								</span>
							)}
							<span className="composer-picker-name">{model.name}</span>
							<span className="composer-picker-id">{model.id}</span>
						</li>
					))}
				</ul>
			)}
		</span>
	);
}
