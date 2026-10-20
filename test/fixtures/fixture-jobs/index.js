/**
 * Test-fixture extension package (jobs Task 3 — sources and
 * reconciliation): declares JOBS from an extension factory result (the
 * `ext:<slug>:<name>` source) plus one registered TASK the task-action
 * tests target, recording module-side for the test to read — the
 * fixture-workers pattern (the loader imports this file by the same
 * `file://` URL the test dynamically imports, so both see ONE module
 * instance).
 *
 * Plain JavaScript so `import(specifier)` resolves it directly. Contract:
 * the default export is an arity-1 factory returning `{ extension, jobs }`
 * (the `jobs` field is the Task-3 factory-result contract).
 *
 * Jobs:
 * - `tick` — an every-60s prompt job (conversation "new").
 * - `tasked` — an every-60s task job firing the `fixture-tick` task.
 *
 * The `fixture-tick` task completes normally, or throws when
 * `controls.boom` is set (the task-action failure case). Completions are
 * recorded module-side as `{input}`.
 */

import { defineExtension, defineTask } from "@earendil-works/pi-durable";

/** fixture-tick completions, recorded in run order. */
export const completions = [];

/** Controls the tests flip module-side. */
export const controls = {
	/** The next fixture-tick run throws (the task-action failure case). */
	boom: false,
	/** The next fixture-tick run parks forever (the abort-settle rig). */
	hangTask: false,
};

/** Reset the records + controls (tests own their fixtures' state). */
export function resetFixtureJobs() {
	completions.length = 0;
	controls.boom = false;
	controls.hangTask = false;
}

/** The task the `tasked` job's action targets. */
const fixtureTick = defineTask({
	name: "fixture-tick",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			completions.push({ input: task.input });
			if (controls.hangTask) {
				// The abort-settle rig: park until the abort signal fires (an
				// uninterruptible park would wedge abortTask's join forever).
				await new Promise((resolve) => {
					runtime.signal.addEventListener("abort", () => resolve(undefined));
				});
			}
			if (controls.boom) {
				throw new Error("fixture-tick boom");
			}
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: { status: "completed", result: undefined },
				}),
				context,
			);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(
			() => ({
				status: "terminal",
					outcome: { status: "aborted", reason: "aborted" },
			}),
			context,
		);
	},
});

/** Default export: factory returning the extension + its declared jobs. */
export default function createFixtureJobs(host) {
	void host;
	return {
		extension: defineExtension({
			name: "fixture-jobs",
			tasks: [fixtureTick],
		}),
		jobs: [
			{
				name: "tick",
				schedule: { every: "60s" },
				action: { kind: "prompt", prompt: "tick", conversation: "new" },
			},
			{
				name: "tasked",
				schedule: { every: "60s" },
				action: { kind: "task", task: "fixture-tick" },
			},
		],
	};
}
