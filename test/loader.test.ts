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
import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.js";
import { resolveExtension } from "../src/harness/loader.js";
import { openHarness } from "../src/harness/boot.js";

/** The test fixture package's entry, imported by specifier (contract: default factory). */
const FIXTURE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-ext", "index.js"),
).href;

/** The fixture memory extension, imported by specifier (contract: factory + submit). */
const MEMORY_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-memory", "index.js"),
).href;

/** The seam fixture extension (host-context contract): for the re-key identity test. */
const SEAM_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-seam", "index.js"),
).href;

/** The zero-arg fixture (contract: a length-0 factory is invoked with NO arguments). */
const ZEROARG_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-zeroarg", "index.js"),
).href;

/** The collision fixture package: registers `fixture_marker` under a second extension. */
const COLLISION_SPECIFIER = pathToFileURL(
	join(
		import.meta.dirname,
		"fixtures",
		"fixture-ext-collision",
		"index.js",
	),
).href;

function configWith(dir: string) {
	return loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
}

test("a factory result may carry capability fields beyond health/submit — they resolve and are ignored", () => {
	// The capability-freedom ruling: core retains only health + submit;
	// an approvals extension may return extra fields (its own doc tooling,
	// future seams) and those are the extension's business, never core's.
	const ext = { name: "sigrun.approvals", hooks: [], tools: [] } as never;
	const result = resolveExtension({
		createApprovals: () => ({
			extension: ext,
			approvals: { listPending: () => {}, decide: () => {} },
		}),
	});
	expect(result?.extension).toBe(ext);
	expect((result as unknown as Record<string, unknown>).approvals).toBeUndefined();
});

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
			expect(snapshot.extension("sigrun-fixture-ext")).toBeDefined();
			expect(
				snapshot.tools().some(
					(entry) => entry.tool.name === "fixture_marker",
				),
			).toBe(true);
			expect(opened.extensionOutcomes).toEqual([
				{ name: "sigrun-fixture-ext", status: "ok" },
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
			expect(opened.registry.snapshot().extension("sigrun-fixture-ext")).toBeDefined();
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
				name: "sigrun-fixture-ext",
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

test("two extensions registering the same tool name: console.warn names the pair (last-wins unchanged)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-"));
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const opened = await openHarness(configWith(dir), {
			env: {},
			extensionSpecifiers: [FIXTURE_SPECIFIER, COLLISION_SPECIFIER],
		});
		try {
			// Both extensions installed (quarantine is for load failures, not collisions).
			expect(opened.extensionOutcomes).toEqual([
				{ name: "sigrun-fixture-ext", status: "ok" },
				{ name: "sigrun-fixture-ext-collision", status: "ok" },
			]);
			// The warning names BOTH extension names and the colliding tool name.
			const warnings = warn.mock.calls.map((call) => String(call[0]));
			const collisionWarning = warnings.find((text) =>
				text.includes("fixture_marker"),
			);
			expect(collisionWarning).toBeDefined();
			expect(collisionWarning).toContain("sigrun-fixture-ext");
			expect(collisionWarning).toContain("sigrun-fixture-ext-collision");
			// And it states the resolution semantics (pi-durable's, unchanged).
			expect(collisionWarning).toContain("last");
			// No duplicate warning for the non-colliding installs.
			expect(warnings.filter((text) => text.includes("fixture_marker"))).toHaveLength(1);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		warn.mockRestore();
		await rm(dir, { recursive: true, force: true });
	}
});

test("no collision: distinct tool names install silently", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-"));
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const opened = await openHarness(configWith(dir), {
			env: {},
			extensionSpecifiers: [FIXTURE_SPECIFIER],
		});
		try {
			expect(opened.extensionOutcomes).toEqual([
				{ name: "sigrun-fixture-ext", status: "ok" },
			]);
			expect(
				warn.mock.calls.some((call) =>
					String(call[0]).includes("duplicate tool name"),
				),
			).toBe(false);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		warn.mockRestore();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a memory extension loads: memory_recall tool + long-term-memory section", async () => {
	// (publish prep: the real package's git devDependency is gone — the
	// fixture speaks the same contract and stands in for it here.)
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-"));
	try {
		const opened = await openHarness(configWith(dir), {
			env: {},
			extensionSpecifiers: [MEMORY_SPECIFIER],
		});
		try {
			const snapshot = opened.registry.snapshot();
			expect(snapshot.extension("sigrun-memory")).toBeDefined();
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
				{ name: "sigrun-memory", status: "ok" },
			]);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a zero-arg factory is invoked with NO arguments (no host leak into defaulted slots)", async () => {
	// The seams loader passes the host context only to arity-1 factories
	// (factory.length > 0). A length-0 factory with a defaulted first
	// parameter (createMemory(backend = new Backend())) closes over its own
	// dependency — an argument would land in the backend slot and every
	// later backend call would throw. The fixture fails loud at load if the
	// loader ever passes it an argument, so an install here IS the assertion.
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-zeroarg-"));
	try {
		const opened = await openHarness(configWith(dir), {
			env: {},
			extensionSpecifiers: [ZEROARG_SPECIFIER],
		});
		try {
			expect(opened.extensionOutcomes).toEqual([
				{ name: "sigrun-fixture-zeroarg", status: "ok" },
			]);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the factory-captured host is the final host (re-key mutates in place)", async () => {
	// The factory captures the host instance it receives; after load, the
	// host boot holds (seamHosts map) must be the SAME instance the fixture
	// factory captured — else inbound handlers registered on the factory's
	// host are unreachable (review M2). The fixture stashes its host on
	// globalThis.__fixtureSeamHost for the identity comparison.
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-rekey-"));
	try {
		(globalThis as { __fixtureSeamHost?: unknown }).__fixtureSeamHost = undefined;
		let opened: Awaited<ReturnType<typeof openHarness>> | undefined;
		try {
			opened = await openHarness(configWith(dir), {
				env: {},
				extensionSpecifiers: [SEAM_SPECIFIER],
			});
			const captured = (globalThis as { __fixtureSeamHost?: unknown })
				.__fixtureSeamHost;
			const booted = opened.seamHosts.get("sigrun-fixture-seam");
			expect(booted).toBeDefined();
			expect(captured).toBeDefined();
			expect(captured).toBe(booted);
		} finally {
			await opened?.harness.close(BACKGROUND_CONTEXT);
			(globalThis as { __fixtureSeamHost?: unknown }).__fixtureSeamHost = undefined;
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
