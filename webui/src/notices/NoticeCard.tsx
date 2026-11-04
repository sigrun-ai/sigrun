/**
 * NoticeCard (notices Task 6): one notice as a card — the tone stripe
 * (the class carries the left edge), the title row (bold title + ✕),
 * the optional body, the meta line (owner · conversation name ·
 * relative age), and the action buttons. The pane stacks these; the
 * inline strip and the peek reuse it.
 *
 * Extension actions POST through `onRun`; the result's `message`/`error`
 * shows on the card for 4 s (a transient line, then gone).
 */

import { useEffect, useState, type ReactNode } from "react";
import type { CoreTarget } from "@sigrun/shared/blocks";
import type { UserNotice, UserNoticeAction } from "@sigrun/shared/notices";

/** How long the run-result line shows on the card. */
export const RESULT_MESSAGE_MS = 4_000;

/** A compact relative age ("2 min", "1 h", "just now"). */
export function relativeAge(at: string, now = Date.now()): string {
	const then = Date.parse(at);
	if (Number.isNaN(then)) return "";
	const seconds = Math.max(0, Math.floor((now - then) / 1000));
	if (seconds < 45) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} h`;
	return `${Math.floor(hours / 24)} d`;
}

export function NoticeCard(props: {
	readonly notice: UserNotice;
	/** The conversation's display name (the meta line links to it). */
	readonly conversationName?: string;
	/** True while an extension action POST is in flight (buttons disable). */
	readonly busy?: boolean;
	/** A transient result line (the 4 s message/error); managed here. */
	readonly run: (
		notice: UserNotice,
		action: UserNoticeAction,
		onNavigate: (target: CoreTarget) => void,
	) => Promise<unknown>;
	readonly dismiss: (id: string) => void;
	readonly onNavigate: (target: CoreTarget) => void;
	/** The DOM id the pane's scroll-to targets. */
	readonly domId?: string;
}): ReactNode {
	const { notice } = props;
	const [result, setResult] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	useEffect(() => {
		if (result === null) return undefined;
		const timer = setTimeout(() => setResult(null), RESULT_MESSAGE_MS);
		return () => clearTimeout(timer);
	}, [result]);

	const busy = props.busy === true || pending;
	const runAction = (action: UserNoticeAction): void => {
		if (action.kind === "extension") {
			if (
				action.confirm !== undefined &&
				!(globalThis as { confirm?: (text: string) => boolean }).confirm?.(
					action.confirm,
				)
			) {
				return;
			}
			setPending(true);
			void props
				.run(notice, action, props.onNavigate)
				.then((response) => {
					if (
						typeof response === "object" &&
						response !== null &&
						"ok" in response
					) {
						const outcome = response as {
							ok: boolean;
							message?: string;
							error?: { message: string };
						};
						if (outcome.ok) {
							if (outcome.message !== undefined) setResult(outcome.message);
						} else if (outcome.error !== undefined) {
							setResult(outcome.error.message);
						}
					}
				})
				.catch((cause: unknown) => {
					setResult(cause instanceof Error ? cause.message : String(cause));
				})
				.finally(() => setPending(false));
			return;
		}
		void props.run(notice, action, props.onNavigate);
	};

	return (
		<div
			className={`notice-card notice-tone-${notice.tone ?? "neutral"}`}
			data-notice-id={notice.id}
			{...(props.domId === undefined ? {} : { id: props.domId })}
		>
			<div className="notice-card-row">
				<strong className="notice-card-title">{notice.title}</strong>
				<button
					type="button"
					className="notice-card-close"
					aria-label="dismiss notice"
					onClick={() => props.dismiss(notice.id)}
				>
					✕
				</button>
			</div>
			{notice.body !== undefined && (
				<p className="notice-card-body">{notice.body}</p>
			)}
			<p className="notice-card-meta">
				{notice.owner}
				{notice.conversationId !== undefined && (
					<>
						{" · "}
						<button
							type="button"
							className="notice-card-conversation"
							onClick={() =>
								props.onNavigate({
									conversation: notice.conversationId as number,
								})
							}
						>
							{props.conversationName ??
								`conversation ${notice.conversationId}`}
						</button>
					</>
				)}
				{" · "}
				{relativeAge(notice.at)}
			</p>
			{(notice.actions ?? []).length > 0 && (
				<div className="notice-card-actions">
					{(notice.actions ?? []).map((action) => (
						<button
							key={action.id}
							type="button"
							className="notice-card-action"
							disabled={busy}
							onClick={() => runAction(action)}
						>
							{action.label}
						</button>
					))}
				</div>
			)}
			{result !== null && (
				<p className="notice-card-result" role="status">
					{result}
				</p>
			)}
		</div>
	);
}
