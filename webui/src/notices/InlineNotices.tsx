/**
 * InlineNotices (notices Task 6): the active conversation's notices as
 * compact card rows above the composer. At most the 3 newest render; a
 * deeper pile folds behind a "N more" button that opens the pane.
 */

import type { ReactNode } from "react";
import type { CoreTarget } from "@sigrun/shared/blocks";
import type { UserNotice, UserNoticeAction } from "@sigrun/shared/notices";
import { NoticeCard } from "./NoticeCard";

/** The inline strip's depth — deeper piles fold behind "N more". */
export const INLINE_MAX = 3;

export function InlineNotices(props: {
	/** The active conversation's notices (any order; the 3 newest show). */
	readonly notices: readonly UserNotice[];
	/** Notices Task 7: the lifted per-notice result texts (useNotices'). */
	readonly results?: Readonly<Record<string, string>>;
	readonly run: (
		notice: UserNotice,
		action: UserNoticeAction,
		onNavigate: (target: CoreTarget) => void,
	) => Promise<unknown>;
	readonly dismiss: (id: string) => void;
	readonly onNavigate: (target: CoreTarget) => void;
	/** The "N more" button opens the notices pane. */
	readonly onOpenPane: () => void;
}): ReactNode {
	if (props.notices.length === 0) return null;
	const shown = props.notices.slice(0, INLINE_MAX);
	const hidden = props.notices.length - shown.length;
	return (
		<div className="inline-notices">
			{shown.map((notice) => (
				<NoticeCard
					key={notice.id}
					notice={notice}
					result={props.results?.[notice.id] ?? null}
					run={props.run}
					dismiss={props.dismiss}
					onNavigate={props.onNavigate}
				/>
			))}
			{hidden > 0 && (
				<button
					type="button"
					className="inline-notices-more"
					onClick={() => props.onOpenPane()}
				>
					{hidden} more
				</button>
			)}
		</div>
	);
}
