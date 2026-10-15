/**
 * The event bus (memory-seam Task 2): commit observation + bounded side
 * lane. See docs/superpowers/specs/2026-10-15-sigrun-memory-seam.md §"Design".
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
 */

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

/** Conversation lifecycle reduced from commit publications. */
export type LifecycleEvent =
	| { readonly type: "conversationCreated"; readonly conversationId: ConversationId }
	| {
			readonly type: "conversationForked";
			readonly childId: ConversationId;
			readonly parentId: ConversationId;
			readonly at: EntryId;
	  }
	| {
			readonly type: "conversationArchived";
			readonly conversationId: ConversationId;
			readonly archived: boolean;
	  };

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

/** Internal queue item: which handler list an event dispatches through. */
type BusEvent =
	| { readonly kind: "settled"; readonly event: SettleGroup }
	| { readonly kind: "lifecycle"; readonly event: LifecycleEvent };

/**
 * The commit-observation side lane. One instance per harness; open after
 * boot, close before the harness closes.
 */
export class EventBus {
	/** Subscribe `harness`'s commit stream; `queueMax` bounds the queue, `hookDeadlineMs` bounds each handler call. */
	public static open(
		harness: Harness,
		options: { queueMax: number; hookDeadlineMs: number },
	): EventBus {
		return new EventBus(harness, options);
	}

	#unsubscribe: () => void;
	#harness: Harness;
	#queueMax: number;
	#hookDeadlineMs: number;
	#queue: BusEvent[] = [];
	#settleHandlers: ((event: SettleGroup) => void | Promise<void>)[] = [];
	#lifecycleHandlers: ((event: LifecycleEvent) => void | Promise<void>)[] = [];
	/** Extension name → its handlers (the loader-validated factory-result fields). */
	#extensions = new Map<
		string,
		{ readonly runSettled?: ExtensionRunSettledHandler }
	>();
	/** Per-conversation `archived` flip baseline (the last value a change was measured against). */
	#archivedBasis = new Map<ConversationId, boolean>();
	/** The single drain loop, when one is running. */
	#loop: Promise<void> | undefined;
	#closed = false;

	private constructor(
		harness: Harness,
		options: { queueMax: number; hookDeadlineMs: number },
	) {
		this.#harness = harness;
		this.#queueMax = options.queueMax;
		this.#hookDeadlineMs = options.hookDeadlineMs;
		this.#unsubscribe = harness.subscribeCommits((publication) => {
			this.observe(publication);
		});
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
	 * path). Returns its unsubscribe.
	 */
	public registerExtension(
		name: string,
		handlers: { readonly runSettled?: ExtensionRunSettledHandler },
	): () => void {
		this.#extensions.set(name, handlers);
		return () => {
			if (this.#extensions.get(name) === handlers) {
				this.#extensions.delete(name);
			}
		};
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

	/** Stop everything: unsubscribe, empty the queue, and let a running loop exit. */
	public close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubscribe();
		this.#queue.length = 0;
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
		}
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

	/** The narrowed read surface handed to `runSettled` handlers. */
	#apiFor(conversationId: ConversationId): MemoryEventApi {
		const harness = this.#harness;
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
