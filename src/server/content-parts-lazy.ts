/** Resolve parts against a lazily-available env: text parts never touch it. */

import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	resolveParts,
	type ResolveOptions,
	type ResolvedInput,
	type SubmissionPart,
} from "./content-parts.js";

/**
 * The lazy-env resolve: text parts (the whole answer-projection case)
 * resolve without the env; the first file/image part awaits it. A sandbox
 * host that cannot build the env therefore still admits answers.
 */
export async function resolvePartsLazy(
	parts: readonly SubmissionPart[],
	envPromise: Promise<ExecutionEnv>,
	context: Context,
	options: ResolveOptions,
): Promise<ResolvedInput> {
	if (parts.every((part) => part.type === "text")) {
		return { content: parts.map((part) => ({ ...part })), attachments: [] };
	}
	return resolveParts(parts, await envPromise, context, options);
}
