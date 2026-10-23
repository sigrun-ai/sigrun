/**
 * The list display (UI-blocks U1 Task 3, spec §5.5): rows, groups,
 * nesting via `children` (2-cell indent per depth), `numbered`, and
 * `checkable` (toggling dispatches the `onCheck` edit action with
 * `{itemId, value}`). Groups render headings in `groups` order; quiet
 * items fold behind "N more"; multi-select offers `bulkActions`.
 */

import type { ReactNode } from "react";
import type {
	CollectionBlock,
	JsonValue,
} from "@sigrun/shared/blocks";
import { useSurfaceActions } from "../context";
import { itemField, type PreparedGroup, type PreparedItem } from "./Collection";
import { CardView } from "./Card";
import {
	BulkActionBar,
	SelectBox,
	useActivate,
	useCollectionView,
	type CollectionView,
} from "./rows";

/** One list row (recursive for `children` nesting). */
function ListRow(props: {
	block: CollectionBlock;
	prepared: PreparedItem;
	depth: number;
	index: number;
	view: CollectionView;
	activate(itemId: string): void;
}): ReactNode {
	const { block, prepared, depth, index, view, activate } = props;
	const nestedValue =
		block.children === undefined
			? undefined
			: itemField(prepared.item, block.children);
	const nestedItems = Array.isArray(nestedValue)
		? (nestedValue as readonly JsonValue[])
		: [];

	return (
		<li className="blk-list-row" data-depth={depth}>
			<div
				className="blk-list-line"
				style={{ paddingInlineStart: `${depth * 2}rem` }}
			>
				{block.select !== undefined && (
					<SelectBox
						checked={view.selection.includes(prepared.id)}
						onToggle={() => view.toggleSelect(prepared.id)}
					/>
				)}
				{block.numbered === true && (
					<span className="blk-list-number">{index + 1}</span>
				)}
				{block.checkable !== undefined && (
					<CheckBox block={block} prepared={prepared} />
				)}
				<div
					className="blk-list-card"
					onClick={() => activate(prepared.id)}
					onKeyDown={(event) => {
						if (event.key === "Enter") activate(prepared.id);
					}}
					role={block.onActivate !== undefined ? "button" : undefined}
					tabIndex={block.onActivate !== undefined ? 0 : undefined}
				>
					<CardView card={block.item} item={prepared.item} display="list" />
				</div>
			</div>
			{nestedItems.length > 0 && (
				<ol className="blk-list-nested">
					{nestedItems.map((child, childIndex) => (
						<ListRow
							key={childIndex}
							block={block}
							prepared={{
								id: `${prepared.id}/${childIndex}`,
								item: child,
							}}
							depth={depth + 1}
							index={childIndex}
							view={view}
							activate={activate}
						/>
					))}
				</ol>
			)}
		</li>
	);
}

/** The checkable checkbox: toggling dispatches the `onCheck` edit
 *  action with `{itemId, value}` (spec §5.5/§6.2). Read access hides
 *  it (§6.5). */
function CheckBox(props: {
	block: CollectionBlock;
	prepared: PreparedItem;
}): ReactNode {
	const actions = useSurfaceActions();
	if (actions.access !== "write") return null;
	const field = props.block.checkable;
	if (field === undefined) return null;
	const checked = itemField(props.prepared.item, field) === true;
	return (
		<input
			type="checkbox"
			className="blk-check"
			checked={checked}
			onChange={() => {
				const onCheck = props.block.onCheck;
				if (onCheck !== undefined) {
					actions.dispatch(
						{ type: "edit", name: onCheck },
						{ itemId: props.prepared.id, value: !checked },
					);
				}
			}}
		/>
	);
}

/** One group's rows (heading + quiet fold). */
function GroupRows(props: {
	block: CollectionBlock;
	group: PreparedGroup;
	view: CollectionView;
	activate(itemId: string): void;
}): ReactNode {
	const { block, group, view, activate } = props;
	const quietKey = `${group.id}:quiet`;
	const quietShown = view.folded.includes(quietKey);
	return (
		<div className="blk-list-group" data-group={group.id || undefined}>
			{group.title !== "" && (
				<div className="blk-list-heading" dir="auto">
					{group.title}
				</div>
			)}
			<ol className="blk-list-rows">
				{group.buckets.visible.map((prepared, index) => (
					<ListRow
						key={prepared.id}
						block={block}
						prepared={prepared}
						depth={0}
						index={index}
						view={view}
						activate={activate}
					/>
				))}
			</ol>
			{group.buckets.quiet.length > 0 &&
				(quietShown ? (
					<ol className="blk-list-rows blk-list-quiet">
						{group.buckets.quiet.map((prepared, index) => (
							<ListRow
								key={prepared.id}
								block={block}
								prepared={prepared}
								depth={0}
								index={index}
								view={view}
								activate={activate}
							/>
						))}
						<button
							type="button"
							className="blk-quiet-toggle"
							onClick={() => view.toggleFold(quietKey)}
						>
							Show less
						</button>
					</ol>
				) : (
					<button
						type="button"
						className="blk-quiet-toggle"
						onClick={() => view.toggleFold(quietKey)}
					>
						{group.buckets.quiet.length} more
					</button>
				))}
		</div>
	);
}

/** The list display. */
export function ListDisplay(props: {
	block: CollectionBlock;
	groups: readonly PreparedGroup[];
}): ReactNode {
	const view = useCollectionView(props.block);
	const activate = useActivate(props.block);
	return (
		<div className="blk blk-collection blk-list" data-display="list">
			<BulkActionBar block={props.block} selection={view.selection} />
			{props.groups.map((group, groupIndex) => (
				<GroupRows
					key={group.id || groupIndex}
					block={props.block}
					group={group}
					view={view}
					activate={activate}
				/>
			))}
		</div>
	);
}
