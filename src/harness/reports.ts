/**
 * pi-durable 1.5.0 `HarnessOptions.onReport` visibility (D5).
 *
 * Reports can arrive DURING `Harness.open`, before a Harness exists for
 * follow-up work. This collector is therefore synchronous and small: count
 * and log immediately. It never reads transcripts, and no failure in
 * logging or an observer can escape into pi-durable.
 */

import type { Report, ReportInfo } from "@earendil-works/pi-durable";

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
	const info = report as ReportInfo;
	const fields: Array<readonly [name: string, value: unknown]> = [];
	if ("task" in info && info.task !== undefined) {
		fields.push(["task", info.task.id], ["kind", info.task.kind], ["conversation", info.task.conversationId]);
	}
	if ("extension" in info && info.extension !== undefined) {
		fields.push(["extension", info.extension]);
	}
	if ("conversationId" in info && info.conversationId !== undefined) {
		fields.push(["conversation", info.conversationId]);
	}
	if ("callback" in info) fields.push(["callback", info.callback]);
	if ("reason" in info) fields.push(["reason", info.reason]);
	fields.push(["message", errorMessage(report.error).slice(0, MESSAGE_LIMIT)]);
	if (report.kind === "storage_failed" && report.error instanceof Error && report.error.stack !== undefined) {
		fields.push(["stack", report.error.stack]);
	}
	return [
		`sigrun: durable ${report.kind}`,
		...fields.map(([name, value]) => field(String(name), value)),
	].join(" ");
}

/** Create the one process-local report collector passed to Harness.open. */
export function createDurableReports(opts: {
	log: (line: string) => void;
	onReport?: (report: Report) => void;
}): {
	onReport(report: Report): void;
	counts(): Readonly<Record<ReportKind, number>>;
} {
	const totals = Object.fromEntries(REPORT_KINDS.map((kind) => [kind, 0])) as Record<ReportKind, number>;
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
			try {
				opts.onReport?.(report);
			} catch {
				// Test/observer seams have the same containment rule.
			}
		},
		counts(): Readonly<Record<ReportKind, number>> {
			return { ...totals };
		},
	};
}
