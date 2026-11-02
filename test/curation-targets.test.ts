/**
 * Task A7 (curator P7): the curation-target contract — the
 * `curationTargets` factory-result field, the loader's validation (the
 * no-undo / unregistered-tool / duplicate-qualified-id quarantines),
 * and the boot-built {@link CurationRegistry} (`targets()` /
 * `byTool()` / `isCurationTool` — the A8 wrapping feed).
 *
 * Hermetic pattern (memory-workers.test.ts): faux provider + tmpdir +
 * `openHarness` with `builtins: false`, loading the fixture extensions
 * through `extensionEntries` (the loader's pre-resolved seam). The
 * curation-target fixture records calls module-side; the test imports
 * the FIXTURE MODULE through the same `file://` URL the loader
 * imported, so both hold one module instance.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ResolvedExtensionInput } from "../src/harness/loader.js";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { seededIdentity } from "./helpers/identity.js";

/** The fixture-curation-target entry (contract: factory + curationTargets). */
const TARGET_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-curation-target", "index.js"),
).href;

/** The no-undo fixture (contract: a target without `undo` quarantines). */
const NO_UNDO_SPECIFIER = pathToFileURL(
	join(
		import.meta.dirname,
		"fixtures",
		"fixture-curation-target-no-undo",
		"index.js",
	),
).href;

/** The unregistered-tool fixture (contract: listed tools must be registered). */
const BAD_TOOL_SPECIFIER = pathToFileURL(
	join(
		import.meta.dirname,
		"fixtures",
		"fixture-curation-target-bad-tool",
		"index.js",
	),
).href;

/** The twin fixture (contract: a duplicate qualified id quarantines the later). */
const TWIN_SPECIFIER = pathToFileURL(
	join(
		import.meta.dirname,
		"fixtures",
		"fixture-curation-target-twin",
		"index.js",
	),
).href;

/** The fixture module's exports (the module-side records + reset). */
type FixtureModule = {
	readonly writes: readonly { text: string }[];
	readonly directs: readonly { text: string }[];
	readonly undos: readonly { user: string; changeId: string }[];
	readonly maintains: readonly {
		user: string;
		deadline: number;
		runs: number;
	}[];
	readonly guidanceFor: { alice: string[] };
	readonly resetTargetFixture: () => void;
};

/** Import the fixture module by the SAME URL the loader imported. */
async function fixtureModule(): Promise<FixtureModule> {
	return (await import(TARGET_SPECIFIER)) as unknown as FixtureModule;
}

const dirs: string[] = [];
const closes: Array<() => Promise<void>> = [];

afterAll(async () => {
	for (const close of closes.splice(0)) await close();
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** Boot one hermetic harness with the curation-target fixtures installed. */
async function boot(
	entries: readonly ResolvedExtensionInput[],
): Promise<{ opened: OpenedHarness; fixture: FixtureModule }> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-curation-targets-"));
	dirs.push(dir);
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		// Hermetic: this suite pins the curation-target contract's own
		// outcomes, not the built-in surface.
		builtins: false,
		env: {},
		extensionEntries: entries,
	});
	closes.push(() => opened.harness.close(BACKGROUND_CONTEXT));
	const fixture = await fixtureModule();
	fixture.resetTargetFixture();
	return { opened, fixture };
}

/** One pre-resolved entry pointing at a fixture entry URL. */
function entry(specifier: string, name?: string): ResolvedExtensionInput {
	return name === undefined
		? { entry: specifier }
		: { name, entry: specifier };
}

// ─── The contract ─────────────────────────────────────────────────────────

describe("curation targets (curator P7)", () => {
	test("fixture target registers as fixture-curation-target:notes", async () => {
		const { opened } = await boot([entry(TARGET_SPECIFIER, "fixture-curation-target")]);
		// The boot outcome is ok under the extension's slug.
		expect(opened.extensionOutcomes).toEqual([
			{ name: "fixture-curation-target", status: "ok" },
		]);
		// The registry carries the qualified target: slug-qualified id,
		// extension attribution, and the target's own shape verbatim.
		const targets = opened.curation.targets();
		expect(targets).toHaveLength(1);
		const [target] = targets;
		expect(target!.id).toBe("fixture-curation-target:notes");
		expect(target!.extension).toBe("fixture-curation-target");
		expect(target!.name).toBe("notes");
		expect(target!.tools).toEqual(["notes_write"]);
		// Guidance resolves per user (async shape allowed; [] for unknown).
		expect(await target!.guidance("alice")).toEqual([
			"Put deploy lessons in the notes target.",
		]);
		expect(await target!.guidance("bob")).toEqual([]);
		// byTool resolves the target through a listed tool.
		expect(opened.curation.byTool("notes_write")?.id).toBe(
			"fixture-curation-target:notes",
		);
	});

	test("a target without undo quarantines its extension", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { opened } = await boot([entry(NO_UNDO_SPECIFIER, "fixture-curation-target-no-undo")]);
			expect(opened.extensionOutcomes).toEqual([
				{
					name: "fixture-curation-target-no-undo",
					status: "quarantined",
					error: 'curation target "notes" has no undo',
				},
			]);
			// Nothing installed, no target registered.
			expect(
				opened.registry
					.snapshot()
					.installed()
					.filter((extension) => extension.name === "fixture-curation-target-no-undo"),
			).toHaveLength(0);
			expect(opened.curation.targets()).toHaveLength(0);
		} finally {
			warn.mockRestore();
		}
	});

	test("a target listing a tool its extension does not register quarantines", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { opened } = await boot([entry(BAD_TOOL_SPECIFIER, "fixture-curation-target-bad-tool")]);
			const [outcome] = opened.extensionOutcomes;
			expect(outcome?.status).toBe("quarantined");
			expect(outcome?.error).toContain("notes_other_write");
			expect(outcome?.error).toContain("fixture-curation-target-bad-tool");
			expect(opened.curation.targets()).toHaveLength(0);
		} finally {
			warn.mockRestore();
		}
	});

	test("two targets with the same qualified id quarantine the later", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// A qualified id ("<slug>:<name>") names ONE curation target — a
			// factory result declaring the same target name twice quarantines
			// (the LATER duplicate is the violation; the first never lands
			// because the whole result fails the load).
			const { opened } = await boot([entry(TWIN_SPECIFIER, "fixture-curation-target-twin")]);
			expect(opened.extensionOutcomes).toEqual([
				{
					name: "fixture-curation-target-twin",
					status: "quarantined",
					error: expect.stringContaining(
						'duplicate curation target id "fixture-curation-target-twin:notes"',
					) as unknown as string,
				},
			]);
			expect(opened.curation.targets()).toHaveLength(0);
		} finally {
			warn.mockRestore();
		}
	});

	test("isCurationTool covers skill_manage and listed target tools only", async () => {
		const { opened } = await boot([entry(TARGET_SPECIFIER, "fixture-curation-target")]);
		const registry = opened.curation;
		expect(registry.isCurationTool("skill_manage")).toBe(true);
		expect(registry.isCurationTool("notes_write")).toBe(true);
		// The unlisted direct tool is NOT a curation tool — a direct
		// "remember this" path stays outside the curator's interception.
		expect(registry.isCurationTool("notes_direct")).toBe(false);
		expect(registry.isCurationTool("read")).toBe(false);
		expect(registry.isCurationTool("bash")).toBe(false);
		expect(registry.isCurationTool("unknown_tool")).toBe(false);
	});

	test("the target's undo and maintain are callable through the qualified target", async () => {
		const { opened, fixture } = await boot([entry(TARGET_SPECIFIER, "fixture-curation-target")]);
		const [target] = opened.curation.targets();
		await target!.undo("alice", "change-1", { abortSignal: undefined });
		expect(fixture.undos).toEqual([{ user: "alice", changeId: "change-1" }]);
		const report = await target!.maintain?.("alice", { abortSignal: undefined }, {
			deadline: 123,
			runs: 2,
			run: async () => ({
				status: "completed",
				text: "digest text",
				changes: [],
			}),
		});
		// A9 widened the fixture's maintain record with `digestTexts` (the
		// budget.run round-trip the wiring gate asserts); the shape is
		// otherwise unchanged.
		expect(fixture.maintains).toEqual([
			{ user: "alice", deadline: 123, runs: 2, digestTexts: ["digest text"] },
		]);
		expect(report).toEqual({ changes: [] });
	});

	test("a zero-target extension loads fine (curationTargets is optional)", async () => {
		const { opened } = await boot([entry(TARGET_SPECIFIER, "fixture-curation-target")]);
		// Re-boot without any curation entry: the registry is empty but present.
		const bare = await boot([]);
		expect(bare.opened.curation.targets()).toHaveLength(0);
		expect(bare.opened.curation.isCurationTool("skill_manage")).toBe(true);
		expect(bare.opened.curation.isCurationTool("notes_write")).toBe(false);
		void opened;
	});
});
