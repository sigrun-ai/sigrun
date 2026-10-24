/** Conservative ownership for pi-durable's detached command processes. */

export const UNATTRIBUTED_OWNER = -1;

export type CommandLifecycleEvent = {
	id: number;
	pid: number;
	phase: "start" | "end";
};

export interface CommandObserver {
	/** Pids whose candidate owners have not all settled. */
	readonly owners: Map<number, Set<number>>;
	/** Remove one settled request from every pid it may own. */
	settleRequest(id: number): void;
}

/**
 * Install ONE observer per environment's private pid set. Overlapping spawn
 * attribution is intentionally conservative; only the -1 sentinel may remain
 * stale. All ordinary owners are removed at request settlement so PID reuse
 * can never turn an old command entry into a signal for an unrelated group.
 */
export function createCommandObserver(opts: {
	registry: Set<number>;
	pending(): ReadonlySet<number>;
	active(): ReadonlySet<number>;
	emit(event: CommandLifecycleEvent): void;
}): CommandObserver {
	const { registry, pending, active, emit } = opts;
	const owners = new Map<number, Set<number>>();
	const originalAdd = registry.add;
	const originalDelete = registry.delete;
	const originalClear = registry.clear;

	registry.add = (pid: number): Set<number> => {
		const result = originalAdd.call(registry, pid);
		const currentlyPending = pending();
		const attributed = currentlyPending.size === 0
			? new Set([UNATTRIBUTED_OWNER])
			: new Set(currentlyPending);
		owners.set(pid, attributed);
		for (const id of attributed) emit({ id, pid, phase: "start" });
		return result;
	};
	registry.delete = (pid: number): boolean => {
		const result = originalDelete.call(registry, pid);
		forgetIfSettled(pid);
		return result;
	};
	registry.clear = (): void => {
		const pids = [...registry];
		originalClear.call(registry);
		for (const pid of pids) forgetIfSettled(pid);
	};

	function forgetIfSettled(pid: number): void {
		const attributed = owners.get(pid);
		if (attributed === undefined) return;
		for (const id of attributed) {
			// The sentinel can never be proved settled; retain it permanently.
			if (id === UNATTRIBUTED_OWNER || active().has(id)) return;
		}
		owners.delete(pid);
		for (const id of attributed) emit({ id, pid, phase: "end" });
	}

	return {
		owners,
		settleRequest(id: number): void {
			for (const [pid, attributed] of owners) {
				if (attributed.has(id)) forgetIfSettled(pid);
			}
		},
	};
}
