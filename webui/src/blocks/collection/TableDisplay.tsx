/**
 * The table display (UI-blocks U1 Task 3, spec §5.5): sortable columns,
 * paged at 50 rows, cell renderers (`meter` bar, `badge` with the item
 * tone), and the §12.3 compact fallback — rows become cards with
 * `priority: "low"` columns behind an expandable part.
 *
 * Sort/page/expanded are view-only (spec §6.2) — component state in the
 * exact shape of the `/view/<blockId>/` branch (see selection.ts).
 */

import { useState, type ReactNode } from "react";
import {
	formatValue,
	type CollectionBlock,
	type CollectionColumn,
	type JsonValue,
} from "@sigrun/shared/blocks";
import { bound, useSurfaceData } from "../context";
import { useWidthClass } from "../width";
import { itemField, type PreparedGroup, type PreparedItem } from "./Collection";
import { CardView } from "./Card";
import {
	BulkActionBar,
	SelectBox,
	useActivate,
	useCollectionView,
	type CollectionView,
} from "./rows";
import { nextSort } from "./selection";

/** The page size (spec §5.5: paged at 50 rows). */
export const PAGE_SIZE = 50;

/** The table's view-only state (sort + page + expanded rows). */
interface TableView {
	readonly sort: { readonly field: string; readonly dir: "asc" | "desc" } | undefined;
	readonly page: number;
	readonly expanded: readonly string[];
	clickSort(field: string): void;
	setPage(page: number): void;
	toggleExpanded(id: string): void;
}

function useTableView(block: CollectionBlock): TableView {
	const [sort, setSort] = useState<TableView["sort"]>(block.sort);
	const [page, setPage] = useState(0);
	const [expanded, setExpanded] = useState<readonly string[]>([]);
	return {
		sort,
		page,
		expanded,
		clickSort: (field: string): void => {
			setSort((current) => nextSort(current, field));
			setPage(0);
		},
		setPage,
		toggleExpanded: (id: string): void => {
			setExpanded((current) =>
				current.includes(id)
					? current.filter((existing) => existing !== id)
					: [...current, id],
			);
		},
	};
}

/** Compare two values for a column sort (numeric formats sort as
 *  numbers; everything else compares as formatted text). */
function compareValues(
	a: JsonValue | undefined,
	b: JsonValue | undefined,
	format: string | undefined,
	locale: string,
): number {
	const aNum = typeof a === "number" ? a : undefined;
	const bNum = typeof b === "number" ? b : undefined;
	if (aNum !== undefined && bNum !== undefined) return aNum - bNum;
	const aText = a === undefined ? "" : formatValue(a, format, locale);
	const bText = b === undefined ? "" : formatValue(b, format, locale);
	return aText.localeCompare(bText);
}

/** Sort items by the table's view sort (stable — Array.sort's). */
function sortItems(
	items: readonly PreparedItem[],
	sort: TableView["sort"],
	columns: readonly CollectionColumn[],
	locale: string,
): readonly PreparedItem[] {
	if (sort === undefined) return items;
	const column = columns.find((candidate) => candidate.field === sort.field);
	const factor = sort.dir === "asc" ? 1 : -1;
	return [...items].sort(
		(a, b) =>
			factor *
			compareValues(
				itemField(a.item, sort.field),
				itemField(b.item, sort.field),
				column?.format,
				locale,
			),
	);
}

/** One cell: `meter` draws a 0–1 bar, `badge` a badge with the item's
 *  tone, text formats per the column's format (spec §5.5). */
function Cell(props: {
	column: CollectionColumn;
	prepared: PreparedItem;
	itemTone: string | undefined;
}): ReactNode {
	const ctx = useSurfaceData();
	const value = itemField(props.prepared.item, props.column.field);
	if (props.column.cell === "meter") {
		const fraction =
			typeof value === "number" ? Math.min(1, Math.max(0, value)) : 0;
		return (
			<td className="blk-table-cell" data-cell="meter">
				<div className="blk-meter-track">
					<div
						className="blk-meter-fill"
						style={{ inlineSize: `${fraction * 100}%` }}
					/>
				</div>
			</td>
		);
	}
	if (props.column.cell === "badge") {
		const text = value === undefined ? "" : formatValue(value, props.column.format, ctx.locale);
		return (
			<td className="blk-table-cell" data-cell="badge">
				<span className="blk-card-badge" data-tone={props.itemTone ?? "neutral"} dir="auto">
					{text}
				</span>
			</td>
		);
	}
	const text = value === undefined ? "" : formatValue(value, props.column.format, ctx.locale);
	return (
		<td className="blk-table-cell" dir="auto">
			{text}
		</td>
	);
}

/** The full (regular/wide) table. */
function FullTable(props: {
	block: CollectionBlock;
	items: readonly PreparedItem[];
	table: TableView;
	view: CollectionView;
	activate(itemId: string): void;
}): ReactNode {
	const ctx = useSurfaceData();
	const { block, table, view, activate } = props;
	const columns = block.columns ?? [];
	const sorted = sortItems(props.items, table.sort, columns, ctx.locale);
	const pageStart = table.page * PAGE_SIZE;
	const pageItems = sorted.slice(pageStart, pageStart + PAGE_SIZE);
	const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));

	return (
		<div className="blk-table-wrap">
			<table className="blk-table">
				<thead>
					<tr>
						{block.select !== undefined && <th className="blk-table-select" />}
						{columns.map((column) => (
							<th key={column.field} data-sortable={column.sortable === true || undefined}>
								{column.sortable === true ? (
									<button
										type="button"
										className="blk-table-sort"
										data-field={column.field}
										data-dir={
											table.sort?.field === column.field ? table.sort.dir : undefined
										}
										onClick={() => table.clickSort(column.field)}
									>
										{typeof column.label === "string"
											? column.label
											: bound<string>(ctx, column.label) ?? column.field}
									</button>
								) : (
									<span dir="auto">
										{typeof column.label === "string"
											? column.label
											: bound<string>(ctx, column.label) ?? column.field}
									</span>
								)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{pageItems.map((prepared) => (
						<tr
							key={prepared.id}
							data-item-id={prepared.id}
							onClick={() => activate(prepared.id)}
						>
							{block.select !== undefined && (
								<td className="blk-table-select">
									<SelectBox
										checked={view.selection.includes(prepared.id)}
										onToggle={() => view.toggleSelect(prepared.id)}
									/>
								</td>
							)}
							{columns.map((column) => (
								<Cell
									key={column.field}
									column={column}
									prepared={prepared}
									itemTone={useItemToneValue(block, prepared, ctx)}
								/>
							))}
						</tr>
					))}
				</tbody>
			</table>
			{pageCount > 1 && (
				<div className="blk-table-pager">
					<button
						type="button"
						disabled={table.page === 0}
						onClick={() => table.setPage(table.page - 1)}
					>
						Previous
					</button>
					<span>
						Page {table.page + 1} of {pageCount}
					</span>
					<button
						type="button"
						disabled={table.page >= pageCount - 1}
						onClick={() => table.setPage(table.page + 1)}
					>
						Next
					</button>
				</div>
			)}
		</div>
	);
}

/** The item's tone, resolved (module-level so Cell rows don't hook). */
function useItemToneValue(
	block: CollectionBlock,
	prepared: PreparedItem,
	ctx: ReturnType<typeof useSurfaceData>,
): string | undefined {
	const tone = block.item.tone;
	if (tone === undefined) return undefined;
	if (typeof tone === "string") return tone;
	return bound<string>({ ...ctx, item: prepared.item }, tone);
}

/** The compact fallback (§12.3): rows as cards; `priority: "low"`
 *  columns move into an expandable part per row. */
function CompactTable(props: {
	block: CollectionBlock;
	items: readonly PreparedItem[];
	table: TableView;
	view: CollectionView;
	activate(itemId: string): void;
}): ReactNode {
	const ctx = useSurfaceData();
	const { block, table, activate } = props;
	const columns = block.columns ?? [];
	const high = columns.filter((column) => column.priority !== "low");
	const low = columns.filter((column) => column.priority === "low");
	const sorted = sortItems(props.items, table.sort, columns, ctx.locale);
	const pageStart = table.page * PAGE_SIZE;
	const pageItems = sorted.slice(pageStart, pageStart + PAGE_SIZE);

	return (
		<div className="blk-table-compact" data-block="table-compact">
			{pageItems.map((prepared) => {
				const expanded = table.expanded.includes(prepared.id);
				return (
					<div key={prepared.id} className="blk-table-card" data-item-id={prepared.id}>
						<div onClick={() => activate(prepared.id)}>
							<CardView card={block.item} item={prepared.item} display="table" />
						</div>
						{high.length > 0 && (
							<dl className="blk-table-high">
								{high.map((column) => (
									<div key={column.field} className="blk-table-field">
										<dt dir="auto">{typeof column.label === "string" ? column.label : column.field}</dt>
										<dd dir="auto">
											{formatValue(
												itemField(prepared.item, column.field) ?? "",
												column.format,
												ctx.locale,
											)}
										</dd>
									</div>
								))}
							</dl>
						)}
						{low.length > 0 && (
							<div className="blk-table-low">
								<button
									type="button"
									className="blk-table-expand"
									aria-expanded={expanded}
									onClick={(event) => {
										event.stopPropagation();
										table.toggleExpanded(prepared.id);
									}}
								>
									{expanded ? "Less" : "More"}
								</button>
								{expanded && (
									<dl className="blk-table-low-fields">
										{low.map((column) => (
											<div key={column.field} className="blk-table-field">
												<dt dir="auto">{typeof column.label === "string" ? column.label : column.field}</dt>
												<dd dir="auto">
													{formatValue(
														itemField(prepared.item, column.field) ?? "",
														column.format,
														ctx.locale,
													)}
												</dd>
											</div>
										))}
									</dl>
								)}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

/** The table display. */
export function TableDisplay(props: {
	block: CollectionBlock;
	groups: readonly PreparedGroup[];
}): ReactNode {
	const view = useCollectionView(props.block);
	const table = useTableView(props.block);
	const activate = useActivate(props.block);
	const widthClass = useWidthClass();
	// Quiet items follow the visible ones (no fold UI in table/grid — the
	// flat order keeps sort/paging simple; list owns the "N more" fold).
	const items = props.groups.flatMap((group) => [
		...group.buckets.visible,
		...group.buckets.quiet,
	]);
	return (
		<div className="blk blk-collection blk-table-block" data-display="table">
			<BulkActionBar block={props.block} selection={view.selection} />
			{widthClass === "compact" ? (
				<CompactTable
					block={props.block}
					items={items}
					table={table}
					view={view}
					activate={activate}
				/>
			) : (
				<FullTable
					block={props.block}
					items={items}
					table={table}
					view={view}
					activate={activate}
				/>
			)}
		</div>
	);
}
