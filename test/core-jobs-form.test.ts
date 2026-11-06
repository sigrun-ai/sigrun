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
import {
	createSpecOf,
	emptyForm,
	formFieldOf,
	formValuesOf,
} from "../src/server/core-views/jobs-form.js";

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
