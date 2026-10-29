/**
 * pi-durable 1.4.0 `HarnessOptions.onReport` visibility (D5).
 *
 * Reports can arrive DURING `Harness.open`, before a Harness exists for
 * follow-up work. This collector is therefore synchronous and small: count
 * and log immediately; retain task_parked identities for boot's post-open
 * drain. It never reads transcripts, and no failure in logging or an
 * observer can escape into pi-durable.
 */

import type { ReportInfo, ReportTask } from "@earendil-works/pi-durable";

/** The report vocabulary is derived from pi-durable, not mirrored as a type. */
export type ReportType = ReportInfo["type"];

export const REPORT_TYPES: readonly ReportType[] = [
	"session_failed",
	"task_faulted",
	"task_parked",
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
function formatReport(error: unknown, info: ReportInfo): string {
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
	fields.push(["message", errorMessage(error).slice(0, MESSAGE_LIMIT)]);
	if (info.type === "session_failed" && error instanceof Error && error.stack !== undefined) {
		fields.push(["stack", error.stack]);
	}
	return [
		`sigrun: durable ${info.type}`,
		...fields.map(([name, value]) => field(String(name), value)),
	].join(" ");
}

/** Create the one process-local report collector passed to Harness.open. */
export function createDurableReports(opts: {
	log: (line: string) => void;
	onReport?: (error: unknown, info: ReportInfo) => void;
}): {
	onReport(error: unknown, info: ReportInfo): void;
	counts(): Readonly<Record<ReportType, number>>;
	takeParked(): readonly ReportTask[];
} {
	const totals = Object.fromEntries(REPORT_TYPES.map((type) => [type, 0])) as Record<ReportType, number>;
	let parked: ReportTask[] = [];
	return {
		onReport(error, info): void {
			// Count and queue before logging: a throwing sink cannot lose the
			// report, and pi-durable never receives a callback exception.
			totals[info.type] += 1;
			if (info.type === "task_parked") parked.push(info.task);
			try {
				opts.log(formatReport(error, info));
			} catch {
				// A host log sink is not allowed to fail durable scheduling.
			}
			try {
				opts.onReport?.(error, info);
			} catch {
				// Test/observer seams have the same containment rule.
			}
		},
		counts(): Readonly<Record<ReportType, number>> {
			return { ...totals };
		},
		takeParked(): readonly ReportTask[] {
			const drained = parked;
			parked = [];
			return drained;
		},
	};
}
