/**
 * The event bus (memory-seam Tasks 2 + 4): commit observation + bounded
 * side lane + idle detection + shutdown sequencing. See
 * docs/superpowers/specs/2026-10-15-sigrun-memory-seam.md §"Design".
 *
 * The bus subscribes to pi-durable's `Session.subscribeCommits` (sigrun's
 * harness IS a Session) and reduces each `CommitPublication` into the
 * memory seam's host events — settled-run groups and conversation
 * lifecycle — without touching run logic. The upstream listener contract
 * ("must not block or call Session APIs", types.d.ts) shapes everything
 * here: the listener only FILTERS AND ENQUEUES; all handler work happens
 * on the single drain loop (`drain()`), where every handler call is
 * deadline-bounded (`Promise.race` against `hookDeadlineMs`), rejections
 * are caught + logged, and overflow drops the OLDEST queued event.
 *
 * Detection rules (verified against pi-durable 1.2.0's publication shapes
 * — table changes are the raw `StorageWrite` records; document changes are
 * `DocumentCommitChange`s whose `record.createdAt === publication.seq`
 * marks creation, `value === null` marks retirement):
 *
 * - **Settle**: a `submission` table write with `value.type === "input"`
 *   and a terminal status (`done`/`unanswered`). Write-type submissions
 *   never run and never settle-emit. Input submissions settle exactly once
 *   per run — the retry path keeps the task running (only exhaustion or a
 *   final answer settles) — and all of a run's inputs settle in ONE commit
 *   (`endRun`), so one publication coalesces per conversation into one
 *   `SettleGroup` sorted by submission id (ids ascend in admission order).
 * - **Created/Forked**: a `conversation` table write. Every creation fires
 *   `conversationCreated` — a fork child is a new conversation too — and a
 *   record carrying `parent` additionally fires `conversationForked` with
 *   the fork point taken from the record.
 * - **Archived**: `document` changes on the session-meta doc. Creation
 *   seeds a per-conversation flip baseline WITHOUT firing; ordinary
 *   changes fire only on boolean flips of `archived`. A fork's
 *   `document.copy` seeds the child's baseline from the fork parent's
 *   (`fork: "current"` — the child starts from the parent's current
 *   state), so inherited archive NEVER fires (the spec delivers that edge
 *   via `conversationForked`). A doc change with no baseline (the doc
 *   predates this process) compares against the materialization default
 *   `false` — archive detection stays commit-driven, nothing to re-arm.
 *
 * Idle detection (Task 4, spec §2's corrected ruling): idle = NO input
 * admission AND no live run. The listener records admissions (`submission`
 * writes with `type === "input"` + `status === "placed"` — a placement
 * both stamps the admission clock and marks the run live; write-type
 * submissions never touch either) and run ends (the settle statuses
 * decrement the live-run count). A host-owned sweep interval (`idleSweepMs`,
 * default 1s) then fires `conversationIdle` for every conversation whose
 * last admission is at least `idleThresholdMs` old, has no live run, and
 * has not already fired for its current quiet period (one fire per quiet
 * period; a later admission re-arms). The sweep NEVER fires mid-run — the
 * live-run gate holds even far past the threshold (review focus 6).
 * Never-run conversations (created, never admitted — no durable anchor)
 * stay non-idle; documented and accepted in the spec. All idle state is
 * in-process: a restart forgets prior quiet periods (missed idle events
 * are acceptable per the spec's at-least-once posture).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	UserEntry,
	type CommitPublication,
	type ConversationDocToken,
	type ConversationId,
	type Cursor,
	type EntryId,
	type EntryQuery,
	type EntryRecord,
	type Harness,
	type JsonObject,
	type Page,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import { SessionMetaDoc } from "../server/session-meta.js";

/** One settled run: every input submission one run settled, in admission (id) order. */
export type SettleGroup = {
	readonly conversationId: ConversationId;
	readonly settled: readonly {
		readonly id: SubmissionId;
		readonly status: "done" | "unanswered";
		readonly entryId: EntryId | undefined;
		readonly answerEntryId: EntryId | undefined;
		readonly reason: string | undefined;
	}[];
};

/**
 * The extension-facing payloads of the lifecycle events (Task 4): the
 * handler NAME discriminates (like pi-durable hooks), so the payloads
 * carry no `type` field — one source of truth for the internal events
 * (which add `type`), the dispatch fan-out, and the loader's contract.
 */
export type ExtensionLifecyclePayload = {
	conversationCreated: { readonly conversationId: ConversationId };
	conversationForked: {
		readonly childId: ConversationId;
		readonly parentId: ConversationId;
		readonly at: EntryId;
	};
	conversationArchived: {
		readonly conversationId: ConversationId;
		readonly archived: boolean;
	};
	conversationIdle: {
		readonly conversationId: ConversationId;
		readonly idleMs: number;
	};
};

/** Conversation lifecycle reduced from commit publications (+ the timer-driven idle event). */
export type LifecycleEvent = {
	readonly [K in keyof ExtensionLifecyclePayload]: {
		readonly type: K;
	} & ExtensionLifecyclePayload[K];
}[keyof ExtensionLifecyclePayload];

/**
 * The extension-facing settled-run event (memory-seam Task 3): one per
 * settled run, with the run's input texts host-resolved from the durable
 * transcript. `inputTexts` is position-paired with `inputs` — an input
 * whose entry is unresolvable (withdrawn while queued, withdrawn entry,
 * read failure) contributes `""` at its position, never a reorder.
 */
export type RunSettledEvent = {
	readonly conversationId: ConversationId;
	readonly inputs: readonly SubmissionId[];
	/** Text blocks of each input's `pi.user` entry, concatenated; unresolvable/withdrawn → "" at that position. */
	readonly inputTexts: readonly string[];
	readonly outcome:
		| {
				readonly status: "answered";
				readonly answerEntryId: EntryId;
				readonly answer: AssistantMessage;
		  }
		| { readonly status: "unanswered"; readonly reason: string };
};

/**
 * The narrowed read surface a `runSettled` handler receives: exactly
 * `entry` / `entries` / `document` over the settled conversation — no
 * `taskId`, no `memo`, no `conversationId` (the event carries those).
 * Structural rather than a `Pick`: pi-durable 1.2.0's `DocumentReader` is
 * itself `Pick<Session, "snapshot" | "snapshotAsOf">`, so the brief's
 * member set is expressed directly. `entries` mirrors `Conversation.entries`
 * (the conversation is implicit); `document` is the committed conversation
 * doc read (`Session.snapshot` semantics).
 */
export type MemoryEventApi = {
	/** One visible entry of the settled conversation by exact id (`undefined` when absent). */
	entry(id: EntryId, context: Context): Promise<EntryRecord | undefined>;
	/** Fork-aware entry history of the settled conversation. */
	entries(
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;
	/** Committed conversation-document read. */
	document<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
};

/** A loaded extension's `runSettled` handler, as the loader validated it. */
export type ExtensionRunSettledHandler = (
	event: RunSettledEvent,
	api: MemoryEventApi,
	context: Context,
) => void | Promise<void>;

/** A loaded extension's lifecycle handler for one event, as the loader validated it. */
export type ExtensionLifecycleHandler<K extends keyof ExtensionLifecyclePayload> = (
	event: ExtensionLifecyclePayload[K],
	api: MemoryEventApi,
	context: Context,
) => void | Promise<void>;

/** A loaded extension's `harnessShutdown` handler (no event payload — shutdown is conversation-less). */
export type ExtensionHarnessShutdownHandler = (
	api: MemoryEventApi,
	context: Context,
) => void | Promise<void>;

/**
 * Everything one loaded extension may register on the bus (the loader's
 * validated factory-result fields, registered by boot under the
 * extension's final resolved name).
 */
export interface ExtensionEventHandlers {
	readonly runSettled?: ExtensionRunSettledHandler;
	readonly conversationCreated?: ExtensionLifecycleHandler<"conversationCreated">;
	readonly conversationForked?: ExtensionLifecycleHandler<"conversationForked">;
	readonly conversationArchived?: ExtensionLifecycleHandler<"conversationArchived">;
	readonly conversationIdle?: ExtensionLifecycleHandler<"conversationIdle">;
	readonly harnessShutdown?: ExtensionHarnessShutdownHandler;
}

/** Internal queue item: which handler list an event dispatches through. */
type BusEvent =
	| { readonly kind: "settled"; readonly event: SettleGroup }
	| { readonly kind: "lifecycle"; readonly event: LifecycleEvent };

/** Options of `EventBus.open` (Task 6 lifts the idle pair into `SIGRUN_*` config). */
export interface EventBusOptions {
	/** Bounds the queue (Task 6: `SIGRUN_QUEUE_MAX`). */
	readonly queueMax: number;
	/** Bounds each handler call (Task 6: `SIGRUN_HOOK_DEADLINE`). */
	readonly hookDeadlineMs: number;
	/**
	 * The idle threshold (Task 6: `SIGRUN_IDLE_THRESHOLD`); omitted = no
	 * idle detection (the Task 2 substrate shape — tests that never sweep).
	 */
	readonly idleThresholdMs?: number;
	/** The idle sweep cadence (spec §2: one host-owned 1s interval). */
	readonly idleSweepMs?: number;
}

/**
 * The commit-observation side lane. One instance per harness; open after
 * boot, close before the harness closes (`shutdownSequence` for the
 * ordered path, `close` otherwise — boot also wires `subscribeClose` to
 * `close` so a failed-session teardown cannot leak the sweep timer).
 */
export class EventBus {
	/** Subscribe `harness`'s commit stream + start the idle sweep when idle options are given. */
	public static open(harness: Harness, options: EventBusOptions): EventBus {
		return new EventBus(harness, options);
	}

	#unsubscribe: () => void;
	#harness: Harness;
	#queueMax: number;
	#hookDeadlineMs: number;
	#idleThresholdMs: number | undefined;
	#queue: BusEvent[] = [];
	#settleHandlers: ((event: SettleGroup) => void | Promise<void>)[] = [];
	#lifecycleHandlers: ((event: LifecycleEvent) => void | Promise<void>)[] = [];
	/** Extension name → its handlers (the loader-validated factory-result fields). */
	#extensions = new Map<string, ExtensionEventHandlers>();
	/** Per-conversation `archived` flip baseline (the last value a change was measured against). */
	#archivedBasis = new Map<ConversationId, boolean>();
	/** Per-conversation wall clock of the last input admission (the idle clock's anchor). */
	#lastAdmission = new Map<ConversationId, number>();
	/** Per-conversation count of placed-but-unsettled inputs (live runs). */
	#liveInputs = new Map<ConversationId, number>();
	/** Per-conversation time of the last idle fire (one fire per quiet period). */
	#idleFiredAt = new Map<ConversationId, number>();
	/** The host-owned idle sweep, when idle detection is on. */
	#sweep: ReturnType<typeof setInterval> | undefined;
	/** The single drain loop, when one is running. */
	#loop: Promise<void> | undefined;
	#closed = false;

	private constructor(harness: Harness, options: EventBusOptions) {
		this.#harness = harness;
		this.#queueMax = options.queueMax;
		this.#hookDeadlineMs = options.hookDeadlineMs;
		this.#idleThresholdMs = options.idleThresholdMs;
		this.#unsubscribe = harness.subscribeCommits((publication) => {
			this.observe(publication);
		});
		// The idle sweep is host-owned machinery (never an extension factory
		// concern — the twill lesson) and binds to THIS bus's lifetime: close
		// and shutdownSequence both clear it. Unref'd so a booted-but-idle
		// process never hangs on it.
		if (
			this.#idleThresholdMs !== undefined &&
			options.idleSweepMs !== undefined &&
			options.idleSweepMs > 0
		) {
			this.#sweep = setInterval(() => {
				if (this.sweepIdle() > 0) {
					void this.drain(this.#hookDeadlineMs, BACKGROUND_CONTEXT);
				}
			}, options.idleSweepMs);
			this.#sweep.unref?.();
		}
	}

	/** Register a settled-run handler (install order = run order); returns its unsubscribe. */
	public onSettled(
		handler: (event: SettleGroup) => void | Promise<void>,
	): () => void {
		this.#settleHandlers.push(handler);
		return () => {
			const index = this.#settleHandlers.indexOf(handler);
			if (index >= 0) this.#settleHandlers.splice(index, 1);
		};
	}

	/** Register a lifecycle handler (install order = run order); returns its unsubscribe. */
	public onLifecycle(
		handler: (event: LifecycleEvent) => void | Promise<void>,
	): () => void {
		this.#lifecycleHandlers.push(handler);
		return () => {
			const index = this.#lifecycleHandlers.indexOf(handler);
			if (index >= 0) this.#lifecycleHandlers.splice(index, 1);
		};
	}

	/**
	 * Register one loaded extension's handlers under its FINAL resolved
	 * name (boot calls this per loaded extension after `Harness.open`).
	 * A same-name registration replaces the previous one (the reinstall
	 * path); boot merges the loader's runSettled + lifecycle bindings into
	 * ONE object per name before registering. Returns its unsubscribe.
	 */
	public registerExtension(name: string, handlers: ExtensionEventHandlers): () => void {
		this.#extensions.set(name, handlers);
		return () => {
			if (this.#extensions.get(name) === handlers) {
				this.#extensions.delete(name);
			}
		};
	}

	/**
	 * One idle sweep (spec §2): enqueue a `conversationIdle` event for every
	 * conversation whose last input admission is at least the threshold old,
	 * that has NO live run (the gate that holds even far past the threshold —
	 * review focus 6), and that has not already fired for its current quiet
	 * period (a later admission re-arms). Never-run conversations have no
	 * admission recorded and stay non-idle. Returns how many events were
	 * enqueued (the sweep's own drain call is skipped when zero).
	 */
	public sweepIdle(now: number = Date.now()): number {
		if (this.#closed || this.#idleThresholdMs === undefined) return 0;
		let enqueued = 0;
		for (const [conversationId, admittedAt] of this.#lastAdmission) {
			if ((this.#liveInputs.get(conversationId) ?? 0) > 0) continue;
			if ((this.#idleFiredAt.get(conversationId) ?? -Infinity) >= admittedAt) {
				continue;
			}
			const idleMs = now - admittedAt;
			if (idleMs < this.#idleThresholdMs) continue;
			this.#idleFiredAt.set(conversationId, now);
			this.#enqueue({
				kind: "lifecycle",
				event: { type: "conversationIdle", conversationId, idleMs },
			});
			enqueued += 1;
		}
		return enqueued;
	}

	/**
	 * The ordered shutdown sequence (Task 4; src/index.ts runs it between
	 * `app.close()` and `harness.close()`):
	 *
	 * 1. stop the idle sweep (no new events from here on);
	 * 2. drain pending settles FIRST — a run that settled just before
	 *    shutdown delivers before the shutdown flush (the ordering
	 *    constraint; Task 5 additionally stops idle workers before this);
	 * 3. deliver `harnessShutdown` to every extension in install order,
	 *    each deadline-bounded. Handlers may commit — admission is still
	 *    open in this window (the seal is `Harness.close`, the caller's
	 *    next step), which is exactly the flush window the spec promises;
	 * 4. close the bus (idempotent; boot's `subscribeClose` wiring makes a
	 *    later `harness.close` a no-op here).
	 */
	public async shutdownSequence(context: Context): Promise<void> {
		if (this.#closed) return;
		if (this.#sweep !== undefined) {
			clearInterval(this.#sweep);
			this.#sweep = undefined;
		}
		await this.drain(this.#hookDeadlineMs, context);
		// harnessShutdown carries no conversation: the conversation-scoped
		// reads resolve empty and `document` serves any conversation.
		const api = this.#apiFor(undefined);
		for (const [name, handlers] of this.#extensions) {
			const handler = handlers.harnessShutdown;
			if (handler === undefined) continue;
			await this.#bounded(`extension ${name} harnessShutdown`, () =>
				handler(api, context),
			);
		}
		this.close();
	}

	/**
	 * Drain pending events through the handlers, each deadline-bounded.
	 * Concurrent calls share ONE loop (the single side-lane worker); each
	 * call resolves when that loop empties the queue or its own deadline
	 * fires — whichever comes first. `context` is the drain's caller
	 * context, forwarded to the extension handlers the loop dispatches;
	 * the loop keeps the context of the drain that started it.
	 */
	public drain(deadlineMs: number, context: Context): Promise<void> {
		if (this.#closed) return Promise.resolve();
		if (this.#loop === undefined) {
			// The clearing hook runs on a MICROTASK after the assignment
			// below, even when the pump empties a ready queue without ever
			// awaiting. Clearing inside the pump instead would race this
			// assignment (an empty pump completes synchronously, its finally
			// would clear `#loop` BEFORE the assignment stores the settled
			// promise) and wedge every later drain on an already-settled loop.
			const run = this.#pump(context).finally(() => {
				if (this.#loop === run) this.#loop = undefined;
			});
			this.#loop = run;
		}
		const loop = this.#loop;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, Math.max(0, deadlineMs));
		});
		return Promise.race([loop, deadline]).finally(() => {
			if (timer !== undefined) clearTimeout(timer);
		});
	}

	/** Stop everything: unsubscribe, empty the queue, stop the sweep, and let a running loop exit. */
	public close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubscribe();
		this.#queue.length = 0;
		if (this.#sweep !== undefined) {
			clearInterval(this.#sweep);
			this.#sweep = undefined;
		}
		// A running pump observes `#closed` at its next iteration and exits;
		// its in-flight handler call is abandoned at the hook deadline at
		// the latest, so pending drains always resolve.
	}

	/**
	 * The commit listener: synchronous filter + enqueue ONLY (the upstream
	 * contract). Never throws — an observation failure is logged and the
	 * publication is skipped, never reported into the Session.
	 */
	private observe(publication: CommitPublication): void {
		try {
			const lifecycle: LifecycleEvent[] = [];
			const forkParents = new Map<ConversationId, ConversationId>();
			for (const change of publication.changes) {
				if (change.type !== "conversation") continue;
				const record = change.value;
				lifecycle.push({
					type: "conversationCreated",
					conversationId: record.id,
				});
				if (record.parent !== undefined) {
					forkParents.set(record.id, record.parent.conversationId);
					lifecycle.push({
						type: "conversationForked",
						childId: record.id,
						parentId: record.parent.conversationId,
						at: record.parent.at,
					});
				}
			}
			for (const change of publication.changes) {
				if (
					change.type !== "document" &&
					change.type !== "document.copy"
				)
					continue;
				if (change.record.kind !== SessionMetaDoc.definition.kind) continue;
				const conversationId = change.conversationId;
				if (conversationId === undefined) continue;
				if (change.type === "document.copy") {
					// The fork initializes the child from the parent's current
					// state: seed the child's baseline, never fire.
					const parent = forkParents.get(conversationId);
					this.#archivedBasis.set(
						conversationId,
						parent === undefined
							? false
							: (this.#archivedBasis.get(parent) ?? false),
					);
					continue;
				}
				if (change.value === null) {
					this.#archivedBasis.delete(conversationId);
					continue;
				}
				const archived = change.value.archived === true;
				if (change.record.createdAt === publication.seq) {
					// Creation (the first patch materializes the doc): seed.
					this.#archivedBasis.set(conversationId, archived);
					continue;
				}
				const prior = this.#archivedBasis.get(conversationId) ?? false;
				if (prior !== archived) {
					this.#archivedBasis.set(conversationId, archived);
					lifecycle.push({
						type: "conversationArchived",
						conversationId,
						archived,
					});
				}
			}
			const groups = new Map<
				ConversationId,
				SettleGroup["settled"][number][]
			>();
			for (const change of publication.changes) {
				if (change.type !== "submission") continue;
				const value = change.value;
				if (value.type !== "input") continue;
				// Idle bookkeeping (Task 4): a PLACED input both stamps the
				// admission clock and marks the run live; a terminal input marks
				// the run end. Write-type submissions never touch either — a
				// passive write must not reset the idle clock (spec §2). Queued
				// inputs are not admissions (they have not placed an entry).
				if (value.status === "placed") {
					this.#lastAdmission.set(value.conversationId, Date.now());
					this.#liveInputs.set(
						value.conversationId,
						(this.#liveInputs.get(value.conversationId) ?? 0) + 1,
					);
				} else if (
					value.status === "done" ||
					value.status === "unanswered"
				) {
					// Gate on the record's ENTRY: a placed-then-settled input keeps
					// its entry (upstream `applySubmissionChange`: "an unanswered
					// input keeps its entry"), while a queued-never-placed withdrawal
					// (abortSubmission on a queued id, Conversation.abort's withdrawal
					// pass) settles with `entry === undefined` — it was never counted
					// live, and decrementing for it would zero the run's count
					// mid-run and let the sweep fire idle (Review Focus 6). The
					// settle-group emission below is NOT gated: a withdrawal still
					// emits runSettled (Task 3's position-preserving contract).
					if (value.entry !== undefined) {
						this.#liveInputs.set(
							value.conversationId,
							Math.max(
								0,
								(this.#liveInputs.get(value.conversationId) ?? 0) - 1,
							),
						);
					}
				}
				if (value.status !== "done" && value.status !== "unanswered")
					continue;
				const list = groups.get(value.conversationId) ?? [];
				list.push({
					id: value.id,
					status: value.status,
					entryId: value.entry,
					answerEntryId: value.answer,
					reason: value.reason,
				});
				groups.set(value.conversationId, list);
			}
			const ordered = [...groups.entries()]
				.map(([conversationId, settled]) => ({
					conversationId,
					settled: [...settled].sort((a, b) => a.id - b.id),
				}))
				.sort((a, b) => a.settled[0]!.id - b.settled[0]!.id);
			// Settles enqueue first: within one publication, a run's settle
			// precedes any archive flip of the same conversation.
			for (const event of ordered) this.#enqueue({ kind: "settled", event });
			for (const event of lifecycle) this.#enqueue({ kind: "lifecycle", event });
		} catch (error) {
			console.error("event-bus: commit observation failed:", error);
		}
	}

	/** Enqueue, dropping the OLDEST event (and logging) on overflow. */
	#enqueue(event: BusEvent): void {
		if (this.#queue.length >= this.#queueMax) {
			const dropped = this.#queue.shift();
			if (dropped !== undefined) {
				console.error(
					"event-bus: queue overflow (queueMax %d) — dropped the oldest %s event",
					this.#queueMax,
					dropped.kind,
				);
			}
		}
		this.#queue.push(event);
	}

	/** The single side-lane worker: pop in publication order until empty or closed. */
	async #pump(context: Context): Promise<void> {
		for (;;) {
			if (this.#closed) return;
			const next = this.#queue.shift();
			if (next === undefined) return;
			await this.#dispatch(next, context);
		}
	}

	/** Run one event's handlers sequentially in install order. */
	async #dispatch(item: BusEvent, context: Context): Promise<void> {
		if (item.kind === "settled") {
			for (const handler of this.#settleHandlers) {
				const handlerRef = handler;
				await this.#bounded("settled", () => handlerRef(item.event));
			}
			await this.#dispatchRunSettled(item.event, context);
		} else {
			for (const handler of this.#lifecycleHandlers) {
				const handlerRef = handler;
				await this.#bounded("lifecycle", () => handlerRef(item.event));
			}
			await this.#dispatchLifecycle(item.event, context);
		}
	}

	/**
	 * Fan one lifecycle event out to every registered extension's matching
	 * handler (the handler NAME discriminates — the extension-facing payload
	 * carries no `type`). The api is scoped to the event's conversation
	 * (the fork child for `conversationForked`).
	 */
	async #dispatchLifecycle(event: LifecycleEvent, context: Context): Promise<void> {
		const type = event.type;
		const registered = [...this.#extensions.entries()].filter(
			([, handlers]) => handlers[type] !== undefined,
		);
		if (registered.length === 0) return;
		const payload = this.#lifecyclePayload(event);
		const api = this.#apiFor(this.#lifecycleConversation(event));
		for (const [name, handlers] of registered) {
			const handler = handlers[type]!;
			// One localized cast: the payload union cannot be correlated to the
			// dynamically-keyed handler at the type level, but both sides come
			// from the same `ExtensionLifecyclePayload` map.
			await this.#bounded(`extension ${name} ${type}`, () =>
				(handler as (event: typeof payload, api: MemoryEventApi, ctx: Context) => void | Promise<void>)(
					payload,
					api,
					context,
				),
			);
		}
	}

	/** The extension-facing payload of one lifecycle event (the `type` discriminator stripped). */
	#lifecyclePayload(event: LifecycleEvent): ExtensionLifecyclePayload[keyof ExtensionLifecyclePayload] {
		switch (event.type) {
			case "conversationCreated":
				return { conversationId: event.conversationId };
			case "conversationForked":
				return { childId: event.childId, parentId: event.parentId, at: event.at };
			case "conversationArchived":
				return { conversationId: event.conversationId, archived: event.archived };
			case "conversationIdle":
				return { conversationId: event.conversationId, idleMs: event.idleMs };
		}
	}

	/** The conversation a lifecycle event's api scopes to (the fork child on forks). */
	#lifecycleConversation(event: LifecycleEvent): ConversationId {
		return event.type === "conversationForked" ? event.childId : event.conversationId;
	}

	/**
	 * Fan one settled group out to every registered extension's
	 * `runSettled`, as a resolved `RunSettledEvent`. The raw `SettleGroup`
	 * handlers above have already run; entry reads happen HERE, on the
	 * drain loop — never in the commit listener (the upstream contract).
	 */
	async #dispatchRunSettled(group: SettleGroup, context: Context): Promise<void> {
		const registered = [...this.#extensions.entries()].filter(
			([, handlers]) => handlers.runSettled !== undefined,
		);
		if (registered.length === 0) return;
		let event: RunSettledEvent;
		try {
			event = await this.#resolveRunSettled(group, context);
		} catch (error) {
			console.error("event-bus: runSettled resolution failed:", error);
			return;
		}
		const api = this.#apiFor(group.conversationId);
		for (const [name, handlers] of registered) {
			const runSettled = handlers.runSettled!;
			await this.#bounded(`extension ${name} runSettled`, () =>
				runSettled(event, api, context),
			);
		}
	}

	/**
	 * Resolve one group into the extension-facing event: per-input text
	 * (any failure → `""` at that position) and the run outcome. A group is
	 * one run's inputs settling in one commit, so the outcome is the run's:
	 * answered only when EVERY input answered (they share the run's final
	 * answer — the last record's), otherwise unanswered with the first
	 * unanswered record's reason. An answer entry that cannot be read
	 * (immutable once committed; defensive) downgrades to unanswered.
	 */
	async #resolveRunSettled(
		group: SettleGroup,
		context: Context,
	): Promise<RunSettledEvent> {
		const inputs: SubmissionId[] = [];
		const inputTexts: string[] = [];
		for (const one of group.settled) {
			inputs.push(one.id);
			inputTexts.push(
				one.entryId === undefined
					? ""
					: await this.#entryText(group.conversationId, one.entryId, context),
			);
		}
		const all = group.settled;
		const everyAnswered =
			all.length > 0 && all.every((one) => one.status === "done");
		if (everyAnswered) {
			const last = all[all.length - 1]!;
			const answerEntryId = last.answerEntryId!;
			const entry = await this.#readEntry(
				group.conversationId,
				answerEntryId,
				context,
			);
			const message =
				entry !== undefined && AssistantEntry.is(entry)
					? entry.model?.[0]
					: undefined;
			if (message !== undefined && message.role === "assistant") {
				return {
					conversationId: group.conversationId,
					inputs,
					inputTexts,
					outcome: { status: "answered", answerEntryId, answer: message },
				};
			}
			console.error(
				"event-bus: answer entry %s could not be resolved — outcome downgraded",
				String(answerEntryId),
			);
		}
		const firstUnanswered = all.find((one) => one.status === "unanswered");
		return {
			conversationId: group.conversationId,
			inputs,
			inputTexts,
			outcome: {
				status: "unanswered",
				reason: firstUnanswered?.reason ?? "unanswered",
			},
		};
	}

	/** One visible entry by exact id (`undefined` on absence or read failure). */
	async #readEntry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<EntryRecord | undefined> {
		try {
			const conversation = await this.#harness.conversation(
				conversationId,
				context,
			);
			if (conversation === undefined) return undefined;
			const page = await conversation.entries(
				{ minEntryId: id, maxEntryId: id },
				1,
				undefined,
				context,
			);
			return page.items[0];
		} catch (error) {
			console.error("event-bus: entry read failed:", error);
			return undefined;
		}
	}

	/** The input text of one entry: `pi.user` `model[0]`'s text blocks joined. */
	async #entryText(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<string> {
		const entry = await this.#readEntry(conversationId, id, context);
		if (entry === undefined || !UserEntry.is(entry)) return "";
		const message = entry.model?.[0];
		if (message === undefined || message.role !== "user") return "";
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
	}

	/**
	 * The narrowed read surface handed to event handlers. `conversationId`
	 * `undefined` (only `harnessShutdown`) scopes the conversation-bound
	 * reads to no conversation: `entry` resolves `undefined`, `entries`
	 * resolves empty, and `document` — which names its conversation per call
	 * — keeps serving any conversation.
	 */
	#apiFor(conversationId: ConversationId | undefined): MemoryEventApi {
		const harness = this.#harness;
		if (conversationId === undefined) {
			return {
				entry: async () => undefined,
				entries: async () => ({ items: [] }),
				document: ((
					token: ConversationDocToken<JsonObject>,
					id: ConversationId,
					context: Context,
				) => harness.snapshot(token, id, context)) as MemoryEventApi["document"],
			};
		}
		return {
			entry: (id, context) => this.#readEntry(conversationId, id, context),
			entries: (query, limit, cursor, context) =>
				this.#entriesOf(conversationId, query, limit, cursor, context),
			// The snapshot overloads are generic per call; the narrowed shape
			// carries one conversation-doc read, forwarded verbatim.
			document: ((token: ConversationDocToken<JsonObject>, id: ConversationId, context: Context) =>
				harness.snapshot(token, id, context)) as MemoryEventApi["document"],
		};
	}

	/** `Conversation.entries` over the settled conversation (read failures resolve empty). */
	async #entriesOf(
		conversationId: ConversationId,
		query: Omit<EntryQuery, "conversationId">,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		try {
			const conversation = await this.#harness.conversation(
				conversationId,
				context,
			);
			if (conversation === undefined) return { items: [] };
			return await conversation.entries(query, limit, cursor, context);
		} catch (error) {
			console.error("event-bus: entries read failed:", error);
			return { items: [] };
		}
	}

	/**
	 * One handler call: resolved by the call or the hook deadline,
	 * whichever first. An abandoned handler's eventual rejection is
	 * logged here (`failed` below runs before the no-op `finish`) — it
	 * already lost the race, and nobody else can observe it.
	 */
	#bounded(label: string, call: () => void | Promise<void>): Promise<void> {
		return new Promise<void>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = () => {
				if (settled) return;
				settled = true;
				if (timer !== undefined) clearTimeout(timer);
				resolve();
			};
			timer = setTimeout(() => {
				console.error(
					"event-bus: %s handler exceeded the %dms hook deadline — abandoned",
					label,
					this.#hookDeadlineMs,
				);
				finish();
			}, Math.max(0, this.#hookDeadlineMs));
			// A handler may throw synchronously; that is the same failure as a
			// rejected promise and must not escape into the drain loop.
			const failed = (error: unknown) => {
				console.error("event-bus: %s handler failed:", label, error);
				finish();
			};
			let result: void | Promise<void>;
			try {
				result = call();
			} catch (error) {
				failed(error);
				return;
			}
			Promise.resolve(result).then(finish, failed);
		});
	}
}
