/**
 * Jobs-editor Task 3: the pure form logic behind the jobs view's
 * "New job" form — the values shape, the field list, the submit
 * envelope read, and the spec assembly. No I/O here: `jobs.ts` owns
 * the surface (the `{edit: true}` params branch, the `createJob`
 * action) and this module owns the form's content.
 *
 * - `JobFormData.model`/`thinking` carry `"default"` (NOT `""`) — it
 *   is the choice field's option id AND the omission sentinel
 *   (`createSpecOf` drops the spec keys for it).
 * - The schedule is wholly form-owned: `scheduleType` picks the shape
 *   (`{cron, timezone?}` / `{every}` / `{at}`) and `schedule` carries
 *   the single text value; `timezone` rides cron only.
 * - New jobs are prompt-only with `conversation: "new"` (the binding
 *   ruling) — the kind param exists for the edit shape (Task 4), whose
 *   field list differs only in the action column.
 */

import type { JsonObject } from "@sigrun/shared/blocks";
import type { JobSpec, JobWire } from "@sigrun/shared/jobs";
import { NAME_PATTERN, validateJobSpec } from "../../jobs/spec.js";

/** The form's values shape (the `/form` branch of the data document). */
export interface JobFormData {
	name: string;
	description: string;
	scheduleType: "cron" | "every" | "at";
	schedule: string;
	timezone: string;
	prompt: string;
	model: string;
	thinking: string;
	enabled: boolean;
}

/** The thinking choice's options ("default" labels as Default). */
export const THINKING_OPTIONS: readonly string[] = [
	"default",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** A new job's seeded values (bound at `/form`). */
export function emptyForm(): JobFormData {
	return {
		name: "",
		description: "",
		scheduleType: "cron",
		schedule: "",
		timezone: "",
		prompt: "",
		model: "default",
		thinking: "default",
		enabled: true,
	};
}

/**
 * An existing job's form values (the Task-4 edit seed; Task 3 creates
 * only, but the shape ships here). Name stays editable on the field
 * list; model/thinking absent ⇒ `"default"`.
 */
export function formFromJob(job: Omit<JobWire, "access">): JobFormData {
	const schedule = job.schedule;
	const action = job.action;
	return {
		name: job.name,
		description: job.description ?? "",
		scheduleType: "cron" in schedule ? "cron" : "every" in schedule ? "every" : "at",
		schedule:
			"cron" in schedule
				? schedule.cron
				: "every" in schedule
					? schedule.every
					: schedule.at,
		timezone: "cron" in schedule ? (schedule.timezone ?? "") : "",
		prompt: action.kind === "prompt" ? action.prompt : "",
		model:
			action.kind === "prompt" && action.model !== undefined
				? action.model
				: "default",
		thinking:
			action.kind === "prompt" && action.thinking !== undefined
				? action.thinking
				: "default",
		enabled: job.enabled,
	};
}

/** Whether `value` is a plain object. */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * The submitted form values: form dispatches wrap the fields as
 * `{values: {...}}` (the webui FormBlock contract — the `fieldOf`
 * convention in skills.ts); a plain object resolves too. An ABSENT
 * `enabled` reads `true` (the toggle defaults on; a disabled/absent
 * field never rides the envelope).
 */
export function formValuesOf(payload: unknown): JobFormData {
	const source = isObject(payload) && isObject(payload.values) ? payload.values : payload;
	const record = isObject(source) ? source : {};
	const scheduleType = record.scheduleType;
	return {
		name: stringOf(record.name),
		description: stringOf(record.description),
		scheduleType:
			scheduleType === "every" || scheduleType === "at" ? scheduleType : "cron",
		schedule: stringOf(record.schedule),
		timezone: stringOf(record.timezone),
		prompt: stringOf(record.prompt),
		model: stringOf(record.model) || "default",
		thinking: stringOf(record.thinking) || "default",
		enabled: typeof record.enabled === "boolean" ? record.enabled : true,
	};
}

/**
 * Map a `validateJobSpec` field path onto the form's field (the
 * field-scoped action error). Unknown paths are FORM-LEVEL (no field).
 */
export function formFieldOf(path: string): string | undefined {
	switch (path) {
		case "name":
			return "name";
		case "description":
			return "description";
		case "schedule":
		case "schedule.cron":
		case "schedule.every":
		case "schedule.at":
			return "schedule";
		case "schedule.timezone":
			return "timezone";
		case "action.prompt":
			return "prompt";
		case "action.model":
			return "model";
		case "action.thinking":
			return "thinking";
		default:
			return undefined;
	}
}

/**
 * The schedule assembly shared by create and edit-save (review fix:
 * extracted so the rule can never drift between the two) — wholly
 * form-owned: `scheduleType` picks the shape (`{cron, timezone?}` /
 * `{every}` / `{at}`) and `schedule` carries the single text value;
 * `timezone` rides cron only.
 */
function scheduleOf(values: JobFormData): JobSpec["schedule"] {
	return values.scheduleType === "every"
		? { every: values.schedule.trim() }
		: values.scheduleType === "at"
			? { at: values.schedule.trim() }
			: values.timezone.trim() === ""
				? { cron: values.schedule.trim() }
				: { cron: values.schedule.trim(), timezone: values.timezone.trim() };
}

/**
 * Assemble the `JobSpec` for `createApi` from the form values, or
 * reject with the field-scoped failure. New jobs are prompt-only with
 * `conversation: "new"`; the `"default"` model/thinking omit the spec
 * keys (the server default applies).
 */
export function createSpecOf(
	values: JobFormData,
): { ok: true; spec: JobSpec } | { ok: false; field: string; message: string } {
	const schedule = scheduleOf(values);
	const spec: JobSpec = {
		name: values.name,
		...(values.description.trim() === ""
			? {}
			: { description: values.description.trim() }),
		schedule,
		action: {
			kind: "prompt",
			prompt: values.prompt,
			...(values.model === "default" ? {} : { model: values.model }),
			...(values.thinking === "default" ? {} : { thinking: values.thinking }),
			conversation: "new",
		},
		enabled: values.enabled,
	};
	const validated = validateJobSpec(spec);
	if (!validated.ok) {
		return {
			ok: false,
			field: formFieldOf(validated.field) ?? validated.field,
			message: validated.message,
		};
	}
	return { ok: true, spec: validated.spec };
}

/**
 * The edit-save patch (jobs-editor Task 4, spec §4 save rules).
 *
 * `updateApi` merges ONE level deep (`{...prior.spec, ...patch}`), so
 * every key the patch carries must be the WHOLE desired value:
 *
 * - the schedule is wholly form-owned (assembled from `scheduleType`
 *   + `schedule` + `timezone`; switching type leaves no second
 *   discriminant — cron→every drops the timezone);
 * - a PROMPT job's action is `{...prior.action, prompt}` with
 *   `model`/`thinking` set from the form or DELETED for `"default"`
 *   (never a fresh literal — `conversation`, `runSharing`, `deliver`
 *   carry over untouched);
 * - a TASK job's patch carries NO `action` key at all (the editor
 *   hides prompt/model/thinking; task + input carry over);
 * - an emptied description becomes an OWN KEY `description: undefined`
 *   after validation, so the spread overrides the prior value and the
 *   stored record + hash drop it.
 *
 * For field-scoped errors the patch is spread over the prior spec
 * (rebuilt from the flattened wire row — owner is not part of a spec)
 * and the MERGED object is validated with `validateJobSpec`.
 */
export function savePatchOf(
	values: JobFormData,
	prior: Omit<JobWire, "access">,
): { ok: true; patch: Partial<JobSpec> & { enabled?: boolean } } | { ok: false; field?: string; message: string } {
	const schedule = scheduleOf(values);

	const patch: Partial<JobSpec> & { enabled?: boolean } = {
		name: values.name,
		schedule,
		enabled: values.enabled,
	};
	if (prior.action.kind === "prompt") {
		const action = { ...prior.action, prompt: values.prompt };
		if (values.model === "default") {
			delete action.model;
		} else {
			action.model = values.model;
		}
		if (values.thinking === "default") {
			delete action.thinking;
		} else {
			action.thinking = values.thinking;
		}
		patch.action = action;
	}

	// Field-scoped validation on the MERGED spec (the wire is
	// flattened; owner lives on the record, not the spec).
	const priorSpec: JobSpec = {
		name: prior.name,
		...(prior.description === undefined
			? {}
			: { description: prior.description }),
		schedule: prior.schedule,
		action: prior.action,
		...(prior.sharing === undefined ? {} : { sharing: prior.sharing }),
		enabled: prior.enabled,
	};
	const merged: JobSpec = {
		...priorSpec,
		...patch,
		...(values.description.trim() === ""
			? {}
			: { description: values.description.trim() }),
	};
	const validated = validateJobSpec(merged);
	if (!validated.ok) {
		return {
			ok: false,
			field: formFieldOf(validated.field),
			message: validated.message,
		};
	}
	// Only AFTER validation does the cleared description land as the
	// own key whose undefined value the spread + JSON round-trip drop.
	if (values.description.trim() === "") {
		patch.description = undefined;
	} else {
		patch.description = values.description.trim();
	}
	return { ok: true, patch };
}

/**
 * The form's field list (the same for new and edit; Name stays
 * editable). For `kind: "task"` the prompt/model/thinking fields are
 * omitted (a task job names a task id instead — Task 4's edit shape).
 */
export function jobFormFields(kind: "prompt" | "task"): JsonObject[] {
	const fields: JsonObject[] = [
		{
			type: "text",
			name: "name",
			label: "Name",
			required: true,
			pattern: NAME_PATTERN.source,
			help: "lowercase letters, digits, dot, dash, underscore",
		},
		{
			type: "text",
			name: "description",
			label: "Description",
		},
		{
			type: "choice",
			name: "scheduleType",
			label: "Schedule type",
			options: [
				{ id: "cron", label: "Cron" },
				{ id: "every", label: "Every" },
				{ id: "at", label: "Once" },
			],
		},
		{
			type: "text",
			name: "schedule",
			label: "Schedule",
			required: true,
			help: "Cron: 0 9 * * 1-5 · Every: 15m or 2h (60s minimum) · Once: an ISO date-time",
		},
		{
			type: "text",
			name: "timezone",
			label: "Timezone",
			help: "Cron only, e.g. America/Toronto; empty = server timezone",
		},
	];
	if (kind === "prompt") {
		fields.push(
			{
				type: "longtext",
				name: "prompt",
				label: "Prompt",
				required: true,
				syntax: "markdown",
				rows: 10,
			},
			{
				type: "choice",
				name: "model",
				label: "Model",
				options: { $: "/modelOptions" },
			},
			{
				type: "choice",
				name: "thinking",
				label: "Thinking",
				options: THINKING_OPTIONS.map((level) => ({
					id: level,
					label: level === "default" ? "Default" : level,
				})),
			},
		);
	}
	fields.push({
		type: "toggle",
		name: "enabled",
		label: "Enabled",
		default: true,
	});
	return fields;
}
