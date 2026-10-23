/**
 * Action rate limiting (UI-blocks U3 Task 3, spec §15): 20 actions per
 * second per principal per surface, burst 40, over → 429. A token
 * bucket keyed `(slug, id, principal.user)`; memory-only, buckets
 * lazily refilled on read and swept when the table grows.
 */

/** The refill rate (spec §15): 20 tokens per second. */
export const RATE_PER_SECOND = 20;

/** The burst capacity (spec §15): 40 tokens. */
export const BURST_CAPACITY = 40;

/** One principal's bucket on one surface. */
interface Bucket {
	tokens: number;
	// Mutable: every take() advances it to the take's time, so the
	// refill interval is measured take-to-take (otherwise a wall-clock
	// gap refills the whole window on EVERY subsequent take — a burst
	// N minutes after the last action would get N×20 free tokens).
	lastRefill: number;
}

/** The per-principal-per-surface token bucket table. */
export class ActionRateLimit {
	private readonly buckets = new Map<string, Bucket>();
	private readonly clock: () => number;
	private disabled = false;

	constructor(clock?: () => number) {
		// Resolve Date.now at CALL time (see ActionDedup's note).
		this.clock = clock ?? (() => Date.now());
	}

	/**
	 * Test seam: disable (or re-enable) the limiter. The actions tests
	 * disable it for the non-rate tests so per-test state isolation is
	 * not required (the service is a per-server singleton).
	 */
	setDisabled(disabled: boolean): void {
		this.disabled = disabled;
	}

	/**
	 * Take one token: `true` when the action may proceed, `false` when
	 * the bucket is empty (→ 429). Refills lazily from the wall clock.
	 */
	take(slug: string, id: string, user: string): boolean {
		if (this.disabled) return true;
		const now = this.clock();
		const key = `${slug}${id}${user}`;
		let bucket = this.buckets.get(key);
		if (bucket === undefined) {
			bucket = { tokens: BURST_CAPACITY - 1, lastRefill: now };
			this.buckets.set(key, bucket);
			if (this.buckets.size > 4096) this.sweep(now);
			return true;
		}
		const refill = ((now - bucket.lastRefill) / 1000) * RATE_PER_SECOND;
		const tokens = Math.min(BURST_CAPACITY, bucket.tokens + refill);
		bucket.lastRefill = now;
		if (tokens < 1) {
			bucket.tokens = tokens;
			return false;
		}
		bucket.tokens = tokens - 1;
		return true;
	}

	/** Drop stale full buckets (nothing a refill would change). */
	private sweep(now: number): void {
		const fullAfterMs = (BURST_CAPACITY / RATE_PER_SECOND) * 1000;
		for (const [key, bucket] of this.buckets) {
			if (now - bucket.lastRefill > fullAfterMs) this.buckets.delete(key);
		}
	}
}
