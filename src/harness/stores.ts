/**
 * The sigrun store roots (extension config surfaces, spec §3/§4): the
 * four XDG-respected roots every on-disk surface resolves under —
 * config, data, cache, state. ONE resolution chain per root:
 *
 * 1. explicit env — `SIGRUN_CONFIG_DIR` / `SIGRUN_DATA_DIR` /
 *    `SIGRUN_CACHE_DIR` / `SIGRUN_STATE_DIR`, used VERBATIM (never
 *    suffixed; the deploy sets these to PVC/emptyDir mounts);
 * 2. `$XDG_CONFIG_HOME` / `$XDG_DATA_HOME` / `$XDG_CACHE_HOME` /
 *    `$XDG_STATE_HOME` + `/sigrun`, when set and non-empty;
 * 3. the spec defaults of {@link DEFAULT_STORE_ROOTS} (`~` expanded via
 *    `homedir()`, the join style of `defaultSettingsDir`).
 *
 * The empty-string-falls-through semantics (`undefined` OR `""` counts
 * as unset) match the existing `SIGRUN_CONFIG_DIR` call sites
 * (`defaultConfigDir` in src/cli.ts, `defaultSettingsDir` in
 * src/harness/settings.ts) — those stay as they are; this module is the
 * additive one-stop resolver for all four roots.
 *
 * Resolution is CALL-TIME on the `env` PARAMETER (never `process.env`
 * directly, never cached): tests vary env per call, and boot reads the
 * live process env once at the boundary. `homedir()` is the one
 * process-global consulted, exactly as the precedents do.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "../config.js";

/** The four resolved store roots — absolute paths, `~` expanded. */
export interface StoreRoots {
	/** The config root (`settings.json`, extension settings files). */
	readonly configDir: string;
	/** The data root (the harness DB, extension data directories). */
	readonly dataDir: string;
	/** The cache root (regenerable derivations; never backed up). */
	readonly cacheDir: string;
	/** The state root (operational bookkeeping; optional backup). */
	readonly stateDir: string;
}

/** The root kinds — the map keys of {@link DEFAULT_STORE_ROOTS}. */
export type StoreRootKind = "config" | "data" | "cache" | "state";

/**
 * One spec default: `[homeRelativeDir, dirName]` — the first element is
 * a `~/`-prefixed path under the user home, the second is appended
 * after whichever base won (the XDG tier appends the same name).
 */
export type StoreRootDefault = readonly [string, string];

/**
 * The tier-3 defaults (spec §4): `~/.config/sigrun`,
 * `~/.local/share/sigrun`, `~/.cache/sigrun`, `~/.local/state/sigrun`.
 */
export const DEFAULT_STORE_ROOTS: Readonly<
	Record<StoreRootKind, StoreRootDefault>
> = {
	config: ["~/.config", "sigrun"],
	data: ["~/.local/share", "sigrun"],
	cache: ["~/.cache", "sigrun"],
	state: ["~/.local/state", "sigrun"],
};

/** The env var names each root's tiers read. */
const ENV_VARS: Readonly<
	Record<StoreRootKind, { readonly explicit: string; readonly xdg: string }>
> = {
	config: { explicit: "SIGRUN_CONFIG_DIR", xdg: "XDG_CONFIG_HOME" },
	data: { explicit: "SIGRUN_DATA_DIR", xdg: "XDG_DATA_HOME" },
	cache: { explicit: "SIGRUN_CACHE_DIR", xdg: "XDG_CACHE_HOME" },
	state: { explicit: "SIGRUN_STATE_DIR", xdg: "XDG_STATE_HOME" },
};

/**
 * Tier 1 — the explicit `SIGRUN_*_DIR` override, VERBATIM (no suffix,
 * no `~` expansion, no absolutizing: the precedents use it as given).
 * `undefined` when unset or empty (the unset-adjacent `""` falls
 * through, exactly like `defaultConfigDir`/`defaultSettingsDir`).
 */
function explicitRoot(env: Env, name: string): string | undefined {
	const value = env[name];
	return value !== undefined && value !== "" ? value : undefined;
}

/**
 * Tier 2 — `$XDG_*_HOME` with the sigrun dir name appended. `undefined`
 * when unset or empty (the XDG spec's own ""-means-unset reading).
 */
function xdgRoot(env: Env, name: string, dirName: string): string | undefined {
	const value = env[name];
	return value !== undefined && value !== ""
		? join(value, dirName)
		: undefined;
}

/**
 * Expand a leading `~` against `home`: `~` alone → `home`, `~/rest` →
 * `home/rest`, anything else unchanged. (Only the fixed
 * {@link DEFAULT_STORE_ROOTS} constants flow through here — a future
 * default without the `~` prefix must pass through untouched, not
 * have its first segment silently swallowed.)
 */
function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

/** Tier 3 — the spec default: `~`-expanded base + dir name. */
function defaultRoot(spec: StoreRootDefault, home: string): string {
	return join(expandHome(spec[0], home), spec[1]);
}

/**
 * Resolve all four store roots from `env` (spec §4's one chain, applied
 * per root). Pure over the argument; call it wherever the roots are
 * needed — nothing is cached, so tests and boot share the same path.
 */
export function resolveStoreRoots(env: Env): StoreRoots {
	const home = homedir();
	const one = (kind: StoreRootKind): string => {
		const { explicit, xdg } = ENV_VARS[kind];
		const spec = DEFAULT_STORE_ROOTS[kind];
		return (
			explicitRoot(env, explicit) ??
			xdgRoot(env, xdg, spec[1]) ??
			defaultRoot(spec, home)
		);
	};
	return {
		configDir: one("config"),
		dataDir: one("data"),
		cacheDir: one("cache"),
		stateDir: one("state"),
	};
}
