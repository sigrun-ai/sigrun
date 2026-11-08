/**
 * SessionList (B3, UI refresh): the grouped, searchable, fork-nested
 * conversation sidebar.
 *
 * Rows arrive as props — App owns the list via `useConversationList`
 * (one request per load; the sidebar itself never fetches). Shaping is
 * the B1 pure module's job: `buildConversationTree` nests forks under
 * their parents and orders roots pinned-first/newest-first, `ageGroup`
 * drives the Pinned / Today / Yesterday / Earlier headings, `formatAge`
 * renders the age column, and `displayName` is the one name spelling
 * (multi-line flattened, unnamed → "New conversation").
 *
 * - Search filters by displayName (case-insensitive substring) and keeps
 *   a match's ANCESTORS visible (the fork stays meaningful under its
 *   parent). Ctrl+K / ⌘K focuses the search input from anywhere.
 * - Row = name (single-line ellipsis — 200-char names never wrap) + age;
   hover/focus-within swaps the age for the ⋯ menu (Rename, Fork,
 *   Archive / Unarchive, Share — owner-only, spec §5.9: the Share item
 *   opens App's ShareMenu; a non-owner row never offers it). The menu
 *   toggle is a real button, so keyboard users reach it (focus-within
 *   reveals it, then Tab). Outside-click + Esc close the open row's menu
 *   (useDismiss).
 * - Children indent one level per depth with the ↳ lineage mark.
 * - The bottom "Job runs" toggle reveals quiet scheduled runs
 *   (`includeJobRuns`, default false); "Archived" switches
 *   `includeArchived`; "Deleted" switches `deletedOnly` — the Deleted
 *   view shows ONLY deleted rows (ignoring the other two toggles) and
 *   each deleted row's menu offers Restore and nothing destructive.
 *   Search narrows the same filtered tree, so it never reveals quiet
 *   runs while their toggle is off, nor deleted rows while Deleted is.
 * - Delete (owner or admin, non-deleted rows only) calls `onDelete(id)`
 *   and shows the rail-local UndoToast (message + Undo, auto-dismiss
 *   8 s) — Undo restores the id captured at delete time, never the
 *   active id, so the toast survives conversation switches.
 * - Rename edits the STORED user name, not `displayName`: a failed run's
 *   "Failed · " label never enters the draft, and an auto-named row starts
 *   with an empty draft so typing its generated name saves a user name.
 *
 * The draft badge the pre-A1 sidebar carried is deliberately GONE: the
 * list endpoint carries no draft state (only the per-conversation view
 * does), and restoring it would reintroduce the per-row meta GET the A1
 * N+1 removal dropped. The row is name + age, per the refresh spec.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ageGroup,
	buildConversationTree,
	displayName,
	formatAge,
	type AgeGroup,
	type TreeNode,
} from "@sigrun/shared/conversations";
import { MoreIcon, PlusIcon } from "../layout/icons";
import { useDismiss } from "../useDismiss";
import type { ConversationSummary } from "../api";
import { UndoToast } from "./UndoToast";

/** The Ctrl+K / ⌘K focus target (a stable id; the shortcut is global). */
export const SESSION_SEARCH_INPUT_ID = "sigrun-session-search";

const GROUP_ORDER: readonly AgeGroup[] = [
	"Pinned",
	"Today",
	"Yesterday",
	"Earlier",
];

/** The stored USER name a rename edits; auto names are suggestions, not
 * user text, so an auto-only row starts with an empty draft. */
function storedUserName(row: ConversationSummary): string {
	return row.autoName !== undefined && row.name === row.autoName
		? ""
		: (row.name ?? "");
}

/** The rendered flat list: a group heading or a row at a nesting depth. */
type Entry =
	| { readonly kind: "heading"; readonly group: AgeGroup }
	| {
			readonly kind: "row";
			readonly node: TreeNode<ConversationSummary>;
			readonly depth: number;
	  };

/** The keydown surface the shortcut listens on (absent in the test env). */
interface WindowLike {
	addEventListener(
		type: "keydown",
		listener: (event: KeyboardEventLike) => void,
	): void;
	removeEventListener(
		type: "keydown",
		listener: (event: KeyboardEventLike) => void,
	): void;
}

interface KeyboardEventLike {
	readonly key: string;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	preventDefault(): void;
}

/** Focus the search input (no DOM in the test env → a no-op). */
function focusSearchInput(): void {
	const input = (
		globalThis as {
			document?: {
				getElementById(id: string): { focus(): void } | null;
			};
		}
	).document?.getElementById(SESSION_SEARCH_INPUT_ID);
	input?.focus();
}

/**
 * The ids search keeps: every displayName match plus its ancestor chain
 * (a matching fork's parent stays visible so the nesting reads).
 */
function searchKeep(
	rows: readonly ConversationSummary[],
	query: string,
): Set<number> {
	const keep = new Set<number>();
	const byId = new Map(rows.map((row) => [row.id, row]));
	for (const row of rows) {
		if (!displayName(row).toLowerCase().includes(query)) continue;
		let cursor: ConversationSummary | undefined = row;
		while (cursor !== undefined && !keep.has(cursor.id)) {
			keep.add(cursor.id);
			cursor =
				cursor.parent === undefined
					? undefined
					: byId.get(cursor.parent.id);
		}
	}
	return keep;
}

/** Group roots by age, then flatten each group's forest depth-first. */
function layoutEntries(
	tree: readonly TreeNode<ConversationSummary>[],
	now: Date,
): Entry[] {
	const entries: Entry[] = [];
	for (const group of GROUP_ORDER) {
		const roots = tree.filter((node) => ageGroup(node, now) === group);
		if (roots.length === 0) continue;
		entries.push({ kind: "heading", group });
		const walk = (node: TreeNode<ConversationSummary>, depth: number) => {
			entries.push({ kind: "row", node, depth });
			for (const child of node.children) walk(child, depth + 1);
		};
		for (const root of roots) walk(root, 0);
	}
	return entries;
}

export function SessionList(props: {
	/** The conversation rows (App's useConversationList). */
	readonly rows: readonly ConversationSummary[];
	/** The currently selected conversation, or null for none. */
	readonly activeId: number | null;
	/** Called with the id when the user switches a conversation. */
	onSelect(id: number): void;
	/** Called when the user starts a new conversation. */
	onNew(): void;
	/** Persist a rename; resolves when the write landed. */
	onRename(id: number, name: string): Promise<void>;
	/** Archive or unarchive; resolves when the write landed. */
	onArchive(id: number, archived: boolean): Promise<void>;
	/** Fork a conversation (App navigates to the created fork). */
	onFork(id: number): void;
	/** The signed-in user (W1 Task 8): a row's ⋯ menu offers Share only
	 *  to its owner. */
	readonly currentUser?: string;
	/** Open the share editor for a conversation id (App renders ShareMenu). */
	onShare?(id: number): void;
	/** Delete a conversation (App patches deleted:true and reloads); the
	 *  sidebar shows the Undo toast after it resolves. */
	onDelete?(id: number): Promise<void>;
	/** Restore a deleted conversation (App patches deleted:false). */
	onRestore?(id: number): Promise<void>;
	/** The signed-in principal's admin flag (App's options.identity?.admin):
	 *  Delete shows for the row's owner OR an admin. */
	readonly admin?: boolean;
}) {
	const { rows, activeId, onSelect, onNew, onRename, onArchive, onFork, currentUser, onShare, onDelete, onRestore, admin } = props;
	const [query, setQuery] = useState("");
	const [includeArchived, setIncludeArchived] = useState(false);
	const [includeJobRuns, setIncludeJobRuns] = useState(false);
	const [deletedOnly, setDeletedOnly] = useState(false);
	// The Undo toast's captured conversation id (deleted-conversations
	// Task 4): set when Delete resolves, restored by the toast's Undo —
	// NEVER the active id (the toast survives conversation switches).
	const [undoFor, setUndoFor] = useState<number | null>(null);
	// Stable callbacks keep UndoToast's auto-dismiss effect from being
	// torn down and restarted on every parent re-render (SSE frames).
	const dismissUndo = useCallback(() => setUndoFor(null), []);
	const restoreUndo = useCallback(
		async (id: number) => {
			await onRestore?.(id);
		},
		[onRestore],
	);
	const [menuFor, setMenuFor] = useState<number | null>(null);
	const menuSlot = useRef<HTMLSpanElement | null>(null);
	useDismiss(menuFor !== null, () => setMenuFor(null), menuSlot);
	const [renaming, setRenaming] = useState<{
		id: number;
		draft: string;
	} | null>(null);

	// The global Ctrl+K / ⌘K shortcut: focus the search input from
	// anywhere in the app (the listener detaches on unmount).
	useEffect(() => {
		const win = (globalThis as { window?: WindowLike }).window;
		if (win === undefined) return;
		const onKey = (event: KeyboardEventLike) => {
			if (!event.ctrlKey && !event.metaKey) return;
			if (event.key !== "k" && event.key !== "K") return;
			event.preventDefault();
			focusSearchInput();
		};
		win.addEventListener("keydown", onKey);
		return () => win.removeEventListener("keydown", onKey);
	}, []);

	const now = new Date();
	const entries = useMemo(() => {
		const trimmed = query.trim().toLowerCase();
		const keep = searchKeep(rows, trimmed);
		const visible =
			trimmed === "" ? rows : rows.filter((row) => keep.has(row.id));
		const tree = buildConversationTree(visible, {
			includeArchived,
			includeJobRuns,
			// The Deleted view shows ONLY deleted rows, ignoring the other
			// two options; search narrows the same filtered tree, so it
			// never reveals deleted rows while the toggle is off.
			deletedOnly,
		});
		return layoutEntries(tree, now);
		// `now` is read per render; a memo keyed on it stays consistent.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rows, query, includeArchived, includeJobRuns, deletedOnly, now.getTime()]);

	const commitRename = (id: number) => {
		if (renaming === null || renaming.id !== id) return;
		const row = rows.find((one) => one.id === id);
		const name = renaming.draft.trim();
		if (row === undefined || name === "" || name === storedUserName(row)) {
			setRenaming(null);
			return;
		}
		void onRename(id, name).then(
			() => setRenaming(null),
			() => setRenaming(null),
		);
	};

	return (
		<nav className="session-list" aria-label="conversations">
			<div className="session-search-row">
				<input
					id={SESSION_SEARCH_INPUT_ID}
					className="session-search"
					type="search"
					placeholder="Search"
					aria-label="search conversations"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<button
					type="button"
					className="session-new"
					title="New conversation"
					aria-label="new conversation"
					onClick={onNew}
				>
					<PlusIcon />
				</button>
			</div>
			<ul>
				{entries.map((entry) => {
					if (entry.kind === "heading") {
						return (
							<li
								key={`group-${entry.group}`}
								className="session-group"
								data-age-group={entry.group}
							>
								{entry.group}
							</li>
						);
					}
					const { node, depth } = entry;
					const row = node.row;
					const name = displayName(row);
					const renamingThis = renaming !== null && renaming.id === row.id;
					// Owner-only (spec §5.9): sharing is the owner's grant to make —
					// and the server independently refuses anyone else's sharing
					// patch, so the menu never offers what the wire would 403.
					const canShare =
						onShare !== undefined &&
						currentUser !== undefined &&
						row.owner === currentUser;
					// Delete (deleted-conversations Task 4): the owner OR an
					// admin, on NON-deleted rows only (a deleted row's menu
					// offers Restore and nothing destructive).
					const canDelete =
						onDelete !== undefined &&
						row.deleted !== true &&
						(admin === true ||
							(currentUser !== undefined && row.owner === currentUser));
					const className = [
						"session-item",
						row.id === activeId ? "session-item-active" : "",
						row.archived ? "session-item-archived" : "",
					]
						.filter(Boolean)
						.join(" ");
					return (
						<li
							key={row.id}
							className={className}
							data-conversation-id={row.id}
							data-depth={depth}
							// One indent level per depth (inline: the depth is
							// dynamic and CSS has no arithmetic on attributes).
							style={depth === 0 ? undefined : { paddingLeft: 6 + depth * 14 }}
						>
							{depth > 0 && (
								<span className="session-fork-mark" aria-hidden="true">
									↳
								</span>
							)}
							{renamingThis ? (
								<input
									className="session-rename-input"
									aria-label="conversation name"
									value={renaming.draft}
									onChange={(event) =>
										setRenaming({ id: row.id, draft: event.target.value })
									}
									onKeyDown={(event) => {
										if (event.key === "Enter") commitRename(row.id);
										else if (event.key === "Escape") setRenaming(null);
									}}
								/>
							) : (
								<button
									type="button"
									className="session-select"
									title={name}
									onClick={() => onSelect(row.id)}
								>
									<span className="session-name">{name}</span>
								</button>
							)}
							<span className="session-age">
								{formatAge(row.lastActivityAt, now)}
							</span>
							<span
								className="session-row-actions"
								ref={menuFor === row.id ? menuSlot : undefined}
							>
								<button
									type="button"
									className="session-menu-toggle"
									aria-label={`actions for ${name}`}
									aria-haspopup="menu"
									aria-expanded={menuFor === row.id}
									onClick={() =>
										setMenuFor(menuFor === row.id ? null : row.id)
									}
								>
									<MoreIcon />
								</button>
								{menuFor === row.id && (
									<div className="session-menu" role="menu">
										{row.deleted === true ? (
											// A deleted row's menu: Restore and nothing
											// destructive (the plan's Global Constraints).
											<button
												type="button"
												role="menuitem"
												data-menu-action="restore"
												onClick={() => {
													setMenuFor(null);
													void onRestore?.(row.id);
												}}
											>
												Restore
											</button>
										) : (
											<>
												{canShare && (
													<button
														type="button"
														role="menuitem"
														data-menu-action="share"
														onClick={() => {
															setMenuFor(null);
															onShare?.(row.id);
														}}
													>
														Share…
													</button>
												)}
												<button
													type="button"
													role="menuitem"
													data-menu-action="rename"
													onClick={() => {
														setMenuFor(null);
														setRenaming({
															id: row.id,
															draft: storedUserName(row),
														});
													}}
												>
													Rename
												</button>
												<button
													type="button"
													role="menuitem"
													data-menu-action="fork"
													onClick={() => {
														setMenuFor(null);
														onFork(row.id);
													}}
												>
													Fork
												</button>
												<button
													type="button"
													role="menuitem"
													data-menu-action="archive"
													onClick={() => {
														setMenuFor(null);
														void onArchive(row.id, !row.archived);
													}}
												>
													{row.archived ? "Unarchive" : "Archive"}
												</button>
												{canDelete && (
													<button
														type="button"
														role="menuitem"
														data-menu-action="delete"
														onClick={() => {
															setMenuFor(null);
															// Capture the id AT DELETE TIME: the
															// toast restores this id, never the
															// active one (a switch must not
															// re-target the undo).
															void onDelete?.(row.id).then(
																() => setUndoFor(row.id),
																() => undefined,
															);
														}}
													>
														Delete
													</button>
												)}
											</>
										)}
									</div>
								)}
							</span>
						</li>
					);
				})}
				{entries.length === 0 && query.trim() !== "" && (
					<li className="session-empty">No matching conversations</li>
				)}
			</ul>
			<button
				type="button"
				className="session-job-runs-toggle"
				aria-pressed={includeJobRuns}
				title="Show job runs"
				onClick={() => setIncludeJobRuns((shown) => !shown)}
			>
				Job runs
			</button>
			<button
				type="button"
				className="session-archived-toggle"
				aria-pressed={includeArchived}
				title="Show archived conversations"
				onClick={() => setIncludeArchived((shown) => !shown)}
			>
				Archived
			</button>
			<button
				type="button"
				className="session-deleted-toggle"
				aria-pressed={deletedOnly}
				title="Show deleted conversations"
				onClick={() => setDeletedOnly((shown) => !shown)}
			>
				Deleted
			</button>
			{undoFor !== null && (
				<UndoToast
					conversationId={undoFor}
					onRestore={restoreUndo}
					onDismiss={dismissUndo}
				/>
			)}
		</nav>
	);
}
