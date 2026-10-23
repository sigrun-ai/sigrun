/**
 * The tree block (UI-blocks U1 Task 2, spec §5.3): bound nested nodes
 * with disclosure. Eager nodes (`children` present) toggle locally; a
 * lazy node (`hasChildren: true`, no `children`) dispatches the
 * `onExpand` handler with `{id}` — the handler returns `DataOps` that
 * INSERT the children into the surface data, so this component only
 * reports and lets the data update render them (§4.3/§6.1). Activating
 * a node dispatches `onActivate` with `{id}`. Disclosure is a real
 * button (Enter/Space keyboard paths, §12.4's "every pointer
 * interaction has a keyboard path").
 */

import { useState, type ReactNode } from "react";
import type { Action, TreeBlock, TreeNode } from "@sigrun/shared/blocks";
import { bound, useSurfaceActions, useSurfaceData } from "./context";
import { Icon } from "./icons";

/** Read a `tree.nodes` binding: a missing path is an empty array (the
 *  render contract — empty, never an error). */
function readNodes(raw: unknown): readonly TreeNode[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(node): node is TreeNode =>
			node !== null &&
			typeof node === "object" &&
			typeof (node as TreeNode).id === "string" &&
			typeof (node as TreeNode).label === "string",
	);
}

/** A tree block. */
export function TreeBlockView(props: { block: TreeBlock }): ReactNode {
	const ctx = useSurfaceData();
	const nodes = readNodes(bound(ctx, props.block.nodes));
	return (
		<div className="blk blk-tree" data-block="tree" role="tree">
			{nodes.map((node, index) => (
				<TreeNodeRow
					key={node.id}
					node={node}
					index={index}
					depth={0}
					onExpand={props.block.onExpand}
					onActivate={props.block.onActivate}
				/>
			))}
		</div>
	);
}

/** One node row: the disclosure toggle, icon, label and children. */
function TreeNodeRow(props: {
	node: TreeNode;
	index: number;
	depth: number;
	onExpand: string | undefined;
	onActivate: Action | undefined;
}): ReactNode {
	const { node, depth, onExpand, onActivate } = props;
	const actions = useSurfaceActions();
	const children = node.children ?? [];
	// Eager children (present on the node) start expanded; lazy ones
	// (hasChildren, none arrived yet) start collapsed.
	const [open, setOpen] = useState(children.length > 0);
	const expandable = children.length > 0 || node.hasChildren === true;

	function toggle(): void {
		// Lazy node: report the expand; the handler's DataOps insert the
		// children, and the resulting data update re-renders this row with
		// them (the component stays stateless about fetched children).
		if (children.length === 0 && node.hasChildren === true) {
			if (onExpand !== undefined && !open) {
				actions.dispatch({ type: "edit", name: onExpand }, { id: node.id });
			}
			setOpen(!open);
			return;
		}
		setOpen(!open);
	}

	function onKeyDown(event: { key: string; preventDefault(): void }): void {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			toggle();
		}
	}

	return (
		<div className="blk-tree-node" data-depth={depth} role="none">
			<div
				className="blk-tree-row"
				data-node-label={node.label}
				role="treeitem"
				aria-level={depth + 1}
				aria-selected={false}
				onClick={() => {
					if (onActivate !== undefined) {
						actions.dispatch(onActivate, { id: node.id });
					}
				}}
			>
				<button
					type="button"
					className="blk-tree-toggle"
					aria-expanded={expandable ? open : undefined}
					aria-label={`Toggle ${node.label}`}
					disabled={!expandable}
					onClick={(event) => {
						// The row's own click (activate) must not fire twice.
						event?.stopPropagation();
						toggle();
					}}
					onKeyDown={onKeyDown}
					style={{ marginLeft: `${depth * 1.1}rem` }}
				>
					{expandable ? <Caret open={open} /> : <span className="blk-tree-dot" />}
				</button>
				{node.icon !== undefined && <Icon name={node.icon} />}
				<span className="blk-tree-label" dir="auto">{node.label}</span>
			</div>
			{open && children.length > 0 && (
				<div className="blk-tree-children" role="group">
					{children.map((child, index) => (
						<TreeNodeRow
							key={child.id}
							node={child}
							index={index}
							depth={depth + 1}
							onExpand={onExpand}
							onActivate={onActivate}
						/>
					))}
				</div>
			)}
			{open && children.length === 0 && node.hasChildren === true && (
				<div className="blk-tree-pending" style={{ marginLeft: `${(depth + 1) * 1.1}rem` }}>
					…
				</div>
			)}
		</div>
	);
}

/** The disclosure caret (rotates with `open`). */
function Caret(props: { open: boolean }): ReactNode {
	return (
		<svg
			className="blk-tree-caret"
			data-open={props.open}
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="m9 18 6-6-6-6" />
		</svg>
	);
}
