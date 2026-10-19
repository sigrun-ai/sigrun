/**
 * W2 Task 8 (spec §6.9): `GET /metrics` — the Prometheus text
 * exposition of in-process state. The families:
 *
 * - `sigrun_up` — 1, or 0 when `harness.inspect()` throws (Review Focus
 *   5: a scrape racing shutdown must degrade, never 500 — a closed
 *   harness fails the inspect, the route still answers 200 with the
 *   inspect-derived families omitted);
 * - `sigrun_live_runs` — conversations with a placed-but-unsettled input
 *   submission (one run per conversation at a time), durable-derived
 *   from the same inspection;
 * - `sigrun_inflight_submission_oldest_seconds` — the event bus's
 *   admission clock (`oldestLiveAdmissionMs`; 0 when no run is live).
 *   In-process: a run admitted before a restart is invisible until it
 *   settles (spec §6.9 accepts this for a wedge-while-up alarm);
 * - `sigrun_tasks_live{status}` — live tasks grouped by scheduler state
 *   kind, the full five-kind vocabulary emitted (0s included) so the
 *   family's label set is scrape-stable. `inspect()` is a Session-line
 *   read (scrape-rate only, never a hot path);
 * - `sigrun_provider_ready{provider,status}` — the per-provider auth
 *   readiness derivation (`providerAuthStatus`, the exact chain
 *   `GET /v1/auth/check` serves), value 1 at the current status;
 * - `sigrun_extensions{status}` — load outcomes (`ok` | `quarantined`),
 *   both emitted even at 0 for the same label-stability reason;
 * - `sigrun_backup_last_success_timestamp_seconds` — Task 7's marker,
 *   read per request like `meta.ts` does (the CronJob is a separate
 *   process; the filesystem is the only fresh-enough view). OMITTED when
 *   backup is unconfigured or no marker exists — absence is what the
 *   `SigrunBackupStale` alert's chart gate keys on.
 *
 * W4 adds the `sigrun_job_*` families (last/next-run timestamps and the
 * `sigrun_job_runs_total` counter the `SigrunJobFailed` alert selects).
 *
 * ACCESS (the plan's documented interim): `/metrics` is unconditionally
 * public on this branch — there is no auth pipeline to gate it with.
 * `config.metricsPublic` (strict `SIGRUN_METRICS_PUBLIC`, W1 Task 1)
 * becomes the gate once W1 lands; the chart already pins the env `true`
 * so the in-cluster scrape survives that switch.
 *
 * FORMAT: every family carries `# HELP` + `# TYPE … gauge` lines; label
 * values escape backslash, quote, and newline per the exposition format;
 * the content type is `text/plain; version=0.0.4; charset=utf-8`.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { readBackupMarker } from "../../backup/marker.js";
import { providerAuthStatus } from "../helpers.js";
import type { ServerContext } from "../context.js";

/** The exposition content type (spec §6.9's format rule). */
const EXPOSITION_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Escape one label value per the exposition format: `\` → `\\`,
 *  `"` → `\"`, newline → `\n`. */
function escapeLabelValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

/** Render one label set (`{a="1",b="2"}`, or `""` when label-less). */
function renderLabels(labels: Readonly<Record<string, string>>): string {
	const entries = Object.entries(labels);
	if (entries.length === 0) return "";
	return `{${entries.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(",")}}`;
}

/**
 * Register `GET /metrics`.
 *
 * One family per call: the HELP/TYPE lines plus one sample per
 * `{labels, value}` pair, appended to the shared line buffer. A family
 * with NO samples is omitted entirely (the backup-marker case) —
 * callers that must always exist pass their 0-valued sample themselves.
 */
export function registerMetricsRoutes(
	app: FastifyInstance,
	ctx: ServerContext,
): void {
	const { opened, config } = ctx;
	app.get("/metrics", async (_request, reply) => {
		const lines: string[] = [];
		const family = (
			name: string,
			help: string,
			samples: readonly {
				readonly labels: Readonly<Record<string, string>>;
				readonly value: number;
			}[],
		): void => {
			if (samples.length === 0) return;
			lines.push(`# HELP ${name} ${help}`);
			lines.push(`# TYPE ${name} gauge`);
			for (const sample of samples) {
				lines.push(`${name}${renderLabels(sample.labels)} ${sample.value}`);
			}
		};

		// Review Focus 5: the harness liveness probe. `inspect()` throws on
		// a closed harness (the shutdown race) and on storage failure — the
		// scrape degrades to `sigrun_up 0` with the inspect-derived
		// families (live runs, wedge age, tasks) omitted rather than 500ing.
		let up = 1;
		try {
			const inspection = await opened.harness.inspect(BACKGROUND_CONTEXT);
			// Live runs: conversations holding a placed-but-unsettled INPUT
			// submission (queued inputs run nothing yet; write-type
			// submissions never run at all). Durable-derived, so a
			// pre-restart run still counts — only the wedge AGE above is
			// restart-invisible.
			const liveConversations = new Set<number>();
			for (const submission of inspection.submissions) {
				if (submission.type !== "input" || submission.status !== "placed") {
					continue;
				}
				liveConversations.add(submission.conversationId);
			}
			family("sigrun_live_runs", "Conversations with a live input run", [
				{ labels: {}, value: liveConversations.size },
			]);
			// The wedge gauge: the admission clock's age over the oldest
			// live run. Always exists while the harness answers (0 when no
			// run is live — the alert's `> 1800` must not key on absence).
			const oldestMs = opened.eventBus.oldestLiveAdmissionMs();
			family(
				"sigrun_inflight_submission_oldest_seconds",
				"Age of the oldest in-flight submission's admission (0 when none; in-process clock — a pre-restart run is invisible until it settles)",
				[{ labels: {}, value: Math.round((oldestMs ?? 0) / 1000) }],
			);
			// Live tasks by scheduler state kind. The full five-kind
			// vocabulary is emitted (0s included) for label stability.
			const taskStatuses: Record<string, number> = {
				running: 0,
				ready: 0,
				waiting: 0,
				completing: 0,
				blocked: 0,
			};
			for (const task of inspection.tasks) {
				taskStatuses[task.state.kind] = (taskStatuses[task.state.kind] ?? 0) + 1;
			}
			family(
				"sigrun_tasks_live",
				"Live tasks by scheduler state",
				Object.entries(taskStatuses).map(([status, count]) => ({
					labels: { status },
					value: count,
				})),
			);
		} catch (error) {
			up = 0;
			console.error("metrics: harness inspection failed:", error);
		}
		family("sigrun_up", "1 when the harness answers inspection", [
			{ labels: {}, value: up },
		]);

		// Provider readiness: the shared derivation (`GET /v1/auth/check`'s
		// exact chain), one 1-valued sample per (provider, current status).
		const producersByName = new Map(
			opened.providerHealth.map((producer) => [producer.name, producer]),
		);
		family(
			"sigrun_provider_ready",
			"1 per provider at its current auth-readiness status",
			opened.models.getProviders().map(({ id }) => ({
				labels: {
					provider: id,
					status: providerAuthStatus(opened, id, producersByName).status,
				},
				value: 1,
			})),
		);

		// Extension load outcomes: both statuses emitted even at 0 so the
		// family exists on a bare-core deploy (label stability).
		const extensionCounts: Record<string, number> = { ok: 0, quarantined: 0 };
		for (const outcome of opened.extensionOutcomes) {
			extensionCounts[outcome.status] =
				(extensionCounts[outcome.status] ?? 0) + 1;
		}
		family(
			"sigrun_extensions",
			"Configured extensions by load outcome",
			Object.entries(extensionCounts).map(([status, count]) => ({
				labels: { status },
				value: count,
			})),
		);

		// Task 7's marker, read per request like meta.ts (the CronJob is a
		// separate process). Omitted when backup is unconfigured or the
		// marker is absent/corrupt — the SigrunBackupStale alert's chart
		// gate treats an unbacked deploy as "no series, no page".
		if (config.backup !== undefined) {
			const marker = await readBackupMarker(config.stateDir);
			if (marker !== undefined) {
				const seconds = Math.floor(Date.parse(marker.at) / 1000);
				if (Number.isFinite(seconds)) {
					family(
						"sigrun_backup_last_success_timestamp_seconds",
						"Unix time of the last successful backup run",
						[{ labels: {}, value: seconds }],
					);
				}
			}
		}

		return await reply.code(200).type(EXPOSITION_CONTENT_TYPE).send(`${lines.join("\n")}\n`);
	});
}
