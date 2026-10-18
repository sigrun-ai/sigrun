/**
 * System-prompt Task 3: boot wiring — guidance LAST + the reserved-key
 * boot assertion.
 *
 * `openHarness` installs the core prompt-section extensions first
 * (context-files, skills), then loads extension packages, then the
 * memory owner (or the no-op default), and finally
 * `modelGuidanceExtension` (spec §Design: guidance sections appear and
 * disappear with the matched model; trailing placement keeps those
 * transitions minimal patches instead of full prompt re-emits).
 *
 * The reserved-key assertion walks `registry.snapshot().sections()` AFTER
 * `loadExtensions` and after the guidance install: any non-core extension
 * owning one of `RESERVED_CORE_SECTION_KEYS` — including one that
 * last-writer-wins REPLACED a core section — fails boot loud, naming the
 * extension and the key. Sections are registry state that shapes every
 * conversation's prompt; a silent takeover is not a valid configuration.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.js";
import {
	openHarness,
	RESERVED_CORE_SECTION_KEYS,
	RESERVED_CORE_SECTION_OWNERS,
} from "../src/harness/boot.js";

/** The plain fixture extension (loader tests): contributes `fixture-note`. */
const FIXTURE_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-ext", "index.js"),
).href;

/**
 * The section-collision fixture: declares the reserved `persona` key
 * under its own extension name.
 */
const SECTION_COLLISION_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-section-collision", "index.js"),
).href;

function configWith(dir: string) {
	return loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
}

test("core section order: identity first, guidance after long-term-memory", async () => {
	// A bare boot (zero extensions): context-files + skills install before
	// the loader, the memory no-op installs after it (no memory owner), and
	// guidance installs LAST. The full section key order is pinned end to
	// end — the order is the deliverable (install order = render order).
	const dir = await mkdtemp(join(tmpdir(), "sigrun-boot-order-"));
	try {
		const opened = await openHarness(configWith(dir), { env: {} });
		try {
			const sections = opened.registry.snapshot().sections();
			expect(sections.map((entry) => entry.section.key)).toEqual([
				"identity",
				"persona",
				"workspace-instructions",
				"skills",
				"long-term-memory",
				"tool-guidance",
				"execution-guidance",
			]);
			// Every reserved key is owned by its expected core extension —
			// the same ownership the boot assertion enforces.
			expect(
				sections
					.filter((entry) => entry.section.key in RESERVED_CORE_SECTION_OWNERS)
					.map((entry) => `${entry.section.key}:${entry.extension.name}`),
			).toEqual([
				"identity:sigrun.context-files",
				"persona:sigrun.context-files",
				"workspace-instructions:sigrun.context-files",
				"skills:sigrun.skills",
				"tool-guidance:sigrun.model-guidance",
				"execution-guidance:sigrun.model-guidance",
			]);
			expect(opened.extensionOutcomes).toEqual([]);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an extension declaring persona fails boot loud", async () => {
	// The collision fixture installs cleanly (the registry allows duplicate
	// section keys across extensions — last-writer-wins at render); boot
	// must throw AFTER loadExtensions, naming the extension and the key.
	const dir = await mkdtemp(join(tmpdir(), "sigrun-boot-order-"));
	try {
		const boot = openHarness(configWith(dir), {
			env: {},
			extensionSpecifiers: [SECTION_COLLISION_SPECIFIER],
		});
		await expect(boot).rejects.toThrow(
			'extension "sigrun-fixture-section-collision" declares reserved core section "persona"',
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("guidance sections install after loadExtensions (memory section precedes them)", async () => {
	// With a loaded extension contributing its own section, the memory
	// no-op installs after the loader and guidance stays last: extension
	// sections sit between the core sections and the trailing memory +
	// guidance pair.
	const dir = await mkdtemp(join(tmpdir(), "sigrun-boot-order-"));
	try {
		const opened = await openHarness(configWith(dir), {
			env: {},
			extensionSpecifiers: [FIXTURE_SPECIFIER],
		});
		try {
			expect(
				opened.registry
					.snapshot()
					.sections()
					.map((entry) => entry.section.key),
			).toEqual([
				"identity",
				"persona",
				"workspace-instructions",
				"skills",
				"fixture-note",
				"long-term-memory",
				"tool-guidance",
				"execution-guidance",
			]);
			// The loaded extension booted ok — the reserved-key assertion
			// passed on its non-reserved `fixture-note` section.
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

test("the exported reserved-key contract matches the core surfaces", () => {
	expect(RESERVED_CORE_SECTION_KEYS).toEqual([
		"identity",
		"persona",
		"workspace-instructions",
		"skills",
		"tool-guidance",
		"execution-guidance",
	]);
	// Every reserved key has exactly one expected core owner.
	expect([...new Set(Object.values(RESERVED_CORE_SECTION_OWNERS))].sort()).toEqual(
		["sigrun.context-files", "sigrun.model-guidance", "sigrun.skills"],
	);
});
