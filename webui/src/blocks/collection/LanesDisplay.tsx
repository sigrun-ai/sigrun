/**
 * The lanes display (UI-blocks U1 Task 4, spec §5.5/§12.3/§12.4):
 * one column per group, side by side and horizontally scrollable in
 * regular width; compact shows one lane plus a lane switcher, and a
 * per-item "Move to…" menu handles cross-lane moves there.
 *
 * Moves use POINTER events (not HTML5 drag-and-drop) so mouse and touch
 * share the path; drop targets are elements carrying
 * `data-drop-group`/`data-drop-index` (drag.ts). The keyboard path
 * (§12.4) produces the exact same payload: focus an item, `m` picks it
 * up, arrows move the placement cursor (left/right across lanes,
 * up/down within), `Enter` drops, `Esc` cancels.
 */

import { useRef, useState, type ReactNode } from "react";
import type { CollectionBlock, JsonObject } from "@sigrun/shared/blocks";
import { resolvePointer } from "@sigrun/shared/blocks";
import { useSurfaceActions, useSurfaceData } from "../context";
import { useWidthClass } from "../width";
import { type PreparedGroup, type PreparedItem } from "./Collection";
import { CardView } from "./Card";
import {
	cancelDrag,
	dropTargetAt,
	endDrag,
	movePayload,
	startDrag,
	type DropMove,
	type DragState,
} from "./drag";
import {
	BulkActionBar,
	SelectBox,
	useActivate,
	useCollectionView,
} from "./rows";

/** A lane's placement cursor (keyboard moves): group + index the
 *  picked-up item would drop at. */
interface Placement {
	readonly group: string;
	readonly index: number;
}

/** The lanes display. */
export function LanesDisplay(props: {
	block: CollectionBlock;
	groups: readonly PreparedGroup[];
}): ReactNode {
	const block = props.block;
	const view = useCollectionView(block);
	const activate = useActivate(block);
	const actions = useSurfaceActions();
	const widthClass = useWidthClass();
	const compact = widthClass === "compact";
	const writeAccess = actions.access === "write";
	const canMove = writeAccess && block.onMove !== undefined;

	// Compact lane selection (spec §12.3): component state that SURVIVES
	// width-class changes — Review Focus 3 pins it: a resize across the
	// boundary keeps the selected lane.
	const [selectedLane, setSelectedLane] = useState<string>(
		props.groups[0]?.id ?? "",
	);
	// The keyboard-picked-up item and its placement cursor.
	const [held, setHeld] = useState<{ itemId: string; at: Placement } | null>(null);

	const laneOrder = props.groups.map((group) => group.id);
	const shownLane =
		compact && laneOrder.includes(selectedLane)
			? selectedLane
			: laneOrder[0] ?? "";

	const dispatchMove = (move: DropMove): void => {
		const onMove = block.onMove;
		if (onMove === undefined) return;
		actions.dispatch({ type: "move", name: onMove }, movePayload(move));
	};

	/** The pointer drag state (one at a time; the ref mirrors it so the
	 *  down->up pair inside one event batch reads the latest). */
	const [drag, setDrag] = useState<DragState | null>(null);
	const dragRef = useRef<DragState | null>(null);
	const dragEl = useRef<{ setPointerCapture?(id: number): void; releasePointerCapture?(id: number): void } | null>(null);
	void drag; // the state drives a drag affordance class (blocks.css)

	const onPointerDown = (
		event: {
			pointerId: number;
			currentTarget?: { setPointerCapture?(id: number): void; releasePointerCapture?(id: number): void };
		},
		itemId: string,
		from: Placement,
	): void => {
		if (!canMove) return;
		// Pointer capture on the dragged element: the pointer-up reaches
		// it even when the pointer is released over ANOTHER element.
		const el = event.currentTarget;
		dragEl.current = el ?? null;
		if (el !== undefined) startDrag(el, event.pointerId, { itemId, from });
		dragRef.current = { itemId, from };
		setDrag({ itemId, from });
	};

	const onPointerUp = (event: {
		pointerId: number;
		clientX: number;
		clientY: number;
		currentTarget?: { setPointerCapture?(id: number): void; releasePointerCapture?(id: number): void };
	}): void => {
		const current = dragRef.current;
		if (current === null) return;
		dragRef.current = null;
		setDrag(null);
		const el = event.currentTarget ?? dragEl.current ?? undefined;
		dragEl.current = null;
		// endDrag releases capture and hit-tests; without an element
		// reference (a bare synthetic event) hit-test directly.
		if (el !== undefined) {
			const move = endDrag(el, event.pointerId, current, event.clientX, event.clientY);
			if (move !== undefined) dispatchMove(move);
			return;
		}
		const target = dropTargetAt(event.clientX, event.clientY);
		if (target === undefined) return;
		if (target.group === current.from.group && target.index === current.from.index) {
			return;
		}
		dispatchMove({ itemId: current.itemId, from: current.from, to: target });
	};

	/** Pointer cancel (touch drag stolen by scroll): clear the pending
	 *  drag with NO dispatch. */
	const onPointerCancel = (event: {
		pointerId: number;
		currentTarget?: { setPointerCapture?(id: number): void; releasePointerCapture?(id: number): void };
	}): void => {
		if (dragRef.current === null) return;
		dragRef.current = null;
		setDrag(null);
		const el = event.currentTarget ?? dragEl.current ?? undefined;
		dragEl.current = null;
		if (el !== undefined) cancelDrag(el, event.pointerId);
	};

	/** Keyboard moves (§12.4): `m` pick up, arrows place, Enter drop,
	 *  Esc cancel. The event target carries the item id via closest. */
	const onKeyDown = (event: {
		key: string;
		target: EventTarget | { closest(selector: string): { getAttribute(name: string): string | null } | null };
	}): void => {
		const target = event.target as {
			closest?(selector: string): { getAttribute(name: string): string | null } | null;
		};
		if (!canMove) return;
		if (event.key === "m") {
			const carrier = target.closest?.("[data-drag-item]");
			const itemId = carrier?.getAttribute("data-drag-item");
			if (itemId === null || itemId === undefined) return;
			const at = placementOf(itemId);
			if (at !== undefined) setHeld({ itemId, at });
			return;
		}
		if (held === null) return;
		if (event.key === "Escape" || event.key === "Esc") {
			setHeld(null);
			return;
		}
		const laneIndex = laneOrder.indexOf(held.at.group);
		if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
			const nextLane =
				event.key === "ArrowRight" ? laneIndex + 1 : laneIndex - 1;
			const group = laneOrder[nextLane];
			if (group === undefined) return;
			const size = laneSize(group, held.itemId);
			setHeld({ itemId: held.itemId, at: { group, index: Math.min(held.at.index, size) } });
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			const size = laneSize(held.at.group, held.itemId);
			const index =
				event.key === "ArrowDown"
					? Math.min(held.at.index + 1, size)
					: Math.max(held.at.index - 1, 0);
			setHeld({ itemId: held.itemId, at: { group: held.at.group, index } });
			return;
		}
		if (event.key === "Enter") {
			const from = placementOf(held.itemId);
			setHeld(null);
			if (from === undefined) return;
			if (from.group === held.at.group && from.index === held.at.index) return;
			dispatchMove({ itemId: held.itemId, from, to: held.at });
		}
	};

	/** An item's current placement (group + index within the lane). */
	const placementOf = (itemId: string): Placement | undefined => {
		for (const group of props.groups) {
			const index = group.buckets.visible.findIndex(
				(prepared) => prepared.id === itemId,
			);
			if (index >= 0) return { group: group.id, index };
		}
		return undefined;
	};

	/** The lane's length, counting the held item as present (it is —
	 *  its removal happens on drop, not on pickup). */
	const laneSize = (group: string, _heldItem: string): number => {
		const found = props.groups.find((candidate) => candidate.id === group);
		return found?.buckets.visible.length ?? 0;
	};

	const renderCard = (
		prepared: PreparedItem,
		group: string,
		index: number,
	): ReactNode => (
		<div
			key={prepared.id}
			className="blk-lane-card"
			data-drag-item={canMove ? prepared.id : undefined}
			data-drop-group={group}
			data-drop-index={index}
			onPointerDown={(event) =>
				onPointerDown(event, prepared.id, { group, index })
			}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerCancel}
			onClick={() => activate(prepared.id)}
		>
			{block.select !== undefined && (
				<SelectBox
					checked={view.selection.includes(prepared.id)}
					onToggle={() => view.toggleSelect(prepared.id)}
				/>
			)}
			<CardView card={block.item} item={prepared.item} display="lanes" />
			{compact && canMove && props.groups.length > 1 && (
				<MoveToMenu
					block={block}
					prepared={prepared}
					from={{ group, index }}
					otherGroups={laneOrder.filter((id) => id !== group)}
					dispatchMove={dispatchMove}
				/>
			)}
		</div>
	);

	const shownGroups = compact
		? props.groups.filter((group) => group.id === shownLane)
		: props.groups;

	return (
		<div
			className="blk blk-collection blk-lanes"
			data-display="lanes"
			data-layout={compact ? "single" : "side-by-side"}
			onKeyDown={onKeyDown}
		>
			<BulkActionBar block={block} selection={view.selection} />
			{compact && props.groups.length > 1 && (
				<select
					className="blk-lane-switcher"
					aria-label="Lane"
					value={shownLane}
					onChange={(event) => setSelectedLane(event.target.value)}
				>
					{props.groups.map((group) => (
						<option key={group.id} value={group.id}>
							{group.title}
						</option>
					))}
				</select>
			)}
			<div className="blk-lanes-row">
				{shownGroups.map((group) => (
					<div
						key={group.id}
						className="blk-lane"
						data-lane={group.id}
						data-drop-group={group.id}
						data-drop-index={group.buckets.visible.length}
					>
						<div className="blk-lane-heading" dir="auto">
							{group.title}
						</div>
						{group.buckets.visible.map((prepared, index) =>
							renderCard(prepared, group.id, index),
						)}
					</div>
				))}
			</div>
		</div>
	);
}

	/** The compact "Move to…" menu: one entry per OTHER group, dispatching
 *  the move to the end of that lane (spec §12.3). */
function MoveToMenu(props: {
	block: CollectionBlock;
	prepared: PreparedItem;
	from: Placement;
	otherGroups: readonly string[];
	dispatchMove(move: DropMove): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const data = useSurfaceData();
	const groups = groupTitles(props.block);
	const stop = (event?: { stopPropagation?: () => void }): void => {
		event?.stopPropagation?.();
	};
	return (
		<span className="blk-move-to">
			<button
				type="button"
				aria-label="Move to…"
				data-item={props.prepared.id}
				data-targets={props.otherGroups.join(",")}
				onClick={(event) => {
					stop(event);
					setOpen((current) => !current);
				}}
			>
				Move to…
			</button>
			{open &&
				props.otherGroups.map((group) => (
					<button
						key={group}
						type="button"
						className="blk-move-to-target"
						data-item={props.prepared.id}
						data-move-target={group}
						onClick={(event) => {
							stop(event);
							setOpen(false);
							props.dispatchMove({
								itemId: props.prepared.id,
								from: props.from,
								to: {
									group,
									index: laneSizeFromData(props.block, data.data, group),
								},
							});
						}}
					>
						{groups.get(group) ?? group}
					</button>
				))}
		</span>
	);
}

/** Group id -> display title. */
function groupTitles(block: CollectionBlock): Map<string, string> {
	return new Map(
		(block.groups ?? []).map((group) => [
			group.id,
			typeof group.title === "string" ? group.title : group.id,
		]),
	);
}

/** The length of a lane in the CURRENT rendered data (the "Move to…"
 *  target index is the lane's end). Computed from the data context so
 *  the compact single-lane view can target lanes it is not showing. */
function laneSizeFromData(
	block: CollectionBlock,
	data: JsonObject,
	group: string,
): number {
	const itemsValue = block.items;
	// Literal rows (the ambient shape) carry no data path to size.
	if (
		typeof itemsValue !== "object" ||
		Array.isArray(itemsValue) ||
		!("$" in itemsValue)
	) {
		return 0;
	}
	const resolved = resolvePointer(data, itemsValue.$);
	const items = Array.isArray(resolved) ? resolved : [];
	const groupBy = block.groupBy;
	if (groupBy === undefined) return items.length;
	return items.filter(
		(item) =>
			typeof item === "object" &&
			item !== null &&
			!Array.isArray(item) &&
			(item as JsonObject)[groupBy] === group,
	).length;
}
