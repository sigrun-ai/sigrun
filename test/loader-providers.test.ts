/**
 * Task 1 (provider plugins): the loader's provider-contribution pathway.
 *
 * A plugin extension's factory result may carry a `providers` array
 * (`ProviderContribution[]`); the loader validates it fail-loud (a
 * malformed entry quarantines, exactly like a malformed health/submit),
 * retains it, and boot feeds every loaded contributor into
 * `collectProviders` AFTER the `options.extensions` test seam. A result
 * carrying `providers` with NO `extension` is a valid provider-only
 * contributor (identified by its `name` field), and factories may return a
 * Promise — the plugins read their scoped settings store in the factory,
 * so the loader awaits the result.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";

/** The extension+providers fixture: registers an extension AND contributes a provider. */
const PROVIDERS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-providers", "index.js"),
).href;

/** The provider-only fixture: `name` + `providers` (+ health), NO extension. */
const ONLY_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-providers-only", "index.js"),
).href;

/** The async-factory fixture: returns a Promise (the settings-reading plugin shape). */
const ASYNC_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-providers-async", "index.js"),
).href;

/** The malformed fixture: a providers entry without `provider.id`. */
const BAD_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-providers-bad", "index.js"),
).href;

function configWith(dir: string) {
	return loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
}

/** Boot the harness with the fixture specifiers; close + clean up after. */
async function withOpenedHarness(
	specifiers: readonly string[],
	run: (opened: Awaited<ReturnType<typeof openHarness>>) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-providers-"));
	let opened: Awaited<ReturnType<typeof openHarness>> | undefined;
	try {
		opened = await openHarness(configWith(dir), {
			env: {},
			// Hermetic: this suite pins the provider pathway's outcomes for
			// its FIXTURE specifiers, not the built-in surface (builtins:
			// false = the pre-Task-2 boot shape).
			builtins: false,
			extensionSpecifiers: specifiers,
		});
		await run(opened);
	} finally {
		await opened?.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	}
}

test("a factory returning providers contributes them to collectProviders", async () => {
	await withOpenedHarness([PROVIDERS_SPECIFIER], async (opened) => {
		// The contributed provider landed in the merged catalog...
		const ids = opened.models.getProviders().map((provider) => provider.id);
		expect(ids).toContain("fixture-gw");
		expect(opened.models.getModel("fixture-gw", "fixture-m")).toBeDefined();
		// ...and the extension half of the same factory result still installs.
		expect(
			opened.registry.snapshot().extension("sigrun-fixture-providers"),
		).toBeDefined();
		// Ownership names the contributor (Task 6's auth-check discriminator).
		expect(opened.providerOwnership.get("fixture-gw")).toBe(
			"sigrun-fixture-providers",
		);
	});
});

test("a provider-only contributor (no extension field) loads without quarantine", async () => {
	await withOpenedHarness([ONLY_SPECIFIER], async (opened) => {
		expect(opened.extensionOutcomes).toEqual([
			{ name: "sigrun-fixture-provider-only", status: "ok" },
		]);
		// Nothing pi-durable behind it: no registry entry by that name.
		expect(
			opened.registry
				.snapshot()
				.extension("sigrun-fixture-provider-only"),
		).toBeUndefined();
		// Its provider and its §3 health producer both reached the catalog.
		expect(
			opened.models.getProviders().map((provider) => provider.id),
		).toContain("fixture-only-gw");
		const producer = opened.providerHealth.find(
			(entry) => entry.name === "sigrun-fixture-provider-only",
		);
		expect(producer).toBeDefined();
		expect(producer?.health()).toBe("degraded");
	});
});

test("an async factory (Promise result) is awaited, not quarantined", async () => {
	await withOpenedHarness([ASYNC_SPECIFIER], async (opened) => {
		expect(opened.extensionOutcomes).toEqual([
			{ name: "sigrun-fixture-provider-async", status: "ok" },
		]);
		expect(
			opened.models.getProviders().map((provider) => provider.id),
		).toContain("fixture-async-gw");
	});
});

test("a malformed providers entry fails loud in the outcome", async () => {
	await withOpenedHarness([BAD_SPECIFIER], async (opened) => {
		expect(opened.extensionOutcomes).toHaveLength(1);
		const outcome = opened.extensionOutcomes[0];
		expect(outcome?.status).toBe("quarantined");
		// The error names the providers field — not the generic
		// "does not satisfy the contract" message a shapeless package gets.
		expect(outcome?.error).toContain("providers");
	});
});
