/**
 * NoticePeek (notices Task 6): the transient arrival card near the bell.
 *
 * Rules (the spec's Global Constraints):
 * - shows for 6 s, then folds; hover/focus PAUSES the countdown;
 * - arrivals landing inside the window MERGE — one notice shows its
 *   title + first action + ✕, several merge into "N new notices";
 * - NO peek while the document is hidden, and none for the on-screen
 *   conversation's notice (Chats active with that conversation open —
 *   `visibleConversationId` carries it);
 * - `role="status" aria-live="polite"`; a click opens the pane (scrolled
 *   to the notice when there's one); ✕ dismisses.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CoreTarget } from "@sigrun/shared/blocks";
import type { UserNotice, UserNoticeAction } from "@sigrun/shared/notices";

/** How long the peek shows before folding (paused on hover/focus). */
export const PEEK_MS = 6_000;

/** Test seam: the countdown drives the peek via injected now/sleep;
 *  the browser defaults are Date.now + setTimeout. */
export interface PeekClock {
	now(): number;
	sleep(ms: number, fn: () => void): ReturnType<typeof setTimeout>;
	clear(handle: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_CLOCK: PeekClock = {
	now: () => Date.now(),
	sleep: (ms, fn) => setTimeout(fn, ms),
	clear: (handle) => clearTimeout(handle),
};

function documentHidden(): boolean {
	return (
		(globalThis as { document?: { visibilityState?: string } }).document
			?.visibilityState === "hidden"
	);
}

/** One peek batch (merged arrivals) with its own fold countdown. */
function PeekCard(props: {
	readonly batch: readonly UserNotice[];
	readonly onFold: () => void;
	readonly run: NoticePeekProps["run"];
	readonly dismiss: (id: string) => void;
	readonly onNavigate: (target: CoreTarget) => void;
	readonly onOpenPane: (id?: string) => void;
	readonly clock: PeekClock;
}): ReactNode {
	const { batch, clock } = props;
	const single = batch.length === 1 ? batch[0] : undefined;
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const remainingRef = useRef(PEEK_MS);
	const shownAtRef = useRef(0);
	const arm = (): void => {
		if (timerRef.current !== null) clock.clear(timerRef.current);
		shownAtRef.current = clock.now();
		timerRef.current = clock.sleep(remainingRef.current, props.onFold);
	};
	// Arm on mount; clear on unmount. The batch's contents can GROW while
	// mounted (the merge) — the countdown runs from the latest arm, which
	// the parent's key change re-arms when the batch RESETS.
	useEffect(() => {
		arm();
		return () => {
			if (timerRef.current !== null) clock.clear(timerRef.current);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const pause = (): void => {
		if (timerRef.current === null) return;
		clock.clear(timerRef.current);
		timerRef.current = null;
		remainingRef.current = Math.max(
			0,
			remainingRef.current - (clock.now() - shownAtRef.current),
		);
	};
	const resume = (): void => {
		if (timerRef.current === null) arm();
	};
	const firstAction = single?.actions?.[0];
	return (
		<div
			className="notice-peek"
			role="status"
			aria-live="polite"
			onMouseEnter={pause}
			onMouseLeave={resume}
			onFocus={pause}
			onBlur={resume}
		>
			<button
				type="button"
				className="notice-peek-body"
				onClick={() => {
					props.onOpenPane(single?.id);
					props.onFold();
				}}
			>
				{single === undefined ? (
					<strong>{batch.length} new notices</strong>
				) : (
					<strong>{single.title}</strong>
				)}
			</button>
			{single !== undefined && firstAction !== undefined && (
				<button
					type="button"
					className="notice-peek-action"
					onClick={() => {
						void props.run(single, firstAction, props.onNavigate);
						props.onFold();
					}}
				>
					{firstAction.label}
				</button>
			)}
			{single !== undefined && (
				<button
					type="button"
					className="notice-peek-close"
					aria-label="dismiss notice"
					onClick={() => {
						props.dismiss(single.id);
						props.onFold();
					}}
				>
					✕
				</button>
			)}
		</div>
	);
}

interface NoticePeekProps {
	/** The useNotices peek feed (posted since the last refetch). */
	readonly arrivals: readonly UserNotice[];
	/** The on-screen conversation (its notices never peek). */
	readonly visibleConversationId?: number | null;
	readonly run: (
		notice: UserNotice,
		action: UserNoticeAction,
		onNavigate: (target: CoreTarget) => void,
	) => Promise<unknown>;
	readonly dismiss: (id: string) => void;
	readonly onNavigate: (target: CoreTarget) => void;
	/** Open the pane; an id scrolls it to that notice. */
	readonly onOpenPane: (id?: string) => void;
	/** Test seam: the countdown clock (defaults to the system clock). */
	readonly clock?: PeekClock;
}

export function NoticePeek(props: NoticePeekProps): ReactNode {
	// The batch is keyed: a fold or a merge RESETS the card (a fresh
	// countdown) — the key joins the first member's id with the size.
	const [batch, setBatch] = useState<readonly UserNotice[]>([]);
	const seenRef = useRef<Set<string>>(new Set());

	// New arrivals join the batch — never while the document is hidden
	// (a hidden tab shows nothing), never for the on-screen conversation.
	useEffect(() => {
		const fresh = props.arrivals.filter(
			(one) =>
				!seenRef.current.has(one.id) &&
				(props.visibleConversationId === null ||
					props.visibleConversationId === undefined ||
					one.conversationId !== props.visibleConversationId),
		);
		for (const one of props.arrivals) seenRef.current.add(one.id);
		if (fresh.length === 0 || documentHidden()) return;
		setBatch((current) => [...current, ...fresh]);
	}, [props.arrivals, props.visibleConversationId]);

	if (batch.length === 0) return null;
	return (
		<PeekCard
			key={`${batch[0]?.id}:${batch.length}`}
			batch={batch}
			onFold={() => setBatch([])}
			run={props.run}
			dismiss={props.dismiss}
			onNavigate={props.onNavigate}
			onOpenPane={props.onOpenPane}
			clock={props.clock ?? SYSTEM_CLOCK}
		/>
	);
}
