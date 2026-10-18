/**
 * Test-fixture extension package (provider plugins Task 5): a
 * provider-only contributor whose `fetchModels` COUNTS every catalog
 * fetch into a file — the observable tick signal for the interval
 * refresh scheduler's serve-level tests. The scheduler re-runs
 * `models.refresh()` on cadence (which calls `fetchModels`), so the
 * counter file's size is exactly the number of fetches: one for the T4
 * boot refresh plus one per interval tick. A `SIGRUN_SCHEDULER_COUNTER`
 * env var names the counter file; unset → counting is off (the provider
 * still answers normally). The env var is read at FACTORY time (once per
 * boot), so a cached module instance can never write into a later
 * test's counter file.
 *
 * Plain JavaScript so `import(specifier)` resolves it directly — the
 * same dynamic-import path the loader uses. Contract: the default
 * export is a factory returning `{ name, providers }` (the provider-only
 * contributor shape).
 */

import { appendFileSync } from "node:fs";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";

const core = createFauxCore({
	provider: "sched-gw",
	api: "faux",
	models: [{ id: "sched-m", contextWindow: 128_000 }],
});

/** Default export: factory returning a provider-only contributor. */
export default function createSchedulerFixture() {
	// Captured at FACTORY time (per boot, not per fetch): the counting
	// target is a property of THIS boot, so a cached module instance can
	// never write into a later test's counter file.
	const counter = process.env.SIGRUN_SCHEDULER_COUNTER;
	const countFetch = () => {
		if (counter !== undefined && counter !== "") {
			appendFileSync(counter, "x");
		}
	};
	const provider = createProvider({
		id: "sched-gw",
		auth: {
			apiKey: {
				name: "Fixture",
				resolve: async () => ({ auth: {} }),
			},
		},
		models: core.models,
		api: {
			stream: core.stream,
			streamSimple: core.streamSimple,
			fetchDeferred: core.fetchDeferred,
			cancelDeferred: core.cancelDeferred,
		},
		fetchModels: async () => {
			countFetch();
			return core.models.map((model) => ({ ...model }));
		},
	});
	return {
		name: "sigrun-fixture-scheduler",
		providers: [{ provider }],
	};
}
