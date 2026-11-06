/**
 * Jobs-editor Task 3: the pure form-logic module
 * (`src/server/core-views/jobs-form.ts`) behind the jobs view's
 * "New job" form and `createJob` action.
 *
 * Pinned here:
 *
 * - `createSpecOf` assembles a `JobSpec` from the form values —
 *   schedule wholly form-owned (`{cron, timezone?}` / `{every}` /
 *   `{at}`; timezone rides cron only), prompt jobs always
 *   `conversation: "new"` (new jobs are prompt-only, the binding
 *   ruling), "Default" model/thinking omit the spec keys;
 * - validation failures map back to the FORM field (`name` /
 *   `description` / `schedule` / `timezone` / `prompt` / `model` /
 *   `thinking`; anything else is form-level, no field);
 * - `formValuesOf` reads the `{values}` submit envelope, treating an
 *   absent `enabled` as `true`.
 */

import { expect, test } from "vitest";
import type { JobWire } from "@sigrun/shared/jobs";
import {
	createSpecOf,
	emptyForm,
	formFieldOf,
	formFromJob,
	formValuesOf,
	savePatchOf,
} from "../src/server/core-views/jobs-form.js";

/** An api prompt job wire row (every 1h, prompt "old", conversation "new"), with overrides spread. */
function wireOf(overrides: Partial<JobWire>): JobWire {
	return {
		id: "api:acme-1",
		name: "acme-job",
		source: "api",
		schedule: { every: "1h" },
		action: { kind: "prompt", prompt: "old", conversation: "new" },
		enabled: true,
		state: "waiting",
		version: 1,
		access: "write",
		...overrides,
	};
}

test("createSpecOf assembles a cron prompt job with conversation new", () => {
	const result = createSpecOf({
		...emptyForm(),
		name: "acme-nightly",
		schedule: "0 9 * * 1-5",
		timezone: "America/St_Johns",
		prompt: "say ok",
		model: "acme/m1",
		thinking: "low",
	});
	expect(result).toEqual({
		ok: true,
		spec: {
			name: "acme-nightly",
			schedule: { cron: "0 9 * * 1-5", timezone: "America/St_Johns" },
			action: {
				kind: "prompt",
				prompt: "say ok",
				model: "acme/m1",
				thinking: "low",
				conversation: "new",
			},
			enabled: true,
		},
	});
});

test("Default model and thinking are omitted; every ignores the timezone", () => {
	const result = createSpecOf({
		...emptyForm(),
		name: "acme-every",
		scheduleType: "every",
		schedule: "15m",
		timezone: "America/St_Johns",
		prompt: "say ok",
	});
	expect(result.ok && result.spec.schedule).toEqual({ every: "15m" });
	expect(result.ok && "model" in result.spec.action).toBe(false);
});

test("validation failures map to form fields", () => {
	expect(
		createSpecOf({
			...emptyForm(),
			name: "Bad Name",
			schedule: "15m",
			scheduleType: "every",
			prompt: "x",
		}),
	).toMatchObject({ ok: false, field: "name" });
	expect(
		createSpecOf({
			...emptyForm(),
			name: "acme-x",
			schedule: "0 25 * * *",
			prompt: "x",
		}),
	).toMatchObject({ ok: false, field: "schedule" });
	expect(formFieldOf("action.kind")).toBeUndefined();
});

test("formValuesOf reads the {values} envelope; an absent enabled means true", () => {
	const values = formValuesOf({
		values: {
			name: "acme-x",
			scheduleType: "every",
			schedule: "15m",
			prompt: "say ok",
			model: "default",
			thinking: "default",
		},
	});
	expect(values).toEqual({
		...emptyForm(),
		name: "acme-x",
		scheduleType: "every",
		schedule: "15m",
		prompt: "say ok",
	});
	expect(values.enabled).toBe(true);
	// An explicit false survives.
	expect(formValuesOf({ values: { enabled: false } }).enabled).toBe(false);
	// The plain-object (no envelope) shape resolves too.
	expect(formValuesOf({ name: "acme-y", enabled: false }).name).toBe("acme-y");
});

test("save keeps conversation, deliver and runSharing", () => {
	const prior = wireOf({
		action: {
			kind: "prompt",
			prompt: "old",
			conversation: 42,
			runSharing: { scope: "people", users: ["acme-bob"], level: "read" },
		},
	});
	const result = savePatchOf({ ...formFromJob(prior), prompt: "new" }, prior);
	expect(result.ok && result.patch.action).toEqual({
		kind: "prompt",
		prompt: "new",
		conversation: 42,
		runSharing: { scope: "people", users: ["acme-bob"], level: "read" },
	});
});

test("save keeps deliver on a conversation-new job", () => {
	const prior = wireOf({
		action: {
			kind: "prompt",
			prompt: "old",
			conversation: "new",
			deliver: ["acme:chan"],
		},
	});
	const result = savePatchOf({ ...formFromJob(prior), prompt: "new" }, prior);
	expect(result.ok && result.patch.action).toEqual({
		kind: "prompt",
		prompt: "new",
		conversation: "new",
		deliver: ["acme:chan"],
	});
});

test("switching cron to every drops the timezone", () => {
	const prior = wireOf({
		schedule: { cron: "0 9 * * *", timezone: "America/St_Johns" },
	});
	const result = savePatchOf(
		{ ...formFromJob(prior), scheduleType: "every", schedule: "15m" },
		prior,
	);
	expect(result.ok && result.patch.schedule).toEqual({ every: "15m" });
});

test("a task job's patch carries no action", () => {
	const prior = wireOf({
		action: { kind: "task", task: "acme-task", input: { a: 1 } },
	});
	const result = savePatchOf(
		{ ...formFromJob(prior), name: "acme-renamed" },
		prior,
	);
	expect(result.ok && "action" in result.patch).toBe(false);
	expect(result.ok && result.patch.name).toBe("acme-renamed");
});
