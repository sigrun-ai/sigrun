/**
 * §8.2 schedule math (jobs Task 1) — when a job fires next.
 *
 * Cron semantics belong to croner (spec §8.2: "Cron parsing uses
 * croner … DST is exactly the class of bug not to hand-roll"); this
 * module only dispatches the three schedule shapes and never
 * re-derives a time. `nextFireAt` is the scheduler's single walk step:
 * given a schedule and an instant, the next fire STRICTLY AFTER that
 * instant, or `undefined` when the schedule can never fire again (a
 * one-shot `at` already past).
 *
 * `every` intervals anchor at `after` itself — after downtime the next
 * fire is computed from now, never from a missed slot (the plan's
 * Review Focus 5: `catchUp` decides whether a missed fire is recorded,
 * and the schedule never fires once per missed interval).
 *
 * `cronFor` is the ONE croner parse in the tree: validation
 * (src/jobs/spec.ts rejects a bad pattern via croner's constructor
 * throwing) and evaluation (below) must agree, so they share both the
 * options and the pattern. `mode: "5-part"` enforces the Global
 * Constraints' 5-field grammar — croner's auto mode would silently
 * reinterpret a 6-field pattern as second-level precision instead of
 * rejecting it.
 */

import { Cron } from "croner";
import type { JobSchedule } from "@sigrun/shared/jobs";

/** The `every` grammar (Global Constraints): `^\d+(s|m|h|d)$`, ≥ 60 s. */
const EVERY_PATTERN = /^\d+(s|m|h|d)$/;
const EVERY_UNIT_MS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};
/** The floor the Global Constraints put on `every` intervals. */
const EVERY_MIN_MS = 60_000;

/**
 * The single croner parse (see the module header): a `Cron` whose
 * constructor throws on an invalid 5-field pattern. No callback is
 * passed, so croner never arms a timer — this is pure pattern math.
 */
export function cronFor(cron: string, timezone?: string): Cron {
	return new Cron(cron, { timezone, mode: "5-part" });
}

/**
 * Parse an `every` interval into milliseconds. Throws on anything
 * outside `^\\d+(s|m|h|d)$` and on intervals below the 60 s floor.
 */
export function parseEvery(text: string): number {
	const match = EVERY_PATTERN.exec(text);
	if (match === null) {
		throw new Error(
			`every must match ${EVERY_PATTERN.source} (got ${JSON.stringify(text)})`,
		);
	}
	const ms = Number.parseInt(match[0], 10) * EVERY_UNIT_MS[match[1]];
	if (ms < EVERY_MIN_MS) {
		throw new Error(
			`every must be at least 60 s (got ${JSON.stringify(text)})`,
		);
	}
	return ms;
}

/**
 * The next fire strictly after `after`, in epoch ms — or `undefined`
 * when the schedule will never fire again (a one-shot `at` at or
 * before `after`). A cron's timezone is the schedule's, else
 * `defaultTz` (the resolved `server.timezone`).
 */
export function nextFireAt(
	schedule: JobSchedule,
	after: number,
	defaultTz: string,
): number | undefined {
	if ("cron" in schedule) {
		const next = cronFor(schedule.cron, schedule.timezone ?? defaultTz).nextRun(
			new Date(after),
		);
		return next === null ? undefined : next.getTime();
	}
	if ("every" in schedule) {
		// Anchored at `after` (see the module header): the next fire is
		// one interval from the instant asked about.
		return after + parseEvery(schedule.every);
	}
	const fireAt = Date.parse(schedule.at);
	return Number.isNaN(fireAt) || fireAt <= after ? undefined : fireAt;
}
