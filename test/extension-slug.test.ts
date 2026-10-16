/**
 * Task 3: extension slug identity — `slugifyName` (src/harness/stores.ts)
 * + the loader's one-point rename.
 *
 * The slug rule (spec §6, plan Global Constraints, verbatim): declared
 * name → take everything after the LAST `/` → strip trailing `@version`
 * suffix → lowercase → fold `[^a-z0-9_-]+` runs to `-` → trim edge
 * `-`/`_`. The slug IS the extension identity everywhere downstream —
 * registry key, seam host identity, interaction/ambient records, worker
 * names — computed at ONE point in the loader, before the seam host
 * exists (the two-phase rekey is untouched).
 *
 * Ruling C (plan ledger, this table): the brief's row
 * `Pí /// weird///name` → `p-name` was a hand-computed typo — the last-`/`
 * step drops the whole `Pí /// weird///` prefix (exactly the
 * `@a/tool`-vs-`@b/tool` collapse the spec says is deliberate), so the
 * rule yields `name`. The fold/trim coverage that row meant to exercise
 * lives in the `Pí Name@2.1.0` → `p-name` row instead.
 *
 * Rejections ride the LOADER (Review Focus 2): an empty slug or a slug
 * collision fails the LOAD (quarantine naming the declared name, or both
 * colliding names) — never the first store use mid-run.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import { loadExtensions } from "../src/harness/loader.js";
import { createRegistry } from "../src/harness/registry.js";
import { slugifyName } from "../src/harness/stores.js";

/** The pure-function table: [declared, slug] (synthetic names only). */
const SLUG_TABLE: readonly (readonly [string, string])[] = [
	// npm scope dropped by the last-`/` step (spec: `@a/tool` and
	// `@b/tool` share a slug by design).
	["@juicesharp/rpiv-ask-user-question", "rpiv-ask-user-question"],
	// URL-ish git name → last segment.
	["git:host/org/tool", "tool"],
	// Trailing `@version` stripped; `_` survives the fold untouched.
	["My_Tool@2.1.0", "my_tool"],
	// Ruling C: the last-`/` step drops the entire prefix — the brief's
	// `p-name` expectation for this row was a hand-computed typo.
	["Pí /// weird///name", "name"],
	// Ruling C replacement row: version strip + non-ASCII fold + a
	// multi-char run (`í `) folding to ONE dash.
	["Pí Name@2.1.0", "p-name"],
	// A folded run adjacent to a literal dash does NOT merge with it.
	["Pí -Name@2.1.0", "p--name"],
	// Edge `-`/`_` trimmed after the fold.
	["@acme/-edge-_", "edge"],
	// Already-clean names pass through byte-identical.
	["plain", "plain"],
	["a-c_9", "a-c_9"],
	// Empty results: the FUNCTION returns "" (the LOADER rejects these).
	["@scope/", ""],
	["///", ""],
	["!!!", ""],
	["", ""],
];

describe("slugifyName", () => {
	for (const [declared, expected] of SLUG_TABLE) {
		test(JSON.stringify(declared), () => {
			expect(slugifyName(declared)).toBe(expected);
		});
	}

	test("is pure: no slash into the fold means the whole name is the segment", () => {
		// No `/` anywhere → lastIndexOf returns -1 → slice(0) keeps all —
		// pinned so a future refactor cannot silently drop a no-slash name.
		expect(slugifyName("acme-tool")).toBe("acme-tool");
	});
});

/** Fixture: scoped-declared extension whose factory captures its host. */
const SCOPED_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-slug-scoped", "index.js"),
).href;

/** Fixture: declares `@scope/` — empty last segment, must fail the load. */
const EMPTY_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-slug-empty", "index.js"),
).href;

/** Fixture: declares `@acme/tool`. */
const TWIN_A_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-slug-twin-a", "index.js"),
).href;

/** Fixture: declares `@other/tool` — same slug as twin A, must fail. */
const TWIN_B_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-slug-twin-b", "index.js"),
).href;

function configWith(dir: string) {
	return loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
}

describe("loader slug integration", () => {
	test("a scoped-declared extension loads with the slug as its identity everywhere", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-slug-"));
		(globalThis as { __fixtureSlugHost?: unknown }).__fixtureSlugHost =
			undefined;
			(globalThis as { __fixtureSlugSelfName?: () => Promise<string> })
			.__fixtureSlugSelfName = undefined;
		let opened: Awaited<ReturnType<typeof openHarness>> | undefined;
		try {
			opened = await openHarness(configWith(dir), {
				env: {},
				extensionSpecifiers: [SCOPED_SPECIFIER],
			});
			const snapshot = opened.registry.snapshot();
			// The registry key IS the slug; the declared name is gone.
			expect(snapshot.extension("scoped-tool")).toBeDefined();
			expect(snapshot.extension("@acme/scoped-tool")).toBeUndefined();
			// The outcome reports the slug (never the declared name).
			expect(opened.extensionOutcomes).toEqual([
				{ name: "scoped-tool", status: "ok" },
			]);
			// The seam host maps key by the slug AND hold the very instance
			// the factory captured (the rekey path, untouched, now rekeys to
			// the slug).
			const captured = (globalThis as { __fixtureSlugHost?: unknown })
				.__fixtureSlugHost;
			const booted = opened.seamHosts.get("scoped-tool");
			expect(booted).toBeDefined();
			expect(captured).toBe(booted);
			expect(opened.seamHosts.has("@acme/scoped-tool")).toBe(false);
			expect(opened.seamKinds.get("scoped-tool")).toBeDefined();
			// The host the factory RECEIVED identifies itself as the slug:
			// the fixture's lazy thunk trips the ambient kind gate, whose
			// error embeds the host's rekeyed identity name (checked before
			// any harness wait, so no boot ordering is involved).
				const selfName = (globalThis as { __fixtureSlugSelfName?: () => Promise<string> })
				.__fixtureSlugSelfName;
				expect(selfName).toBeDefined();
				const message = await selfName!();
			expect(message).toContain("scoped-tool");
			expect(message).not.toContain("@acme/scoped-tool");
		} finally {
			await opened?.harness.close(BACKGROUND_CONTEXT);
			(globalThis as { __fixtureSlugHost?: unknown }).__fixtureSlugHost =
				undefined;
			(globalThis as { __fixtureSlugSelfName?: () => string })
				.__fixtureSlugSelfName = undefined;
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a name that slugs empty fails the LOAD, naming the declared name", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const registry = createRegistry();
		try {
			const { outcomes } = await loadExtensions([EMPTY_SPECIFIER], registry);
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]?.status).toBe("quarantined");
			// The quarantine name is the specifier; the ERROR names the
			// declared name (`@scope/`).
			expect(outcomes[0]?.error).toContain("@scope/");
			expect(registry.snapshot().installed()).toHaveLength(0);
		} finally {
			warn.mockRestore();
		}
	});

	test("two extensions whose slugs collide: the second load fails naming BOTH", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const registry = createRegistry();
		try {
			const { outcomes } = await loadExtensions(
				[TWIN_A_SPECIFIER, TWIN_B_SPECIFIER],
				registry,
			);
			// The first installs under the shared slug and stays ok.
			expect(outcomes[0]).toEqual({ name: "tool", status: "ok" });
			// The second is quarantined AT LOAD with an error naming both
			// extensions (declared names — the identities a deployer chose).
			expect(outcomes[1]?.status).toBe("quarantined");
			expect(outcomes[1]?.error).toContain("@acme/tool");
			expect(outcomes[1]?.error).toContain("@other/tool");
			// Only ONE `tool` is installed — the collision never reaches the
			// registry (silently sharing an identity is what this rejects).
			const installed = registry
				.snapshot()
				.installed()
				.filter((extension) => extension.name === "tool");
			expect(installed).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});
});
