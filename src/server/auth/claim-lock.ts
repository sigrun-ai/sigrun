/**
 * The claim mutex (core hardening W1 Task 4, spec §5.8): ONE in-process
 * promise chain shared by the onboarding claim route and invite
 * redemption. Claims and redeems are serialized end-to-end — the
 * directory's `isClaimed()` read happens INSIDE the lock, and the
 * directory write itself is atomic (Task 2's stores) — so of two
 * concurrent correct claims exactly one lands the first admin and the
 * rest observe `already_claimed`.
 *
 * In-process by design: the directory's MutationQueue already serializes
 * single-store writes across processes; this mutex closes the
 * read-decide-write WINDOW (check unclaimed → add) that would otherwise
 * let two same-process claims both pass the check.
 */

/** The one module-level chain; every critical section rides its tail. */
let chain: Promise<unknown> = Promise.resolve();

/**
 * Run `section` under the claim mutex: it starts only after the previous
 * section settles (either way — a failed claim must not wedge the
 * chain), and the next waiter sees this section's tail. The returned
 * promise carries `section`'s own settlement (success or rejection) to
 * its caller.
 */
export function withClaimLock<T>(section: () => Promise<T>): Promise<T> {
	const run = chain.then(section, section);
	chain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}
