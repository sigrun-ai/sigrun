/**
 * Fake harness clock (pi-durable 1.4.0 upgrade, Task B1 Step 0a): one
 * controllable clock driving BOTH `HarnessOptions.now` and
 * `HarnessOptions.setTimer`, so a test steps time instead of waiting
 * real intervals.
 *
 * Why both seams: in 1.4.0 a sleeping task wakes from ONE foreground
 * timer armed for `until - now` (scheduler `#armTimer`). Moving an
 * injected `now` forward does NOT fire a real timer, so every sleep
 * test needs this `setTimer` too. `advance(ms)` moves the clock, fires
 * every due timer in time order, and awaits microtasks between them so
 * the scheduler's wake → reserve → commit chain settles deterministically.
 *
 * `setTimer` ALWAYS returns a disarm function for foreground timers
 * (never declines — a declined foreground timer silently falls back to
 * a real `setTimeout` and the test hangs on wall time again), and may
 * return `undefined` for background ones (they only free memory).
 */

/**
 * pi-durable 1.4.0's `SetTimer`, mirrored structurally so this helper
 * also compiles on 1.3.0 (written BEFORE the family bump). Once core is
 * on 1.4.0 the types are identical and assignment-compatible.
 */
export type SetTimer = (
	callback: () => void,
	delayMs: number,
	options: { readonly background: boolean },
) => (() => void) | undefined;

interface FakeTimer {
	readonly at: number;
	readonly background: boolean;
	readonly callback: () => void;
	disarmed: boolean;
}

export interface FakeClock {
	/** The `OpenHarnessOptions.now` seam value. */
	now(): Date;
	/** The `OpenHarnessOptions.setTimer` seam value. */
	setTimer: SetTimer;
	/** The clock in epoch milliseconds (the jobs `deps.now` lever). */
	nowMs(): number;
	/** Set the clock without firing timers (downtime simulation). */
	set(ms: number): void;
	/**
	 * Move the clock forward by `ms`, firing every timer that comes due
	 * in time order, awaiting microtasks between firings.
	 */
	advance(ms: number): Promise<void>;
}

export function createFakeClock(start: number): FakeClock {
	let current = start;
	let timers: FakeTimer[] = [];

	const setTimer: SetTimer = (callback, delayMs, options) => {
		const timer: FakeTimer = {
			at: current + Math.max(0, delayMs),
			background: options.background,
			callback,
			disarmed: false,
		};
		if (options.background) {
			// Background timers only free memory; a host may decline them.
			// Track them so `advance` still fires their callbacks, but never
			// return a disarm requirement — declining is allowed. We keep a
			// disarm function anyway for symmetry; callers may ignore it.
		}
		timers.push(timer);
		return () => {
			timer.disarmed = true;
		};
	};

	/** Flush pending microtasks (and a macrotask turn) so task commits land. */
	async function flush(): Promise<void> {
		for (let i = 0; i < 20; i++) {
			await Promise.resolve();
		}
		await new Promise((resolve) => setImmediate(resolve));
	}

	return {
		now: () => new Date(current),
		nowMs: () => current,
		setTimer,
		set: (ms) => {
			current = ms;
		},
		advance: async (ms) => {
			const target = current + ms;
			for (;;) {
				// Fire the earliest due, non-disarmed timer at or before target.
				const due = timers
					.filter((t) => !t.disarmed && t.at <= target)
					.sort((a, b) => a.at - b.at)[0];
				if (due === undefined) break;
				// Time never runs backward: a timer scheduled in the past fires now.
				current = Math.max(current, due.at);
				due.disarmed = true;
				due.callback();
				await flush();
			}
			current = target;
			timers = timers.filter((t) => !t.disarmed);
			await flush();
		},
	};
}
