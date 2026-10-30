/**
 * Unit tests for the fake harness clock (Task B1 Step 0a): timers fire
 * in time order, disarm works, `advance` crosses several timers in one
 * call, and background timers never keep `advance` waiting.
 */

import { describe, expect, test } from "vitest";
import { createFakeClock } from "./fake-clock.js";

describe("createFakeClock", () => {
	test("now/nowMs track the start and set", () => {
		const clock = createFakeClock(1_000);
		expect(clock.nowMs()).toBe(1_000);
		expect(clock.now().getTime()).toBe(1_000);
		clock.set(5_000);
		expect(clock.nowMs()).toBe(5_000);
	});

	test("timers fire in time order, not registration order", async () => {
		const clock = createFakeClock(0);
		const fired: string[] = [];
		clock.setTimer(() => fired.push("late"), 300, { background: false });
		clock.setTimer(() => fired.push("early"), 100, { background: false });
		clock.setTimer(() => fired.push("middle"), 200, { background: false });
		await clock.advance(400);
		expect(fired).toEqual(["early", "middle", "late"]);
		expect(clock.nowMs()).toBe(400);
	});

	test("advance stops at its target; later timers stay pending", async () => {
		const clock = createFakeClock(0);
		const fired: number[] = [];
		clock.setTimer(() => fired.push(100), 100, { background: false });
		clock.setTimer(() => fired.push(500), 500, { background: false });
		await clock.advance(200);
		expect(fired).toEqual([100]);
		expect(clock.nowMs()).toBe(200);
		await clock.advance(400);
		expect(fired).toEqual([100, 500]);
	});

	test("disarm prevents the fire", async () => {
		const clock = createFakeClock(0);
		let fired = false;
		const disarm = clock.setTimer(() => {
			fired = true;
		}, 100, { background: false });
		expect(typeof disarm).toBe("function");
		disarm!();
		await clock.advance(200);
		expect(fired).toBe(false);
	});

	test("a foreground setTimer NEVER declines (no real-timer fallback)", () => {
		const clock = createFakeClock(0);
		const disarm = clock.setTimer(() => {}, 1_000, { background: false });
		expect(disarm).toBeTypeOf("function");
	});

	test("a timer re-armed from its own callback fires on a later advance", async () => {
		const clock = createFakeClock(0);
		const fired: number[] = [];
		const arm = () =>
			clock.setTimer(
				() => {
					fired.push(clock.nowMs());
					if (fired.length < 3) arm();
				},
				100,
				{ background: false },
			);
		arm();
		await clock.advance(250);
		expect(fired).toEqual([100, 200]);
		await clock.advance(100);
		expect(fired).toEqual([100, 200, 300]);
	});

	test("background timers fire without keeping advance waiting", async () => {
		const clock = createFakeClock(0);
		let fired = false;
		clock.setTimer(() => {
			fired = true;
		}, 100, { background: true });
		await clock.advance(200);
		expect(fired).toBe(true);
		expect(clock.nowMs()).toBe(200);
	});

	test("a timer armed for zero delay fires on the next advance", async () => {
		const clock = createFakeClock(0);
		let fired = false;
		clock.setTimer(() => {
			fired = true;
		}, 0, { background: false });
		await clock.advance(0);
		expect(fired).toBe(true);
	});
});
