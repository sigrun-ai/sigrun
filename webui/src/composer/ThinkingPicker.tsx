/**
 * ThinkingPicker (B6): the composer toolbar's thinking pill — a popover
 * over the levels `/thinking` accepts. ALWAYS rendered regardless of the
 * catalog's `reasoning` flag: /v1/models reports `reasoning:false` for
 * models that do think (glm-5.3-flash), so the flag must never hide the
 * control (the refresh design's binding ruling).
 *
 * The current level is the LAST LEVEL PICKED THIS SESSION (the caller's
 * state) — `perModelThinking` is not on the view, so before a pick the
 * honest label is "default" (the server-side per-model default applies).
 *
 * Keyboard (the combobox-lite pattern the slash menu uses): the toggle
 * holds focus; Enter/Space/ArrowDown opens, ArrowUp/ArrowDown move the
 * highlight (aria-activedescendant names it), Enter picks, Escape closes.
 * Enter/Space are always preventDefault-ed so the native button click
 * cannot double-fire alongside the keydown path.
 */

import { useState } from "react";

/**
 * The `thinking` values `/thinking` accepts (mirrors the server's
 * THINKING_LEVELS — itself pi-ai `ModelThinkingLevel`; the webui cannot
 * import server sources). Duplicated so an invalid level errors CLEARLY in
 * the composer instead of the generic non-2xx message.
 */
export const THINKING_LEVELS: readonly string[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** The label of a level with no session pick yet. */
export const DEFAULT_THINKING_LABEL = "default";

export function ThinkingPicker(props: {
	/** The last level picked this session, or null (→ "default"). */
	readonly current: string | null;
	/**
	 * Apply a level — the caller's `configure` call. MUST NOT reject: the
	 * caller owns error display (the composer's alert strip) and keeps its
	 * previous selection on failure.
	 */
	onPick: (level: string) => Promise<void>;
}) {
	const { current, onPick } = props;
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(0);

	/** Open the menu with the highlight ON the current level (or the first). */
	function openMenu(): void {
		const current_ = THINKING_LEVELS.indexOf(current ?? "");
		setHighlight(current_ === -1 ? 0 : current_);
		setOpen(true);
	}

	async function pick(level: string): Promise<void> {
		setOpen(false);
		await onPick(level);
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
				setHighlight((h) => (h + 1) % THINKING_LEVELS.length);
				break;
			case "ArrowUp":
				event.preventDefault();
				setHighlight(
					(h) => (h - 1 + THINKING_LEVELS.length) % THINKING_LEVELS.length,
				);
				break;
			case "Enter":
			case " ":
				event.preventDefault();
				void pick(THINKING_LEVELS[highlight] ?? THINKING_LEVELS[0]!);
				break;
			case "Tab":
				setOpen(false);
				break;
			default:
				break;
		}
	}

	const label = current ?? DEFAULT_THINKING_LABEL;
	return (
		<span className="composer-picker">
			<button
				type="button"
				className="composer-pill"
				data-picker="thinking"
				title={`Thinking: ${label}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-activedescendant={
					open ? `composer-thinking-option-${highlight}` : undefined
				}
				onClick={() => (open ? setOpen(false) : openMenu())}
				onKeyDown={onKeyDown}
			>
				{`Thinking: ${label}`}
				<span className="composer-pill-caret" aria-hidden="true">
					▾
				</span>
			</button>
			{open && (
				<ul className="composer-picker-menu" role="listbox" aria-label="thinking levels">
					{THINKING_LEVELS.map((level, index) => (
						<li
							key={level}
							id={`composer-thinking-option-${index}`}
							role="option"
							aria-selected={level === current}
							data-thinking-level={level}
							data-highlighted={index === highlight || undefined}
							onMouseDown={(event) => {
								// Keep the toggle's focus (the highlight is
								// keyboard state, not a second focus target).
								event.preventDefault();
							}}
							onClick={() => void pick(level)}
						>
							{level === current && (
								<span className="composer-picker-check" aria-hidden="true">
									✓
								</span>
							)}
							{level}
						</li>
					))}
				</ul>
			)}
		</span>
	);
}
