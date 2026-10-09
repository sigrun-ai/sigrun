/**
 * WorkspaceBrowser (Task 24): the right-panel file tree for the active
 * conversation's workspace (spec §6.1: "on-demand workspace file browser
 * right panel (list/read; hermes's preview polish can trail)").
 *
 * - `client.listFiles(id, path)` lists a directory; the root (`"."`) loads
 *   when the conversation activates.
 * - A directory EXPANDS lazily: its children fetch on first expand and are
 *   cached (re-expand after a collapse does not refetch).
 * - A file select opens the read-only {@link FilePreview} below the tree.
 * - Entries sort directories-first, then by name (the server returns the
 *   workspace env's listing order; the tree wants a stable shape).
 * - Switching the conversation resets the tree, the cache, and the
 *   selection, and reloads the root.
 * - Read-only by design: the wire has no write/delete — the composer attach
 *   path owns file creation (`POST .../uploads`).
 */

import { useEffect, useState, type ReactNode } from "react";
import type { FileEntryWire, SigrunClient } from "../api";
import { FilePreview } from "./FilePreview";

/** Directories first, then files, each alphabetical (stable tree shape). */
function sortEntries(
	entries: readonly FileEntryWire[],
): readonly FileEntryWire[] {
	return [...entries].sort((a, b) => {
		const aDir = a.kind === "directory" ? 0 : 1;
		const bDir = b.kind === "directory" ? 0 : 1;
		return aDir - bDir || a.name.localeCompare(b.name);
	});
}

export function WorkspaceBrowser(props: {
	readonly client: SigrunClient;
	readonly conversationId: number | null;
}) {
	const { client, conversationId } = props;
	// Root entries; null = not loaded yet (loading or no conversation).
	const [root, setRoot] = useState<readonly FileEntryWire[] | null>(null);
	// Loaded directory children, keyed by the directory's path.
	const [children, setChildren] = useState<
		Readonly<Record<string, readonly FileEntryWire[]>>
	>({});
	const [expanded, setExpanded] = useState<Readonly<Record<string, true>>>(
		{},
	);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setRoot(null);
		setChildren({});
		setExpanded({});
		setSelectedPath(null);
		setError(null);
		if (conversationId === null) return;
		let cancelled = false;
		client
			.listFiles(conversationId)
			.then((response) => {
				if (cancelled) return;
				setRoot(sortEntries(response.entries));
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [client, conversationId]);

	async function toggleDir(entry: FileEntryWire): Promise<void> {
		if (conversationId === null) return;
		if (expanded[entry.path]) {
			setExpanded((previous) => {
				const next = { ...previous };
				delete next[entry.path];
				return next;
			});
			return;
		}
		setExpanded((previous) => ({ ...previous, [entry.path]: true }));
		if (children[entry.path] !== undefined) return; // cached
		try {
			const response = await client.listFiles(conversationId, entry.path);
			setChildren((previous) => ({
				...previous,
				[entry.path]: sortEntries(response.entries),
			}));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	function renderEntries(
		entries: readonly FileEntryWire[],
		depth: number,
	): ReactNode {
		return entries.map((entry) => {
			if (entry.kind === "directory") {
				const isOpen = expanded[entry.path] === true;
				const loaded = children[entry.path];
				return (
					<li key={entry.path}>
						<button
							type="button"
							className="workspace-dir"
							data-tree-row="true"
							data-path={entry.path}
							aria-expanded={isOpen}
							style={{ paddingLeft: `${depth * 0.9}rem` }}
							onClick={() => void toggleDir(entry)}
						>
							{isOpen ? "▾" : "▸"} {entry.name}/
						</button>
						{isOpen && loaded !== undefined && (
							<ul className="workspace-children">
								{renderEntries(loaded, depth + 1)}
							</ul>
						)}
					</li>
				);
			}
			return (
				<li key={entry.path}>
					<button
						type="button"
						className="workspace-file"
						data-tree-row="true"
						data-path={entry.path}
						data-selected={selectedPath === entry.path || undefined}
						style={{ paddingLeft: `${depth * 0.9}rem` }}
						onClick={() => setSelectedPath(entry.path)}
					>
						{entry.name}
					</button>
				</li>
			);
		});
	}

	return (
		<section className="workspace-browser" aria-label="workspace files">
			<h2 className="workspace-title">Workspace</h2>
			{conversationId === null ? (
				<p className="workspace-empty">
					Select a conversation to browse its workspace
				</p>
			) : (
				<>
					{error !== null && <p role="alert">{error}</p>}
					{/* After a failed root list, the error owns the panel — suppress
					    the perpetual "loading…" (it never resolves on its own). */}
					{root === null && error === null ? (
						<p className="workspace-loading">loading…</p>
					) : root === null ? null : (
						<ul className="workspace-tree">{renderEntries(root, 0)}</ul>
					)}
					{selectedPath !== null && (
						<FilePreview
							client={client}
							conversationId={conversationId}
							path={selectedPath}
						/>
					)}
				</>
			)}
		</section>
	);
}
