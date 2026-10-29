/**
 * W2 Task 8 (spec §6.9): `GET /metrics` — the Prometheus text
 * exposition of in-process state. The families:
 *
 * - `sigrun_up` — 1, or 0 when `harness.inspect()` throws (Review Focus
 *   5: a scrape racing shutdown must degrade, never 500 — a closed
 *   harness fails the inspect, the route still answers 200 with the
 *   inspect-derived families omitted);
 * - `sigrun_ready` — core-hardening Task 5: `checkStorage` (the SAME
 *   root-conversation read `/readyz` gates on) as a gauge — 1 when
 *   `"ok"`, 0 when `"failed"`. Always emitted: the finding was a
 *   storage read failing while inspection stayed healthy (`sigrun_up
 *   1`), so `/readyz` 503'd but the scrape stayed green and nothing
 *   paged; sharing one derivation means the gauge and the probe
 *   cannot disagree.
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
 * - W4 Task 4's job families: `sigrun_job_last_run_timestamp_seconds
 *   {job,outcome}` and `sigrun_job_next_run_timestamp_seconds{job}` —
 *   per-record gauges re-read per scrape (the same scrape-rate posture
 *   as the inspect families); `sigrun_job_runs_total{outcome}` — a
 *   COUNTER over the boot's in-process run-settle observation (reset on
 *   restart by design; the durable history lives in the run records).
 *   Families with no samples are omitted (the backup-marker
 *   convention).
 *
 * ACCESS: `/metrics` is public iff `config.metricsPublic` (strict
 * `SIGRUN_METRICS_PUBLIC`, W1 Task 1) — the decision is made by the
 * matched-route auth pipeline (`src/server/auth/pipeline.ts` rule 2:
 * pattern `/metrics` and `metricsPublic` → public, else authenticated).
 * The chart pins the env `true` so the in-cluster scrape survives.
 *
 * FORMAT: every family carries `# HELP` + `# TYPE` lines (gauge, or
 * counter for the one cumulative family); label values escape
 * backslash, quote, and newline per the exposition format; the content
 * type is `text/plain; version=0.0.4; charset=utf-8`.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FastifyInstance } from "fastify";
import { REPORT_TYPES } from "../../harness/reports.js";
import { readBackupMarker } from "../../backup/marker.js";
import { scanJobs } from "../../jobs/docs.js";
import { providerAuthStatus } from "../helpers.js";
import type { ServerContext } from "../context.js";
import { checkStorage } from "../readiness.js";

/** The exposition content type (spec §6.9's format rule). */
const EXPOSITION_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

const BLOCKED_REASONS = ["missing_task", "task_too_old", "migration_failed", "restart_limit"] as const;

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
			type: "gauge" | "counter" = "gauge",
		): void => {
			if (samples.length === 0) return;
			lines.push(`# HELP ${name} ${help}`);
			lines.push(`# TYPE ${name} ${type}`);
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
			// Live tasks by scheduler state kind. The full six-kind
			// vocabulary is emitted (0s included) for label stability
			// (1.4.0 adds `sleeping` — the durable-sleep state).
			const taskStatuses: Record<string, number> = {
				running: 0,
				ready: 0,
				waiting: 0,
				sleeping: 0,
				completing: 0,
				blocked: 0,
			};
			const blockedReasons: Record<string, number> = Object.fromEntries(
				BLOCKED_REASONS.map((reason) => [reason, 0]),
			);
			for (const task of inspection.tasks) {
				taskStatuses[task.state.kind] = (taskStatuses[task.state.kind] ?? 0) + 1;
				if (task.state.kind === "blocked") {
					blockedReasons[task.state.reason] = (blockedReasons[task.state.reason] ?? 0) + 1;
				}
			}
			family(
				"sigrun_tasks_blocked",
				"Live tasks blocked by scheduler reason",
				Object.entries(blockedReasons).map(([reason, count]) => ({
					labels: { reason },
					value: count,
				})),
			);
			family(
				"sigrun_tasks_live",
				"Live tasks by scheduler state",
				Object.entries(taskStatuses).map(([status, count]) => ({
					labels: { status },
					value: count,
				})),
			);
			// W4 Task 4's job families — record-derived gauges, scrape-rate
			// reads over the same records-only scan the jobs service lists
			// through (inside the inspect guard: a closed harness degrades to
				// omission, never a 500).
			const jobRecords = await scanJobs(opened.storage, BACKGROUND_CONTEXT);
			const epochSeconds = (iso: string): number =>
				Math.floor(Date.parse(iso) / 1000);
			family(
				"sigrun_job_last_run_timestamp_seconds",
				"Unix time of each job's last run (by outcome)",
				jobRecords.flatMap(({ id, record }) =>
					record.lastRun === undefined
						? []
						: [
								{
									labels: { job: id, outcome: record.lastRun.outcome },
									value: epochSeconds(
										record.lastRun.settledAt ?? record.lastRun.startedAt,
									),
								},
							],
				),
			);
			family(
				"sigrun_job_next_run_timestamp_seconds",
				"Unix time of each job's next scheduled fire",
				jobRecords.flatMap(({ id, record }) =>
						record.nextRun === undefined
							? []
							: [
									{
										labels: { job: id },
										value: epochSeconds(record.nextRun),
									},
								],
				),
			);
		} catch (error) {
			up = 0;
			console.error("metrics: harness inspection failed:", error);
		}
		family("sigrun_up", "1 when the harness answers inspection", [
			{ labels: {}, value: up },
		]);

		// Core-hardening Task 5: the readiness storage check as a gauge —
		// the exact call /readyz gates on (never throws, never omitted), so
		// SigrunNotReady's `or sigrun_ready == 0` arm fires on a storage
		// failure even while inspection (and the whole scrape) stays green.
		const storage = await checkStorage(ctx);
		family(
			"sigrun_ready",
			"1 when the readiness storage check (the /readyz root-conversation read) succeeds",
			[{ labels: {}, value: storage === "ok" ? 1 : 0 }],
		);

		// D5: process-local durable failure reports. Every known type is
		// emitted, including zeros, for scrape-stable alert expressions.
		const reportCounts = opened.reports.counts();
		family(
			"sigrun_durable_reports_total",
			"Durable failure reports since process start",
			REPORT_TYPES.map((type) => ({ labels: { type }, value: reportCounts[type] })),
			"counter",
		);

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

		// The in-process run counter (§6.9): boot counts run SETTLES from
		// `sigrun.job.run` commits in this process — reset on restart by
		// design; the alert's `increase(…[1h])` reads the deltas.
		family(
			"sigrun_job_runs_total",
			"Job runs settled by outcome since process start",
			[...opened.jobRunTotals()].map(([outcome, count]) => ({
				labels: { outcome },
				value: count,
			})),
			"counter",
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
