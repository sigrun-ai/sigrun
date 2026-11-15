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
	renameSync,
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

/**
 * Resolve the lean-retry name for an exact (array) selection.
 *
 * WHY THIS EXISTS. The lean-retry clear runs only where the core
 * extension is SELECTED. Host-default selections get the name appended
 * by boot's `settings.extensions` getter, but a conversation whose
 * stored `pi.agent.extensions` is an EXACT array is resolved verbatim
 * by pi-durable (`selectExtensions`, dist/harness/agent.js) — no host
 * getter call — so without this helper an exact-array conversation
 * would never clear its marker and the lean state would be unbounded.
 *
 * The tool-result cap deliberately keeps its exact-array opt-out seam;
 * the lean-retry crash guard has NO such opt-out — it is force-appended
 * to every exact selection the server's resolution paths produce
 * (create op, configure op, fork inheritance, curation's internal-run
 * rebuild). Callers must use THIS helper rather than re-implementing
 * the append, so the invariant stays single-sourced.
 */
export function appendNameIfAbsent(
	names: readonly string[],
	name: string,
): readonly string[] {
	return names.includes(name) ? names : [...names, name];
}

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
		// Atomic write (tmp + rename): a host crash mid-`writeFileSync`
		// would otherwise leave a torn JSON file at the FINAL path that
		// `recover` would misread as absence-of-evidence. A tmp write +
		// atomic rename means a crash leaves either the OLD record
		// complete or ABSENT — never a half-written marker.
		const path = recordPath(conversationId);
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(record), "utf8");
		renameSync(tmp, path);
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

	/** Best-effort record write: a marker miss must not eat the request. */
	function tryEnsureRecord(conversationId: ConversationId, taskId: TaskId): void {
		try {
			ensureRecord(conversationId, taskId);
		} catch (error) {
			// Fail open (review minor 7): the crash guard is best-effort; a
			// disk error must not skip the extension's request hook. Boot's
			// `mkdirSync(dir, { recursive: true })` makes this unlikely (the
			// dir exists before any wrap can fire) — this guard catches
			// genuine filesystem errors (quota, readonly remount, …).
			console.warn(
				`lean retry: marker write failed for conversation ${conversationId}: ${String(error)} — the next attempt does NOT learn the crash guard`,
			);
		}
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
			// No hook registrations: identity wrap.
			if (extension.hooks === undefined) return extension;
			const registrations = extension.hooks;
			const generationKind = GenerationTask.definition.name;
			let changed = false;
			const nextRegistrations = registrations.map((registration) => {
				if (registration.task !== generationKind) return registration;
				const handlers = registration.handlers as Record<string, unknown>;
				type Handler = (
					this: unknown,
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
					return registration;
				}
				changed = true;
				// Wrap ONLY these two handlers; everything else passes through
				// by identity (the `onYield`, `afterResponse`, etc. keys on the
				// wrapped handlers object are the SAME references). EARLY
				// registrations on the same task are permitted (the loader
				// installs one `defineExtension` per package, whose hooks array
				// may register the same task more than once) — EVERY
				// pi.generation registration gets the wrap (review minor 5),
				// not only the first.
				const wrappedHandlers: Record<string, unknown> = { ...handlers };
				if (originalBeforeRequest !== undefined) {
					const wrappedBeforeRequest: Handler = function (
						this: unknown,
						request,
						api,
						context,
					) {
						if (shouldSkip(api.conversationId)) return undefined;
						tryEnsureRecord(api.conversationId, api.taskId);
						// Pi-durable binds the receiver when invoking an
						// extension handler. Forward the same receiver rather
						// than replacing it with the captured handlers bag.
						return originalBeforeRequest.call(this, request, api, context);
					};
					wrappedHandlers.beforeRequest = wrappedBeforeRequest;
				}
				if (originalBeforeProviderRequest !== undefined) {
					const wrappedBeforeProviderRequest: Handler = function (
						this: unknown,
						request,
						api,
						context,
					) {
						if (shouldSkip(api.conversationId)) return undefined;
						tryEnsureRecord(api.conversationId, api.taskId);
						return originalBeforeProviderRequest.call(this, request, api, context);
					};
					wrappedHandlers.beforeProviderRequest = wrappedBeforeProviderRequest;
				}
				return { ...registration, handlers: wrappedHandlers };
			});
			if (!changed) return extension;
			return {
				...extension,
				hooks: nextRegistrations,
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
				const path = join(dir, name);
				let record: InflightRecord | undefined;
				let keep = false;
				try {
					record = JSON.parse(readFileSync(path, "utf8")) as InflightRecord;
				} catch {
					// Torn or unreadable marker (review minor 3: a pre-atomic-
					// era crash could leave half-written JSON at the final
					// path): no parseable evidence of live work → conservative
					// delete, no lean attempt. Match the no-live-task posture.
					record = undefined;
				}
				// Key by the record's CONTENT (review minor 6), not the
				// filename: a stray non-numeric filename must not decode as
				// NaN into the lean set; a mismatched name-for-content file
				// still recovers the right conversation. A record whose
				// conversationId is not a finite number is not usable either.
				if (
					record !== undefined &&
					typeof record.conversationId === "number" &&
					Number.isFinite(record.conversationId) &&
					liveGenerationConversations.has(record.conversationId)
				) {
					keep = true;
				}
				if (keep && record !== undefined) {
					recovered.push(record.conversationId);
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
