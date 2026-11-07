/**
 * Built-in wiring (release workstream Task 1.2): the six built-in
 * extensions must appear in EVERY place that enumerates them, and the
 * enumerations must agree. Finding A of the release scan was exactly
 * this drift: the gateway built-in shipped in `src/harness/builtins.ts`
 * and core's `dependencies` but was missing from `publish-deps.mjs`'s
 * BUILTINS and the workflows' lock-regen name lists — a publish would
 * have written `file:../sigrun-ext-gateway` into the packument and
 * quarantined the gateway on every registry install.
 *
 * Four sets are asserted EQUAL (sorted):
 *
 *  (a) the keys `publish-deps.mjs list` prints (the script's BUILTINS);
 *  (b) the dependency names in core's `package.json` whose VALUE is a
 *      `file:../sigrun-ext-*` sibling spec (dev shape) or the sibling's
 *      version when the publish marker is present (registry shape) —
 *      matched on the value, never the key (`@sigrun/oauth` lives in
 *      `../sigrun-ext-oauth`);
 *  (c) the `repository:` entries of the `family-checkout` composite
 *      action's checkout steps, mapped through the sibling manifests;
 *  (d) the specifiers `src/harness/builtins.ts` keys on.
 *
 * Plus: `pins` prints exactly one `<name>@<semver>` per built-in, each
 * version read from the sibling checkout's own manifest; `slugs` prints
 * exactly the loader slugs `src/harness/builtins.ts` declares (the fifth
 * enumeration — `/v1/meta` rows key on the slug, so the image smoke's
 * boot assertion derives its names from `slugs`, never a second
 * hardcoded list); and no built-in's `peerDependencies` may skew against
 * the host pins core itself carries (the peer-skew case from Task 1.1's
 * Step 4).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";
import { describe, expect, test } from "vitest";
import { satisfies } from "semver";
import { BUILTIN_EXTENSIONS } from "../src/harness/builtins.js";

/** Repo root (test/ → ..). */
const REPO_ROOT = realpathSync(join(import.meta.dirname, ".."));

/** Run a publish-deps.mjs mode, returning stdout. */
function publishDeps(mode: string): string {
	return execFileSync(
		process.execPath,
		[join(REPO_ROOT, "scripts", "publish-deps.mjs"), mode],
		{ cwd: REPO_ROOT, encoding: "utf8" },
	);
}

interface MinimalManifest {
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

function manifest(path: string): MinimalManifest {
	return JSON.parse(readFileSync(path, "utf8")) as MinimalManifest;
}

/** The sibling-dir spec a built-in carries in dev shape. */
const SIBLING_SPEC = /^file:\.\.\/(sigrun-ext-[a-z-]+)$/;

/** (a) The names `publish-deps.mjs list` prints (one `<name> <dir>` per line). */
function listNames(): string[] {
	const out = publishDeps("list").trim();
	const rows = out.split("\n").map((line) => {
		const [name, dir] = line.split(" ");
		// The printed dir must be a real sibling whose manifest declares
		// the printed name (value truth, not key truth).
		expect(dir, `list row "${line}" carries a sibling dir`).toMatch(
			/^sigrun-ext-[a-z-]+$/,
		);
		const sibling = manifest(join(REPO_ROOT, "..", dir, "package.json"));
		expect(sibling.name, `sibling ${dir} declares ${name}`).toBe(name);
		return name;
	});
	return out === "" ? [] : out.trim() === "" ? [] : rows;
}

/** (b) Core's built-in dependency names, matched on the VALUE. */
function manifestBuiltinNames(): string[] {
	const core = manifest(join(REPO_ROOT, "package.json"));
	const markerPath = join(REPO_ROOT, ".publish-deps-applied.json");
	const marker = existsSync(markerPath)
		? (JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, string>)
		: undefined;
	const names: string[] = [];
	for (const [name, value] of Object.entries(core.dependencies ?? {})) {
		const devMatch = SIBLING_SPEC.exec(value);
		if (devMatch !== null) {
			// Dev shape: the sibling must declare this very name.
			const sibling = manifest(join(REPO_ROOT, "..", devMatch[1], "package.json"));
			expect(sibling.name, `${devMatch[1]} declares ${name}`).toBe(name);
			names.push(name);
			continue;
		}
		// Registry shape (publish marker present): the marker recorded the
		// original sibling spec; the rewritten value is the sibling's version.
		if (
			marker !== undefined &&
			typeof marker[name] === "string" &&
			SIBLING_SPEC.test(marker[name]) &&
			/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value)
		) {
			names.push(name);
		}
	}
	return names;
}

/** (c) The composite action's checkout repositories → sibling package names. */
function actionBuiltinNames(): string[] {
	const action = YAML.parse(
		readFileSync(
			join(REPO_ROOT, ".github", "actions", "family-checkout", "action.yml"),
			"utf8",
		),
) as {
		runs?: {
			using?: string;
			steps?: { uses?: string; with?: Record<string, unknown> }[];
		};
};
		expect(action.runs?.using, "family-checkout is a composite action").toBe("composite");
	const steps = action.runs?.steps ?? [];
	const names: string[] = [];
	for (const step of steps) {
		if (!step.uses?.startsWith("actions/checkout@")) continue;
		const repo = String(step.with?.repository ?? "");
		const path = String(step.with?.path ?? "");
		expect(repo, "a sibling checkout names sigrun-ai/<repo>").toMatch(
			/^sigrun-ai\/sigrun-(ext-)?[a-z-]+$/,
		);
		// The checkout path IS the sibling dir (the layout the file: specs
		// resolve against), and it is the repository's basename.
		expect(path, `checkout path for ${repo}`).toBe(basename(repo));
		const sibling = manifest(join(REPO_ROOT, "..", path, "package.json"));
		expect(sibling.name).toMatch(/^@sigrun\//);
		names.push(sibling.name as string);
	}
	return names;
}

/** (d) The specifiers builtins.ts keys on. */
function harnessBuiltinNames(): string[] {
	return BUILTIN_EXTENSIONS.map((builtin) => builtin.specifier);
}

/**
 * The released ext-gateway line's @sigrun/shared peer acceptance,
 * derived from BOTH facts the sibling manifest carries — its version
 * AND its declared peer range — never the version alone. Part A shipped
 * 0.1.3 with an exact 0.2.1 peer; 0.1.4 widened it to
 * "0.2.1 || 0.3.0" (the 0.3.0 core family) and 0.1.5 widened it again
 * to "0.3.0 || 0.4.0" (the 0.4.0 family, still co-installing with 0.3.0).
 * A declaration is accepted when it honestly installs against core's
 * own pin (the range CONTAINS `own`), or inside the documented Part A
 * transitional window (core 0.3.0 against the published 0.1.3/0.1.4
 * line still peering 0.2.1). A version bumped past its peer — e.g. a
 * 0.1.5 still declaring "0.2.1 || 0.3.0" against core 0.4.0 — accepts
 * NOTHING (that pairing is uninstallable: ERESOLVE), and every other
 * sibling keeps the exact-version default branch.
 */
function acceptedSharedPeers(
	name: string,
	siblingVersion: string | undefined,
	declaredPeer: string | undefined,
	own: string,
): Set<string> {
	const declared = new Set(
		(declaredPeer ?? "").split("||").map((part) => part.trim()).filter(Boolean),
	);
	if (name !== "@sigrun/ext-gateway") return new Set([own]);
	// The honest case: the declared range itself installs against core's
	// pin (this is the reviewer-pairing assertion — a 0.1.5+ line must
	// DECLARE the core line it claims to support, not just be versioned
	// for it).
	if (declared.has(own)) return declared;
	// The Part A transitional window: core 0.3.0 with the PUBLISHED
	// gateway line still peering 0.2.1 (integration may move the sibling
	// directly to the family version; until then the exact 0.2.1 peer is
	// the published reality). Exactly the two released declarations.
	if (
		own === "0.3.0" &&
		/^0\.1\.[3-4]$/.test(siblingVersion ?? "") &&
		(declaredPeer === "0.2.1" || declaredPeer === "0.2.1 || 0.3.0")
	) {
		return declared;
	}
	return new Set();
}

/** The five sibling checkouts, keyed by declared package name. */
function siblingManifests(): Map<string, { dir: string; manifest: MinimalManifest }> {
	const map = new Map<string, { dir: string; manifest: MinimalManifest }>();
	for (const builtin of BUILTIN_EXTENSIONS) {
		// The sibling dir is the one core's dev-shape spec points at.
		const core = manifest(join(REPO_ROOT, "package.json"));
		const value = core.dependencies?.[builtin.specifier] ?? "";
		const markerPath = join(REPO_ROOT, ".publish-deps-applied.json");
		const marker = existsSync(markerPath)
			? (JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, string>)
			: undefined;
		const spec = SIBLING_SPEC.test(value) ? value : (marker?.[builtin.specifier] ?? "");
		const match = SIBLING_SPEC.exec(spec);
		expect(match, `${builtin.specifier} resolves to a sibling checkout`).not.toBeNull();
		const dir = match?.[1] as string;
		map.set(builtin.specifier, {
			dir,
			manifest: manifest(join(REPO_ROOT, "..", dir, "package.json")),
		});
	}
	return map;
}

describe("built-in wiring (release workstream Task 1.2)", () => {
	test("the four built-in enumerations agree: publish-deps list, core manifest, family-checkout action, builtins.ts", () => {
		// memory-markdown is a DEV sibling (core's devDependency, the
		// curation-e2e's loaded extension) — checked out with the family
		// but never a built-in (not in publish-deps' list/pins/slugs).
		const DEV_SIBLINGS = ["@sigrun/memory-markdown"];
		const sets: [string, string[]][] = [
			["publish-deps.mjs list", listNames()],
			["package.json dependencies", manifestBuiltinNames()],
			[
				"family-checkout action (built-ins; dev siblings filtered)",
				actionBuiltinNames().filter((dir) => !DEV_SIBLINGS.includes(dir)),
			],
			["src/harness/builtins.ts", harnessBuiltinNames()],
		];
		for (const [label, names] of sets) {
			expect(new Set(names).size, `${label} has no duplicates`).toBe(names.length);
		}
		const [first, ...rest] = sets.map(([, names]) => [...names].sort());
		for (const [index, names] of rest.entries()) {
			expect(names, `${sets[index + 1]?.[0]} equals ${sets[0]?.[0]}`).toEqual(first);
		}
		// The release scan's finding: FIVE built-ins, not four; Task B1
		// made it six (the curator is the last).
		expect(first).toHaveLength(6);
		expect(first).toContain("@sigrun/ext-gateway");
		expect(first).toContain("@sigrun/ext-curator");
	});

	test("pins prints exactly one <name>@<semver> per built-in, each version from the sibling manifest", () => {
		const pins = publishDeps("pins").trim().split(/\s+/).filter(Boolean);
		expect(pins).toHaveLength(6);
		const siblings = siblingManifests();
		const seen = new Set<string>();
		for (const pin of pins) {
			const match = /^(@sigrun\/[a-z-]+)@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(pin);
			expect(match, `pin "${pin}" is <name>@<semver>`).not.toBeNull();
			const [_, name, version] = match as unknown as [string, string, string];
			expect(seen.has(name), `no duplicate pin for ${name}`).toBe(false);
			seen.add(name);
			const sibling = siblings.get(name);
			expect(sibling, `${name} is a built-in`).toBeDefined();
			expect(version, `${name}'s pin is the sibling manifest version`).toBe(
				sibling?.manifest.version,
			);
		}
	});

	test("slugs prints exactly the loader slugs builtins.ts declares", () => {
		const out = publishDeps("slugs").trim();
		const rows = out === "" ? [] : out.split("\n");
		expect(rows, "one slug row per built-in").toHaveLength(6);
		const printed = new Map(
			rows.map((line) => {
				const [name, slug] = line.split(" ");
				return [name, slug] as const;
			}),
		);
		// The fifth enumeration: the slug set must equal builtins.ts's
		// declared slugs exactly — /v1/meta rows key on the slug, so drift
		// here false-fails (or worse, false-passes) the image smoke.
		const declared = new Map(
			BUILTIN_EXTENSIONS.map((builtin) => [builtin.specifier, builtin.slug] as const),
		);
		expect(Object.fromEntries(printed)).toEqual(Object.fromEntries(declared));
	});

	test("the Part A ext-gateway shared-peer exception stays narrow", () => {
		const siblings = siblingManifests();
		const gateway = siblings.get("@sigrun/ext-gateway");
		// The linked checkout tracks the RELEASED gateway line: 0.1.3
		// (Part A, exact 0.2.1 peer), 0.1.4 (the peer-widening patch that
		// adds 0.3.0), and 0.1.5-0.1.21 (the peer-widening line that adds
		// 0.4.x/0.5.0/0.6.x/0.7.0/0.8.0/0.9.0/0.10.0/0.10.1/0.10.2
		// while keeping 0.3.0). Each legitimately declares its line's
		// acceptance; anything older — or a declaration from the WRONG
		// line — is skew.
		expect(gateway?.manifest.version ?? "").toMatch(/^0\.1\.([3-9]|1[0-9]|2[01])$/);
		expect(gateway?.manifest.peerDependencies?.["@sigrun/shared"] ?? "").toMatch(
			// The peer-widening line appends each new shared minor; the
			// acceptance is the cumulative chain ending at the line's
			// newest minor (0.11.0 as of the core 0.11.0 line).
			/^0\.3\.0( \|\| 0\.4\.0( \|\| 0\.4\.1( \|\| 0\.4\.2( \|\| 0\.5\.0( \|\| 0\.6\.0( \|\| 0\.6\.1( \|\| 0\.7\.0( \|\| 0\.8\.0( \|\| 0\.9\.0( \|\| 0\.10\.0( \|\| 0\.10\.1( \|\| 0\.10\.2( \|\| 0\.11\.0)?)?)?)?)?)?)?)?)?)?)?)?)?$/,
		);
		// The 0.4.0 core line: only the 0.1.5 declaration installs against
		// it (the range must CONTAIN core's pin — version alone is not
		// acceptance), and it keeps the 0.3.0 arm.
		const atFour = acceptedSharedPeers(
			"@sigrun/ext-gateway",
			"0.1.5",
			"0.3.0 || 0.4.0",
			"0.4.0",
		);
		expect(atFour.has("0.4.0")).toBe(true);
		expect(atFour.has("0.3.0")).toBe(true);
		expect(atFour.has("0.2.1")).toBe(false);
		const atFourOne = acceptedSharedPeers(
			"@sigrun/ext-gateway",
			"0.1.6",
			"0.3.0 || 0.4.0 || 0.4.1",
			"0.4.1",
		);
		expect(atFourOne.has("0.4.1")).toBe(true);
		expect(atFourOne.has("0.4.0")).toBe(true);
		expect(atFourOne.has("0.3.0")).toBe(true);
		// THE poisoned pairing: a gateway bumped to 0.1.5 that still
		// declares the 0.1.4-era range is uninstallable against shared 0.4.0
		// (ERESOLVE) — the acceptance must be EMPTY, whatever the version
		// says.
		const poisoned = acceptedSharedPeers(
			"@sigrun/ext-gateway",
			"0.1.5",
			"0.2.1 || 0.3.0",
			"0.4.0",
		);
		expect(poisoned.size).toBe(0);
		// The 0.3.0 core line: the 0.1.5 declaration installs honestly
		// (its range keeps 0.3.0)…
		expect(
			acceptedSharedPeers("@sigrun/ext-gateway", "0.1.5", "0.3.0 || 0.4.0", "0.3.0").has(
				"0.3.0",
			),
		).toBe(true);
		// …and the published 0.1.3/0.1.4 line rides the Part A
		// transitional window (core 0.3.0 with the sibling still peering
		// 0.2.1): each era declaration accepts exactly its own literals.
		expect(
			acceptedSharedPeers("@sigrun/ext-gateway", "0.1.4", "0.2.1 || 0.3.0", "0.3.0").has(
				"0.2.1",
			),
		).toBe(true);
		expect(
			acceptedSharedPeers("@sigrun/ext-gateway", "0.1.3", "0.2.1", "0.3.0").has("0.2.1"),
		).toBe(true);
		// Anything older is skew, and the exception never leaks to other
		// built-ins.
		expect(
			acceptedSharedPeers("@sigrun/ext-gateway", "0.1.2", "0.2.1", "0.3.0").has("0.2.1"),
		).toBe(false);
		expect(acceptedSharedPeers("@sigrun/ext-mcp", "0.1.2", "0.3.0", "0.3.0").has("0.2.1")).toBe(
			false,
		);
	});

	test("no peer skew: every built-in's host peers pin core's own version of that module", () => {
		const core = manifest(join(REPO_ROOT, "package.json"));
		const siblings = siblingManifests();
		for (const [name, sibling] of siblings) {
			for (const [module, pin] of Object.entries(sibling.manifest.peerDependencies ?? {})) {
				const own = core.dependencies?.[module];
				if (own !== undefined) {
					// A peer range that excludes core's pin is the skew class
					// this test exists to catch. Peers may be exact literals or
					// ranges ("1.3.0 || 1.4.0" in the 1.4 era, "~1.5.0" now) —
					// semver's satisfies answers both.
					const accepted = new Set(pin.split("||").map((part) => part.trim()));
					// An invalid range throws RangeError out of satisfies; that IS
					// the skew this test names — fail the expect, not the loop.
					let rangeAccepts = false;
					try {
						rangeAccepts = satisfies(own, pin);
					} catch {
						rangeAccepts = false;
					}
					expect(
						module === "@sigrun/shared"
							? [...accepted].some((entry) =>
								acceptedSharedPeers(name, sibling.manifest.version, pin, own).has(entry),
							)
							: accepted.has(own) || rangeAccepts,
						`${name} peer ${module} accepts core's pin ${own}`,
					).toBe(true);
				} else {
					// A transitive host module (e.g. @earendil-works/pi-codemode,
					// which arrives via pi-durable): the peer must equal the
					// version core's tree actually resolves.
					const resolved = manifest(
						join(REPO_ROOT, "node_modules", module, "package.json"),
					).version as string;
					const accepted = new Set(pin.split("||").map((part) => part.trim()));
					expect(
						accepted.has(resolved) || satisfies(resolved, pin),
						`${name} peer ${module} accepts core's resolved ${resolved}`,
					).toBe(true);
				}
			}
		}
	});
});
