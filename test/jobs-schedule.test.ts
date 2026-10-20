/**
 * Jobs Task 1: job-spec validation and schedule math.
 *
 * `nextFireAt`/`parseEvery` (src/jobs/schedule.ts) and
 * `validateJobSpec`/`specHash` (src/jobs/spec.ts) are the foundation
 * every later jobs task computes with: the scheduler walks
 * `nextFireAt`, boot reconciliation compares `specHash`, and every job
 * source (api/file/extension) funnels through `validateJobSpec`.
 *
 * Cron semantics are croner's — spec §8.2: "Cron parsing uses croner
 * … DST is exactly the class of bug not to hand-roll". The DST case
 * PINS croner 10.0.1's measured gap behavior so a croner upgrade
 * cannot silently change it. Plan Review Focus 2's prose expected the
 * non-existent 02:30 slot to skip to the NEXT day (2026-03-09T06:30Z);
 * croner 10.0.1 instead resolves the nominal 02:30 EST slot to 03:30
 * EDT the SAME day (2026-03-08T07:30:00Z). Supervisor ruling 2026-10-20:
 * pin the measured value — the spec delegates DST to croner verbatim,
 * and the pin's purpose (upgrade drift detection) is served by the
 * real value.
 *
 * Hermeticity: every cron case passes an explicit timezone (either on
 * the schedule or as `defaultTz`), so the runner's process TZ cannot
 * move an expectation.
 */

import { describe, expect, it } from "vitest";
import type { JobSpec } from "@sigrun/shared/jobs";
import { specHash, validateJobSpec } from "../src/jobs/spec.js";
import { nextFireAt, parseEvery } from "../src/jobs/schedule.js";

/** The spec §8.2 example job, verbatim (the ellipsis is the spec's). */
const morningBrief = {
	name: "morning-brief",
	schedule: { cron: "0 7 * * *", timezone: "America/Toronto" },
	action: {
		kind: "prompt",
		prompt: "Summarize …",
		model: "bifrost/glm-5.3-flash",
		thinking: "low",
		conversation: "new",
	},
	overlap: "skip",
	catchUp: "once",
	enabled: true,
} satisfies JobSpec;

describe("nextFireAt", () => {
	it("advances a Toronto cron to the next 07:00 wall-clock slot (EDT)", () => {
		expect(
			nextFireAt(
				{ cron: "0 7 * * *", timezone: "America/Toronto" },
				Date.parse("2026-10-19T12:00:00Z"),
				"UTC",
			),
		).toBe(Date.parse("2026-10-20T11:00:00Z"));
	});

	it("falls back to the server default timezone when the schedule omits one", () => {
		expect(
			nextFireAt(
				{ cron: "0 7 * * *" },
				Date.parse("2026-10-19T12:00:00Z"),
				"America/Toronto",
			),
		).toBe(Date.parse("2026-10-20T11:00:00Z"));
	});

	it("pins croner's DST spring-forward slot (02:30 America/New_York on 2026-03-08 does not exist)", () => {
		// See the module header: croner 10.0.1 maps the skipped slot to
		// 03:30 EDT the same day, not the next day's 02:30.
		expect(
			nextFireAt(
				{ cron: "30 2 * * *", timezone: "America/New_York" },
				Date.parse("2026-03-07T12:00:00Z"),
				"UTC",
			),
		).toBe(Date.parse("2026-03-08T07:30:00Z"));
	});

	it("fires an every-interval from `after` (never from a missed slot)", () => {
		const t = Date.parse("2026-10-19T12:00:00Z");
		expect(nextFireAt({ every: "15m" }, t, "UTC")).toBe(t + 900_000);
	});

	it("returns undefined for a one-shot already past", () => {
		expect(
			nextFireAt(
				{ at: "2026-10-19T00:00:00Z" },
				Date.parse("2026-10-19T12:00:00Z"),
				"UTC",
			),
		).toBeUndefined();
	});

	it("returns the instant for a one-shot still ahead", () => {
		expect(
			nextFireAt(
				{ at: "2026-10-20T00:00:00Z" },
				Date.parse("2026-10-19T12:00:00Z"),
				"UTC",
			),
		).toBe(Date.parse("2026-10-20T00:00:00Z"));
	});
});

describe("parseEvery", () => {
	it("parses unit suffixes into milliseconds", () => {
		expect(parseEvery("15m")).toBe(900_000);
		expect(parseEvery("1h")).toBe(3_600_000);
	});

	it("throws below the 60 s floor", () => {
		expect(() => parseEvery("30s")).toThrow();
	});

	it("throws on malformed interval text", () => {
		expect(() => parseEvery("15x")).toThrow();
	});
});

describe("validateJobSpec", () => {
	it("accepts the spec §8.2 example", () => {
		expect(validateJobSpec(morningBrief)).toEqual({ ok: true, spec: morningBrief });
	});

	it("rejects a name outside the job-name grammar", () => {
		expect(
			validateJobSpec({ ...morningBrief, name: "Morning Brief" }),
		).toMatchObject({ ok: false, field: "name" });
	});

	it("rejects an out-of-range cron via croner's constructor", () => {
		expect(
			validateJobSpec({ ...morningBrief, schedule: { cron: "0 25 * * *" } }),
		).toMatchObject({ ok: false, field: "schedule.cron" });
	});

	it("rejects a 6-field cron (schedules are 5-field)", () => {
		expect(
			validateJobSpec({ ...morningBrief, schedule: { cron: "0 0 7 * * *" } }),
		).toMatchObject({ ok: false, field: "schedule.cron" });
	});

	it("rejects an unknown action kind", () => {
		expect(
			validateJobSpec({ ...morningBrief, action: { kind: "email", to: "a@b.c" } }),
		).toMatchObject({ ok: false, field: "action.kind" });
	});
});

describe("specHash", () => {
	it("is stable across key order", () => {
		const shuffled = {
			enabled: true,
			catchUp: "once",
			overlap: "skip",
			action: {
				conversation: "new",
				thinking: "low",
				model: "bifrost/glm-5.3-flash",
				prompt: "Summarize …",
				kind: "prompt",
			},
			schedule: { timezone: "America/Toronto", cron: "0 7 * * *" },
			name: "morning-brief",
		} satisfies JobSpec;
		expect(specHash("api:1", shuffled)).toBe(specHash("api:1", morningBrief));
	});

	it("changes when the owner changes", () => {
		expect(specHash("api:1", { ...morningBrief, owner: "michael" })).not.toBe(
			specHash("api:1", morningBrief),
		);
	});
});
