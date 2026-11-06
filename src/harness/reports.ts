/**
 * pi-durable 1.5.0 `HarnessOptions.onReport` visibility (D5).
 *
 * Reports can arrive DURING `Harness.open`, before a Harness exists for
 * follow-up work. This collector is therefore synchronous and small: count
 * and log immediately. It never reads transcripts, and no failure in
 * logging or an observer can escape into pi-durable.
 */

import type { Report, ReportInfo, ReportTask } from "@earendil-works/pi-durable";

/** The report vocabulary is derived from pi-durable, not mirrored as a type. */
export type ReportKind = ReportInfo["kind"];

export const REPORT_KINDS: readonly ReportKind[] = [
	"storage_failed",
	"task_faulted",
	"task_interrupted",
	"migration_failed",
	"task_outdated",
	"task_error",
	"extension_error",
	"host_error",
	"listener_error",
];

const MESSAGE_LIMIT = 500;

/** A message without a throw of its own (unknown values can be hostile). */
function errorMessage(error: unknown): string {
	try {
		if (error instanceof Error) return error.message;
	} catch {
		// A cross-realm/hostile error can reject instanceof; fall through.
	}
	try {
		return String(error);
	} catch {
		return Object.prototype.toString.call(error);
	}
}

/** One structured log field. JSON quoting keeps newlines out of the line. */
function field(name: string, value: unknown): string {
	return `${name}=${JSON.stringify(value)}`;
}

/** Format one report without exposing transcript content or ordinary stacks. */
function formatReport(report: Report): string {
	const fields: Array<readonly [name: string, value: unknown]> = [];
	if ("task" in report && report.task !== undefined) {
		fields.push(["task", report.task.id], ["kind", report.task.kind], ["conversation", report.task.conversationId]);
	}
	if ("extension" in report && report.extension !== undefined) {
		fields.push(["extension", report.extension]);
	}
	if ("conversationId" in report && report.conversationId !== undefined) {
		fields.push(["conversation", report.conversationId]);
	}
	if ("callback" in report) fields.push(["callback", report.callback]);
	if ("reason" in report) fields.push(["reason", report.reason]);
	fields.push(["message", errorMessage(report.error).slice(0, MESSAGE_LIMIT)]);
	if (report.kind === "storage_failed" && report.error instanceof Error && report.error.stack !== undefined) {
		fields.push(["stack", report.error.stack]);
	}
	return [
		`sigrun: durable ${report.kind}`,
		...fields.map(([name, value]) => field(String(name), value)),
	].join(" ");
}

/** A restart-limited report's listener (boot registers it after open). */
export type RestartLimitedListener = (task: ReportTask) => void;

/**
 * The restart-limit predicate (D2). Schedules are an extension task
 * kind, so a restart-limited schedule arrives as `task_faulted` (reason
 * `restart_limit`); `task_interrupted` is the built-in tasks' spelling.
 * Checked FIRST, before anything else.
 */
function isRestartLimited(report: Report): report is Report & { task: ReportTask } {
	return (
		(report.kind === "task_faulted" || report.kind === "task_interrupted") &&
		report.reason === "restart_limit"
	);
}

/** Create the one process-local report collector passed to Harness.open. */
export function createDurableReports(opts: {
	log: (line: string) => void;
	onReport?: (report: Report) => void;
}): {
	onReport(report: Report): void;
	counts(): Readonly<Record<ReportKind, number>>;
	/** The queued restart-limited reports (drained by boot after open). */
	takeRestartLimited(): readonly ReportTask[];
	/**
	 * Register the restart-limited listener. Queued reports drain to it
	 * via `setImmediate`; each later report is delivered the same way.
	 * The collector NEVER calls the Harness from inside `onReport` (that
	 * runs inside Session machinery) — delivery is always deferred.
	 */
	onRestartLimited(listener: RestartLimitedListener): void;
} {
	const totals = Object.fromEntries(REPORT_KINDS.map((kind) => [kind, 0])) as Record<ReportKind, number>;
	let queued: ReportTask[] = [];
	let listener: RestartLimitedListener | undefined;
	let drainScheduled = false;
	const scheduleDrain = (): void => {
		if (drainScheduled) return;
		drainScheduled = true;
		setImmediate(() => {
			drainScheduled = false;
			const sink = listener;
			if (sink === undefined) return;
			const batch = queued;
			queued = [];
			for (const task of batch) {
				try {
					sink(task);
				} catch (error) {
					console.error("reports: restart-limited listener failed:", error);
				}
			}
		});
	};
	return {
		onReport(report): void {
			// Count and log before observing: a throwing sink cannot lose the
			// report, and pi-durable never receives a callback exception.
			totals[report.kind] += 1;
			try {
				opts.log(formatReport(report));
			} catch {
				// A host log sink is not allowed to fail durable scheduling.
			}
			// The restart-limit queue: the predicate is checked FIRST. Only
			// the ReportTask is queued — the collector never touches the
			// Harness; the listener (registered by boot after open) owns all
			// follow-up reads/commits.
			if (isRestartLimited(report)) {
				queued.push(report.task);
				if (listener !== undefined) scheduleDrain();
			}
			try {
				opts.onReport?.(report);
			} catch {
				// Test/observer seams have the same containment rule.
			}
		},
		counts(): Readonly<Record<ReportKind, number>> {
			return { ...totals };
		},
		takeRestartLimited(): readonly ReportTask[] {
			return [...queued];
		},
		onRestartLimited(sink: RestartLimitedListener): void {
			listener = sink;
			if (queued.length > 0) scheduleDrain();
		},
	};
}
