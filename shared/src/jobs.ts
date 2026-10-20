/**
 * §8.2 job wire types — THE jobs channel contract.
 *
 * Part of the shared leaf package (`@sigrun/shared`): the server owns
 * the runtime half (src/jobs/* — validation, schedule math) and both
 * clients (webui, tui) import these types directly. Like every wire
 * module, imports are TYPE-ONLY from sibling shared modules (the
 * views-purity guard enforces this), so the module erases at compile
 * time and contributes no runtime.
 *
 * The shapes follow spec §8.2's schedule/action grammar verbatim:
 * a schedule is exactly one of a 5-field `cron` (with an optional IANA
 * `timezone`, defaulting to the server timezone), an `every` interval
 * (`^\\d+(s|m|h|d)$`, minimum 60 s), or a one-shot ISO 8601 `at`; an
 * action is a `prompt` (optionally pinning the model/thinking of a NEW
 * conversation, or targeting a fixed conversation id) or a `task`
 * (a registered extension task name plus optional JSON input).
 */

import type { Sharing } from "./access.js";
import type { JsonValue } from "./json.js";

// The task action's `input` rides the wire inside this module's shapes;
// re-exported (type-only, erased at compile) so the server-side
// validator resolves it from the same contract entry point.
export type { JsonValue };

/** When a job fires: a cron (5-field, TZ-aware), an interval, or one instant. */
export type JobSchedule =
	| { cron: string; timezone?: string }
	| { every: string }
	| { at: string };

/** What a job does when it fires (spec §8.2). */
export type JobAction =
	| {
			kind: "prompt";
			prompt: string;
			model?: string;
			thinking?: string;
			conversation: "new" | number;
			runSharing?: Sharing;
	  }
	| { kind: "task"; task: string; input?: JsonValue };

/** A job's declared shape — what every source (api/file/extension) supplies. */
export interface JobSpec {
	name: string;
	schedule: JobSchedule;
	action: JobAction;
	overlap?: "skip" | "queue";
	catchUp?: "once" | "none";
	enabled?: boolean;
	owner?: string;
	sharing?: Sharing;
}

/** One job as `GET /v1/jobs` serves it (the list row and the detail). */
export interface JobWire {
	id: string;
	name: string;
	source: "api" | "file" | "extension";
	owner?: string;
	sharing?: Sharing;
	schedule: JobSchedule;
	action: JobAction;
	enabled: boolean;
	state: "waiting" | "firing" | "disabled" | "blocked";
	reason?: string;
	version: number;
	nextRun?: string;
	lastRun?: JobRunWire;
	lastError?: string;
	access: "read" | "write";
}

/** One fire of a job, as the job's `lastRun` copy serves it. */
export interface JobRunWire {
	jobId: string;
	version: number;
	fireAt: string;
	manual: boolean;
	conversationId?: number;
	taskId?: number;
	outcome: "running" | "succeeded" | "failed" | "skipped";
	startedAt: string;
	settledAt?: string;
	error?: string;
}

/**
 * One immutable revision of a job (`sigrun.job.revision`, keyed
 * `<jobId>:<version>`): the spec exactly as it stood at that version.
 */
export interface JobRevisionWire {
	jobId: string;
	version: number;
	source: "api" | "file" | "extension";
	spec: JobSpec;
	owner?: string;
	sharing?: Sharing;
	enabled: boolean;
	changedAt: string;
	changedBy: string;
}
