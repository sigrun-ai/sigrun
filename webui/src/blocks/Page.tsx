/**
 * The `page` shell (UI-blocks U1 Task 6, spec §5.1/§12.3): the header
 * (title, subtitle, switcher, action buttons), then sidebar, main and
 * detail columns — the channel draws them, the extension never
 * positions them.
 *
 * - `empty` replaces MAIN ONLY when main's first collection binds to a
 *   missing path, `null` or `[]` (the render contract `toText` pins);
 *   the sidebar and detail slots keep rendering.
 * - Compact (spec §12.3): the sidebar becomes a drawer (hidden until
 *   the header toggle opens it); the detail becomes a pushed page with
 *   a back button.
 * - The header `switcher` is a `choice` field; selecting dispatches a
 *   `navigate` action carrying `{<field name>: id}` as params.
 */

import { useState, type ReactNode } from "react";
import type {
	ActionButton,
	Bindable,
	Block,
	ChoiceField,
	CollectionBlock,
	Field,
	JsonObject,
	PageBlock,
} from "@sigrun/shared/blocks";
import { resolvePointer } from "@sigrun/shared/blocks";
import { BlockView } from "./BlockView";
import { bound, boundString, useSurfaceActions, useSurfaceData } from "./context";
import { Icon } from "./icons";
import { useWidthClass } from "./width";

/** The first `collection` block in a slot list, depth-first (mirrors
 *  the `toText` projection's `firstCollection`). */
function firstCollection(blocks: readonly Block[]): CollectionBlock | undefined {
	for (const block of blocks) {
		if (block.type === "collection") return block;
		if (block.type === "stack") {
			const found = firstCollection(block.children);
			if (found !== undefined) return found;
		}
		if (block.type === "section") {
			// A section's children mix blocks and fields; scan the blocks.
			const found = firstCollection(
				block.children.filter(
					(child: Block | Field): child is Block =>
						child.type === "collection" ||
						child.type === "stack" ||
						child.type === "columns" ||
						child.type === "grid" ||
						child.type === "section",
				),
			);
			if (found !== undefined) return found;
		}
		if (block.type === "columns" || block.type === "grid") {
			for (const child of block.children) {
				const found = firstCollection([child.block]);
				if (found !== undefined) return found;
			}
		}
	}
	return undefined;
}

/** Whether `empty` replaces main: the first collection's `items`
 *  binding resolves missing, null or an empty array (spec §5.1). */
function isMainEmpty(block: PageBlock, data: JsonObject): boolean {
	if (block.empty === undefined) return false;
	const collection = firstCollection(block.main);
	if (collection === undefined) return false;
	// Literal rows (the ambient shape) are never an empty main: only a
	// binding can resolve missing/empty against the data document.
	const binding = collection.items;
	if (typeof binding !== "object" || !("$" in binding)) return false;
	const items = resolvePointer(data, binding.$);
	return !Array.isArray(items) || items.length === 0;
}

/** Render a slot's blocks (every slot is implicitly a stack, §5.2). */
function slot(blocks: readonly Block[]): ReactNode {
	return blocks.map((child, index) => <BlockView key={index} block={child} />);
}

/** The header switcher (spec §5.1): a `choice`; selecting navigates. */
function Switcher(props: { field: ChoiceField }): ReactNode {
	const data = useSurfaceData();
	const actions = useSurfaceActions();
	const options = bound(data, props.field.options) ?? [];
	const select = (id: string): void => {
		actions.dispatch(
			{ type: "navigate", params: { [props.field.name]: id } },
			{ [props.field.name]: id },
		);
	};
	return (
		<span className="blk-page-switcher" data-page-switcher="">
			{options.map((option) => (
				<label key={option.id} className="blk-page-switcher-option">
					<input
						type="radio"
						name={props.field.name}
						value={option.id}
						onChange={() => select(option.id)}
					/>
					<span>{boundString(data, option.label)}</span>
				</label>
			))}
		</span>
	);
}

/** A header action button (spec §5.1: `{id, label, icon?, action}`). */
function HeaderAction(props: { button: ActionButton }): ReactNode {
	const data = useSurfaceData();
	const actions = useSurfaceActions();
	if (actions.access === "read") return null;
	return (
		<button
			type="button"
			className="blk-page-action"
			data-page-action={props.button.id}
			onClick={() => actions.dispatch(props.button.action, {})}
		>
			{props.button.icon !== undefined && <Icon name={props.button.icon} size={14} />}
			<span>{boundString(data, props.button.label)}</span>
		</button>
	);
}

/** The page block (spec §5.1). */
export function PageBlockView(props: { block: PageBlock }): ReactNode {
	const block = props.block;
	const data = useSurfaceData();
	const widthClass = useWidthClass();
	const compact = widthClass === "compact";
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [detailOpen, setDetailOpen] = useState(false);

	const title = boundString(data, block.title as Bindable<string> | undefined);
	const subtitle = boundString(data, block.subtitle);
	const empty = isMainEmpty(block, data.data);
	const hasSidebar = block.sidebar !== undefined && block.sidebar.length > 0;
	const hasDetail = block.detail !== undefined && block.detail.length > 0;

	return (
		<div className="blk blk-page" data-block="page" id={block.id}>
			<header className="blk-page-header">
				<div className="blk-page-titles">
					<h1 className="blk-page-title" dir="auto">
						{title}
					</h1>
					{subtitle !== "" && (
						<p className="blk-page-subtitle" dir="auto">
							{subtitle}
						</p>
					)}
				</div>
				{block.switcher !== undefined && <Switcher field={block.switcher} />}
				{(block.actions ?? []).map((button) => (
					<HeaderAction key={button.id} button={button} />
				))}
				{compact && hasSidebar && (
					<button
						type="button"
						className="blk-page-toggle"
						data-page-drawer-toggle=""
						aria-label="toggle sidebar"
						onClick={() => setDrawerOpen((open) => !open)}
					>
						☰
					</button>
				)}
				{compact && hasDetail && (
					<button
						type="button"
						className="blk-page-toggle"
						data-page-detail-toggle=""
						aria-label="open detail"
						onClick={() => setDetailOpen(true)}
					>
						›
					</button>
				)}
			</header>
			<div className="blk-page-body">
				{hasSidebar && (
					<aside
						className="blk-page-sidebar"
						data-page-region="sidebar"
						data-open={
							compact ? (drawerOpen ? "" : undefined) : undefined
						}
					>
						{slot(block.sidebar ?? [])}
					</aside>
				)}
				<main className="blk-page-main" data-page-region="main">
					{empty && block.empty !== undefined ? (
						<div className="blk-page-empty" data-page-empty="">
							<Icon name={block.empty.icon} size={24} />
							<p className="blk-page-empty-title">{block.empty.title}</p>
							{block.empty.hint !== undefined &&
								block.empty.hint !== "" && (
									<p className="blk-page-empty-hint">{block.empty.hint}</p>
								)}
						</div>
					) : (
						slot(block.main)
					)}
				</main>
				{hasDetail && (
					<aside
						className="blk-page-detail"
						data-page-region="detail"
						data-open={
							compact ? (detailOpen ? "" : undefined) : undefined
						}
					>
						{compact && (
							<button
								type="button"
								className="blk-page-toggle"
								data-page-detail-back=""
								aria-label="back"
								onClick={() => setDetailOpen(false)}
							>
								‹ back
							</button>
						)}
						{slot(block.detail ?? [])}
					</aside>
				)}
			</div>
		</div>
	);
}
