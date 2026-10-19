/**
 * The login rate limiter (W1 Task 3, spec §5.4): per-source-IP failure
 * buckets over {@link Set} keys. Ten consecutive failures within the
 * window lock the source for the lockout period; a successful login
 * clears the bucket. Time is injectable for fake-timer tests.
 */

export const LOGIN_LIMIT_MAX_FAILURES = 10;
export const LOGIN_LIMIT_WINDOW_MS = 10 * 60_000;
export const LOGIN_LOCKOUT_MS = 10 * 60_000;

/**
 * The system clock, captured at module load: vitest's `useFakeTimers`
 * replaces the global `Date`, and the login route's limiter must keep
 * wall-clock semantics when a test fakes timers to skip the 1 000 ms
 * failure delay (the limiter windows are minutes — no test waits them
 * out; they simply never advance within one test).
 */
const systemNow = Date.now;

interface Bucket {
	/** Epoch-ms timestamps of the recent failures (window-trimmed). */
	readonly failures: number[];
	/** Locked until this epoch ms; 0 = not locked. */
	lockedUntil: number;
}

export class LoginLimiter {
	private readonly buckets = new Map<string, Bucket>();

	constructor(private readonly now: () => number = systemNow) {}

	/**
	 * Whether a login attempt from `key` (the source IP) may proceed.
	 * False while locked; the locked reply never reveals the state of the
	 * token (checked BEFORE the credential and the wait, per the brief).
	 */
	allowed(key: string): boolean {
		const bucket = this.buckets.get(key);
		return bucket === undefined || bucket.lockedUntil <= this.now();
	}

	/** Record a failed attempt; the 10th inside the window locks the key. */
	recordFailure(key: string): void {
		const now = this.now();
		const bucket = this.buckets.get(key) ?? { failures: [], lockedUntil: 0 };
		while (
			bucket.failures.length > 0 &&
			now - bucket.failures[0] >= LOGIN_LIMIT_WINDOW_MS
		) {
			bucket.failures.shift();
		}
		bucket.failures.push(now);
		if (bucket.failures.length >= LOGIN_LIMIT_MAX_FAILURES) {
			bucket.lockedUntil = now + LOGIN_LOCKOUT_MS;
			bucket.failures.length = 0;
		}
		this.buckets.set(key, bucket);
	}

	/** A success clears the bucket — the lock punishes guessing, not use. */
	recordSuccess(key: string): void {
		this.buckets.delete(key);
	}
}
