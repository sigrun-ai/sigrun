/**
 * SessionList (Task 23a): the sidebar — conversations from
 * `client.listConversations()`. Pinned conversations sort first (server
 * order otherwise preserved); archived conversations render dimmed and no
 * longer offer an archive action. Actions: new (POST creates, then
 * selects the created conversation), switch (`onSelect`), archive (PATCH
 * `{ archived: true }`, merged server-side).
 *
 * UI refresh A1: the listing itself carries the sidebar metadata —
 * `name`, `archived`, `pinned` ride `ConversationSummary` — so one
 * request renders the list (no per-row meta GET; the N+1 is gone). The
 * meta PATCH remains the archive action's write path.
 */

import { useCallback, useEffect, useState } from "react";
import type { ConversationSummary, SigrunClient } from "../api";

/** Fallback title when the session has no name: `Conversation #<id>`. */
function titleOf(id: number): string {
	return `Conversation #${id}`;
}

function classNameOf(item: ConversationSummary, active: boolean): string {
	const parts = ["session-item"];
	if (active) parts.push("session-item-active");
	if (item.archived) parts.push("session-item-archived");
	return parts.join(" ");
}

function badgesOf(item: ConversationSummary): string {
	const badges: string[] = [];
	if (item.pinned) badges.push("pinned");
	if (item.archived) badges.push("archived");
	return badges.length === 0 ? "" : ` (${badges.join(", ")})`;
}

export function SessionList(props: {
	client: SigrunClient;
	/** The currently selected conversation, or null for none. */
	activeId: number | null;
	/** Called with the id when the user switches (or creates) a conversation. */
	onSelect: (id: number) => void;
}) {
	const { client, activeId, onSelect } = props;
	const [items, setItems] = useState<readonly ConversationSummary[]>([]);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async (): Promise<void> => {
		try {
			const list = await client.listConversations();
			const ordered = [...list.conversations].sort((a, b) => {
				if (a.pinned === b.pinned) return 0;
				return a.pinned ? -1 : 1;
			});
			setItems(ordered);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, [client]);

	useEffect(() => {
		void reload();
	}, [reload]);

	const onNew = useCallback(async (): Promise<void> => {
		try {
			const created = await client.createConversation();
			await reload();
			setError(null);
			onSelect(created.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, [client, reload, onSelect]);

	const onArchive = useCallback(
		async (id: number): Promise<void> => {
			try {
				await client.patchConversationMeta(id, { archived: true });
				await reload();
				setError(null);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		},
		[client, reload],
	);

	return (
		<nav className="session-list" aria-label="conversations">
			<button type="button" className="session-new" onClick={onNew}>
				New conversation
			</button>
			{error !== null && <p role="alert">{error}</p>}
			<ul>
				{items.map((item) => (
					<li
						key={item.id}
						className={classNameOf(item, item.id === activeId)}
					>
						<button
							type="button"
							className="session-select"
							onClick={() => onSelect(item.id)}
						>
							{item.name ?? titleOf(item.id)}
							{badgesOf(item)}
						</button>
						{item.archived ? null : (
							<button
								type="button"
								className="session-archive"
								onClick={() => void onArchive(item.id)}
							>
								Archive
							</button>
						)}
					</li>
				))}
			</ul>
		</nav>
	);
}
