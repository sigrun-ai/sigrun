import { describe, expect, test } from "vitest";
import {
	createCommandObserver,
	UNATTRIBUTED_OWNER,
} from "../src/sandbox/command-observer.js";

type CommandEvent = { id: number; pid: number; phase: "start" | "end" };

function fixture() {
	const registry = new Set<number>();
	const active = new Set<number>();
	const pending = new Set<number>();
	const events: CommandEvent[] = [];
	const observer = createCommandObserver({
		registry,
		pending: () => pending,
		active: () => active,
		emit: (event) => events.push(event),
	});
	return { registry, active, pending, events, observer };
}

describe("sandbox command ownership", () => {
	test("overlapping spawn attribution cannot end a pid until every owner settles", () => {
		const { registry, active, pending, events, observer } = fixture();
		active.add(1).add(2);
		pending.add(1).add(2);
		registry.add(501);
		expect(events).toEqual([
			{ id: 1, pid: 501, phase: "start" },
			{ id: 2, pid: 501, phase: "start" },
		]);

		pending.delete(1);
		registry.delete(501);
		expect(events).toHaveLength(2);
		active.delete(1);
		observer.settleRequest(1);
		expect(events).toHaveLength(2);

		pending.delete(2);
		active.delete(2);
		observer.settleRequest(2);
		expect(events).toEqual([
			{ id: 1, pid: 501, phase: "start" },
			{ id: 2, pid: 501, phase: "start" },
			{ id: 1, pid: 501, phase: "end" },
			{ id: 2, pid: 501, phase: "end" },
		]);
		expect(observer.owners.size).toBe(0);
	});

	test("a normal command exit ends after its request settles and forgets the pid", () => {
		const { registry, active, pending, events, observer } = fixture();
		active.add(7);
		pending.add(7);
		registry.add(777);
		pending.delete(7);
		registry.delete(777);
		expect(events).toEqual([{ id: 7, pid: 777, phase: "start" }]);
		expect(observer.owners.get(777)).toEqual(new Set([7]));

		active.delete(7);
		observer.settleRequest(7);
		expect(events).toEqual([
			{ id: 7, pid: 777, phase: "start" },
			{ id: 7, pid: 777, phase: "end" },
		]);
		expect(observer.owners.size).toBe(0);
	});

	test("a request settling before its command also ends exactly once", () => {
		const { registry, active, pending, events, observer } = fixture();
		active.add(8);
		pending.add(8);
		registry.add(888);
		pending.delete(8);
		active.delete(8);
		observer.settleRequest(8);
		expect(events.at(-1)).toEqual({ id: 8, pid: 888, phase: "end" });
		expect(observer.owners.size).toBe(0);
		registry.delete(888);
		expect(events.filter((event) => event.phase === "end")).toHaveLength(1);
	});

	test("an unattributed pid is retained rather than ended unsafely", () => {
		const { registry, events, observer } = fixture();
		registry.add(999);
		registry.delete(999);
		expect(events).toEqual([{ id: UNATTRIBUTED_OWNER, pid: 999, phase: "start" }]);
		expect(observer.owners.get(999)).toEqual(new Set([UNATTRIBUTED_OWNER]));
		observer.settleRequest(UNATTRIBUTED_OWNER);
		expect(events).toHaveLength(1);
		expect(observer.owners.size).toBe(1);
	});
});
