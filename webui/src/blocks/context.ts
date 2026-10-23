/**
 * The renderer's two contexts (UI-blocks U1 Task 1, spec §4.2/§6.5):
 * every block component reads its data through `SurfaceData` and
 * reports actions through `SurfaceActions`, so the renderer has no idea
 * which placement or transport it serves. U3/U4 (extension surfaces)
 * and U5 (chat) provide the values; the defaults below render any tree
 * standalone — the gallery, previews, and these tests.
 */

import { createContext, useContext } from "react";
import type {
	Action,
	Bindable,
	Binding,
	JsonObject,
	JsonValue,
} from "@sigrun/shared/blocks";
import { resolvePointer } from "@sigrun/shared/blocks";

/** What a block's bindings resolve against: the surface's confirmed
 *  data (an object), the current collection item (inside item
 *  templates, where `./` pointers root), and the formatting locale. */
export interface SurfaceDataCtx {
	data: JsonObject;
	item?: JsonValue;
	locale: string;
}

/** The surface's view-only state (spec §6.2): the `/view/` branch the
 *  channel owns and never sends to the server. */
export type ViewState = JsonObject;

/** How blocks report actions: `dispatch` forwards `{action, payload}`
 *  to the surface's transport (the channel adds the `actionId`), and
 *  `access` follows the principal's surface access (spec §6.5):
 *  `read` hides every edit and answer action. */
export interface SurfaceActionsCtx {
	dispatch(action: Action, payload: JsonValue): void;
	access: "read" | "write";
	viewState: ViewState;
	/** Server-side field errors, keyed by field name (spec §5.6: the
	 *  `{error: {field}}` from a rejected action surfaces under that
	 *  field). Empty when no rejection has landed. */
	readonly serverErrors?: Readonly<Record<string, string>>;
}

/** The locale used when no provider narrows it (Node test envs have no
 *  `navigator.language`; the browser's own default is right there). */
const DEFAULT_LOCALE: string =
	typeof navigator === "object" && typeof navigator.language === "string"
		? navigator.language
		: "en";

/** Render without a data provider: bindings resolve against an empty
 *  document (a missing path renders empty — the render contract). */
export const SurfaceDataContext = createContext<SurfaceDataCtx>({
	data: {},
	locale: DEFAULT_LOCALE,
});

/** Render without an actions provider: writes dispatch nowhere and read
 *  access is not assumed (the standalone shapes are previews). */
export const SurfaceActionsContext = createContext<SurfaceActionsCtx>({
	dispatch: (): void => {},
	access: "read",
	viewState: {},
	serverErrors: {},
});

/** The surface data bindings resolve against. */
export function useSurfaceData(): SurfaceDataCtx {
	return useContext(SurfaceDataContext);
}

/** The action surface blocks dispatch through. */
export function useSurfaceActions(): SurfaceActionsCtx {
	return useContext(SurfaceActionsContext);
}

/** Whether `value` is a binding: an object whose SOLE contract key
 *  `$` is a string. The string check is the fix the Task-1 review
 *  demanded: without it the literal branch's pass-through could hand a
 *  `{$: …}`-shaped object to a caller as if it were the VALUE for
 *  non-string `Bindable` props (chart series data, meter values) — a
 *  genuine binding now always resolves (or renders empty), and a
 *  literal object that merely CONTAINS a `$` key of another type stays
 *  a literal. */
function isBinding(value: unknown): value is Binding {
	return (
		typeof value === "object" &&
		value !== null &&
		"$" in value &&
		typeof value.$ === "string"
	);
}

/** Resolve `value` in a binding-aware way (spec §4.2): a `{$: pointer}`
 *  reads the pointer against the context's data (or its `item`, for
 *  the `./` item-rooted pointers); a literal passes through; an absent
 *  prop resolves `undefined`. A missing path resolves `undefined` —
 *  never an error, and never the binding object itself. */
export function bound<T>(
	ctx: SurfaceDataCtx,
	value: Bindable<T> | undefined,
): T | undefined {
	if (value === undefined) return undefined;
	if (isBinding(value)) {
		const resolved = resolvePointer(ctx.data, value.$, ctx.item);
		return resolved === undefined ? undefined : (resolved as T);
	}
	// Not a binding object — a literal. The cast is safe by the check
	// above (no `{$: string}` shape reaches here); it exists because TS
	// cannot narrow a generic `T | Binding` union.
	return value as T;
}

/** A binding-aware string (labels, titles, text): missing → "". */
export function boundString(
	ctx: SurfaceDataCtx,
	value: Bindable<string> | undefined,
): string {
	return bound(ctx, value) ?? "";
}
