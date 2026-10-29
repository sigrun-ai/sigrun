/**
 * Built-in wiring (release workstream Task 1.2): the five built-in
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
			/^sigrun-ai\/sigrun-ext-[a-z-]+$/,
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
 * Part A released ext-gateway with an exact @sigrun/shared 0.2.1 peer.
 * Leg A leaves that published sibling untouched; integration may move it
 * directly to the 0.3.0 family version. Older shared versions remain skew.
 */
function acceptedSharedPeers(name: string, own: string): Set<string> {
	return name === "@sigrun/ext-gateway" && own === "0.3.0"
		? new Set(["0.2.1", "0.3.0"])
		: new Set([own]);
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
		const sets: [string, string[]][] = [
			["publish-deps.mjs list", listNames()],
			["package.json dependencies", manifestBuiltinNames()],
			["family-checkout action", actionBuiltinNames()],
			["src/harness/builtins.ts", harnessBuiltinNames()],
		];
		for (const [label, names] of sets) {
			expect(new Set(names).size, `${label} has no duplicates`).toBe(names.length);
		}
		const [first, ...rest] = sets.map(([, names]) => [...names].sort());
		for (const [index, names] of rest.entries()) {
			expect(names, `${sets[index + 1]?.[0]} equals ${sets[0]?.[0]}`).toEqual(first);
		}
		// The release scan's finding: FIVE built-ins, not four.
		expect(first).toHaveLength(5);
		expect(first).toContain("@sigrun/ext-gateway");
	});

	test("pins prints exactly one <name>@<semver> per built-in, each version from the sibling manifest", () => {
		const pins = publishDeps("pins").trim().split(/\s+/).filter(Boolean);
		expect(pins).toHaveLength(5);
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
		expect(rows, "one slug row per built-in").toHaveLength(5);
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
		const accepted = acceptedSharedPeers("@sigrun/ext-gateway", "0.3.0");
		expect(accepted.has("0.2.1")).toBe(true);
		expect(accepted.has("0.3.0")).toBe(true);
		expect(accepted.has("0.1.2")).toBe(false);
		expect(acceptedSharedPeers("@sigrun/ext-mcp", "0.3.0").has("0.2.1")).toBe(false);
	});

	test("no peer skew: every built-in's host peers pin core's own version of that module", () => {
		const core = manifest(join(REPO_ROOT, "package.json"));
		const siblings = siblingManifests();
		for (const [name, sibling] of siblings) {
			for (const [module, pin] of Object.entries(sibling.manifest.peerDependencies ?? {})) {
				const own = core.dependencies?.[module];
				if (own !== undefined) {
					// Phase-1 peers deliberately accept both host majors while
					// core develops against 1.4.0. A range that excludes core's
					// pin is the skew class this test exists to catch.
					const accepted = new Set(pin.split("||").map((part) => part.trim()));
					expect(
						module === "@sigrun/shared"
							? [...accepted].some((pin) => acceptedSharedPeers(name, own).has(pin))
							: accepted.has(own),
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
						accepted.has(resolved),
						`${name} peer ${module} accepts core's resolved ${resolved}`,
					).toBe(true);
				}
			}
		}
	});
});
