/**
 * UndoToast (deleted-conversations Task 4): the rail-local actionable
 * toast for Delete — message + one action button, auto-dismiss after
 * 8 s. It lives in the rail (SessionList), NOT in the chat column, so
 * it survives switching conversations: Undo restores the id CAPTURED AT
 * DELETE TIME (the `conversationId` prop), never the active id.
 *
 * There is no pre-existing client-local actionable toast — the notices
 * system is server-sourced; this one is a pure local component.
 */

import { useEffect } from "react";

/** The auto-dismiss window (the plan's Global Constraints: 8 s). */
const DISMISS_MS = 8_000;

export function UndoToast(props: {
	/** The deleted conversation's id — captured when Delete was clicked. */
	readonly conversationId: number;
	/** Restore the captured conversation (App's restoreConversation). */
	readonly onRestore: (id: number) => Promise<void>;
	/** Dismiss without restoring (also fires on the auto-dismiss timer). */
	readonly onDismiss: () => void;
}) {
	const { conversationId, onRestore, onDismiss } = props;
	useEffect(() => {
		const timer = setTimeout(onDismiss, DISMISS_MS);
		return () => clearTimeout(timer);
	}, [onDismiss]);
	return (
		<div className="undo-toast" role="status">
			<span className="undo-toast-message">Conversation deleted</span>
			<button
				type="button"
				className="undo-toast-action"
				data-undo-action="undo"
				onClick={() => {
					void onRestore(conversationId).then(onDismiss, onDismiss);
				}}
			>
				Undo
			</button>
		</div>
	);
}
