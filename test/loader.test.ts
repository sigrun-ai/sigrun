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

/** The fixture memory extension (contract: factory; current per-conversation recall). */
const MEMORY_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-memory", "index.js"),
).href;

/** The minimal legacy-submit fixture: the retirement-warning vehicle (the retired `{extension, submit}` shape). */
const LEGACY_SUBMIT_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-legacy-submit", "index.js"),
).href;

/** The seam fixture extension (host-context contract): for the re-key identity test. */
const SEAM_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-seam", "index.js"),
).href;

/** The zero-arg fixture (contract: a length-0 factory is invoked with NO arguments). */
const ZEROARG_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-zeroarg", "index.js"),
).href;

/**
 * The skew fixture (core-hardening Task 5): bundles its own nested
 * `node_modules/@earendil-works/pi-durable` at 0.0.1 while the host runs
 * 1.3.0 — the discriminator for the loader's host-module version guard.
 */
const SKEW_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-skew", "index.js"),
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

test("a factory result may carry capability fields beyond health — they resolve and are ignored", async () => {
	// The capability-freedom ruling: core retains only health; a gating
	// extension may return extra fields (its own doc tooling, future seams)
	// and those are the extension's business, never core's.
	const ext = { name: "sigrun.warden", hooks: [], tools: [] } as never;
	const result = await resolveExtension({
		default: () => ({
			extension: ext,
			gating: { listPending: () => {}, decide: () => {} },
		}),
	});
	expect(result?.extension).toBe(ext);
	expect(
		(result as unknown as Record<string, unknown>).gating,
	).toBeUndefined();
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
			// Hermetic: the loader contract is this suite's subject, not the
			// built-in surface (builtins: false = the pre-Task-2 boot shape).
			builtins: false,
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

test("an extension resolving a different pi-durable is quarantined; the healthy one still loads", async () => {
	// Spec §6.4 R6: an extension silently running a DIFFERENT pi-durable
	// than the host is the classic trap (its Extension/tool objects flow
	// into the host registry under structural typing — identity never
	// matches). The guard anchors version resolution at the extension
	// ENTRY's directory, so the fixture's nested fake 0.0.1 counts even
	// though the entry itself imports nothing. Quarantine fires right
	// after the import: no registry install, no seam host keyed, and the
	// next specifier in the list still loads.
	//
	// The fixture ALSO nests a minor-skew pi-ai (1.99.0, same major):
	// pi-ai's exports map exposes neither `./package.json` nor any
	// require-compatible condition, so resolving it needs the guard's
	// node_modules-walk fallback — the WARN line below is the regression
	// signal that pi-ai skew stays VISIBLE (a silent skip would be the
	// exact R6 blind spot re-opened).
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-skew-"));
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const opened = await openHarness(configWith(dir), {
			// Hermetic: the loader contract is this suite's subject, not the
			// built-in surface (builtins: false = the pre-Task-2 boot shape).
			builtins: false,
			env: {},
			extensionSpecifiers: [SKEW_SPECIFIER, FIXTURE_SPECIFIER],
		});
		try {
			expect(opened.extensionOutcomes).toEqual([
				{
					name: SKEW_SPECIFIER,
					status: "quarantined",
					error: expect.stringMatching(
						/host module skew: @earendil-works\/pi-durable resolves to 0\.0\.1 from .*fixture-skew, host runs \d+\.\d+\.\d+/,
					),
				},
				{ name: "sigrun-fixture-ext", status: "ok" },
			]);
			// Nothing installed and no seam host filed for the skew fixture.
			expect(
				opened.registry.snapshot().extension("sigrun-fixture-skew"),
			).toBeUndefined();
			expect(opened.seamHosts.has("sigrun-fixture-skew")).toBe(false);
			// The healthy fixture in the same list loaded fine.
			expect(
				opened.registry.snapshot().extension("sigrun-fixture-ext"),
			).toBeDefined();
			// The minor-skew pi-ai WARNED (seen by the fallback), not quarantined.
			const warnings = warn.mock.calls.map((call) => String(call[0]));
			expect(
					warnings.find((text) =>
						text.includes("@earendil-works/pi-ai resolves to 1.99.0"),
					),
			).toBeDefined();
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		warn.mockRestore();
		await rm(dir, { recursive: true, force: true });
	}
});

test("an extension resolving a different @sigrun/sigrun is quarantined (the blocks host-module rule)", async () => {
	// Spec §14.1: `@sigrun/sigrun/blocks` must emit the SERVER's block-set
	// version, so sigrun joins the exact-match tier (EXACT_HOST_MODULES) —
	// an extension whose tree resolves a different sigrun (a bundled or
	// npm-installed second copy) is quarantined with the SAME message shape
	// the pi-durable skew produces, before anything is keyed or installed.
	// The nested fake is built inline: it stays hermetic and no fixture on
	// disk ever ships a fake @sigrun/sigrun.
	const { mkdir, writeFile } = await import("node:fs/promises");
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-selfskew-"));
	const pkgDir = join(dir, "skew-blocks-ext");
	await mkdir(join(pkgDir, "node_modules", "@sigrun", "sigrun"), {
		recursive: true,
	});
	await writeFile(
		join(pkgDir, "node_modules", "@sigrun", "sigrun", "package.json"),
		JSON.stringify({
			name: "@sigrun/sigrun",
			version: "0.0.1",
			private: true,
			type: "module",
			main: "index.js",
		}),
	);
	await writeFile(
		join(pkgDir, "node_modules", "@sigrun", "sigrun", "index.js"),
		"export const BLOCK_SET_VERSION = 999;\n",
	);
	await writeFile(
		join(pkgDir, "package.json"),
		JSON.stringify({
			name: "skew-blocks-ext",
			version: "0.1.0",
			private: true,
			type: "module",
			main: "index.js",
		}),
	);
	await writeFile(
		join(pkgDir, "index.js"),
		"export default function createSkewBlocks() {\n" +
			"\treturn {\n" +
			"\t\textension: { name: 'skew-blocks-ext', hooks: [], tools: [], sections: [] },\n" +
			"\t};\n" +
		"}\n",
	);
	try {
		const opened = await openHarness(configWith(dir), {
			builtins: false,
			env: {},
			extensionSpecifiers: [pathToFileURL(join(pkgDir, "index.js")).href],
		});
		try {
			expect(opened.extensionOutcomes).toEqual([
				{
					name: pathToFileURL(join(pkgDir, "index.js")).href,
					status: "quarantined",
						error: expect.stringMatching(
							/host module skew: @sigrun\/sigrun resolves to 0\.0\.1 from .*skew-blocks-ext, host runs \d+\.\d+\.\d+/,
						),
					},
			]);
			expect(
				opened.registry.snapshot().extension("skew-blocks-ext"),
			).toBeUndefined();
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
			// Hermetic: the loader contract is this suite's subject, not the
			// built-in surface (builtins: false = the pre-Task-2 boot shape).
			builtins: false,
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
		const opened = await openHarness(configWith(dir), {
			// Hermetic: the loader contract is this suite's subject, not the
			// built-in surface (builtins: false = the pre-Task-2 boot shape).
			builtins: false,
			env: {},
		});
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
			// Hermetic: the loader contract is this suite's subject, not the
			// built-in surface (builtins: false = the pre-Task-2 boot shape).
			builtins: false,
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
			// Hermetic: the loader contract is this suite's subject, not the
			// built-in surface (builtins: false = the pre-Task-2 boot shape).
			builtins: false,
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
			// Hermetic: the loader contract is this suite's subject, not the
			// built-in surface (builtins: false = the pre-Task-2 boot shape).
			builtins: false,
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
			// The `submit` pass-through surface is RETIRED (§6.7): boot
			// exposes no submit surface regardless of the fixture's shape.
			expect((opened as unknown as { memorySubmit?: unknown }).memorySubmit).toBeUndefined();
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

test("a factory result carrying submit loads ok and warns (retired pass-through)", async () => {
	// §6.7: the submit pass-through is retired. @sigrun/memory-markdown
	// dropped its `submit` in 1ae6c90, so the surface is gone — but a result
	// still carrying one must NOT quarantine (old packages keep loading):
	// it is ignored with exactly one warning naming the extension slug.
	// fixture-legacy-submit is the dedicated minimal vehicle for this pin
	// (fixture-memory itself follows the CURRENT per-conversation contract).
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-submit-"));
	try {
		const opened = await openHarness(configWith(dir), {
			// Hermetic: the loader contract is this suite's subject, not the
			// built-in surface (builtins: false = the pre-Task-2 boot shape).
			builtins: false,
			env: {},
			extensionSpecifiers: [LEGACY_SUBMIT_SPECIFIER],
		});
		try {
			expect(opened.extensionOutcomes).toEqual([
				{ name: "sigrun-fixture-legacy-submit", status: "ok" },
			]);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
		const retirementWarnings = warn.mock.calls
			.map((call) => String(call[0]))
			.filter((line) => line.includes("the submit pass-through was retired"));
		expect(retirementWarnings).toEqual([
			'extension "sigrun-fixture-legacy-submit": the submit pass-through was retired; ignoring',
		]);
	} finally {
		warn.mockRestore();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a zero-arg factory is invoked with NO arguments (no host leak into defaulted slots)", async () => {
	// The seams loader passes the host context only to arity-1 factories
	// (factory.length > 0). A length-0 factory with a defaulted first
	// parameter (e.g. createBackend(backend = new Backend())) closes over its own
	// dependency — an argument would land in the backend slot and every
	// later backend call would throw. The fixture fails loud at load if the
	// loader ever passes it an argument, so an install here IS the assertion.
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-zeroarg-"));
	try {
		const opened = await openHarness(configWith(dir), {
			// Hermetic: the loader contract is this suite's subject, not the
			// built-in surface (builtins: false = the pre-Task-2 boot shape).
			builtins: false,
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
				// Hermetic: the loader contract is this suite's subject, not the
				// built-in surface (builtins: false = the pre-Task-2 boot shape).
				builtins: false,
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

// ---------------------------------------------------------------------------
// Core hardening W5 Task 4 (spec §9.4): skills-only packages, the
// skillsRoots collection, and package skills in the prompt section.
// ---------------------------------------------------------------------------

test("a skills-only git package loads ok: the .ts pi extension is skipped with one warning, its skills serve", async () => {
	// Review Focus 4: the fixture is shaped like obra/superpowers — a
	// pi-compat manifest whose only extension entry is TypeScript with a
	// SYNTAX ERROR inside, proving the module is never imported.
	const fixtureDir = join(import.meta.dirname, "fixtures", "fixture-skills-only");
	const repoDir = await (async () => {
		const { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } = await import("node:fs");
		const { execFileSync } = await import("node:child_process");
		const dir = await mkdtemp(join(tmpdir(), "sigrun-git-skillsonly-"));
		cpSync(fixtureDir, dir, { recursive: true });
		rmSync(join(dir, ".git"), { recursive: true, force: true });
		const git = (args: string[]): string =>
			execFileSync("git", [...args, ...(args[0] === "commit" ? ["--no-gpg-sign"] : [])], {
				cwd: dir,
				encoding: "utf8",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "fixture",
					GIT_AUTHOR_EMAIL: "fixture@example.invalid",
					GIT_COMMITTER_NAME: "fixture",
					GIT_COMMITTER_EMAIL: "fixture@example.invalid",
					GIT_CONFIG_GLOBAL: "/dev/null",
				},
			});
		git(["init", "-q", "-b", "main"]);
		git(["add", "."]);
		git(["commit", "-q", "-m", "fixture"]);
		return dir;
	})();

	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-skills-"));
	try {
		const { syncPackages } = await import("../src/harness/packages.js");
		const resolutions = await syncPackages([`git:file://${repoDir}`], join(dir, "packages"), {
			log: false,
			configDir: dir,
		});
		const opened = await openHarness(configWith(dir), {
			// Hermetic: the loader contract is this suite's subject, not the
			// built-in surface (builtins: false = the pre-Task-2 boot shape).
			builtins: false,
			env: {},
			extensionEntries: resolutions,
		});
		try {
			// Outcome ok under the slug of the package name — nothing
			// quarantined, nothing imported.
			expect(opened.extensionOutcomes).toEqual([
				{ name: "fixture-skills-only", status: "ok" },
			]);
			const skips = warn.mock.calls
				.map((call) => String(call[0]))
				.filter((line) => line.includes("pi-compat: skipping TypeScript pi extension"));
			expect(skips).toHaveLength(1);
			expect(skips[0]).toContain(".pi/extensions/x.ts");

			// The package's skills reached the reserved skills section.
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const submission = await root.submit(
				{ type: "input", content: "hello" },
				BACKGROUND_CONTEXT,
			);
			await submission.wait(BACKGROUND_CONTEXT);
			const view = await root.context(BACKGROUND_CONTEXT);
			const system = view.messages.find((message) => message.role === "system");
			const sections = (system as { sections?: Record<string, string> } | undefined)
				?.sections;
			expect(sections?.skills).toContain("- demo:");
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		warn.mockRestore();
		await rm(dir, { recursive: true, force: true });
		await rm(repoDir, { recursive: true, force: true });
	}
});

test("a package declaring an entry that does not resolve is quarantined (skills or none)", async () => {
	const fixtureDir = await mkdtemp(join(tmpdir(), "sigrun-missing-entry-"));
	const { mkdirSync, writeFileSync } = await import("node:fs");
	mkdirSync(fixtureDir, { recursive: true });
	writeFileSync(
		join(fixtureDir, "package.json"),
		JSON.stringify({ name: "missing-entry-pkg", sigrun: { extension: "./missing.js" } }),
	);
	const { execFileSync } = await import("node:child_process");
	const git = (args: string[]): string =>
		execFileSync("git", [...args, ...(args[0] === "commit" ? ["--no-gpg-sign"] : [])], {
			cwd: fixtureDir,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "fixture",
				GIT_AUTHOR_EMAIL: "fixture@example.invalid",
				GIT_COMMITTER_NAME: "fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.invalid",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
		});
	git(["init", "-q", "-b", "main"]);
	git(["add", "."]);
	git(["commit", "-q", "-m", "fixture"]);

	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-missing-"));
	try {
		const { syncPackages } = await import("../src/harness/packages.js");
		const resolutions = await syncPackages(
			[`git:file://${fixtureDir}`],
			join(dir, "packages"),
			{ log: false, configDir: dir },
		);
		const opened = await openHarness(configWith(dir), {
			// Hermetic: the loader contract is this suite's subject, not the
			// built-in surface (builtins: false = the pre-Task-2 boot shape).
			builtins: false,
			env: {},
			extensionEntries: resolutions,
		});
		try {
			expect(opened.extensionOutcomes).toEqual([
				{
					name: expect.stringContaining("missing.js"),
					status: "quarantined",
					error: expect.any(String),
				},
			]);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
		await rm(fixtureDir, { recursive: true, force: true });
	}
});

test("a factory result's skills field contributes skill dirs under the extension slug", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-factoryskills-"));
	try {
		const opened = await openHarness(configWith(dir), {
			// Hermetic: the loader contract is this suite's subject, not the
			// built-in surface (builtins: false = the pre-Task-2 boot shape).
			builtins: false,
			env: {},
			extensionSpecifiers: [
				pathToFileURL(
					join(import.meta.dirname, "fixtures", "fixture-skills-factory", "index.js"),
				).href,
			],
		});
		try {
			expect(opened.extensionOutcomes).toEqual([
				{ name: "sigrun-fixture-skills-factory", status: "ok", version: "0.1.0" },
			]);
			expect(opened.skillRoots).toEqual([
				{
					extension: "sigrun-fixture-skills-factory",
					dir: join(
						import.meta.dirname,
						"fixtures",
						"fixture-skills-only",
						"skills",
					),
				},
			]);
			// And the dir reached the reserved skills section.
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const submission = await root.submit(
				{ type: "input", content: "hello" },
				BACKGROUND_CONTEXT,
			);
			await submission.wait(BACKGROUND_CONTEXT);
			const view = await root.context(BACKGROUND_CONTEXT);
			const system = view.messages.find((message) => message.role === "system");
			const sections = (system as { sections?: Record<string, string> } | undefined)
				?.sections;
			expect(sections?.skills).toContain("- demo:");
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a factory result with a nonexistent skill dir is quarantined", async () => {
	// The contract: `skills` entries are absolute EXISTING directories — a
	// package that THINKS it contributed skills must not silently lose them.
	const fixtureDir = await mkdtemp(join(tmpdir(), "sigrun-badskills-fixture-"));
	const { writeFileSync } = await import("node:fs");
	writeFileSync(
		join(fixtureDir, "index.js"),
		"import { defineExtension } from \"@earendil-works/pi-durable\";\n" +
			"export default function create() {\n" +
			"\treturn { extension: defineExtension({ name: \"sigrun-bad-skills\", sections: [], tools: [] }), skills: [\"/nonexistent-skill-dir\"] };\n" +
		"}\n",
	);
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-badskills-"));
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const opened = await openHarness(configWith(dir), {
			// Hermetic: the loader contract is this suite's subject, not the
			// built-in surface (builtins: false = the pre-Task-2 boot shape).
			builtins: false,
			env: {},
			extensionSpecifiers: [pathToFileURL(join(fixtureDir, "index.js")).href],
		});
		try {
			expect(opened.extensionOutcomes).toEqual([
				{
					name: pathToFileURL(join(fixtureDir, "index.js")).href,
					status: "quarantined",
					error: expect.stringContaining("skills"),
				},
			]);
			expect(opened.skillRoots).toEqual([]);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		warn.mockRestore();
		await rm(dir, { recursive: true, force: true });
		await rm(fixtureDir, { recursive: true, force: true });
	}
});

test("a reserved extension slug is quarantined before install", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-reserved-slug-"));
	const specifier = pathToFileURL(
		join(import.meta.dirname, "fixtures", "fixture-reserved-slug", "index.js"),
	).href;
	try {
		const opened = await openHarness(configWith(dir), {
			builtins: false,
			env: {},
			extensionSpecifiers: [specifier],
		});
		try {
			expect(opened.extensionOutcomes).toEqual([
				{
					name: specifier,
					status: "quarantined",
					error: 'reserved extension slug "sandbox"',
				},
			]);
			expect(opened.registry.snapshot().extension("sandbox")).toBeUndefined();
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});


// ---------------------------------------------------------------------------
// Multi-user M3b: login-provider contributions
// ---------------------------------------------------------------------------

const LOGIN_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-login", "index.js"),
).href;

async function bootWithLoginProviders(loginProviders: unknown) {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-login-loader-"));
	const config = configWith(dir);
	const fixture = await import("./fixtures/fixture-login/index.js");
	fixture.setFixtureLoginProviders(loginProviders);
	const opened = await openHarness(config, {
		extensionSpecifiers: [LOGIN_SPECIFIER],
		builtins: false,
	});
	try {
		return opened;
	} finally {
		fixture.setFixtureLoginProviders([fixture.fixtureLoginProvider]);
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	}
}

test("login providers load with slug-qualified provider ids", async () => {
	const opened = await bootWithLoginProviders([{
		id: "oidc",
		label: "OIDC",
		begin: async () => ({ redirectUrl: "https://idp.example.invalid" }),
		complete: async () => ({ subject: "s", profile: {} }),
	}]);
	expect(opened?.loginProviders).toHaveLength(1);
	expect(opened?.loginProviders[0]?.provider).toBe("login:fixture-login:oidc");
	expect(opened?.extensionOutcomes).toContainEqual(expect.objectContaining({ status: "ok" }));
});

test.each([
	["Bad Id", "id"],
	["duplicate", "duplicate"],
])("a login provider with %s quarantines its extension", async (id) => {
	const provider = {
		id: id === "duplicate" ? "oidc" : id,
		label: "OIDC",
		begin: async () => ({ redirectUrl: "https://idp.example.invalid" }),
		complete: async () => ({ subject: "s", profile: {} }),
	};
	const opened = await bootWithLoginProviders([provider, ...(id === "duplicate" ? [provider] : [])]);
	expect(opened?.extensionOutcomes).toContainEqual(expect.objectContaining({
		name: LOGIN_SPECIFIER,
		status: "quarantined",
	}));
	expect(opened?.loginProviders).toEqual([]);
});
