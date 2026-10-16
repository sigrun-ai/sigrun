/**
 * Task 1: store-root resolution (`src/harness/stores.ts`).
 *
 * The one resolution chain per root — explicit `SIGRUN_*_DIR` env →
 * `$XDG_*_HOME` + `/sigrun` → the `$HOME`-based spec default. Pure
 * function over the `env` PARAMETER (never `process.env` — the module
 * reads env exclusively through the argument); the only process-global
 * the resolution touches is `os.homedir()`, which reads `process.env.HOME`
 * at call time — so these tests pin `HOME` to a synthetic literal and
 * restore it after (tests own their literals; no real user paths).
 *
 * The empty-string-falls-through semantics mirror the existing call
 * sites (`defaultConfigDir` in src/cli.ts, `defaultSettingsDir` in
 * src/harness/settings.ts): a var counts as unset when `undefined` OR
 * `""`. Explicit overrides are VERBATIM (never suffixed, never
 * rewritten); only the XDG tier appends `/sigrun`.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	DEFAULT_STORE_ROOTS,
	resolveStoreRoots,
	type StoreRoots,
} from "../src/harness/stores.js";

/** The synthetic home every default-tier assertion resolves against. */
const HOME = "/synthetic/home";

/** The per-root table: env var names, XDG var names, spec-default dir. */
const ROOTS = [
	{
		kind: "config",
		field: "configDir",
		explicit: "SIGRUN_CONFIG_DIR",
		xdg: "XDG_CONFIG_HOME",
		defaultRel: ".config",
	},
	{
		kind: "data",
		field: "dataDir",
		explicit: "SIGRUN_DATA_DIR",
		xdg: "XDG_DATA_HOME",
		defaultRel: ".local/share",
	},
	{
		kind: "cache",
		field: "cacheDir",
		explicit: "SIGRUN_CACHE_DIR",
		xdg: "XDG_CACHE_HOME",
		defaultRel: ".cache",
	},
	{
		kind: "state",
		field: "stateDir",
		explicit: "SIGRUN_STATE_DIR",
		xdg: "XDG_STATE_HOME",
		defaultRel: ".local/state",
	},
] as const;

/** An explicit-override value (absolute, distinctive, NOT /sigrun-suffixed). */
const explicitValue = (kind: (typeof ROOTS)[number]["kind"]): string =>
	`/explicit/${kind}`;

/** An XDG value (the BASE dir — /sigrun is appended by the resolution). */
const xdgValue = (kind: (typeof ROOTS)[number]["kind"]): string =>
	`/synthetic/xdg/${kind}`;

const realHome = process.env.HOME;
const realLeakVars = [
	"SIGRUN_CONFIG_DIR",
	"SIGRUN_DATA_DIR",
	"SIGRUN_CACHE_DIR",
	"SIGRUN_STATE_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
].map((name) => [name, process.env[name]] as const);

beforeEach(() => {
	// os.homedir() reads HOME per call on POSIX; pin it so the default
	// tier is deterministic and never touches the real user home.
	process.env.HOME = HOME;
	// Planted leak probes: if resolution ever read process.env directly,
	// these values would win and every param-driven assertion below
	// would fail (the contract is param-only resolution).
	process.env.SIGRUN_CONFIG_DIR = "/leak/config";
	process.env.XDG_DATA_HOME = "/leak/data";
});

afterEach(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	for (const [name, value] of realLeakVars) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("resolveStoreRoots", () => {
	test("homedir() tracks the synthetic HOME (the fixture is honest)", () => {
		expect(homedir()).toBe(HOME);
	});

	for (const root of ROOTS) {
		describe(root.kind, () => {
			test("explicit env wins over $XDG_*_HOME (verbatim, un-suffixed)", () => {
				const explicit = explicitValue(root.kind);
				const roots = resolveStoreRoots({
					[root.explicit]: explicit,
					[root.xdg]: xdgValue(root.kind),
				});
				expect(roots[root.field]).toBe(explicit);
			});

			test("$XDG_*_HOME set wins over the $HOME default (+ /sigrun)", () => {
				const roots = resolveStoreRoots({
					[root.xdg]: xdgValue(root.kind),
				});
				expect(roots[root.field]).toBe(
					join(xdgValue(root.kind), "sigrun"),
				);
			});

			test("all unset → the $HOME spec default", () => {
				const roots = resolveStoreRoots({});
				expect(roots[root.field]).toBe(
					join(HOME, root.defaultRel, "sigrun"),
				);
			});

			test("empty explicit env falls through to the XDG tier", () => {
				const roots = resolveStoreRoots({
					[root.explicit]: "",
					[root.xdg]: xdgValue(root.kind),
				});
				expect(roots[root.field]).toBe(
					join(xdgValue(root.kind), "sigrun"),
				);
			});

			test("empty $XDG_*_HOME falls through to the $HOME default", () => {
				const roots = resolveStoreRoots({ [root.xdg]: "" });
				expect(roots[root.field]).toBe(
					join(HOME, root.defaultRel, "sigrun"),
				);
			});
		});
	}

	test("every root resolves independently (no tier leakage across roots)", () => {
		// Only DATA carries an override; the other three stay on defaults.
		const roots = resolveStoreRoots({
			SIGRUN_DATA_DIR: explicitValue("data"),
		});
		expect(roots.dataDir).toBe(explicitValue("data"));
		expect(roots.configDir).toBe(join(HOME, ".config", "sigrun"));
		expect(roots.cacheDir).toBe(join(HOME, ".cache", "sigrun"));
		expect(roots.stateDir).toBe(join(HOME, ".local/state", "sigrun"));
	});

	test("default and XDG tiers return absolute paths ending in /sigrun", () => {
		const defaults = resolveStoreRoots({});
		for (const key of Object.keys(defaults) as (keyof StoreRoots)[]) {
			expect(isAbsolute(defaults[key])).toBe(true);
			expect(defaults[key].endsWith("/sigrun")).toBe(true);
		}
		const xdg = resolveStoreRoots({
			XDG_CONFIG_HOME: xdgValue("config"),
			XDG_DATA_HOME: xdgValue("data"),
			XDG_CACHE_HOME: xdgValue("cache"),
			XDG_STATE_HOME: xdgValue("state"),
		});
		for (const key of Object.keys(xdg) as (keyof StoreRoots)[]) {
			expect(isAbsolute(xdg[key])).toBe(true);
			expect(xdg[key].endsWith("/sigrun")).toBe(true);
		}
	});

	test("an explicit override returns the env-given path verbatim (no suffix)", () => {
		// The override is absolute and does NOT end in /sigrun — proving
		// the resolution neither suffixes nor rewrites explicit values.
		const explicit = "/explicit/untouched";
		expect(explicit.endsWith("/sigrun")).toBe(false);
		const roots = resolveStoreRoots({ SIGRUN_CONFIG_DIR: explicit });
		expect(roots.configDir).toBe(explicit);
	});

	test("resolution is call-time on the env parameter (no caching, no process.env)", () => {
		// The planted process.env values (beforeEach) must NEVER win —
		// resolution reads the env PARAMETER exclusively.
		expect(resolveStoreRoots({}).configDir).toBe(
			join(HOME, ".config", "sigrun"),
		);
		expect(resolveStoreRoots({}).dataDir).toBe(
			join(HOME, ".local/share", "sigrun"),
		);
		expect(
			resolveStoreRoots({ SIGRUN_CONFIG_DIR: "/later/override" })
				.configDir,
		).toBe("/later/override");
		expect(resolveStoreRoots({}).configDir).toBe(
			join(HOME, ".config", "sigrun"),
		);
	});
});

describe("DEFAULT_STORE_ROOTS", () => {
	test("carries the documented defaults semantics", () => {
		expect(DEFAULT_STORE_ROOTS).toEqual({
			config: ["~/.config", "sigrun"],
			data: ["~/.local/share", "sigrun"],
			cache: ["~/.cache", "sigrun"],
			state: ["~/.local/state", "sigrun"],
		});
	});

	test("the default tier resolves by expanding ~ and appending the suffix", () => {
		const roots = resolveStoreRoots({});
		for (const root of ROOTS) {
			const [homeRel, suffix] = DEFAULT_STORE_ROOTS[root.kind];
			// The `~/`-prefixed segment expands against homedir(); the
			// second element is the appended dir name.
			expect(roots[root.field]).toBe(
				join(homedir(), homeRel.slice(2), suffix),
			);
		}
	});
});
