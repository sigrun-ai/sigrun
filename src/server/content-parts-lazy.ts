/** Resolve parts against a lazily-available env: text parts never touch it. */

import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	resolveParts,
	type InlinePart,
	type SubmissionPart,
} from "./content-parts.js";

/**
 * The lazy-env resolve: text parts (the whole answer-projection case)
 * resolve without the env; the first file/image part awaits it. A sandbox
 * host that cannot build the env therefore still admits answers.
 *
 * `maxInlineFileBytes` is the defensive-inputs cap on a `file` part's
 * inlined body (see `cappedFilePartText`); text-only arrays never consult
 * it.
 */
export async function resolvePartsLazy(
	parts: readonly SubmissionPart[],
	envPromise: Promise<ExecutionEnv>,
	context: Context,
	maxInlineFileBytes: number,
): Promise<InlinePart[]> {
	if (parts.every((part) => part.type === "text")) {
		return resolveParts(parts, {} as ExecutionEnv, context, maxInlineFileBytes);
	}
	return resolveParts(parts, await envPromise, context, maxInlineFileBytes);
}
