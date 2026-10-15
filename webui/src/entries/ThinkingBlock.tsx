/**
 * ThinkingBlock: one collapsible thinking block of an assistant message.
 *
 * A native `<details>` — collapsed at rest (the user expands at will),
 * `open` while `live` (the streaming partial renders its thinking visibly,
 * doubling as the working indicator; the 2026-10-15 quick-wins ruling).
 * When `live` is false the `open` attribute is absent, so the element is
 * fully uncontrolled — a user's manual toggle is never fought by a
 * re-render.
 *
 * `showThinking=false` hides the block entirely — the AssistantEntry skips
 * rendering it (the pref gate lives there, one place).
 */

export function ThinkingBlock(props: {
	/** The thinking text (verbatim, pre-wrap — never markdown-parsed). */
	readonly text: string;
	/** Live (streaming partial): expanded + pulsing. */
	readonly live?: boolean;
}) {
	const { text, live = false } = props;
	return (
		<details
			className="entry-thinking"
			data-live={live || undefined}
			open={live || undefined}
		>
			<summary className="entry-thinking-summary">
				{live ? "thinking…" : "thinking"}
			</summary>
			<div className="entry-thinking-body">{text}</div>
		</details>
	);
}
