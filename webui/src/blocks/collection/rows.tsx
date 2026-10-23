/**
 * Shared collection rows (UI-blocks U1 Task 3, spec §5.5): the pieces
 * every display composes — selection checkboxes, activation dispatch
 * (`onActivate`, edit vs view-only honoured), the multi-select bulk
 * action bar, and the quiet "N more" fold.
 *
 * View-only state (selection, folds) lives in component state shaped
 * exactly like the `/view/<blockId>/` branch Task 4's `useSurface`
 * will hold (see selection.ts) — never dispatched to the server.
 */

import { useState, type ReactNode } from "react";
import type {
	BulkAction,
	CollectionBlock,
	JsonObject,
	JsonValue,
} from "@sigrun/shared/blocks";
import { bound, useSurfaceActions, useSurfaceData } from "../context";
import { toggleKey, toggleSelection } from "./selection";

/** The hook contract: one collection's view-only state slice plus the
 *  toggles the displays drive. Task 4 swaps the state source. */
export interface CollectionView {
	readonly selection: readonly string[];
	readonly folded: readonly string[];
	toggleSelect(id: string): void;
	toggleFold(key: string): void;
}

/** Hold the selection/fold view state in component state, shaped for
 *  the `/view/` branch (Task 4 moves it verbatim). */
export function useCollectionView(block: CollectionBlock): CollectionView {
	const [selection, setSelection] = useState<readonly string[]>([]);
	const [folded, setFolded] = useState<readonly string[]>([]);
	return {
		selection,
		folded,
		toggleSelect: (id: string): void => {
			setSelection((current) =>
				toggleSelection(current, id, block.select ?? "single"),
			);
		},
		toggleFold: (key: string): void => {
			setFolded((current) => toggleKey(current, key));
		},
	};
}

/** Whether an edit action is allowed (read access hides every edit —
 *  spec §6.5). Checkable and bulk edits honour it. */
export function useWriteAccess(): boolean {
	return useSurfaceActions().access === "write";
}

/** The activation handler for an item (click/Enter): dispatches
 *  `onActivate` with `{itemId}`. View-only actions are allowed at read
 *  access; edits/answers require write (§6.5 — ActionButtonRow applies
 *  the same filter to card buttons). */
export function useActivate(block: CollectionBlock): (itemId: string) => void {
	const actions = useSurfaceActions();
	return (itemId: string): void => {
		const action = block.onActivate;
		if (action === undefined) return;
		const viewOnly =
			action.type === "navigate" || action.type === "copy" || action.type === "open";
		if (!viewOnly && actions.access !== "write") return;
		actions.dispatch(action, { itemId });
	};
}

/** The multi-select bulk action bar (spec §5.5): offered when a
 *  selection exists. A bulk action with a `form` opens a minimal inline
 *  form (Task 5 owns full form rendering; this task's inline shape
 *  renders the form's field names as text inputs) and dispatches
 *  `{ids, values}`; without a form it dispatches `{ids}`. Read access
 *  hides the bar entirely (bulk actions are edits). */
export function BulkActionBar(props: {
	block: CollectionBlock;
	selection: readonly string[];
}): ReactNode {
	const actions = useSurfaceActions();
	const data = useSurfaceData();
	const [openForm, setOpenForm] = useState<BulkAction | null>(null);
	const [values, setValues] = useState<JsonObject>({});
	const bulkActions = props.block.bulkActions ?? [];
	if (
		actions.access !== "write" ||
		props.block.select !== "multi" ||
		props.selection.length === 0 ||
		bulkActions.length === 0
	) {
		return null;
	}

	const submit = (action: BulkAction, formValues: JsonObject): void => {
		actions.dispatch(
			{ type: "submit", name: action.onSubmit },
			{ ids: [...props.selection], values: formValues },
		);
		setOpenForm(null);
		setValues({});
	};

	return (
		<div className="blk-bulk" data-block="bulk-actions">
			{bulkActions.map((action) => {
				const label = bound<string>(data, action.label) ?? action.id;
				return (
					<button
						key={action.id}
						type="button"
						className="blk-bulk-action"
						onClick={() => {
							if (action.form === undefined) submit(action, {});
							else {
								setOpenForm(action);
								setValues({});
							}
						}}
					>
						{label}
					</button>
				);
			})}
			{openForm !== null && (
				<form
					className="blk-bulk-form"
					onSubmit={(event) => {
						event.preventDefault();
						submit(openForm, values);
					}}
				>
					{formFieldNames(openForm).map((name) => (
						<input
							key={name}
							name={name}
							aria-label={name}
							value={typeof values[name] === "string" ? (values[name] as string) : ""}
							onChange={(event) =>
								setValues((current) => ({
									...current,
									[name]: event.target.value,
								}))
							}
						/>
					))}
					<button type="submit" className="blk-bulk-submit">
						Apply
					</button>
				</form>
			)}
		</div>
	);
}

/** The field names a minimal bulk form renders (Task 5 renders the full
 *  tree; this inline shape reads the form's top-level field `name`s). */
function formFieldNames(action: BulkAction): readonly string[] {
	// SAFETY: `Tree` is an opaque shape to this task (Task 5 owns forms);
	// the inline bulk form only reads its top-level field names, so the
	// narrow `{children?: …}` view is all that is needed. The runtime
	// guards (`Array.isArray`, typeof) check before any access.
	const form = action.form as unknown as { readonly children?: readonly JsonValue[] };
	if (form === undefined || !Array.isArray(form.children)) return [];
	return form.children
		.map((child) =>
			typeof child === "object" && child !== null && !Array.isArray(child)
				? (child as JsonObject).name
				: undefined,
		)
		.filter((name): name is string => typeof name === "string");
}

/** The selection checkbox (read access hides it — selection exists to
 *  drive edits). */
export function SelectBox(props: {
	checked: boolean;
	onToggle(): void;
}): ReactNode {
	const actions = useSurfaceActions();
	if (actions.access !== "write") return null;
	return (
		<input
			type="checkbox"
			className="blk-select"
			checked={props.checked}
			onChange={() => props.onToggle()}
		/>
	);
}
