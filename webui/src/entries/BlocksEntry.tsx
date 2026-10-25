/**
 * BlocksEntry (UI-blocks U5 Task 4): one chat block surface rendered
 * INLINE in the chat column. The entry's immutable `{title, tree, data}`
 * definition arrives on the timeline event; the LIVE state (another
 * user's edits, the agent's `update_blocks`) comes from the chat-block
 * transport (`/v1/conversations/:id/blocks/:entryId`) whose `onChanged`
 * fires off the conversation-scoped `surface.changed` frames.
 *
 * The surface renders pinned to the `compact` width class (spec: the
 * chat column keeps its compact fallbacks even when the window is
 * 60 rem wide). SurfaceView's own `ContainerWidth` would measure the
 * WIDER chat container, so `PinnedWidth` re-asserts the compact class
 * BELOW that container — the tree's structural fallbacks (lanes →
 * single, calendar → agenda, `visibleAt`) read the pin, not the window.
 *
 * A `read` viewer (a user whose conversation access is read-only, per
 * the load's `access`) sees no drag handles — the collection displays
 * gate every affordance on the context's access (spec §6.5/§8.2).
 */

import { useMemo, type ReactNode } from "react";
import type { JsonObject, Tree } from "@sigrun/shared/blocks";
import { useChatTransport } from "./chatTransportContext";
import { BlockView } from "../blocks/BlockView";
import { SurfaceDataContext, SurfaceActionsContext } from "../blocks/context";
import { WidthContext } from "../blocks/width";
import { useSurface } from "../blocks/useSurface";

/** The narrowed `data` of a `sigrun.blocks` entry (the payload Task 1's
 *  BlocksEntry kind declares): the immutable definition the transport's
 *  first load re-renders from (the transport's `load` answers the SAME
 *  shape from the server's current read). */
export interface BlocksEntryData {
	readonly title: string;
	readonly tree: Tree;
	readonly data: JsonObject;
}

/** Narrow an entry's `data` to the blocks payload (undefined = not one —
 *  the renderer falls back to a fail-visible placeholder). */
export function blocksEntryData(data: unknown): BlocksEntryData | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const candidate = data as {
		readonly title?: unknown;
		readonly tree?: unknown;
		readonly data?: unknown;
	};
	if (typeof candidate.title !== "string") return undefined;
	if (typeof candidate.tree !== "object" || candidate.tree === null) {
		return undefined;
	}
	if (typeof candidate.data !== "object" || candidate.data === null) {
		return undefined;
	}
	return {
		title: candidate.title,
		tree: candidate.tree as Tree,
		data: candidate.data as JsonObject,
	};
}

/** The width pin: `compact` asserted INSTEAD of any measurement (no
 *  ContainerWidth in the chat column — the tree's structural fallbacks
 *  (lanes → single, calendar → agenda, `visibleAt`) read the pin). */
function PinnedWidth(props: { readonly children: ReactNode }): ReactNode {
	return (
		<WidthContext.Provider value={{ widthClass: "compact", rem: null }}>
			{props.children}
		</WidthContext.Provider>
	);
}

/** The loading/error states (SurfaceView's wording, inline). */
function BlocksState(props: {
	readonly status: "loading" | "notFound" | "error";
	readonly onRetry?: () => void;
}): ReactNode {
	if (props.status === "loading") {
		return <p className="entry-blocks-state">loading…</p>;
	}
	if (props.status === "notFound") {
		return <p className="entry-blocks-state">surface not found</p>;
	}
	return (
		<p className="entry-blocks-state" role="alert">
			something went wrong{" "}
			{props.onRetry !== undefined && (
				<button type="button" onClick={props.onRetry}>
					Retry
				</button>
			)}
		</p>
	);
}

export function BlocksEntry(props: {
	readonly conversationId: number;
	/** The entry id as the route addresses it (a decimal string). */
	readonly entryId: number;
	readonly data: unknown;
}): ReactNode {
	const payload = blocksEntryData(props.data);
	const attach = useChatTransport();
	// The transport is stable per (conversationId, entryId) — the entry
	// never changes address; the hub routes its onChanged.
	const transport = useMemo(
		() =>
			attach({
				conversationId: props.conversationId,
				entryId: String(props.entryId),
			}),
		[attach, props.conversationId, props.entryId],
	);
	const surface = useSurface(transport);
	const locale = navigator.language;
	const actionsCtx = useMemo(
		() => ({
			dispatch: surface.dispatch,
			access: surface.access,
			viewState: {} as JsonObject,
			setView: surface.setView,
			serverErrors: surface.serverErrors,
		}),
		[
			surface.dispatch,
			surface.access,
			surface.setView,
			surface.serverErrors,
		],
	);
	if (payload === undefined) {
		return (
			<div className="entry-blocks entry-blocks-unknown" data-blocks="invalid">
				unsupported blocks entry
			</div>
		);
	}
	if (surface.status !== "ready" || surface.tree === undefined) {
		return (
			<div className="entry-blocks" data-blocks-entry={props.entryId}>
				<div className="entry-blocks-title">{payload.title}</div>
				{/* Narrowed by the branch guard above. */}
				<BlocksState
					status={surface.status as "loading" | "notFound" | "error"}
					onRetry={
						surface.status === "error"
							? () => {
									surface.retry();
								}
							: undefined
					}
				/>
			</div>
		);
	}
	return (
		<div className="entry-blocks" data-blocks-entry={props.entryId}>
			<div className="entry-blocks-title">{payload.title}</div>
			<PinnedWidth>
				<SurfaceDataContext.Provider value={{ data: surface.view, locale }}>
					<SurfaceActionsContext.Provider value={actionsCtx}>
						<BlockView block={surface.tree.root} />
					</SurfaceActionsContext.Provider>
				</SurfaceDataContext.Provider>
			</PinnedWidth>
		</div>
	);
}

/**
 * The §8.3 note row: collapsed by default ("UI changes sent to the
 * agent"), expanding to the note's text. The note's `model` carries the
 * note as a user message — the row shows THAT text, never the `advance`
 * coverage (a model-facing artifact, spec §8.3).
 */
export function NoteEntry(props: {
	readonly entryId: number;
	/** The note text (the entry's joined user-message text). */
	readonly text: string;
}): ReactNode {
	return (
		<details className="entry-note" data-note-entry={props.entryId}>
			<summary className="entry-note-summary">
				UI changes sent to the agent
			</summary>
			<div className="entry-note-text">{props.text}</div>
		</details>
	);
}
