/**
 * The sigrun store roots (extension config surfaces, spec §3/§4): the
 * four XDG-respected roots every on-disk surface resolves under —
 * config, data, cache, state — plus the extension slug function that
 * names every per-extension surface under them. ONE resolution chain
 * per root:
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
 *
 * The lifecycle half sits below the resolver: `ensureStoreRoots` (the
 * boot-time mkdir of every root but cache) and `ensureCacheDir` (the
 * per-call repair of `<cacheDir>/<slug>`). The split is the plan's
 * Review Focus 5: a wiped cache root (the container `emptyDir` case)
 * must never break boot — so boot never ensures cache, and every
 * cache-path consumer recreates it at call time instead.
 */

import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";
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

/** The config root's per-extension settings subdirectory (spec §3 map). */
const SETTINGS_DIR_NAME = "settings";

/**
 * `mkdir -p` one path, failing loud with the path and the operation
 * named when it cannot be created (EACCES/EROFS and friends — the
 * message carries the root so a mispermissioned deploy points at the
 * exact directory, not a generic sqlite/npm error from further in).
 */
async function ensureDir(path: string): Promise<void> {
	try {
		await mkdir(path, { recursive: true });
	} catch (error) {
		const { code, message } = error as NodeJS.ErrnoException;
		const detail =
			code === undefined
				? String(error)
				: `${code}: ${message ?? String(error)}`;
		throw new Error(`sigrun: cannot mkdir ${path} (${detail})`, {
			cause: error,
		});
	}
}

/**
 * Ensure the durable store roots exist (spec §6 boot): mkdir recursive
 * on the config root AND its `settings/` subdirectory (the
 * per-extension settings files' home), plus the data and state roots.
 * The CACHE root is deliberately absent from this list — it is
 * regenerable and wipe-prone (`emptyDir` mounts), so ensuring it at
 * boot would make a wipe break the NEXT boot's repair story instead;
 * `ensureCacheDir` owns it, per call.
 */
export async function ensureStoreRoots(roots: StoreRoots): Promise<void> {
	await ensureDir(roots.configDir);
	await ensureDir(join(roots.configDir, SETTINGS_DIR_NAME));
	await ensureDir(roots.dataDir);
	await ensureDir(roots.stateDir);
}

/**
 * Ensure and return `<cacheDir>/<slug>` — mkdir -p AT CALL TIME (never
 * at boot), recreating the cache root itself when it has vanished
 * since the last call (the wiped-`emptyDir` repair, Review Focus 5).
 * Idempotent: an existing directory is a no-op. Never touches any
 * other root — repair is confined to the cache path, and the resolved
 * path always sits under `roots.cacheDir` (there is no fallback chain;
 * a missing cache root is recreated, never rerouted under data).
 */
export async function ensureCacheDir(
	roots: StoreRoots,
	slug: string,
): Promise<string> {
	const dir = join(roots.cacheDir, slug);
	await ensureDir(dir);
	return dir;
}

/**
 * The extension slug (spec §6 rename rule): the sanitized identity every
 * sigrun surface keys on — registry name, store sections, seam records,
 * worker names. The chain, verbatim: take everything after the LAST `/`
 * (npm scopes `@org/name` and URL-ish git names both collapse to their
 * last segment — `@a/tool` and `@b/tool` share a slug by design), strip a
 * trailing `@version` suffix (defensive; manifest names cannot carry
 * one), lowercase, fold `[^a-z0-9_-]+` runs to a single `-`, trim edge
 * `-`/`_`. An empty result is the CALLER's rejection — the loader fails
 * the load naming the declared name (Review Focus 2); this function
 * itself just returns "" for names nothing survives.
 */
export function slugifyName(declared: string): string {
	const segment = declared.slice(declared.lastIndexOf("/") + 1);
	const versionAt = segment.lastIndexOf("@");
	const unversioned =
		versionAt === -1 ? segment : segment.slice(0, versionAt);
	return unversioned
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "");
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
