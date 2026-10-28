/**
 * The notifications surface (core hardening W5 Task 6, spec §9.6): ONE
 * subscription on the event hub that turns host events into
 * per-recipient `NotificationEvent`s and delivers them to every
 * collected notifier contribution (`OpenedHarness.notifierBindings`)
 * through the event bus's bounded side lane (`eventBus.runBounded`).
 *
 * Emitted events (spec §9.6):
 *
 * - `interaction.pending` — always. An agent needs a human.
 * - `job.failed` — always. A job's run record settled `failed` (read
 *   off the hub's `job.changed` carries; deduped per failed RUN, since
 *   `job.changed` fires for every record change and a failed `lastRun`
 *   stays in the row until the next settle).
 * - `run.settled` — per the LIVE `notifications.runSettled` setting:
 *   `"unwatched"` (default) only when no `/stream` client is attached
 *   (the away-from-desk case — `ServerContext.watchersByConversation`),
 *   `"cron"` only for job-run conversations (`SessionMeta.source ===
 *   "cron"`), `"always"`, `"never"`.
 *
 * Recipients: each event goes to the resource's owner. For
 * `interaction.pending` it ALSO goes to every directory user with
 * `write` access (`accessOf`) — anyone who can answer.
 *
 * Delivery is best-effort: each notify call is deadline-bounded on the
 * side lane, a throwing or over-deadline notifier is logged and
 * isolated (the other notifiers still receive the event), and nothing
 * is retried durably — reliability is a notifier's own concern. The
 * hub listener itself never blocks (the hub contract): every delivery
 * is kicked fire-and-forget onto the side lane.
 *
 * Transports live in extensions (ntfy, Signal, web push); core ships
 * none — with zero notifier contributions this module subscribes
 * nothing at all.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { accessOf, type Sharing } from "@sigrun/shared/access";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import type { JobRunWire, JobWire } from "@sigrun/shared/jobs";
import type { NotificationEvent, NotifierContribution, RunSettledOutcome, SigrunHost } from "../extension.js";
import type { ServerContext } from "./context.js";
import type { HostEventWire } from "./events/types.js";
import { SessionMetaDoc } from "./session-meta.js";

/** One delivery target: a notifier plus its extension's seam host. */
interface DeliveryTarget {
	/** The contributing extension's slug (the delivery label's attribution). */
	readonly extension: string;
	readonly notifier: NotifierContribution;
	/**
	 * The extension's seam host — the notify ctx's `host`, the Task 2
	 * ext-route semantics (the captured instance, possibly `undefined`
	 * when the factory took no host context).
	 */
	readonly host: SigrunHost | undefined;
}

/**
 * The event fields every recipient of one occurrence shares; `user` is
 * stamped per recipient at delivery.
 */
interface EventBase {
	readonly type: NotificationEvent["type"];
	readonly conversationId: number | undefined;
	readonly jobId: string | undefined;
	/** Gateway C6: the pending record's id — set on `interaction.pending` only. */
	readonly callId: string | undefined;
	readonly title: string;
	readonly body: string;
	/** The settled run's outcome — set on `run.settled` only. */
	readonly outcome?: RunSettledOutcome;
}

/** The conversation's display name (spec §9.6): name ?? autoName ?? fallback. */
function displayName(meta: SessionMeta | undefined, id: number): string {
	return meta?.name ?? meta?.autoName ?? `Conversation ${id}`;
}

/**
 * Start the notifications surface. Returns its unsubscribe (the server
 * never calls it today — the surface rides the process lifetime — but
 * tests and embedders may). A no-op unsubscribe when no extension
 * contributed a notifier: nothing subscribes, zero overhead.
 */
export function startNotifications(ctx: ServerContext): () => void {
	const { opened, config } = ctx;
	const targets: DeliveryTarget[] = [];
	for (const binding of opened.notifierBindings) {
		// The Task 2 ext-route host semantics: the captured seam host,
		// cast across the not-yet-bridged members.
		const host = opened.seamHosts.get(binding.extension) as
			| SigrunHost
			| undefined;
		for (const notifier of binding.notifiers) {
			targets.push({ extension: binding.extension, notifier, host });
		}
	}
	if (targets.length === 0) return () => {};

	const bus = opened.eventBus;
	const watchers = ctx.watchersByConversation;

	/** Deliver one occurrence to every recipient through every notifier. */
	const deliver = (base: EventBase, recipients: Iterable<string | undefined>): void => {
		// The deep link rides only when the deployment set a public URL and
		// the event names a conversation.
		const url =
			base.conversationId !== undefined && config.publicUrl !== undefined
				? `${config.publicUrl}/#/c/${base.conversationId}`
				: undefined;
		for (const user of recipients) {
			const event: NotificationEvent = {
				type: base.type,
				conversationId: base.conversationId,
				jobId: base.jobId,
				...(base.callId === undefined ? {} : { callId: base.callId }),
				user,
				title: base.title,
				body: base.body,
				...(url === undefined ? {} : { url }),
				// The settled outcome rides ONLY run.settled events — the
				// other variants never gain the field (the type is the union;
				// the conditional spread keeps the wire shape exact).
				...(base.outcome === undefined ? {} : { outcome: base.outcome }),
			} as NotificationEvent;
			for (const target of targets) {
				// Fire-and-forget per transport call: one notifier's failure or
				// hang neither blocks nor loses the others' deliveries.
				void bus.runBounded(
					`notifier ${target.extension}.${target.notifier.name}`,
					() =>
						target.notifier.notify(event, {
							host: target.host as SigrunHost,
						}),
				);
			}
		}
	};

	/** One conversation's live SessionMeta (undefined on absence or read failure, logged). */
	const metaOf = async (
		conversationId: number,
	): Promise<SessionMeta | undefined> => {
		try {
			// SAFETY: the host event's plain `number` is the branded
			// ConversationId the snapshot takes; compared/used by value.
			return await opened.harness.snapshot(
				SessionMetaDoc,
				conversationId as ConversationId,
				BACKGROUND_CONTEXT,
			);
		} catch (error) {
			console.error("notifications: session-meta read failed:", error);
			return undefined;
		}
	};

	/** interaction.pending → the owner plus every directory user with write. */
	const handleInteraction = async (
		conversationId: number,
		callId: string | undefined,
	): Promise<void> => {
		const meta = await metaOf(conversationId);
		const owner = meta?.owner;
		const sharing: Sharing | undefined = meta?.sharing;
		// The owner first (always a recipient — even one the directory no
		// longer lists); then every directory user whose accessOf is write.
		const recipients = new Set<string | undefined>([owner]);
		for (const { user, admin } of opened.identity.users.list()) {
			if (
				accessOf({ user, superuser: admin }, { owner, sharing }) === "write"
			) {
				recipients.add(user);
			}
		}
		deliver(
			{
				type: "interaction.pending",
				conversationId,
				jobId: undefined,
				callId,
				title: "Sigrun needs you",
				body: displayName(meta, conversationId),
			},
			recipients,
		);
	};

	/** run.settled → the owner, gated by the live `notifications.runSettled` mode. */
	const handleRunSettled = async (
		conversationId: number,
		outcome: "answered" | "unanswered",
		reason: string | undefined,
	): Promise<void> => {
		const mode =
			opened.settings.read().notifications?.runSettled ?? "unwatched";
		if (mode === "never") return;
		const meta = await metaOf(conversationId);
		if (mode === "cron" && meta?.source !== "cron") return;
		if (
			mode === "unwatched" &&
			(watchers.get(conversationId as ConversationId) ?? 0) > 0
		) {
			return;
		}
		// Translate the EXISTING wire outcome/reason straight across (no
		// second answer read, no inferred status). An unanswered run never
		// titles itself "Reply ready": the reason is the run's own, with
		// the bare status as the fallback for a reason-less settle.
		const settledOutcome: RunSettledOutcome =
			outcome === "answered"
				? { status: "answered" }
				: { status: "unanswered", reason: reason ?? "unanswered" };
		const settledReason = reason ?? "unanswered";
		deliver(
			{
				type: "run.settled",
				conversationId,
				jobId: undefined,
				callId: undefined,
				title:
					outcome === "answered"
						? "Reply ready"
						: "Run ended without a reply",
				body:
					outcome === "answered"
						? displayName(meta, conversationId)
						: `${displayName(meta, conversationId)} — ${settledReason}`,
				outcome: settledOutcome,
			},
			[meta?.owner],
		);
	};

	/**
	 * job.changed → job.failed once per failed RUN. `job.changed` fires
	 * for every record change; the run identity (jobId + fire key +
	 * startedAt) dedupes — a later change re-serving the same failed
	 * `lastRun` never re-notifies, and the next run's settle does.
	 */
	const lastNotifiedFailedRun = new Map<string, string>();
	const handleJobChanged = (job: Omit<JobWire, "access">): void => {
		const run: JobRunWire | undefined = job.lastRun;
		if (run?.outcome !== "failed") return;
		const identity = `${run.jobId}:${run.fireAt}:${run.manual}:${run.startedAt}`;
		if (lastNotifiedFailedRun.get(job.id) === identity) return;
		lastNotifiedFailedRun.set(job.id, identity);
		deliver(
			{
				type: "job.failed",
				conversationId: run.conversationId,
				jobId: job.id,
				callId: undefined,
				title: `Job ${job.name} failed`,
				// The observer always settles a failed run with its error
				// text; the fallback only covers a hand-corrupted record.
				body: run.error ?? "the run failed",
			},
			[job.owner],
		);
	};

	const unsubscribe = opened.events.subscribe((event: HostEventWire) => {
		// The hub contract: no blocking work — each handling is kicked onto
		// the bus's bounded side lane (resolution + delivery alike never
		// run inline here).
		if (event.type === "interaction.pending") {
			void bus.runBounded("notifications interaction.pending", () =>
				handleInteraction(event.conversationId, event.callId),
			);
		} else if (event.type === "run.settled") {
			void bus.runBounded("notifications run.settled", () =>
				handleRunSettled(event.conversationId, event.outcome, event.reason),
			);
		} else if (event.type === "job.changed") {
			void bus.runBounded("notifications job.changed", () => {
				handleJobChanged(event.job);
			});
		}
	});
	return unsubscribe;
}
