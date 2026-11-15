/**
 * `sigrun.lean-retry` — the crash guard that makes the NEXT attempt of a
 * conversation's request skip extension `pi.generation` request hooks.
 *
 * WHY THIS EXISTS. When the host dies while a model request is being
 * PREPARED (typically inside an extension `beforeRequest` /
 * `beforeProviderRequest` handler), pi-durable counts the death as a
 * failed attempt, resumes the generation on the next boot, and re-runs
 * the SAME hooks on every attempt — so ONE bad request can kill the
 * server `settings.retry` times in a row. A crashed preparation is not
 * PROOF that a hook caused it (attribution-free ruling), so the retry
 * runs without any extension request hooks at all: only additions are
 * dropped, the request body the extension never edited is sent as-is.
 *
 * THE MECHANISM. The first wrapped request hook of an attempt writes a
 * small JSON marker file `<dir>/<conversationId>.json` =
 * `{conversationId, taskId, at}` BEFORE calling the extension. The core
 * `sigrun.lean-retry` extension's `afterResponse` removes it
 * synchronously — that is the ONLY clear (a provider message reached
 * classification, so the request phase is over; clearing on `runSettled`
 * would race the NEXT run's record because that delivery is
 * asynchronous). At boot, before `harness.resume()`, `recover(inspection)`
 * reads every marker; a marker whose conversation has an unfinished
 * `pi.generation` task keeps it and marks the conversation LEAN (every
 * later attempt in that conversation skips extension request hooks
 * until a provider response arrives). A marker with no live generation
 * task means the host died during preparation of a run that already
 * ended some other way — deleted, no lean attempt, no notice.
 *
 * Core-owned extensions (installed by boot, not by the loader) are NOT
 * wrapped by design: the marker wrap lives in the loader's install path.
 */

import {
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	defineExtension,
	GenerationTask,
	hook,
	type ConversationId,
	type Extension,
	type HarnessInspection,
	type HookApi,
	type TaskId,
} from "@earendil-works/pi-durable";

/** The lean-retry extension's registered name. */
export const LEAN_RETRY_EXTENSION = "sigrun.lean-retry";

/** One marker file's JSON shape. */
interface InflightRecord {
	readonly conversationId: ConversationId;
	readonly taskId: TaskId;
	readonly at: number;
}

/**
 * The lean-retry surface: wrap loaded extensions, expose the core
 * extension, and recover at boot.
 */
export interface LeanRetry {
	readonly extension: Extension;
	wrapExtension(extension: Extension): Extension;
	recover(inspection: HarnessInspection): readonly ConversationId[];
	isLean(conversationId: ConversationId): boolean;
}

/**
 * Build the lean-retry pair (core extension + loader wrap).
 *
 * `dir` is `<stateDir>/core/inflight-requests`, created at boot before
 * `loadExtensions` or `Harness.open` can touch a record. The constructor
 * itself never creates it — boot owns the mkdir.
 */
export function createLeanRetry(options: { readonly dir: string }): LeanRetry {
	const dir = options.dir;
	const leanConversations = new Set<ConversationId>();

	function recordPath(conversationId: ConversationId): string {
		return join(dir, `${conversationId}.json`);
	}

	function writeRecord(conversationId: ConversationId, taskId: TaskId): void {
		const record: InflightRecord = { conversationId, taskId, at: Date.now() };
		writeFileSync(recordPath(conversationId), JSON.stringify(record), "utf8");
	}

	function clearRecord(conversationId: ConversationId): void {
		rmSync(recordPath(conversationId), { force: true });
		leanConversations.delete(conversationId);
	}

	function shouldSkip(conversationId: ConversationId): boolean {
		return leanConversations.has(conversationId);
	}

	function ensureRecord(conversationId: ConversationId, taskId: TaskId): void {
		const path = recordPath(conversationId);
		if (existsSync(path)) {
			try {
				const existing = JSON.parse(readFileSync(path, "utf8")) as InflightRecord;
				if (existing.taskId === taskId) return;
			} catch {
				// Corrupt marker: overwrite it below. A marker that cannot be
				// read has no durable evidence of a taskId match, so a rewrite
				// is the conservative recovery (and the next afterResponse
				// still clears it).
			}
		}
		writeRecord(conversationId, taskId);
	}

	const coreExtension = defineExtension({
		name: LEAN_RETRY_EXTENSION,
		hooks: [
			hook(GenerationTask, {
				afterResponse(_message, api: HookApi): void {
					// Synchronous clear: the record's lifetime ends the moment a
					// provider message reaches classification. This is the ONLY
					// clear — a `runSettled` observer runs asynchronously and
					// could clear the NEXT run's freshly-written record.
					clearRecord(api.conversationId);
				},
			}),
		],
	});

	return {
		extension: coreExtension,
		isLean(conversationId: ConversationId): boolean {
			return leanConversations.has(conversationId);
		},
		wrapExtension(extension: Extension): Extension {
			// No extension hooks, or none on pi.generation: identity wrap.
			if (extension.hooks === undefined) return extension;
			const registrations = extension.hooks;
			const generationKind = GenerationTask.definition.name;
			const generation = registrations.find((r) => r.task === generationKind);
			if (generation === undefined) return extension;

			const handlers = generation.handlers as Record<string, unknown>;
			type Handler = (
				request: unknown,
				api: HookApi,
				context: unknown,
			) => unknown;
			const originalBeforeRequest = handlers.beforeRequest as Handler | undefined;
			const originalBeforeProviderRequest = handlers.beforeProviderRequest as
				| Handler
				| undefined;

			if (
				originalBeforeRequest === undefined &&
				originalBeforeProviderRequest === undefined
			) {
				return extension;
			}

			// Wrap ONLY these two handlers; everything else passes through
			// by identity (the `onYield`, `afterResponse`, etc. keys on the
			// wrapped handlers object are the SAME references).
			const wrappedHandlers: Record<string, unknown> = { ...handlers };

			if (originalBeforeRequest !== undefined) {
				const beforeRequest: Handler = function wrappedBeforeRequest(
					request,
					api,
					context,
				) {
					if (shouldSkip(api.conversationId)) return undefined;
					ensureRecord(api.conversationId, api.taskId);
					return originalBeforeRequest(request, api, context);
				};
				wrappedHandlers.beforeRequest = beforeRequest;
			}
			if (originalBeforeProviderRequest !== undefined) {
				const beforeProviderRequest: Handler = function wrappedBeforeProviderRequest(
					request,
					api,
					context,
				) {
					if (shouldSkip(api.conversationId)) return undefined;
					ensureRecord(api.conversationId, api.taskId);
					return originalBeforeProviderRequest(request, api, context);
				};
				wrappedHandlers.beforeProviderRequest = beforeProviderRequest;
			}

			return {
				...extension,
				hooks: registrations.map((registration) =>
					registration === generation
						? { ...registration, handlers: wrappedHandlers }
						: registration,
				),
			};
		},
		recover(inspection: HarnessInspection): readonly ConversationId[] {
			if (!existsSync(dir)) return [];
			const liveGenerationConversations = new Set<ConversationId>();
			const generationKind = GenerationTask.definition.name;
			for (const task of inspection.tasks) {
				if (
					task.record.kind === generationKind &&
					task.state.kind !== "blocked"
				) {
					liveGenerationConversations.add(task.record.conversationId);
				}
			}
			const recovered: ConversationId[] = [];
			const names = readdirSync(dir).filter((name) => name.endsWith(".json"));
			for (const name of names) {
				const conversationId = Number(
					name.slice(0, -".json".length),
				) as ConversationId;
				const path = join(dir, name);
				let keep = false;
				try {
					const record = JSON.parse(readFileSync(path, "utf8")) as InflightRecord;
					keep = liveGenerationConversations.has(record.conversationId);
				} catch {
					// Unreadable marker: conservative delete (no evidence of live
					// work, so no lean attempt — matching the no-live-task case).
					keep = false;
				}
				if (keep) {
					recovered.push(conversationId);
				} else {
					rmSync(path, { force: true });
				}
			}
			// Replace the lean set with exactly the recovered conversations
			// (recover is boot-only, but a double-call returns the same ids —
			// per-conversation state keeps every later attempt skipping).
			leanConversations.clear();
			for (const conversationId of recovered) leanConversations.add(conversationId);
			return recovered;
		},
	};
}
