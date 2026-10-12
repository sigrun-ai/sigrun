/**
 * SessionList (Task 23a): the sidebar — conversations from
 * `client.listConversations()` joined with their per-conversation meta
 * (`GET /v1/conversations/:id/meta`). Pinned conversations sort first
 * (server order otherwise preserved); archived conversations render dimmed
 * and no longer offer an archive action. Actions: new (POST creates, then
 * selects the created conversation), switch (`onSelect`), archive (PATCH
 * `{ archived: true }`, merged server-side).
 *
 * Metas load best-effort per conversation: a failing meta GET renders the
 * conversation with the default meta (fail-visible for the action error,
 * never a blank sidebar). Mutations reload the list so the rendered state
 * always reflects the server's.
 */

import { useCallback, useEffect, useState } from "react";
import type {
	ConversationMeta,
	ConversationSummary,
	SigrunClient,
} from "../api";

interface ListedConversation {
	readonly summary: ConversationSummary;
	readonly meta: ConversationMeta;
}

/** The meta rendered before one loads (or when its GET fails). */
const DEFAULT_META: ConversationMeta = {
	pinned: false,
	tagged: [],
	archived: false,
	draft: { text: "", attachments: [] },
	source: "user",
};

/** Fallback title when the session has no name: `Conversation #<id>`. */
function titleOf(id: number): string {
	return `Conversation #${id}`;
}

function classNameOf(item: ListedConversation, active: boolean): string {
	const parts = ["session-item"];
	if (active) parts.push("session-item-active");
	if (item.meta.archived) parts.push("session-item-archived");
	return parts.join(" ");
}

function badgesOf(item: ListedConversation): string {
	const badges: string[] = [];
	if (item.meta.pinned) badges.push("pinned");
	if (item.meta.archived) badges.push("archived");
	if (item.meta.draft.text.length > 0) badges.push("draft");
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
	const [items, setItems] = useState<readonly ListedConversation[]>([]);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async (): Promise<void> => {
		try {
			const list = await client.listConversations();
			const loaded = await Promise.all(
				list.conversations.map(async (summary): Promise<ListedConversation> => {
					try {
						return {
							summary,
							meta: await client.getConversationMeta(summary.id),
						};
					} catch {
						// A failing meta GET must never blank the sidebar row.
						return { summary, meta: DEFAULT_META };
					}
				}),
			);
			const ordered = [...loaded].sort((a, b) => {
				if (a.meta.pinned === b.meta.pinned) return 0;
				return a.meta.pinned ? -1 : 1;
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
						key={item.summary.id}
						className={classNameOf(item, item.summary.id === activeId)}
					>
						<button
							type="button"
							className="session-select"
							onClick={() => onSelect(item.summary.id)}
						>
							{item.meta.name ?? titleOf(item.summary.id)}
							{badgesOf(item)}
						</button>
						{item.meta.archived ? null : (
							<button
								type="button"
								className="session-archive"
								onClick={() => void onArchive(item.summary.id)}
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
