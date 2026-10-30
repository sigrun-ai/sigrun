/**
 * Normalize the extension contract's structural invocation context to the
 * full chord Context required by pi-durable 1.4.0.
 *
 * Extensions deliberately depend only on HandlerContext (`abortSignal`), so
 * they may pass a plain object. Durable publishes read telemetry and other
 * context values, however; forwarding that literal would make the first
 * entry/submission write fail at the host boundary. Deriving from
 * BACKGROUND_CONTEXT supplies the runtime defaults while preserving caller
 * cancellation. A real Context passes through BY IDENTITY so its telemetry
 * parent and application values are never discarded.
 */

import {
	BACKGROUND_CONTEXT,
	withAbortSignal,
	type Context,
} from "@earendil-works/chord/context";
import type { HandlerContext } from "../extension.js";

/** Upgrade a structural handler context, or retain an existing chord context. */
export function toDurableContext(context: HandlerContext | Context): Context {
	const candidate = context as Partial<Context>;
	if (
		typeof candidate.telemetry === "object" &&
		candidate.telemetry !== null &&
		typeof candidate.value === "function"
	) {
		return context as Context;
	}
	return context.abortSignal === undefined
		? BACKGROUND_CONTEXT
		: withAbortSignal(context.abortSignal, BACKGROUND_CONTEXT);
}
