/**
 * MessageActions (B4, UI refresh): the quiet per-turn action row — Copy
 * (clipboard write, label flips to "Copied" for 1.5 s), Edit (user turns
 * only), Fork from here. Hover/FOCUS-WITHIN reveals it via CSS only: the
 * buttons are always in the DOM and the tab order, never hover-only
 * reachable.
 */

import { useEffect, useRef, useState } from "react";

/** How long the Copy button's label reads "Copied" (ms). */
const COPIED_RESET_MS = 1500;

/**
 * Copy text through the async clipboard API. Best-effort: an absent
 * clipboard (the test runner, insecure origins) or a rejected write is a
 * no-op — Copy is never a blocking action.
 */
export function copyText(text: string): void {
	const clipboard = (
		globalThis as {
			navigator?: { clipboard?: { writeText(text: string): Promise<void> } };
		}
	).navigator?.clipboard;
	if (clipboard === undefined) return;
	void clipboard.writeText(text).catch(() => {
		// best-effort: a failed write keeps the transcript usable
	});
}

export function MessageActions(props: {
	kind: "user" | "assistant";
	/** The message's source text (Copy writes it verbatim). */
	text: string;
	onFork(): void;
	/** Edit opens the message for resubmission (user turns only). */
	onEdit?(): void;
	/** The right-aligned faint label (`<model> · <n> tokens`), when known. */
	meta?: string;
}) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		return () => {
			if (timer.current !== null) clearTimeout(timer.current);
		};
	}, []);
	const onCopy = (): void => {
		copyText(props.text);
		setCopied(true);
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
	};
	return (
		<div className="message-actions" data-kind={props.kind}>
			<button
				type="button"
				className="message-action"
				data-copied={copied || undefined}
				onClick={onCopy}
			>
				{copied ? "Copied" : "Copy"}
			</button>
			{props.kind === "user" && props.onEdit !== undefined && (
				<button type="button" className="message-action" onClick={props.onEdit}>
					Edit
				</button>
			)}
			<button type="button" className="message-action" onClick={props.onFork}>
				Fork from here
			</button>
			{props.meta !== undefined && (
				<span className="message-meta">{props.meta}</span>
			)}
		</div>
	);
}
