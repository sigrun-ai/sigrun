/**
 * `host.models.complete` (warden Task 4): one-shot completions for
 * extensions — NO conversation, the auto-namer's `completeTitle` shape
 * generalized into a host surface (skill-card generation is the first
 * consumer).
 *
 * Model resolution (binding): an explicit `input.model` wins; else the
 * live settings' `namingModel` when it is a string (`false` counts as
 * unset); else the boot default model. The chosen ref must be SERVED —
 * an unserved model throws `UnservedModelError` naming it, never a
 * silent fallback.
 *
 * Failure posture: throws on an unserved model, a timeout (default
 * {@link DEFAULT_COMPLETE_TIMEOUT_MS} ms), or a `stopReason` of
 * `error`/`aborted` — never resolves silently. The `Promise.race`, not
 * the abort signal alone, bounds the wait: a provider that ignores the
 * abort is abandoned without wedging the chain (the race keeps its
 * late rejection handled). `input.signal` aborts the completion from
 * the caller side; the completion's own abort fires on timeout.
 */

import type {
	Api,
	AssistantMessage,
	Model,
	Models,
} from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { parseModelSpec } from "../config.js";
import { requireServedModel } from "./providers/index.js";
import type { SettingsFile } from "./settings.js";

/** Default bound on one one-shot completion. */
export const DEFAULT_COMPLETE_TIMEOUT_MS = 60_000;

/** The one-shot completion input (the contract's shape, spelled out). */
export interface CompleteInput {
	/** Explicit `provider/model-id` (or a bare model id); wins over the role. */
	readonly model?: string;
	/** The only role today: the utility completion (settings `namingModel`). */
	readonly role?: "utility";
	/** Optional system prompt prepended to the request. */
	readonly systemPrompt?: string;
	/** The user-turn text of the one-shot request. */
	readonly prompt: string;
	/** Bound on the whole call; default {@link DEFAULT_COMPLETE_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
	/** Caller-side abort (linked with the internal timeout abort). */
	readonly signal?: AbortSignal;
}

/** The dependencies `completeOnce` needs. */
export interface CompleteDeps {
	/** The merged catalog the completion dispatches through. */
	readonly models: Models;
	/** Boot default model (the last resolution fallback). */
	readonly defaultModel: ModelRef;
	/** Live settings read per call (a change applies without a restart). */
	readonly readSettings: () => SettingsFile;
}

/**
 * Run ONE one-shot completion against the resolved model and return its
 * concatenated text parts (non-text parts skipped) plus the
 * `provider/id` of the model actually used.
 *
 * @throws `UnservedModelError` naming the ref when no contributor serves
 *   it; an `Error` naming the timeout when the call overruns
 *   `timeoutMs`; an `Error` carrying the message's `errorMessage` (or
 *   the stop reason) when the completion stops with `error`/`aborted`.
 */
export async function completeOnce(
	deps: CompleteDeps,
	input: CompleteInput,
): Promise<{ text: string; model: string }> {
	const settings = deps.readSettings();
	const ref: ModelRef =
		input.model !== undefined
			? parseModelSpec(input.model, "model")
			: typeof settings.namingModel === "string"
				? parseModelSpec(settings.namingModel, "namingModel")
				: deps.defaultModel;
	const model: Model<Api> = requireServedModel(deps.models, ref);
	const key = `${ref.provider}/${ref.modelId}`;
	const timeoutMs = input.timeoutMs ?? DEFAULT_COMPLETE_TIMEOUT_MS;
	const controller = new AbortController();
	// A caller-side abort aborts the completion too (either source wins).
	const unlinkCaller =
		input.signal === undefined
			? undefined
			: linkAbort(input.signal, controller);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error(`the completion timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref?.();
	});
	let message: AssistantMessage;
	try {
		message = await Promise.race([
			deps.models.completeSimple(
				model,
				{
					...(input.systemPrompt === undefined
						? {}
						: { systemPrompt: input.systemPrompt }),
					messages: [
						{ role: "user", content: input.prompt, timestamp: Date.now() },
					],
				},
				{ signal: controller.signal },
			),
			timedOut,
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		unlinkCaller?.();
	}
	// An errored or aborted completion is a failure, not a result (the
	// message may still carry text content alongside the error).
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		throw new Error(
			`completion on ${key} stopped with ${message.stopReason}` +
				(message.errorMessage === undefined
					? ""
					: `: ${message.errorMessage}`),
		);
	}
	return { text: textOf(message.content), model: key };
}

/** The text blocks of an assistant message, concatenated. */
function textOf(content: AssistantMessage["content"]): string {
	return content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** Abort `target` when `source` aborts; returns the unlink. */
function linkAbort(
	source: AbortSignal,
	target: AbortController,
): () => void {
	if (source.aborted) {
		target.abort();
		return () => {};
	}
	const onAbort = () => target.abort();
	source.addEventListener("abort", onAbort, { once: true });
	return () => source.removeEventListener("abort", onAbort);
}
