/**
 * JobsPanel (W4 Task 5, spec §8.4): the right-panel jobs tab — the
 * caller-visible jobs with run-now.
 *
 * - One row per job (`GET /v1/jobs`, access-stamped): name, schedule
 *   summary, next run, last run outcome, and a link into the last run's
 *   conversation. "Run now" appears only on `access === "write"` rows
 *   (`POST /v1/jobs/:id/run`); the fire answer surfaces in the row.
 * - Expanding a row lazily fetches and caches its history —
 *   `GET …/runs` (newest first: when, version, manual, outcome, error,
 *   the run conversation link) and `GET …/revisions` (newest first:
 *   version, changedAt, changedBy, and the revision's JSON spec diffed
 *   against the PREVIOUS revision through the interaction `diff`
 *   primitive's styling — the same before/after panes the interaction
 *   cards render).
 * - Freshness rides the app's shared `/v1/events` source (owned by
 *   `useConversationList`): App bumps `refreshToken` on `job.changed`
 *   and this panel refetches the list. The panel itself NEVER opens an
 *   EventSource — one per app, per the W3 events-stream rule.
 */

import { useEffect, useState, type ReactNode } from "react";
import type {
	JobRevisionWire,
	JobRunWire,
	JobWire,
	SigrunClient,
} from "../api";

/** One schedule's summary text: cron (+ timezone), interval, or instant. */
function scheduleSummary(job: JobWire): string {
	if ("cron" in job.schedule) {
		return job.schedule.timezone === undefined
			? job.schedule.cron
			: `${job.schedule.cron} (${job.schedule.timezone})`;
	}
	if ("every" in job.schedule) {
		return `every ${job.schedule.every}`;
	}
	return `at ${job.schedule.at}`;
}

/** One expanded job's fetched history. */
interface JobHistory {
	readonly runs: readonly JobRunWire[];
	readonly revisions: readonly JobRevisionWire[];
}

export function JobsPanel(props: {
	readonly client: SigrunClient;
	/** Navigate to a conversation (App's conversation switcher). */
	readonly onNavigate?: (conversationId: number) => void;
	/**
	 * Refetch token: App increments it on every `job.changed` host event
	 * (the shared events source — see the module comment). Stable across
	 * renders otherwise.
	 */
	readonly refreshToken?: number;
}) {
	const { client, onNavigate, refreshToken = 0 } = props;
	const [jobs, setJobs] = useState<readonly JobWire[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Readonly<Record<string, true>>>(
		{},
	);
	// The expanded rows' fetched history, keyed by job id.
	const [history, setHistory] = useState<
		Readonly<Record<string, JobHistory>>
	>({});
	// The latest run-now answer per job id (the row surfaces the outcome).
	const [runOutcome, setRunOutcome] = useState<
		Readonly<Record<string, string>>
	>({});

	// The list load: on mount and on every refreshToken bump (job.changed).
	useEffect(() => {
		let cancelled = false;
		client
			.listJobs()
			.then((response) => {
				if (cancelled) return;
				setJobs(response.jobs);
				setError(null);
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [client, refreshToken]);

	// The expanded rows' history: fetch once per job, cache the result
	// (re-expand after collapse does not refetch — the workspace tree rule).
	useEffect(() => {
		let cancelled = false;
		const missing = Object.entries(expanded).filter(
			([id, open]) => open === true && history[id] === undefined,
		);
		for (const [id] of missing) {
			void (async () => {
				try {
					const [runs, revisions] = await Promise.all([
						client.listJobRuns(id),
						client.listJobRevisions(id),
					]);
					if (cancelled) return;
					setHistory((previous) => ({
						...previous,
						[id]: { runs: runs.runs, revisions: revisions.revisions },
					}));
				} catch (cause) {
					if (cancelled) return;
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			})();
		}
		return () => {
				cancelled = true;
		};
	}, [client, expanded, history]);

	async function toggleRow(job: JobWire): Promise<void> {
		setExpanded((previous) => {
			const next = { ...previous };
			if (next[job.id] === true) delete next[job.id];
			else next[job.id] = true;
			return next;
		});
	}

	async function runNow(job: JobWire): Promise<void> {
		try {
			const response = await client.runJob(job.id);
			setRunOutcome((previous) => ({
				...previous,
				[job.id]: response.outcome,
			}));
			setError(null);
			// The fired job's row refreshes with the run record when
			// `job.changed` lands (the token bump refetches the list).
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	/** A conversation link (the last-run and per-run rows share the shape). */
	const conversationLink = (
		conversationId: number,
		label: string,
	): ReactNode => (
		<button
			type="button"
			className="job-conversation"
			aria-label={label}
			title={`conversation #${conversationId}`}
			onClick={() => onNavigate?.(conversationId)}
		>
			#{conversationId}
		</button>
	);

	const renderRuns = (job: JobWire, runs: readonly JobRunWire[]) => (
		<div className="job-runs" data-job-runs={job.id}>
			<h3 className="job-section-title">Runs</h3>
			{runs.length === 0 ? (
				<p className="job-empty">no runs yet</p>
			) : (
				runs.map((run) => (
					<div key={run.fireAt} className="job-run-row">
						<span className="job-run-when">{run.fireAt}</span>
						<span className="job-run-version">v{run.version}</span>
						{run.manual && <span className="job-run-manual">manual</span>}
						<span
							className="job-run-outcome"
							data-outcome={run.outcome}
						>
							{run.outcome}
						</span>
						{run.error !== undefined && (
							<span className="job-run-error" title={run.error}>
								{run.error}
							</span>
						)}
						{run.conversationId !== undefined &&
							conversationLink(run.conversationId, "open run conversation")}
					</div>
				))
			)}
		</div>
	);

	const renderRevisions = (
		job: JobWire,
		revisions: readonly JobRevisionWire[],
	) => (
		<div className="job-revisions" data-job-revisions={job.id}>
			<h3 className="job-section-title">Revisions</h3>
			{revisions.length === 0 ? (
				<p className="job-empty">no revisions</p>
			) : (
				revisions.map((revision, index) => {
					// The diff baseline: the NEXT-older revision (the list is
					// newest first); the oldest revision has none to diff
					// against, so it renders bare.
					const previous = revisions[index + 1];
					return (
						<div key={revision.version} className="job-revision-row">
							<div className="job-revision-meta">
								<span className="job-revision-version">
									v{revision.version}
								</span>
								<span className="job-revision-changedAt">
									{revision.changedAt}
								</span>
								<span className="job-revision-changedBy">
									{revision.changedBy}
								</span>
							</div>
							{previous !== undefined && (
								// The interaction diff primitive's styling: before =
								// the previous revision's spec, after = this one's.
								<div className="interaction-diff">
									<pre className="interaction-diff-before">
										{JSON.stringify(previous.spec, null, 2)}
									</pre>
									<pre className="interaction-diff-after">
										{JSON.stringify(revision.spec, null, 2)}
									</pre>
								</div>
							)}
						</div>
					);
				})
			)}
		</div>
	);

	return (
		<section className="jobs-panel" aria-label="jobs">
			<h2 className="workspace-title">Jobs</h2>
			{error !== null && <p role="alert">{error}</p>}
			{jobs === null && error === null ? (
				<p className="workspace-loading">loading…</p>
			) : jobs === null ? null : jobs.length === 0 ? (
				<p className="workspace-empty">No jobs</p>
			) : (
				<ul className="jobs-list">
					{jobs.map((job) => {
						const open = expanded[job.id] === true;
						const fetched = history[job.id];
						const outcome = runOutcome[job.id];
						return (
							<li key={job.id} className="job-row">
								<button
									type="button"
									className="job-summary"
									data-job-id={job.id}
									aria-expanded={open}
									onClick={() => void toggleRow(job)}
								>
									<span className="job-name">
										{open ? "▾" : "▸"} {job.name}
									</span>
									<span className="job-schedule">
										{scheduleSummary(job)}
									</span>
									<span className="job-next">
										{job.nextRun ?? "no next run"}
									</span>
									<span className="job-last">
										{outcome ?? job.lastRun?.outcome ?? "never run"}
									</span>
								</button>
								<div className="job-summary-side">
									{job.lastRun?.conversationId !== undefined &&
										conversationLink(
											job.lastRun.conversationId,
											"open last run conversation",
										)}
									{job.access === "write" && (
										<button
											type="button"
											className="job-runnow"
											onClick={() => void runNow(job)}
										>
											Run now
										</button>
									)}
								</div>
								{open && fetched !== undefined && (
									<div className="job-detail">
										{renderRuns(job, fetched.runs)}
										{renderRevisions(job, fetched.revisions)}
									</div>
								)}
								{open && fetched === undefined && (
									<p className="workspace-loading">loading…</p>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
