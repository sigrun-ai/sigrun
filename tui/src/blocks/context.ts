/**
 * The block render context (UI-blocks U2 Task 1): everything a block
 * component reads while rendering — the surface's data, the theme, the
 * locale, the principal's access, the dispatch seam and the channel's
 * view state — plus the binding/text resolution helpers every block
 * renderer shares.
 *
 * `view` is the channel-owned view-state branch (spec §6.2): sort,
 * filter, expansion, selection. It is `{values}` today; later tasks
 * widen it as collections and forms land.
 */

import { resolvePointer } from "@sigrun/shared/blocks";
import type { Action, Binding, JsonObject, JsonValue, Tone } from "@sigrun/shared/blocks";
import type { TuiTheme } from "../theme.js";

/** The channel-owned view state a render reads (spec §6.2). */
export interface ViewState {
	/** Values written by view-only actions (live forms bound `/view/`). */
	values: JsonObject;
}

/** The render context {@link renderBlock} threads to every component. */
export interface BlockCtx {
	/** The surface's confirmed data model (bindings resolve against it). */
	data: JsonObject;
	/** The current item, inside a collection's card template (`./` pointers). */
	item?: JsonValue;
	theme: TuiTheme;
	locale: string;
	/**
	 * Time zone for `Intl` time formats (chart axes, log timestamps);
	 * absent means the runtime's local zone. Tests pass `UTC` for
	 * byte-stable output (`formatValue`'s fourth argument).
	 */
	timeZone?: string;
	access: "read" | "write";
	/**
	 * Whether the terminal renders Unicode glyphs (spec §10.2): false
	 * selects the ASCII fallbacks — `icons.ts` glyphs and `tones.ts`
	 * markers — so an ASCII terminal never shows mojibake.
	 */
	unicode: boolean;
	/** Route an action to the surface (view-only ones never reach this). */
	dispatch(action: Action, payload: JsonValue): void;
	view: ViewState;
	/** The terminal copy writes to (OSC 52); defaults to process.stdout. */
	terminal?: { write(data: string): void };
}

/** Is `value` a binding (spec §4.2: `{ $: pointer }`)? */
export function isBinding(value: unknown): value is Binding {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Binding).$ === "string"
	);
}

/** The tone names (the `bindTone` guard's set). */
const TONES: ReadonlySet<string> = new Set([
	"neutral",
	"accent",
	"good",
	"warn",
	"bad",
	"info",
]);

/** Resolve a bindable of any shape to its raw JSON value (untyped). */
export function bindRaw(value: unknown, ctx: BlockCtx): JsonValue | undefined {
	if (!isBinding(value)) return value as JsonValue | undefined;
	return resolvePointer(ctx.data, value.$, ctx.item);
}

/** Resolve a bindable to text: empty string for missing or non-string values. */
export function bindText(value: unknown, ctx: BlockCtx): string {
	const resolved = bindRaw(value, ctx);
	return typeof resolved === "string" ? resolved : "";
}

/** Resolve a bindable tone: `neutral` when absent or not a tone name. */
export function bindTone(value: unknown, ctx: BlockCtx): Tone {
	const resolved = bindRaw(value, ctx);
	return TONES.has(typeof resolved === "string" ? resolved : "")
		? (resolved as Tone)
		: "neutral";
}

/** True when a block's `visibleAt` hides it at the rendered width class. */
export function hiddenAtCompact(
	block: { readonly visibleAt?: string },
	width: number,
): boolean {
	return block.visibleAt === "atLeast:regular" && width < 80;
}
