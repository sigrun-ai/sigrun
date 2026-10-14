/**
 * Task 5.5: extension loader + no-op memory default (spec §3, §4.1).
 *
 * Extensions are external packages. The loader dynamic-imports each
 * configured specifier, resolves the package contract (default export = a
 * factory returning `{ extension }`, with a bridge for the named factory
 * exports of pre-contract packages), installs the extension, and quarantines
 * any failure — boot never aborts. The no-op memory default guarantees a
 * bare core (zero extensions) still renders the stable `long-term-memory`
 * prompt section.
 *
 * CHANGED (publish prep 2.2): the personal git-pinned packages are no
 * longer devDependencies — the fixture extensions under test/fixtures/
 * (fixture-ext, fixture-memory) speak the same contract
 * and stand in for real packages.
 *
 * The packages-dir resolution order (deployment-installed wins, then bare
 * import) and the boot-time install of the settings file's `packages`
 * declarations are covered by test/packages.test.ts (npm `file:`/tarball
 * fixtures — no network).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";

/** The test fixture package's entry, imported by specifier (contract: default factory). */
const FIXTURE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-ext", "index.js"),
).href;

/** The fixture memory extension, imported by specifier (contract: factory + submit). */
const MEMORY_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-memory", "index.js"),
).href;

function configWith(dir: string) {
	return loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
}

test("SIGRUN_EXTENSIONS parses into config.extensions", () => {
	const config = loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_EXTENSIONS: "some-ext-package, ./local/extension",
	});
	expect(config.extensions).toEqual(["some-ext-package", "./local/extension"]);
});

test("SIGRUN_EXTENSIONS empty or unset means no extensions", () => {
	expect(loadConfig({ SIGRUN_MODEL: "openai/gpt-4o" }).extensions).toEqual(
		[],
	);
	expect(
		loadConfig({
			SIGRUN_MODEL: "openai/gpt-4o",
			SIGRUN_EXTENSIONS: " , , ",
		}).extensions,
	).toEqual([]);
});

test("a valid fixture extension installs through the loader", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-"));
	try {
		const opened = await openHarness(configWith(dir), {
			env: {},
			extensionSpecifiers: [FIXTURE_SPECIFIER],
		});
		try {
			const snapshot = opened.registry.snapshot();
			expect(snapshot.extension("sigrun.fixture-ext")).toBeDefined();
			expect(
				snapshot.tools().some(
					(entry) => entry.tool.name === "fixture_marker",
				),
			).toBe(true);
			expect(opened.extensionOutcomes).toEqual([
				{ name: "sigrun.fixture-ext", status: "ok" },
			]);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a failing specifier is quarantined; the valid one still installs", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-"));
	try {
		const opened = await openHarness(configWith(dir), {
			env: {},
			extensionSpecifiers: [
				"file:///nonexistent-package-does-not-exist.js",
				FIXTURE_SPECIFIER,
			],
		});
		try {
			// Boot succeeded: Harness.open returned.
			expect(opened.registry.snapshot().extension("sigrun.fixture-ext")).toBeDefined();
			const quarantined = opened.extensionOutcomes.filter(
				(outcome) => outcome.status === "quarantined",
			);
			expect(quarantined).toHaveLength(1);
			expect(quarantined[0]?.name).toBe(
				"file:///nonexistent-package-does-not-exist.js",
			);
			expect(quarantined[0]?.error).toBeTruthy();
			expect(opened.extensionOutcomes).toHaveLength(2);
			expect(opened.extensionOutcomes[1]).toEqual({
				name: "sigrun.fixture-ext",
				status: "ok",
			});
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("zero extensions: boot succeeds with the no-op memory section present", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-"));
	try {
		const opened = await openHarness(configWith(dir), { env: {} });
		try {
			const snapshot = opened.registry.snapshot();
			const memorySections = snapshot
				.sections()
				.filter((entry) => entry.section.key === "long-term-memory");
			expect(memorySections).toHaveLength(1);
			const rendered = await memorySections[0].section.render(
				// The no-op section reads nothing from the input.
				{ env: undefined } as never,
				BACKGROUND_CONTEXT,
			);
			expect(rendered).toContain("long-term memory backend not configured");
			expect(opened.extensionOutcomes).toEqual([]);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a memory extension loads: memory_recall tool + long-term-memory section", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-"));
	try {
		const opened = await openHarness(configWith(dir), {
			env: {},
			extensionSpecifiers: [MEMORY_SPECIFIER],
		});
		try {
			const snapshot = opened.registry.snapshot();
			expect(snapshot.extension("sigrun.memory")).toBeDefined();
			expect(
				snapshot.tools().some((entry) => entry.tool.name === "memory_recall"),
			).toBe(true);
			expect(
				snapshot.sections().some(
					(entry) => entry.section.key === "long-term-memory",
				),
			).toBe(true);
			// The factory result carried a submit pass-through: boot retains it.
			expect(opened.memorySubmit).toBeDefined();
			// A memory extension owns the section: the no-op default must NOT be installed.
			expect(
				snapshot
					.sections()
					.filter((entry) => entry.section.key === "long-term-memory"),
			).toHaveLength(1);
			expect(opened.extensionOutcomes).toEqual([
				{ name: "sigrun.memory", status: "ok" },
			]);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
