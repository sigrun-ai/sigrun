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
 * as unset) predate this module and hold across the whole chain. The
 * core config-dir helpers (`defaultConfigDir` in src/cli.ts,
 * `defaultSettingsDir` in src/harness/settings.ts) delegate to
 * `resolveStoreRoots` for their configDir — ONE chain everywhere, so
 * settings/auth/packages/git can never split from the store roots
 * (spec Decision 3).
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

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Env } from "../config.js";
import {
	MutationQueue,
	invalidateJsonCache,
	readJson,
	writeJson,
} from "./identity/json-store.js";
import { UserDirectory } from "./identity/users.js";

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
		throw mkdirFailure(path, error);
	}
}

/** The loud `cannot mkdir` error both ensure paths share (async + sync). */
function mkdirFailure(path: string, error: unknown): Error {
	const { code, message } = error as NodeJS.ErrnoException;
	const detail =
		code === undefined
			? String(error)
			: `${code}: ${message ?? String(error)}`;
	return new Error(`sigrun: cannot mkdir ${path} (${detail})`, {
		cause: error,
	});
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
 *
 * The mkdir core is synchronous (`ensureCacheDirAt`): the async wrapper
 * is the call-time contract callers hold, while the sync core serves
 * the extension-stores handle's `paths.cache` getter — a getter cannot
 * await, and a fire-and-forget ensure would let a caller stat a path
 * whose mkdir is still in flight. Same semantics, one implementation.
 */
export async function ensureCacheDir(
	roots: StoreRoots,
	slug: string,
): Promise<string> {
	return ensureCacheDirAt(roots, slug);
}

/** The synchronous mkdir core behind {@link ensureCacheDir}. */
function ensureCacheDirAt(roots: StoreRoots, slug: string): string {
	return ensureDirAt(join(roots.cacheDir, slug));
}

/** The synchronous mkdir core behind lazy path getters. */
function ensureDirAt(dir: string): string {
	try {
		mkdirSync(dir, { recursive: true });
	} catch (error) {
		throw mkdirFailure(dir, error);
	}
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

/**
 * The extension store classes + the secret precedence resolver (spec
 * §3's server-mediated surfaces): extension code NEVER touches these
 * files directly — it asks the server, which is the single writer.
 * Every write goes through {@link writeFileAtomic}, so a crash or a
 * concurrent reader can only ever see the old complete file or the new
 * complete file, never a half-written one.
 */

/**
 * Atomic file replace: stage `data` to a fresh temp file in the SAME
 * directory as `path` (rename is same-filesystem atomic), stamp the
 * final `mode` on the temp BEFORE the rename (a chmod after the rename
 * would leave a window at the wrong permissions on secrets; `chmod`
 * beats `writeFile`'s `mode` option here because the latter is masked
 * by umask), then `rename` over the target. On failure the staged temp
 * is best-effort removed and the error rethrown — the target keeps its
 * old bytes.
 */
export async function writeFileAtomic(
	path: string,
	data: string,
	mode: number,
): Promise<void> {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, data, { mode });
		await chmod(temp, mode);
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {});
		throw error;
	}
}

/** Serialize a JSON value the house way (tabs, trailing newline). */
function serializeJson(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

/**
 * Read one JSON-object file. Absent (`ENOENT`) → `{}` — first use is
 * not an error for either store. Every OTHER failure mode is loud:
 * unparseable JSON, or JSON that is not an object (an array/scalar
 * file is malformed for a map-shaped surface). The error names the
 * path — a corrupt `secrets.json` must stop the show pointing at the
 * file, never be silently reset to `{}` by the next write.
 */
async function readJsonObject(
	path: string,
): Promise<Record<string, unknown>> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`sigrun: malformed JSON in ${path}: ${String(error)}`,
			{ cause: error },
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			`sigrun: malformed JSON in ${path}: expected an object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}`,
		);
	}
	return parsed as Record<string, unknown>;
}

/** An object-shaped value check (sections are always written objects). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" && value !== null && !Array.isArray(value)
	);
}

/**
 * The secrets store (spec §3): ONE `secrets.json` at the config root,
 * keyed by extension slug — whole-file read-modify-write, atomic,
 * `0600`. The server (the API-mediated secret endpoints) is the only
 * writer; extension code reads through `resolveSecretFor`.
 */
export class SecretsStore {
	constructor(private readonly secretsPath: string) {}

	/** One extension's secret section; absent section → `{}`. */
	async readSection(slug: string): Promise<Record<string, unknown>> {
		const section = (await readJsonObject(this.secretsPath))[slug];
		return isPlainObject(section) ? section : {};
	}

	/**
	 * Set one extension's section, preserving every sibling section
	 * (read-modify-write of the whole map). Loud on a malformed file —
	 * never a silent reset.
	 */
	async writeSection(
		slug: string,
		section: Record<string, unknown>,
	): Promise<void> {
		const all = await readJsonObject(this.secretsPath);
		all[slug] = section;
		await writeFileAtomic(this.secretsPath, serializeJson(all), 0o600);
	}
}

/**
 * The per-extension settings store (spec §3): one JSON file per slug
 * under `<configDir>/settings/`, contents entirely the extension's
 * shape. Absent → `{}`; atomic `0644` writes (settings are not
 * secrets — world-unreadable is not required, group/other-readable
 * is acceptable).
 */
export class ExtensionSettingsStore {
	constructor(private readonly settingsDir: string) {}

	private pathFor(slug: string): string {
		return join(this.settingsDir, `${slug}.json`);
	}

	/** One extension's settings object; absent file → `{}`. */
	async read(slug: string): Promise<Record<string, unknown>> {
		return readJsonObject(this.pathFor(slug));
	}

	/** Replace one extension's settings file atomically. */
	async write(
		slug: string,
		value: Record<string, unknown>,
	): Promise<void> {
		await writeFileAtomic(this.pathFor(slug), serializeJson(value), 0o644);
	}
}

/** Where a resolved secret's winning value came from. */
export interface SecretResolution {
	readonly value: string;
	readonly source: "stored" | "env";
}

/** The env prefix every extension secret's fallback var carries. */
const SECRET_ENV_PREFIX = "SIGRUN_EXT_";

/** slug/key → `SIGRUN_EXT_<SLUG-SNAKE>_<KEY-SNAKE>` (upper, `-`→`_`). */
function secretEnvName(slug: string, key: string): string {
	const snake = (part: string) => part.toUpperCase().replace(/-/g, "_");
	return `${SECRET_ENV_PREFIX}${snake(slug)}_${snake(key)}`;
}

/**
 * Resolve one secret for one extension (spec §4 precedence): the
 * STORED section wins when it has the key; else the env var
 * `SIGRUN_EXT_<SLUG>_<KEY>`; else undefined. Pure over its arguments —
 * it NEVER writes env values down (Review Focus 4: env-only
 * resolution must leave the file byte-identical; the write path is
 * the API alone). Takes the SECTION object (the caller just did
 * `readSection`), not a store instance. An empty-string env var
 * counts as unset — the same ""-means-unset reading this module's dir
 * tiers use.
 */
export function resolveSecretFor(
	slug: string,
	section: Record<string, unknown>,
	key: string,
	env: Env,
): SecretResolution | undefined {
	const stored = section[key];
	if (stored !== undefined && stored !== null) {
		return { value: String(stored), source: "stored" };
	}
	const fromEnv = env[secretEnvName(slug, key)];
	return fromEnv !== undefined && fromEnv !== ""
		? { value: fromEnv, source: "env" }
		: undefined;
}

/**
 * The extension-stores handle (spec §5's scoped surface): the ONLY
 * store view extension code ever receives — through its factory host
 * (src/harness/seam-host.ts), never by importing this module. Secrets
 * and settings are SERVER-MEDIATED (the extension calls get/set on ITS
 * section / ITS file and cannot name another slug; it never sees a
 * path, only the handle); data/state/cache are RAW directories (the
 * extension owns the I/O; only the cache one is created by sigrun,
 * lazily at first access — Review Focus 5: never at boot).
 */
export interface UserExtensionStores {
	/** This user and slug's secrets section. Values never appear on HTTP reads. */
	readonly secrets: {
		get(key: string): Promise<string | undefined>;
		set(key: string, value: string): Promise<void>;
		delete(key: string): Promise<void>;
	};
	/** This user's `user-settings/<user>/<slug>.json` object. */
	readonly settings: {
		get(): Promise<Record<string, unknown>>;
		set(value: Record<string, unknown>): Promise<void>;
	};
	/** Per-user raw directories, each created synchronously on first access. */
	readonly paths: {
		readonly data: string;
		readonly state: string;
		readonly cache: string;
	};
}

export interface ExtensionStores {
	/** This slug's `secrets.json` section (whole-section read-modify-write). */
	readonly secrets: {
		get(key: string): Promise<string | undefined>;
		set(key: string, value: string): Promise<void>;
	};
	/** This slug's `settings/<slug>.json` file, absent → `{}`. */
	readonly settings: {
		get(): Promise<Record<string, unknown>>;
		set(value: Record<string, unknown>): Promise<void>;
	};
	/** Per-slug raw directories under the data/state/cache roots. */
	/** One directory user's stores, still scoped to this extension's slug. */
	user(user: string): UserExtensionStores;
	readonly paths: {
		/** `<dataDir>/<slug>` — the root exists; the subdir is the extension's. */
		readonly data: string;
		/**
		 * `<cacheDir>/<slug>` — CREATED on access (mkdir -p at call time,
		 * never at boot; an access after a wipe self-heals, which is why
		 * the ensure is not memoized).
		 */
		readonly cache: string;
		/** `<stateDir>/<slug>` — the root exists; the subdir is the extension's. */
		readonly state: string;
	};
}

/**
 * The boot-shared store trio one `scopedExtensionStores` view closes
 * over: the two store classes (stateless file wrappers — instances may
 * be shared freely; every operation reads-modifies-writes the file) plus
 * the resolved roots. Built ONCE per boot from the roots `openHarness`
 * already resolved (never re-resolved from env).
 *
 * The ADMIN surface (spec §7.7, core hardening W3 Task 7): the
 * slug-addressed operations the `/v1/extensions` routes ride — settings
 * get/set on the same `settings/<slug>.json` the scoped handle reads,
 * secret-key listing (stored keys plus the `SIGRUN_EXT_<SLUG>_`-prefixed
 * env fallbacks that resolve), and secret set/delete. The env parameter
 * feeds ONLY the env-secret listing (the resolver's precedence stays
 * `resolveSecretFor`'s — stored wins; env values are never written down).
 */
export interface SharedExtensionStores {
	readonly secrets: SecretsStore;
	readonly settings: ExtensionSettingsStore;
	readonly roots: StoreRoots;
	/** The live directory; stores.user validates through this on every call. */
	readonly users: UserDirectory;
	/** One user's stores for one slug (the /v1/me routes ride this too). */
	userExtensionStores(slug: string, user: string): UserExtensionStores;
	/** §10.6 step 5: credentials/settings and cache only; data/state stay. */
	removeUserData(user: string): Promise<void>;
	/** One user/slug's stored secret names (never values, no env fallback). */
	userSecretKeys(slug: string, user: string): Promise<readonly string[]>;
	/** One slug's settings file get/set (the API's verbatim object store). */
	settingsFor(slug: string): {
		get(): Promise<Record<string, unknown>>;
		set(value: Record<string, unknown>): Promise<void>;
	};
	/** One slug's secret keys with their winning source (never values). */
	secretKeys(slug: string): Promise<readonly ExtensionSecretKey[]>;
	/** Set one secret in the slug's stored section (the API write path). */
	setSecret(slug: string, key: string, value: string): Promise<void>;
	/** Delete one secret from the slug's stored section (idempotent). */
	deleteSecret(slug: string, key: string): Promise<void>;
}

/** One listed secret key: the key name and its winning source, never the value. */
export interface ExtensionSecretKey {
	readonly key: string;
	readonly source: "stored" | "env";
}

/** The `secrets.json` file name at the config root (spec §3 map). */
const SECRETS_FILE_NAME = "secrets.json";

/**
 * One user's secrets file (multi-user M2): the same object-map discipline
 * as the shared SecretsStore, plus the identity helpers' mtime reload and
 * MutationQueue. A queued write re-reads the CURRENT file inside its
 * mutation, so sibling sections survive concurrent sets.
 */
/** One FIFO per secrets file, shared by independently constructed views. */
const userSecretMutations = new Map<string, MutationQueue>();

export class UserSecretsStore {
	private readonly mutations: MutationQueue;

	constructor(readonly path: string) {
		this.mutations = userSecretMutations.get(path) ?? new MutationQueue();
		userSecretMutations.set(path, this.mutations);
	}

	private readAll(): Record<string, unknown> {
		const value = readJson<unknown>(this.path, {});
		if (!isPlainObject(value)) {
			throw new Error(`sigrun: ${this.path} must contain a JSON object`);
		}
		return value;
	}

	readSection(slug: string): Record<string, unknown> {
		const section = this.readAll()[slug];
		return isPlainObject(section) ? section : {};
	}

	writeSection(slug: string, section: Record<string, unknown>): Promise<void> {
		return this.mutate(slug, (draft) => {
			for (const key of Object.keys(draft)) delete draft[key];
			Object.assign(draft, section);
		});
	}

	/** One serialized read-modify-write; validation runs INSIDE the queue. */
	mutate(
		slug: string,
		update: (section: Record<string, unknown>) => void,
	): Promise<void> {
		return this.mutations.run(async () => {
			const all = this.readAll();
			const current = all[slug];
			const draft = isPlainObject(current) ? { ...current } : {};
			update(draft);
			all[slug] = draft;
			// The parent is created only on the first actual secret write.
			await ensureDir(dirname(this.path));
			// writeJson -> writeFileAtomic(..., 0600), on create AND rewrite.
			await writeJson(this.path, all);
		});
	}
}

/** In-memory only: active userDeleted fan-out windows (Task 5 owns begin/end). */
const deletingUsers = new Map<string, number>();

/**
 * Mark one user's deletion fan-out active. The returned idempotent end hook
 * releases only this window; nested fan-outs cannot clear each other early.
 * No marker is persisted and no catch-all allowMissing flag exists.
 */
export function beginUserDeletion(user: string): () => void {
	deletingUsers.set(user, (deletingUsers.get(user) ?? 0) + 1);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		const remaining = (deletingUsers.get(user) ?? 1) - 1;
		if (remaining <= 0) deletingUsers.delete(user);
		else deletingUsers.set(user, remaining);
	};
}

/** Resolve one directory user, or the explicit deletion-window exception. */
function requireStoreUser(users: UserDirectory, user: string): void {
	if (users.get(user) === undefined && !deletingUsers.has(user)) {
		throw new Error(`unknown user "${user}"`);
	}
}

/** Build the shared trio from resolved roots (cheap, no I/O). */
export function sharedExtensionStores(
	roots: StoreRoots,
	env: Env = {},
	users?: UserDirectory,
): SharedExtensionStores {
	const settings = new ExtensionSettingsStore(
		join(roots.configDir, SETTINGS_DIR_NAME),
	);
	const secrets = new SecretsStore(join(roots.configDir, SECRETS_FILE_NAME));
	// The optional fallback keeps this low-level factory usable without an
	// identity bundle; production boot always passes its LIVE directory.
	const directory = users ?? new UserDirectory(join(roots.configDir, "users.json"));
	return {
		secrets,
		settings,
		roots,
		users: directory,
		removeUserData: (user) => removeUserData(roots, user),
		userExtensionStores: (slug, user) =>
			userExtensionStores(roots, directory, slug, user),
		userSecretKeys: async (slug, user) => {
			requireStoreUser(directory, user);
			const store = new UserSecretsStore(
				join(roots.configDir, USER_SECRETS_DIR, `${user}.json`),
			);
			return Object.keys(store.readSection(slug));
		},
		settingsFor: (slug) => ({
			get: () => settings.read(slug),
			set: (value) => settings.write(slug, value),
		}),
		secretKeys: async (slug) => {
			// Stored keys first (the resolver's winning source), then the
			// `SIGRUN_EXT_<SLUG>_`-prefixed env fallbacks that are not stored.
			// A stored key with an env twin lists ONCE as stored — exactly
			// `resolveSecretFor`'s precedence, never two entries for one key.
			const section = await secrets.readSection(slug);
			const keys: ExtensionSecretKey[] = Object.keys(section).map((key) => ({
				key,
				source: "stored",
			}));
			const prefix = `${SECRET_ENV_PREFIX}${slug
				.toUpperCase()
				.replace(/-/g, "_")}_`;
			for (const name of Object.keys(env)) {
				if (!name.startsWith(prefix)) continue;
				// The resolver's ""-means-unset reading applies to the listing
				// too: an empty env var is no secret at all.
				if (env[name] === undefined || env[name] === "") continue;
				// The inverse of `secretEnvName`'s key map (upper, `-`→`_`):
				// lower, `_`→`-` — kebab keys round-trip exactly; a snake key
				// still forward-resolves (both map to the same env name).
				const key = name.slice(prefix.length).toLowerCase().replace(/_/g, "-");
				if (key === "" || section[key] !== undefined) continue;
				keys.push({ key, source: "env" });
			}
			return keys;
		},
		setSecret: async (slug, key, value) => {
			const section = await secrets.readSection(slug);
			section[key] = value;
			await secrets.writeSection(slug, section);
		},
		deleteSecret: async (slug, key) => {
			const section = await secrets.readSection(slug);
			if (section[key] === undefined) return;
			delete section[key];
			await secrets.writeSection(slug, section);
		},
	};
}

/**
 * Build ONE extension's scoped view over the shared trio — the object
 * the factory host exposes as `stores`. All cheap closure wiring (no
 * I/O at construction): reads/writes ride the shared classes keyed by
 * `slug`, paths are joins, and the cache dir is created only when
 * `paths.cache` is actually read. The seam host REBUILDS this view on
 * `rekey` (the two-phase identity pattern) so the view always keys on
 * the host's CURRENT slug.
 */
export function scopedExtensionStores(
	shared: SharedExtensionStores,
	slug: string,
): ExtensionStores {
	return {
		user: (user) => shared.userExtensionStores(slug, user),
		secrets: {
			async get(key) {
				const section = await shared.secrets.readSection(slug);
				const value = section[key];
				return value === undefined || value === null
					? undefined
					: String(value);
			},
			async set(key, value) {
				const section = await shared.secrets.readSection(slug);
				section[key] = value;
				await shared.secrets.writeSection(slug, section);
			},
		},
		settings: {
			get: () => shared.settings.read(slug),
			set: (value) => shared.settings.write(slug, value),
		},
		paths: {
			data: join(shared.roots.dataDir, slug),
			state: join(shared.roots.stateDir, slug),
			get cache() {
				return ensureCacheDirAt(shared.roots, slug);
			},
		},
	};
}

/** The per-user file/dir layout (multi-user M2 §10.2, verbatim). */
const USER_SECRETS_DIR = "user-secrets";
const USER_SETTINGS_DIR = "user-settings";

/** Core's §10.6 step-5 cleanup, after userDeleted and directory removal.
 * Cache entries are enumerated because per-user registry entries may already
 * have uninstalled slugs. Data/state deliberately remain extension-owned.
 */
async function removeUserData(roots: StoreRoots, user: string): Promise<void> {
	await rm(join(roots.configDir, USER_SECRETS_DIR, `${user}.json`), { force: true });
	await rm(join(roots.configDir, USER_SETTINGS_DIR, user), { recursive: true, force: true });
	let slugs: readonly string[] = [];
	try {
		slugs = await readdir(roots.cacheDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await Promise.all(slugs.map((slug) =>
		rm(join(roots.cacheDir, slug, "users", user), { recursive: true, force: true }),
	));
}

/** Settings use sync mtime reload + queued atomic writes (0644, like shared settings). */
const userSettingQueues = new Map<string, MutationQueue>();
const userSettingMutations = {
	run<T>(path: string, op: () => Promise<T>): Promise<T> {
		const queue = userSettingQueues.get(path) ?? new MutationQueue();
		userSettingQueues.set(path, queue);
		return queue.run(op);
	},
};

function readUserSettings(path: string): Record<string, unknown> {
	const value = readJson<unknown>(path, {});
	if (!isPlainObject(value)) {
		throw new Error(`sigrun: ${path} must contain a JSON object`);
	}
	return value;
}

async function writeUserSettings(
	path: string,
	value: Record<string, unknown>,
): Promise<void> {
	try {
		await writeFileAtomic(path, serializeJson(value), 0o644);
	} finally {
		invalidateJsonCache(path);
	}
}

/** One user/slug view; user validity is checked at EVERY operation, not cached. */
// Directory usernames are validated at creation, and extension slugs are
// loader-sanitized; the joins below therefore cannot escape the store roots.
// The deleting marker is the ONLY missing-record exception, and its release
// immediately re-enables checks on handles already captured during fan-out.
export function userExtensionStores(
	roots: StoreRoots,
	users: UserDirectory,
	slug: string,
	user: string,
): UserExtensionStores {
	requireStoreUser(users, user);
	const secrets = new UserSecretsStore(
		join(roots.configDir, USER_SECRETS_DIR, `${user}.json`),
	);
	const rawPath = (root: string): string => {
		requireStoreUser(users, user);
		return ensureDirAt(join(root, slug, "users", user));
	};
	return {
		secrets: {
			async get(key) {
				requireStoreUser(users, user);
				const value = secrets.readSection(slug)[key];
				return value === undefined || value === null ? undefined : String(value);
			},
			async set(key, value) {
				await secrets.mutate(slug, (section) => {
					requireStoreUser(users, user);
					section[key] = value;
				});
			},
			async delete(key) {
				await secrets.mutate(slug, (section) => {
					requireStoreUser(users, user);
					delete section[key];
				});
			},
		},
		settings: {
			async get() {
				requireStoreUser(users, user);
				return readUserSettings(
					join(roots.configDir, USER_SETTINGS_DIR, user, `${slug}.json`),
				);
			},
			async set(value) {
				await userSettingMutations.run(
					join(roots.configDir, USER_SETTINGS_DIR, user, `${slug}.json`),
					async () => {
						requireStoreUser(users, user);
						await ensureDir(join(roots.configDir, USER_SETTINGS_DIR, user));
						await writeUserSettings(
							join(roots.configDir, USER_SETTINGS_DIR, user, `${slug}.json`),
							value,
						);
					},
				);
			},
		},
		paths: {
			get data() { return rawPath(roots.dataDir); },
			get state() { return rawPath(roots.stateDir); },
			get cache() { return rawPath(roots.cacheDir); },
		},
	};
}
