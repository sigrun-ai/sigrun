/**
 * §8.2 job-spec validation and hashing (jobs Task 1).
 *
 * Every job source — api (`POST /v1/jobs`), file (settings.json
 * `jobs[]`), extension (factory-result `jobs[]`) — funnels through
 * `validateJobSpec` before a job record exists; boot reconciliation
 * then compares `specHash` to decide whether a declared job's schedule
 * task may keep running (same hash) or must be recreated (changed).
 *
 * Validation maps every rejection to a `field` path so callers can
 * attribute the 400 to the offending input. Cron validation IS
 * croner's parse (`cronFor` in ./schedule.js — the constructor throws
 * on a bad 5-field pattern), so what the validator accepts is exactly
 * what the scheduler can evaluate; nothing is validated by a second
 * grammar that could drift.
 *
 * `specHash` canonicalizes (recursively sorted object keys) before
 * hashing, so key order — where the spec came from, which JSON parser
 * read it — never changes a job's identity.
 */

import { createHash } from "node:crypto";
import { isSharing } from "@sigrun/shared/access";
import type { JobAction, JobSpec, JsonValue } from "@sigrun/shared/jobs";
import { cronFor, parseEvery } from "./schedule.js";

/** Job names double as the file/extension id suffix (Global Constraints). */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** A validation rejection: the offending field path plus why. */
export interface InvalidJobSpec {
	ok: false;
	field: string;
	message: string;
}

type ValidationResult =
	| { ok: true; spec: JobSpec }
	| InvalidJobSpec;

/**
 * Refine `unknown` (a request body, a settings block, an extension
 * declaration) into a `JobSpec`, or reject with the first offending
 * field. The accepted spec is rebuilt field-by-field: only the
 * declared, validated fields survive, so extra keys in the input never
 * ride into the record (or into `specHash`).
 */
export function validateJobSpec(value: unknown): ValidationResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return invalid("spec", "a job spec must be an object");
	}
	const record = value as Record<string, unknown>;

	if (typeof record.name !== "string" || !NAME_PATTERN.test(record.name)) {
		return invalid(
			"name",
			`name must be a string matching ${NAME_PATTERN.source}`,
		);
	}

	const schedule = validateSchedule(record.schedule);
	if (!schedule.ok) return schedule;

	const action = validateAction(record.action);
	if (!action.ok) return action;

	if (record.overlap !== undefined && record.overlap !== "skip" && record.overlap !== "queue") {
		return invalid("overlap", 'overlap must be "skip" or "queue"');
	}
	if (record.catchUp !== undefined && record.catchUp !== "once" && record.catchUp !== "none") {
		return invalid("catchUp", 'catchUp must be "once" or "none"');
	}
	if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
		return invalid("enabled", "enabled must be a boolean");
	}
	if (record.owner !== undefined && typeof record.owner !== "string") {
		return invalid("owner", "owner must be a string");
	}
	if (record.sharing !== undefined && !isSharing(record.sharing)) {
		return invalid("sharing", "sharing must be a Sharing value");
	}

	const spec: JobSpec = {
		name: record.name,
		schedule: schedule.schedule,
		action: action.action,
	};
	if (record.overlap !== undefined) spec.overlap = record.overlap;
	if (record.catchUp !== undefined) spec.catchUp = record.catchUp;
	if (record.enabled !== undefined) spec.enabled = record.enabled;
	if (record.owner !== undefined) spec.owner = record.owner;
	if (record.sharing !== undefined) spec.sharing = record.sharing;
	return { ok: true, spec };
}

/**
 * sha256 of the canonical JSON (recursively key-sorted) of
 * `{ id, spec }` — one job version's identity, as boot reconciliation
 * compares it.
 */
export function specHash(id: string, spec: JobSpec): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalize({ id, spec })))
		.digest("hex");
}

function invalid(field: string, message: string): InvalidJobSpec {
	return { ok: false, field, message };
}

/**
 * A schedule is exactly ONE of the three shapes (the wire type is a
 * union): a schedule carrying two discriminants matches no member, so
 * it is rejected rather than silently dispatched on the first present.
 */
function validateSchedule(
	value: unknown,
): { ok: true; schedule: JobSpec["schedule"] } | InvalidJobSpec {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return invalid("schedule", "schedule must be an object");
	}
	const record = value as Record<string, unknown>;
	const discriminants = ["cron", "every", "at"].filter(
		(key) => record[key] !== undefined,
	);
	if (discriminants.length !== 1) {
		return invalid(
			"schedule",
			'schedule must carry exactly one of "cron", "every", or "at"',
		);
	}

	if (record.cron !== undefined) {
		if (typeof record.cron !== "string") {
			return invalid("schedule.cron", "cron must be a string");
		}
		if (record.timezone !== undefined) {
			if (typeof record.timezone !== "string") {
				return invalid("schedule.timezone", "timezone must be a string");
			}
			// croner validates the name lazily (at evaluation, not parse), so
			// the gate checks it here — a bad name would otherwise crash the
			// scheduler instead of rejecting the spec.
			if (!isIanaTimeZone(record.timezone)) {
				return invalid(
					"schedule.timezone",
					`timezone must be an IANA name (got ${JSON.stringify(record.timezone)})`,
				);
			}
		}
		try {
			cronFor(record.cron, record.timezone);
		} catch (error) {
			return invalid(
				"schedule.cron",
				error instanceof Error ? error.message : String(error),
			);
		}
		const schedule: JobSpec["schedule"] = { cron: record.cron };
		if (record.timezone !== undefined) schedule.timezone = record.timezone;
		return { ok: true, schedule };
	}

	if (record.every !== undefined) {
		if (typeof record.every !== "string") {
			return invalid("schedule.every", "every must be a string");
		}
		try {
			parseEvery(record.every);
		} catch (error) {
			return invalid(
				"schedule.every",
				error instanceof Error ? error.message : String(error),
			);
		}
		return { ok: true, schedule: { every: record.every } };
	}

	// The one remaining discriminant is "at".
	if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))) {
		return invalid("schedule.at", "at must be an ISO 8601 timestamp");
	}
	return { ok: true, schedule: { at: record.at } };
}

function validateAction(
	value: unknown,
): { ok: true; action: JobAction } | InvalidJobSpec {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return invalid("action", "action must be an object");
	}
	const record = value as Record<string, unknown>;

	if (record.kind === "prompt") {
		if (typeof record.prompt !== "string") {
			return invalid("action.prompt", "prompt must be a string");
		}
		if (
			record.conversation !== "new" &&
			!(
				typeof record.conversation === "number" &&
				Number.isInteger(record.conversation)
			)
		) {
			return invalid(
				"action.conversation",
				'conversation must be "new" or a conversation id',
			);
		}
		if (record.model !== undefined && typeof record.model !== "string") {
			return invalid("action.model", "model must be a string");
		}
		if (record.thinking !== undefined && typeof record.thinking !== "string") {
			return invalid("action.thinking", "thinking must be a string");
		}
		if (record.runSharing !== undefined && !isSharing(record.runSharing)) {
			return invalid("action.runSharing", "runSharing must be a Sharing value");
		}
		// Gateway C7 (spec §8.0): deliver targets ride ONLY new-conversation
		// prompt jobs — a conversation bound to a chat already delivers
		// there, so deliver on a fixed id is a spec error naming this field.
		// Shape-only: the target grammar belongs to the gateway.
		if (record.deliver !== undefined) {
			if (record.conversation !== "new") {
				return invalid(
					"action.deliver",
					'deliver requires conversation "new"',
				);
			}
			if (
				!Array.isArray(record.deliver) ||
				record.deliver.length < 1 ||
				record.deliver.length > 8 ||
				record.deliver.some(
					(target) =>
						typeof target !== "string" ||
						target.length < 1 ||
						target.length > 256,
				)
			) {
				return invalid(
					"action.deliver",
					"deliver must be an array of 1-8 strings, each 1-256 chars",
				);
			}
		}
		const action: Extract<JobAction, { kind: "prompt" }> = {
			kind: "prompt",
			prompt: record.prompt,
			// Guarded above: "new" or an integer conversation id.
			conversation: record.conversation as "new" | number,
		};
		if (record.model !== undefined) action.model = record.model;
		if (record.thinking !== undefined) action.thinking = record.thinking;
		if (record.runSharing !== undefined) action.runSharing = record.runSharing;
		if (record.deliver !== undefined) action.deliver = [...record.deliver];
		return { ok: true, action };
	}

	if (record.kind === "task") {
		if (typeof record.task !== "string") {
			return invalid("action.task", "task must be a string");
		}
		if (record.input !== undefined && !isJsonValue(record.input)) {
			return invalid("action.input", "input must be a JSON value");
		}
		const action: Extract<JobAction, { kind: "task" }> = {
			kind: "task",
			task: record.task,
		};
		if (record.input !== undefined) action.input = record.input;
		return { ok: true, action };
	}

	return invalid(
		"action.kind",
		`action.kind must be "prompt" or "task" (got ${JSON.stringify(record.kind)})`,
	);
}

/**
 * `Intl` accepts exactly the IANA names `DateTimeFormat` resolves —
 * the same resolver croner's evaluation path uses — and throws on
 * everything else.
 */
export function isIanaTimeZone(name: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: name });
		return true;
	} catch {
		return false;
	}
}

/** Structural JSON check for the `task` action's optional `input`. */
function isJsonValue(value: unknown): value is JsonValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true;
	}
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value === "object") {
		return Object.values(value).every(isJsonValue);
	}
	return false;
}

/**
 * The canonicalized mirror of a JSON value: same shape, every object's
 * keys sorted (and `undefined`-valued keys dropped — absent ≡ undefined).
 */
type Canonical =
	| string
	| number
	| boolean
	| null
	| Canonical[]
	| { [key: string]: Canonical };

/** Canonical form for hashing: key order never affects the digest. */
function canonicalize(value: unknown): Canonical {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const sorted: Record<string, Canonical> = {};
		for (const key of Object.keys(record).sort()) {
			if (record[key] === undefined) continue;
			sorted[key] = canonicalize(record[key]);
		}
		return sorted;
	}
	return value as Canonical;
}
