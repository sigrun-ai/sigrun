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
 * are acceptable per the spec's at-least-once posture). Archive prunes a
 * conversation's idle state (archive is stronger idle, with its own
 * event); an un-archived conversation re-enters the idle clock only at
 * its next admission (conservative — misses idles, never invents them).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { WorkerStatus } from "@sigrun/shared/views";
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
import { EXPANDED_ENTRY_KIND } from "../commands/expand.js";
import { InteractionDoc, TERMINAL as INTERACTION_TERMINAL } from "./interactions.js";
import { AmbientDoc } from "./ambient.js";
import type { HostEventWire } from "@sigrun/shared/views";

/** The internal host-event payload: the wire union plus the hub-only `providers.changed`/`job.changed` variants boot publishes directly. */
export type HostEvent = HostEventWire;

/**
 * The tracked SessionMeta summary fields (W3 Task 4): the per-conversation
 * baseline `conversation.changed` diffs against. The bus already kept an
 * archive-flip baseline per conversation; this record generalizes it.
 */
interface MetaBasis {
	name?: string;
	autoName?: string;
	archived: boolean;
	pinned: boolean;
	lastActivityAt?: string;
	owner?: string;
	/** The sharing snapshot — compared by JSON (small, closed shape). */
	sharing?: string;
}

/** Project a SessionMeta doc value into the tracked basis. */
function metaBasisOf(value: {
	readonly name?: string;
	readonly autoName?: string;
	readonly archived?: boolean;
	readonly pinned?: boolean;
	readonly lastActivityAt?: string;
	readonly owner?: string;
	readonly sharing?: unknown;
}): MetaBasis {
	const basis: MetaBasis = {
		archived: value.archived === true,
		pinned: value.pinned === true,
	};
	if (value.name !== undefined) basis.name = value.name;
	if (value.autoName !== undefined) basis.autoName = value.autoName;
	if (value.lastActivityAt !== undefined) basis.lastActivityAt = value.lastActivityAt;
	if (value.owner !== undefined) basis.owner = value.owner;
	if (value.sharing !== undefined) basis.sharing = JSON.stringify(value.sharing);
	return basis;
}

/** The interaction terminal statuses are interactions.ts's exported TERMINAL (imported above) — one definition, no drift. */

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
 * `interactionSettled` (gateway C6) joins the same map: terminal
 * interaction transitions detected at the interaction host-event site.
 */
export type ExtensionLifecyclePayload = {
	conversationCreated: {
		readonly conversationId: ConversationId;
		readonly owner?: string;
	};
	conversationForked: {
		readonly childId: ConversationId;
		readonly parentId: ConversationId;
		readonly at: EntryId;
		/** The CHILD's owner at delivery; absent when the child is ownerless. */
		readonly owner?: string;
	};
	conversationArchived: {
		readonly conversationId: ConversationId;
		readonly archived: boolean;
		readonly owner?: string;
	};
	conversationIdle: {
		readonly conversationId: ConversationId;
		readonly idleMs: number;
		readonly owner?: string;
	};
	/** Gateway C6: one terminal interaction transition — the payload mirrors
	 *  the record's terminal envelope fields. */
	interactionSettled: {
		readonly conversationId: ConversationId;
		readonly callId: string;
		readonly kind: string;
		readonly status: "answered" | "skipped" | "expired" | "cancelled";
		readonly owner?: string;
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
	/** The conversation owner at delivery; absent when the conversation is ownerless. */
	readonly owner?: string;
	readonly inputs: readonly SubmissionId[];
	/** Text blocks of each input's entry (`pi.user`, or an expanded input's
	 *  `sigrun.user.expanded` — the ADMITTED text), concatenated;
	 *  unresolvable/withdrawn → "" at that position. */
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
 * Structural rather than a `Pick`: pi-durable 1.3.0's `DocumentReader` is
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
 * The `userDeleted` payload (core hardening W1 Task 4, spec §5.8 user
 * ruling 9): which directory user left and who received their
 * resources. Directly emitted (`EventBus.emitUserDeleted`) — never
 * commit-derived, since the directory is not durable conversation
 * state.
 */
export interface UserDeletedPayload {
	readonly user: string;
	readonly transferTo: string;
}

/** A loaded extension's `userDeleted` handler (the transfer counterpart of harnessShutdown). */
export type ExtensionUserDeletedHandler = (
	event: UserDeletedPayload,
	api: MemoryEventApi,
	context: Context,
) => void | Promise<void>;

/**
 * The lifecycle event names a worker's `wakeOn` may declare (memory-seam
 * Task 5). `harnessShutdown` is excluded by the loader: workers stop BEFORE
 * the shutdown handlers run (spec §3 shutdown ordering).
 */
export type WorkerWakeEvent = Exclude<keyof ExtensionLifecyclePayload, never>;

/** The wake argument of an event-triggered worker run (always present — wakes are the only trigger post-`every`-retirement). */
export type WorkerWake = {
	readonly event: string;
	readonly conversationId: ConversationId;
};

/**
 * One factory-declared idle worker (memory-seam Task 5 — the curator
 * contract), as the loader validated it. Host-owned lifecycle: the bus
 * taps the lifecycle fan-out for `wakeOn` matches (the `every` timer was
 * RETIRED by ruling 12 — wakes are the only trigger). One run at a time
 * per worker; a wake during an in-flight run is queued + coalesced (one
 * pending-wake slot, last wins) and delivered as the next run's `wake`.
 */
export type ExtensionWorker = {
	/** Unique within the extension; surfaces in /v1/meta. */
	readonly name: string;
	/** Lifecycle events that wake the worker (REQUIRED, non-empty — the `every` timer was RETIRED by ruling 12, jobs Task 3: jobs are the only time-based scheduler). */
	readonly wakeOn: readonly WorkerWakeEvent[];
	/** The work; rejects (or overruns the worker deadline) to fail the run. */
	run(context: Context, wake?: WorkerWake): Promise<void>;
};

/**
 * The /v1/meta projection of one worker (memory-seam Task 5): `lastRunAt`
 * appears at the first run's start; `lastError` carries the last failure
 * (rejection or deadline abandonment) and clears on the next success. Both
 * absent until the worker first runs.
 *
 * SPLIT (build-and-webui Task 1): the canonical declaration lives in the
 * `@sigrun/shared` package (`shared/src/views.ts` — it rides the §5
 * `meta.extensions[].workers` wire); re-exported here for bus/boot-side
 * importers.
 */
export type { WorkerStatus } from "@sigrun/shared/views";

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
	/** Terminal interaction transitions from ANY writer (gateway C6). */
	readonly interactionSettled?: ExtensionLifecycleHandler<"interactionSettled">;
	readonly harnessShutdown?: ExtensionHarnessShutdownHandler;
	/** The user-removal transfer event (W1 Task 4); direct fan-out, not commit-derived. */
	readonly userDeleted?: ExtensionUserDeletedHandler;
	/** The settings-change hook (UI-blocks U4, spec §13.2). */
	readonly onSettingsChanged?: (keys: readonly string[]) => void | Promise<void>;
	/** Factory-declared idle workers (memory-seam Task 5); the bus owns their timers. */
	readonly workers?: readonly ExtensionWorker[];
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
	/**
	 * Bounds each worker run (memory-seam Task 5; Task 6: `SIGRUN_WORKER_DEADLINE`).
	 * REQUIRED — config.ts's `DEFAULT_MEMORY_SEAM` is the single source of
	 * the 600_000 default; the bus carries no second copy. A timed-out run
	 * is abandoned — the host stops waiting and logs; the zombie promise
	 * keeps executing with its late writes unguarded (accepted, spec §3).
	 */
	readonly workerDeadlineMs: number;
	/**
	 * The host-event sink (W3 Task 4): when given, installed as the
	 * FIRST `onHostEvent` listener inside the constructor — before any
	 * commit can publish — so the hub never misses an event between the
	 * bus's open and the caller's subscription (resume-era settles
	 * included).
	 */
	readonly onHostEvent?: (event: HostEvent) => void;
}

/** How long shutdown waits for in-flight worker runs before abandoning (spec §3). */
const WORKER_SHUTDOWN_AWAIT_MS = 30_000;

/** Per-worker runtime state (the bus-owned half of the curator contract). */
interface WorkerState {
	readonly extension: string;
	readonly worker: ExtensionWorker;
	readonly deadlineMs: number;
	/** True while a run is in flight (host-side; a zombie counts as not running). */
	running: boolean;
	/** True once shutdown/close stopped the worker (no further runs). */
	stopped: boolean;
	/** The coalesced pending wake (last wins), delivered to the next run. */
	pendingWake: WorkerWake | undefined;
	/** The in-flight run's settle promise (resolves either way), for shutdown awaiting. */
	inflight: Promise<void> | undefined;
	lastRunAt: number | undefined;
	lastError: string | undefined;
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
	/** Per-conversation SessionMeta summary baseline (W3 Task 4): the last
	 * tracked summary values a `conversation.changed` diff was measured
	 * against. `#archivedBasis` stays the archive-flip baseline; this is
	 * the generalized form for the remaining summary fields. */
	#metaBasis = new Map<ConversationId, MetaBasis>();
	/** The host-event listeners (W3 Task 4): fed SYNCHRONOUSLY from the
	 * commit reduction — the contract is no-blocking-work (hub-side
	 * delivery concerns live in the hub). */
	#hostListeners: ((event: HostEvent) => void)[] = [];
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
	/** The worker states, in registration order (memory-seam Task 5). */
	#workers: WorkerState[] = [];
	#workerDeadlineMs: number;
	#closed = false;

	private constructor(harness: Harness, options: EventBusOptions) {
		this.#harness = harness;
		this.#queueMax = options.queueMax;
		this.#hookDeadlineMs = options.hookDeadlineMs;
		this.#idleThresholdMs = options.idleThresholdMs;
		this.#workerDeadlineMs = options.workerDeadlineMs;
		if (options.onHostEvent !== undefined) {
			this.onHostEvent(options.onHostEvent);
		}
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

	/**
	 * Subscribe to the host-event surface (W3 Task 4, spec §7.4): every
	 * event the commit reduction derives — `conversation.created` /
	 * `conversation.changed` (SessionMeta summary diffs) / `run.admitted` /
	 * `run.settled` / `interaction.pending` / `interaction.settled` /
	 * `ambient.changed` — delivered SYNCHRONOUSLY inside the commit
	 * observation. The listener contract: NO blocking work, no Session
	 * API calls (the hub's delivery is its own side lane). Returns the
	 * unsubscribe.
	 */
	public onHostEvent(listener: (event: HostEvent) => void): () => void {
		this.#hostListeners.push(listener);
		return () => {
			const index = this.#hostListeners.indexOf(listener);
			if (index >= 0) this.#hostListeners.splice(index, 1);
		};
	}

	/** Emit one host event to every listener; a throwing listener is logged, never propagated into the Session listener. */
	#emitHost(event: HostEvent): void {
		for (const listener of this.#hostListeners) {
			try {
				listener(event);
			} catch (error) {
				console.error("event-bus: host-event listener failed:", error);
			}
		}
	}

	/**
	 * Run one call under the SAME deadline bound every extension handler
	 * call runs under (W5 Task 6, spec §9.6): the notifications surface's
	 * side lane — host-owned delivery concerns kicked from the event hub,
	 * never bus queue events (so they must not ride the drain loop). The
	 * promise ALWAYS resolves: a throwing or over-deadline call is logged
	 * and abandoned, exactly like an extension handler's.
	 */
	public runBounded(label: string, call: () => void | Promise<void>): Promise<void> {
		return this.#bounded(label, call);
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
		// Task 5: a same-name registration REPLACES — stop the previous
		// workers before installing the new ones so no stale timer survives.
		this.#stopExtensionWorkers(name);
		this.#workers = this.#workers.filter((state) => state.extension !== name);
		this.#extensions.set(name, handlers);
		for (const worker of handlers.workers ?? []) {
			this.#addWorker(name, worker);
		}
		return () => {
			// Identity-guarded: a STALE unsubscribe (a same-name registration
			// has since replaced this one) is a no-op — it must not delete the
			// current registration NOR stop its workers. Both sides key on the
			// exact handlers object this registration installed.
			if (this.#extensions.get(name) !== handlers) return;
			this.#extensions.delete(name);
			this.#stopExtensionWorkers(name);
			this.#workers = this.#workers.filter(
				(state) => state.extension !== name,
			);
		};
	}

	/** Register one worker (no timer — the `every` path was retired by ruling 12; wakes are the only trigger). */
	#addWorker(extension: string, worker: ExtensionWorker): void {
		const state: WorkerState = {
			extension,
			worker,
			deadlineMs: this.#workerDeadlineMs,
			running: false,
			stopped: this.#closed,
			pendingWake: undefined,
			inflight: undefined,
			lastRunAt: undefined,
			lastError: undefined,
		};
		this.#workers.push(state);
	}

	/** Stop every worker of one extension (in-flight runs abandoned host-side). */
	#stopExtensionWorkers(extension: string): void {
		for (const state of this.#workers) {
			if (state.extension !== extension) continue;
			state.stopped = true;
			state.pendingWake = undefined;
		}
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
		// Prune-on-archive (post-ship review item): an archived conversation
		// stops firing conversationIdle — archive is the stronger idle, with
		// its own event. The listener keys the prune on the session-meta
		// flip basis (#archivedBasis), the one place archive state is
		// already tracked; a conversation with no flip record yet
		// (materialization default false, or a pre-process doc) is treated
		// as un-archived. Archived(false) restores NOTHING — the
		// conversation re-enters the idle clock at its next admission
		// (conservative: misses idles, never invents them).
		for (const conversationId of [...this.#lastAdmission.keys()]) {
			if (this.#archivedBasis.get(conversationId) === true) {
				this.#lastAdmission.delete(conversationId);
				this.#liveInputs.delete(conversationId);
				this.#idleFiredAt.delete(conversationId);
			}
		}
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
	 * Emit one `userDeleted` directly (core hardening W1 Task 4): the
	 * DELETE /v1/users route's step 3, AFTER transfer/revocation/link
	 * removal and service stop, but BEFORE the directory record is removed,
	 * so per-user secrets remain readable. Delivered exactly
	 * like `harnessShutdown` — inline to every registered extension's
	 * handler in install order, each deadline-bounded, never queued —
	 * because the directory is not durable conversation state (there is
	 * no commit to derive from). The api is the conversation-less shape:
	 * `entry`/`entries` resolve empty, `document` serves any conversation.
	 */
	public async emitUserDeleted(
		payload: UserDeletedPayload,
		context: Context,
	): Promise<void> {
		if (this.#closed) return;
		const api = this.#apiFor(undefined);
		for (const [name, handlers] of this.#extensions) {
			const handler = handlers.userDeleted;
			if (handler === undefined) continue;
			await this.#bounded(`extension ${name} userDeleted`, () =>
				handler(payload, api, context),
			);
		}
	}

	/**
	 * Emit one `settings.changed` fan-out (UI-blocks U4, spec §13.2):
	 * after a settings write COMMITS, every registered extension's
	 * `onSettingsChanged` receives the flattened keys the write touched.
	 * Delivered like `userDeleted` — inline, deadline-bounded, rejections
	 * caught and logged — because settings are not durable conversation
	 * state (no commit to derive from), and §13.2's rule is explicit: a
	 * throwing handler never fails the write.
	 */
	public async emitSettingsChanged(keys: readonly string[]): Promise<void> {
		if (this.#closed) return;
		for (const [name, handlers] of this.#extensions) {
			const handler = handlers.onSettingsChanged;
			if (handler === undefined) continue;
			await this.#bounded(`extension ${name} onSettingsChanged`, () =>
				handler(keys),
			);
		}
	}

	/**
	 * The wedge gauge's source (W2 Task 8, spec §6.9): the AGE in
	 * milliseconds of the oldest still-live input run — `now` minus the
	 * oldest per-conversation admission instant among conversations with
	 * live inputs. `undefined` when no run is live. In-process state (the
	 * admission clock): a run admitted before a restart is invisible to
	 * this until it settles — the spec's accepted posture for a
	 * wedge-while-up alarm (durable timestamps arrive with the §13 ask).
	 */
	public oldestLiveAdmissionMs(now: number = Date.now()): number | undefined {
		let oldest: number | undefined;
		for (const [conversationId, admittedAt] of this.#lastAdmission) {
			if ((this.#liveInputs.get(conversationId) ?? 0) <= 0) continue;
			if (oldest === undefined || admittedAt < oldest) oldest = admittedAt;
		}
		return oldest === undefined ? undefined : Math.max(0, now - oldest);
	}

	/**
	 * The ordered shutdown sequence (Task 4; src/index.ts runs it between
	 * `app.close()` and `harness.close()`):
	 *
	 * 1. stop the idle sweep (no new events from here on);
	 * 2. stop idle workers FIRST (Task 5, spec §3): pending wakes dropped,
	 *    in-flight runs awaited up to 30s then abandoned — a curator is not
	 *    competing with the flush handlers for the window;
	 * 3. drain pending settles — a run that settled just before shutdown
	 *    delivers before the shutdown flush (the ordering constraint);
	 * 4. deliver `harnessShutdown` to every extension in install order,
	 *    each deadline-bounded. Handlers may commit — admission is still
	 *    open in this window (the seal is `Harness.close`, the caller's
	 *    next step), which is exactly the flush window the spec promises;
	 * 5. close the bus (idempotent; boot's `subscribeClose` wiring makes a
	 *    later `harness.close` a no-op here).
	 */
	public async shutdownSequence(context: Context): Promise<void> {
		if (this.#closed) return;
		if (this.#sweep !== undefined) {
			clearInterval(this.#sweep);
			this.#sweep = undefined;
		}
		await this.#stopWorkers();
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
	 * Concurrent calls share ONE loop (the single side-lane worker), and a
	 * call resolves as soon as EITHER the shared loop empties the queue OR
	 * the call's own deadline fires — the deadline only bounds the WAIT, it
	 * does not reserve a share of the loop: when a loop is already running,
	 * its completion wins the race for every waiter, so a late caller with
	 * a tiny deadline can resolve AFTER that deadline (it rode the running
	 * loop past it). `context` is the drain's caller context, forwarded to
	 * the extension handlers the loop dispatches; the loop keeps the
	 * context of the drain that started it.
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

	/** Stop everything: unsubscribe, empty the queue, stop the sweep + workers, and let a running loop exit. */
	public close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubscribe();
		this.#queue.length = 0;
		if (this.#sweep !== undefined) {
			clearInterval(this.#sweep);
			this.#sweep = undefined;
		}
		// Workers stop too (a failed-session teardown must not leak their
		// runs); in-flight runs are abandoned host-side — close is sync.
		for (const state of this.#workers) {
			state.stopped = true;
			state.pendingWake = undefined;
		}
		// A running pump observes `#closed` at its next iteration and exits;
		// its in-flight handler call is abandoned at the hook deadline at
		// the latest, so pending drains always resolve.
	}

	/**
	 * The /v1/meta worker projection (memory-seam Task 5): extension name →
	 * per-worker `{name, lastRunAt?, lastError?}` (a snapshot per call; the
	 * server re-derives per request). Extensions without workers have no
	 * entry.
	 */
	public workerStatuses(): ReadonlyMap<string, readonly WorkerStatus[]> {
		const statuses = new Map<string, WorkerStatus[]>();
		for (const state of this.#workers) {
			const list = statuses.get(state.extension) ?? [];
			list.push({
				name: state.worker.name,
				...(state.lastRunAt === undefined
					? {}
					: { lastRunAt: state.lastRunAt }),
				...(state.lastError === undefined
					? {}
					: { lastError: state.lastError }),
			});
			statuses.set(state.extension, list);
		}
		return statuses;
	}

	/**
	 * Wake every worker whose `wakeOn` names this lifecycle event (memory-
	 * seam Task 5; taps the dispatch fan-out — detection is the listener's).
	 * A wake on an idle worker starts a run at once; a wake during an
	 * in-flight run is QUEUED + COALESCED (one pending slot, last wins) and
	 * delivered as the next run's `wake`.
	 */
	#wakeWorkers(event: LifecycleEvent, context: Context): void {
		for (const state of this.#workers) {
			if (state.stopped) continue;
			if (!state.worker.wakeOn?.includes(event.type)) continue;
			const wake: WorkerWake = {
				event: event.type,
				conversationId: this.#lifecycleConversation(event),
			};
			if (state.running) {
				state.pendingWake = wake;
			} else {
				this.#startRun(state, wake, context);
			}
		}
	}

	/**
	 * Start one worker run. One run at a time per worker; the run is bounded
	 * by the worker deadline — a timeout ABANDONS the run (logged; the
	 * zombie promise keeps executing, late writes unguarded — accepted,
	 * spec §3) and the next tick still runs. A coalesced pending wake
	 * triggers one follow-up run immediately.
	 */
	#startRun(
		state: WorkerState,
		wake: WorkerWake | undefined,
		context: Context,
	): void {
		if (state.stopped || state.running) return;
		state.running = true;
		state.lastRunAt = Date.now();
		const label = `extension ${state.extension} worker ${state.worker.name}`;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		// `inflight` resolves when the HOST considers the run over (complete),
		// not when the worker's promise settles — a zombie would otherwise
		// wedge the shutdown await (the 30s cap is the outer bound, but a
		// deadline-abandon must release it at once).
		let hostDone: () => void = () => {};
		state.inflight = new Promise<void>((resolve) => {
			hostDone = resolve;
		});
		const complete = (error: unknown) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			state.running = false;
			state.inflight = undefined;
			hostDone();
			if (error === undefined) {
				state.lastError = undefined;
			} else {
				state.lastError =
					error instanceof Error ? error.message : String(error);
				console.error("event-bus: %s failed: %s", label, state.lastError);
			}
			if (!state.stopped && state.pendingWake !== undefined) {
				const nextWake = state.pendingWake;
				state.pendingWake = undefined;
				this.#startRun(state, nextWake, context);
			}
		};
		timer = setTimeout(() => {
			const message = `exceeded the ${state.deadlineMs}ms worker deadline — abandoned`;
			// Logged ONCE by complete (as the run's failure, which also stamps
			// lastError); a separate log here would double-report.
			complete(new Error(message));
		}, Math.max(0, state.deadlineMs));
		timer.unref?.();
		let result: Promise<void>;
		try {
			result = state.worker.run(context, wake);
		} catch (error) {
			complete(error);
			return;
		}
		Promise.resolve(result).then(
			() => complete(undefined),
			(error) => complete(error),
		);
	}

	/**
	 * Stop every worker (spec §3 shutdown ordering): pending wakes dropped,
	 * in-flight runs awaited up to 30s then abandoned. Runs before the
	 * harnessShutdown delivery — a curator is not competing with the flush
	 * handlers for the same window.
	 */
	async #stopWorkers(): Promise<void> {
		for (const state of this.#workers) {
			state.stopped = true;
			state.pendingWake = undefined;
		}
		const inflight = this.#workers
			.map((state) => state.inflight)
			.filter((one) => one !== undefined);
		if (inflight.length === 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cap = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, WORKER_SHUTDOWN_AWAIT_MS);
		});
		await Promise.race([Promise.all(inflight).then(() => undefined), cap]);
		if (timer !== undefined) clearTimeout(timer);
		for (const state of this.#workers) {
			if (state.running) {
				console.error(
					"event-bus: extension %s worker %s still running at shutdown — abandoned",
					state.extension,
					state.worker.name,
				);
				state.running = false;
			}
		}
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
				// W3 Task 4: the host event mirrors the creation detection.
				this.#emitHost({
					type: "conversation.created",
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
				if (change.type !== "document" && change.type !== "document.copy") {
					continue;
				}
				const kind = change.record.kind;
				if (kind !== SessionMetaDoc.definition.kind) {
					// W3 Task 4: the interaction + ambient seam doc families feed
					// their host events here (ordinary document changes only — a
					// fork's document.copy carries no status transition).
					if (
						change.type === "document" &&
						kind === InteractionDoc.definition.kind &&
						change.conversationId !== undefined &&
						change.value !== null
					) {
						const record = change.value as {
							kind?: unknown;
							callId?: unknown;
							status?: unknown;
						};
						if (
							typeof record.callId === "string" &&
							typeof record.kind === "string" &&
							typeof record.status === "string"
						) {
							this.#emitHost({
								type: INTERACTION_TERMINAL.has(record.status)
									? "interaction.settled"
									: "interaction.pending",
								conversationId: change.conversationId,
								callId: record.callId,
								kind: record.kind,
							});
							// Gateway C6: a TERMINAL status transition additionally fans
							// out to the extension lifecycle handlers
							// (`interactionSettled`) from this same commit-observation
							// site. Exactly one document change lands per transition —
							// whatever wrote it (HTTP-route answer, host answer, host
							// settleInteraction) — so exactly one event fires per
							// transition; seeding (pending) fires nothing. It rides the
							// same lifecycle queue + deadline-bounded dispatch as
							// conversationCreated etc., NOT the host event stream. The
							// host-event split above and this gate read the SAME
							// imported set, so a future terminal status added to
							// TERMINAL fires both events together by construction.
							if (INTERACTION_TERMINAL.has(record.status)) {
								lifecycle.push({
									type: "interactionSettled",
									conversationId: change.conversationId,
									callId: record.callId,
									kind: record.kind,
									// SAFETY: `record.status` is a narrowed `string`, but
									// the payload wants the terminal union — sound because
									// the union and the TERMINAL set share one definition
									// (src/harness/interactions.ts): membership in the set
									// IS membership in the union.
									status: record.status as ExtensionLifecyclePayload["interactionSettled"]["status"],
								});
							}
						}
					} else if (
						change.type === "document" &&
						kind === AmbientDoc.definition.kind &&
						change.conversationId !== undefined &&
						typeof change.record.key === "string"
					) {
						this.#emitHost({
							type: "ambient.changed",
							conversationId: change.conversationId,
							key: change.record.key,
						});
					}
					continue;
				}
				const conversationId = change.conversationId;
				if (conversationId === undefined) continue;
				if (change.type === "document.copy") {
					// The fork initializes the child from the parent's current
					// state: seed the child's baseline, never fire.
					const parent = forkParents.get(conversationId);
					const inherited =
						parent === undefined
							? false
							: (this.#archivedBasis.get(parent) ?? false);
					this.#archivedBasis.set(conversationId, inherited);
					// W3 Task 4: seed the child's summary basis from the parent's
					// (fork: "current" — the child starts from the parent's
					// current doc; owner is NOT inherited — the auth hook stamps
					// the forker's own owner in a separate change that diffs
					// against this basis).
					const parentBasis =
						parent === undefined ? undefined : this.#metaBasis.get(parent);
					const childBasis: MetaBasis = {
						archived: inherited,
						pinned: parentBasis?.pinned ?? false,
					};
					if (parentBasis?.name !== undefined) childBasis.name = parentBasis.name;
					if (parentBasis?.autoName !== undefined) childBasis.autoName = parentBasis.autoName;
					if (parentBasis?.lastActivityAt !== undefined) childBasis.lastActivityAt = parentBasis.lastActivityAt;
					if (parentBasis?.sharing !== undefined) childBasis.sharing = parentBasis.sharing;
					this.#metaBasis.set(conversationId, childBasis);
					continue;
				}
				if (change.value === null) {
					this.#archivedBasis.delete(conversationId);
					this.#metaBasis.delete(conversationId);
					continue;
				}
				const archived = change.value.archived === true;
				// W3 Task 4: the summary basis — seed the ARCHIVE flip baseline on
				// creation, but the generalized diff below still runs against the
				// PRIOR basis (default for a first patch): the creation patch
				// materializes the doc WITH its fields (e.g. a create-time name),
				// and those fields are real `conversation.changed` news.
				if (change.record.createdAt === publication.seq) {
					this.#archivedBasis.set(conversationId, archived);
					const basis = this.#metaBasis.get(conversationId) ?? {
						archived: false,
						pinned: false,
					};
					const next = metaBasisOf(change.value);
					const moved: Record<string, unknown> = {};
					if (next.name !== basis.name) {
						moved.name = next.name === undefined ? null : next.name;
					}
					if (next.autoName !== basis.autoName) {
						moved.autoName = next.autoName === undefined ? null : next.autoName;
					}
					// archived/pinned too (fix round 1): a conversation
					// materialized already-pinned/-archived is real changed news.
					if (next.archived !== basis.archived) moved.archived = next.archived;
					if (next.pinned !== basis.pinned) moved.pinned = next.pinned;
					// lastActivityAt deliberately EXCLUDED: activity rides every
					// create and submission (creation stamps it since the
					// sort-order fix), so diffing it here would spam one
					// conversation.changed per turn — listeners who care read the
					// field from the row snapshot, not the change event.
					if (next.owner !== basis.owner) {
						moved.owner = next.owner === undefined ? null : next.owner;
					}
					if (next.sharing !== basis.sharing) {
						moved.sharing =
							next.sharing === undefined ? null : JSON.parse(next.sharing);
					}
					this.#metaBasis.set(conversationId, next);
					if (Object.keys(moved).length > 0) {
						this.#emitHost({
							type: "conversation.changed",
							conversationId,
							fields: moved as Extract<
								HostEventWire,
								{ type: "conversation.changed" }
							>["fields"],
						});
					}
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
				// W3 Task 4: the generalized summary diff — ANY tracked field
				// that moved against the baseline emits one `conversation.changed`
				// carrying exactly the moved fields' new values. The default
				// basis (absent doc / predating this process) compares against
				// the materialization defaults (archived/pinned false), mirroring
				// the archive-flip rule above.
				const basis = this.#metaBasis.get(conversationId) ?? {
					archived: false,
					pinned: false,
				};
				const next = metaBasisOf(change.value);
				// Built through a mutable mirror (the wire fields are readonly);
				// cleared keys ride as null (explicit-clear semantics).
				const moved: Record<string, unknown> = {};
				if (next.name !== basis.name) {
					moved.name = next.name === undefined ? null : next.name;
				}
				if (next.autoName !== basis.autoName) {
					moved.autoName = next.autoName === undefined ? null : next.autoName;
				}
				if (next.archived !== basis.archived) moved.archived = next.archived;
				if (next.pinned !== basis.pinned) moved.pinned = next.pinned;
				if (next.lastActivityAt !== basis.lastActivityAt) {
					moved.lastActivityAt =
						next.lastActivityAt === undefined ? null : next.lastActivityAt;
				}
				if (next.owner !== basis.owner) {
					moved.owner = next.owner === undefined ? null : next.owner;
				}
				if (next.sharing !== basis.sharing) {
					moved.sharing =
						next.sharing === undefined ? null : JSON.parse(next.sharing);
				}
				this.#metaBasis.set(conversationId, next);
				const movedKeys = Object.keys(moved);
				if (movedKeys.length > 0) {
					const fields: Extract<
						HostEventWire,
						{ type: "conversation.changed" }
					>["fields"] = {};
					for (const key of movedKeys) {
						// Keyed assignment through the mutable mirror above; the
						// wire type's readonly is the CONSUMER-side contract.
						(fields as Record<string, unknown>)[key] = moved[key];
					}
					this.#emitHost({
						type: "conversation.changed",
						conversationId,
						fields,
					});
				}
			}
			const groups = new Map<
				ConversationId,
				SettleGroup["settled"][number][]
			>();
			// Jobs Task 3 (§8.1): a `task` table write whose status is TERMINAL
			// reduces to a host-level `taskSettled` — the jobs observer's input
			// for settling `task`-action run records. Emitted from the SAME
			// synchronous filter (the no-blocking-work contract), never queued:
			// it is host machinery (withheld from the SSE wire), and its
			// consumer runs on the drain loop.
			for (const change of publication.changes) {
				if (change.type !== "task") continue;
				const task = change.value;
				// `completing` is decided-but-not-finalized; the jobs observer
				// waits for the terminal receipt — emit only on `terminal`.
				if (task.state.status !== "terminal") continue;
				const outcome = task.state.outcome;
				// The error text rides whichever field the outcome shape
				// carries: `failed` has `error` (a TaskOutcomeError), `aborted`
				// has `reason` (§8.1: an aborted task-action run settles
				// failed WITH the text, never empty).
				const errorText =
					outcome.status === "completed"
						? undefined
						: "error" in outcome
							? outcome.error?.message
							: "reason" in outcome
								? outcome.reason
								: undefined;
				this.#emitHost({
					type: "taskSettled",
					// SAFETY: TaskId is the branded number the wire's plain `number`
					// field carries; the observer compares by === across both forms.
					taskId: task.id as unknown as number,
					status: outcome.status,
					...(errorText === undefined ? {} : { error: errorText }),
				});
			}
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
						// Skip when the key is absent: a conversation archived
						// mid-run has its idle state pruned (see sweepIdle), and a
						// settle arriving after the prune must NOT re-create the
						// entry with a floored 0 — that would re-admit the archived
						// conversation to the sweep (and a still-running second
						// input would then fire idle MID-RUN).
						const live = this.#liveInputs.get(value.conversationId);
						if (live !== undefined) {
							this.#liveInputs.set(
								value.conversationId,
								Math.max(0, live - 1),
							);
						}
					}
				}
				// W3 Task 4: host events for run admission and settlement. The
				// status arms map verbatim: placed → run.admitted, done →
				// run.settled answered, unanswered → run.settled unanswered with
				// the record's reason.
				if (value.status === "placed") {
					this.#emitHost({
						type: "run.admitted",
						conversationId: value.conversationId,
						submissionId: value.id,
					});
				} else if (value.status === "done") {
					this.#emitHost({
						type: "run.settled",
						conversationId: value.conversationId,
						outcome: "answered",
					});
				} else if (value.status === "unanswered") {
					this.#emitHost({
						type: "run.settled",
						conversationId: value.conversationId,
						outcome: "unanswered",
						...(value.reason === undefined ? {} : { reason: value.reason }),
					});
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
		// Task 5: wakes tap the lifecycle fan-out — matched and queued HERE,
		// regardless of whether any extension registered a handler for it.
		this.#wakeWorkers(event, context);
		const registered = [...this.#extensions.entries()].filter(
			([, handlers]) => handlers[type] !== undefined,
		);
		if (registered.length === 0) return;
		const owner = await this.#ownerOf(
			this.#lifecycleConversation(event),
			context,
		);
		const payload = {
			...this.#lifecyclePayload(event),
			...(owner === undefined ? {} : { owner }),
		};
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
			case "interactionSettled":
				return {
					conversationId: event.conversationId,
					callId: event.callId,
					kind: event.kind,
					status: event.status,
				};
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
		const owner = await this.#ownerOf(group.conversationId, context);
		const ownerField = owner === undefined ? {} : { owner };
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
					...ownerField,
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
			...ownerField,
			inputs,
			inputTexts,
			outcome: {
				status: "unanswered",
				reason: firstUnanswered?.reason ?? "unanswered",
			},
		};
	}

	/** The current SessionMeta owner; absent means the key is omitted from the event. */
	async #ownerOf(
		conversationId: ConversationId,
		context: Context,
	): Promise<string | undefined> {
		try {
			const meta = await this.#harness.snapshot(
				SessionMetaDoc,
				conversationId,
				context,
			);
			return meta?.owner;
		} catch (error) {
			console.error("event-bus: owner read failed:", error);
			return undefined;
		}
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

	/** The input text of one entry: a `pi.user` (or an expanded input's
	 *  `sigrun.user.expanded`) entry's `model[0]` text blocks joined — for
	 *  an expanded input that is the ADMITTED text (what the model
	 *  received), exactly what `runSettled` hands its handlers. */
	async #entryText(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<string> {
		const entry = await this.#readEntry(conversationId, id, context);
		if (entry === undefined) return "";
		// An expanded input REPLACES the `pi.user` kind (Task 2c's
		// `entry: {kind: …}` placement) — both kinds are input entries.
		if (!UserEntry.is(entry) && entry.kind !== EXPANDED_ENTRY_KIND) {
			return "";
		}
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
