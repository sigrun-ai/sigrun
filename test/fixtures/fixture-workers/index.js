/**
 * Test-fixture extension package (memory-seam Task 5 — the curator
 * contract): declares idle workers and records every worker run
 * MODULE-SIDE, exporting the records for the test to read — the
 * fixture-memory pattern (the loader imports this file by the same
 * `file://` URL the test dynamically imports, so both see ONE module
 * instance).
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is an arity-1 factory returning `{ extension, workers,
 * harnessShutdown }`.
 *
 * Workers (post-`every`-retirement, jobs Task 3 / ruling 12 — wakeOn only):
 * - `ticker` — wakes on conversationCreated; may hang or fail via the
 *   controls (the abandon/lastError rigs).
 * - `idle-ear` — wakes on conversationIdle.
 * - `arch-ear` — wakes on conversationArchived; `blockArch` makes its run
 *   wait on a test-held release (the in-flight wake-coalescing rig).
 * Run records are `{worker, wake, tick}`: `wake` is the delivered wake
 * (or `undefined`), `tick` is a per-worker monotonically increasing
 * counter that increments at run START (overlap detection).
 */

import { defineExtension } from "@earendil-works/pi-durable";

/** Worker runs, recorded in start order. */
export const runs = [];

/** harnessShutdown deliveries (one `{at}` per delivery). */
export const shutdowns = [];

/** Controls the tests flip module-side. */
export const controls = {
	/** arch-ear's next run waits on {@link releaseBlock} (the coalescing rig). */
	blockArch: false,
	/** ticker hangs past the worker deadline (the abandon rig). */
	hangTicker: false,
	/** ticker rejects (the lastError rig). */
	failTicker: false,
};

let blockRelease;
let tickerTick = 0;
let idleEarTick = 0;
let archEarTick = 0;

/** Reset the records + controls (tests own their fixtures' state). */
export function resetWorkers() {
	runs.length = 0;
	shutdowns.length = 0;
	controls.blockArch = false;
	controls.hangTicker = false;
	controls.failTicker = false;
	if (blockRelease !== undefined) blockRelease();
	blockRelease = undefined;
	tickerTick = 0;
	idleEarTick = 0;
	archEarTick = 0;
}

/** Release a blocked arch-ear run (rejects it — the run completes host-side). */
export function releaseBlock() {
	if (blockRelease !== undefined) {
		const release = blockRelease;
		blockRelease = undefined;
		release();
	}
}

/** Default export: factory returning the extension + its workers. */
export default function createFixtureWorkers(host) {
	void host;
	return {
		extension: defineExtension({
			name: "sigrun-fixture-workers",
		}),
		workers: [
			{
				name: "ticker",
				wakeOn: ["conversationCreated"],
				async run(context, wake) {
					void context;
					runs.push({ worker: "ticker", wake, tick: ++tickerTick });
					if (controls.hangTicker) {
						// The abandon rig: never resolves; the host's deadline
						// abandons the run (the zombie's late settle is guarded).
						await new Promise(() => {});
					}
					if (controls.failTicker) {
						throw new Error("ticker boom");
					}
				},
			},
			{
				name: "idle-ear",
				wakeOn: ["conversationIdle"],
				async run(context, wake) {
					void context;
					runs.push({ worker: "idle-ear", wake, tick: ++idleEarTick });
				},
			},
			{
				name: "arch-ear",
				wakeOn: ["conversationArchived"],
				async run(context, wake) {
					void context;
					runs.push({ worker: "arch-ear", wake, tick: ++archEarTick });
					if (controls.blockArch) {
						await new Promise((resolve, reject) => {
							blockRelease = () => reject(new Error("arch released"));
						});
					}
				},
			},
		],
		harnessShutdown(api, context) {
			void api;
			void context;
			shutdowns.push({ at: Date.now() });
		},
	};
}
