/**
 * NoticesPane (notices Task 6): the notices list surface — a header
 * ("Notices" + Clear all), stacked NoticeCards, and the "No notices"
 * empty state. TWO chrome shapes:
 *
 * - `docked` (the Chats tab): renders inside RightPanel's `notices`
 *   mode — the shell's panel state owns open/close, so this component
 *   adds no chrome of its own.
 * - `overlay` (every other tab): a fixed right-edge panel closing on
 *   outside click, Escape, or the bell (the shell wires the bell).
 *
 * The pane's open state is chrome: NOT persisted, no hash entry.
 *
 * DOM-optional like the rest of the suite: the overlay's document
 * listeners attach only when a document exists (the react-test-renderer
 * environment has none unless a test stubs one).
 */

import { useEffect, useRef, type ReactNode } from "react";
import type { CoreTarget } from "@sigrun/shared/blocks";
import type { UserNotice, UserNoticeAction } from "@sigrun/shared/notices";
import { NoticeCard } from "./NoticeCard";

/** The document surface the overlay chrome listens on (a test fake or
 *  the real one — structural, like useDismiss's DocumentLike). */
interface PaneDocument {
	addEventListener(type: string, listener: (event: unknown) => void): void;
	removeEventListener(type: string, listener: (event: unknown) => void): void;
}

function documentOf(): PaneDocument | undefined {
	return (globalThis as { document?: PaneDocument }).document;
}

export function NoticesPane(props: {
	/** The docked (Chats right-panel) or right-edge overlay chrome. */
	readonly variant: "docked" | "overlay";
	readonly notices: readonly UserNotice[];
	/** Conversation display names by id (the cards' meta links). */
	readonly conversationName?: (id: number) => string | undefined;
	readonly run: (
		notice: UserNotice,
		action: UserNoticeAction,
		onNavigate: (target: CoreTarget) => void,
	) => Promise<unknown>;
	readonly dismiss: (id: string) => void;
	readonly dismissAll: () => void;
	readonly onNavigate: (target: CoreTarget) => void;
	/** Overlay only: outside click / Escape close. */
	readonly onClose?: () => void;
	/** A notice id to scroll into view (the peek's click-through). */
	readonly scrollTo?: string | null;
}): ReactNode {
	const rootRef = useRef<{ contains(node: unknown): boolean } | null>(null);

	// Overlay chrome: Escape closes; outside clicks close (a mousedown
	// that lands OUTSIDE the panel's root).
	useEffect(() => {
		if (props.variant !== "overlay" || props.onClose === undefined) {
			return undefined;
		}
		const doc = documentOf();
		if (doc === undefined) return undefined;
		const onClose = props.onClose;
		const onKey = (event: unknown): void => {
			if ((event as { key?: unknown }).key === "Escape") onClose();
		};
		const onDown = (event: unknown): void => {
			const target = (event as { target?: unknown }).target;
			if (target === null || target === undefined) return;
			const root = rootRef.current;
			if (root !== null && !root.contains(target)) onClose();
		};
		doc.addEventListener("keydown", onKey);
		doc.addEventListener("mousedown", onDown);
		return () => {
			doc.removeEventListener("keydown", onKey);
			doc.removeEventListener("mousedown", onDown);
		};
	}, [props.variant, props.onClose]);

	// The peek's click-through: scroll the named card into view (the
	// browser node has scrollIntoView; test fakes simply lack it).
	useEffect(() => {
		if (props.scrollTo === null || props.scrollTo === undefined) return;
		// SAFETY: the ref holds a browser element at runtime (querySelector
		// exists); in the test env the fake simply lacks it and the lookup
		// skips.
		const root = rootRef.current as unknown as {
			querySelector?: (selector: string) => unknown;
		} | null;
		const card = root?.querySelector?.(
			`[data-notice-id="${props.scrollTo}"]`,
		) as { scrollIntoView?: () => void } | null | undefined;
		card?.scrollIntoView?.();
	}, [props.scrollTo]);

	return (
		<div
			ref={rootRef as never}
			className={
				props.variant === "overlay"
					? "notices-pane notices-pane-overlay"
					: "notices-pane"
			}
			role="complementary"
			aria-label="notices"
		>
			<h4 className="notices-pane-head">
				<span>Notices</span>
				{props.notices.length > 0 && (
					<button
						type="button"
						className="notices-pane-clear"
						onClick={() => props.dismissAll()}
					>
						Clear all
					</button>
				)}
			</h4>
			{props.notices.length === 0 ? (
				<p className="notices-pane-empty">No notices</p>
			) : (
				props.notices.map((notice) => (
					<NoticeCard
						key={notice.id}
						notice={notice}
						conversationName={
							notice.conversationId === undefined
								? undefined
								: props.conversationName?.(notice.conversationId)
						}
						run={props.run}
						dismiss={props.dismiss}
						onNavigate={props.onNavigate}
					/>
				))
			)}
		</div>
	);
}
