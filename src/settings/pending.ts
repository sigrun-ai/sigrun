/**
 * The pending-restart derivation (UI-blocks U4 Task 1, spec §13.2): the
 * server keeps a BOOT SNAPSHOT of every `restart` key's stored value,
 * taken once after settings load and before listen (openHarness is
 * pre-listen by construction). `pendingRestart` is the diff: the
 * restart keys whose CURRENT stored value differs from the snapshot —
 * so patching a key BACK to its boot value removes it (Review Focus 2:
 * the callout disappears without a restart).
 *
 * Also here: the WRITE classification. A PATCH body names top-level or
 * `server.*` sub-keys; `classifyPatch` expands those to the flattened
 * registry paths the patch TOUCHED (a `server: {port: 1}` patch touches
 * `server.port` only) and splits them into `applied` (live) and
 * `pending` (restart) per the registry.
 */

import type { SettingsFile } from "@sigrun/shared/settings";
import { DEFAULT_PROVIDER_REFRESH_MINUTES } from "../config.js";
import { CORE_SETTING_KEYS, applyOf, type SettingApply } from "./registry.js";

/** A settings write's classification (spec §13.2: writes report both). */
export interface ApplyOutcome {
	/** Live keys the write applied immediately. */
	readonly applied: readonly string[];
	/** Restart keys the write stored as pending. */
	readonly pending: readonly string[];
	/** Every flattened key path the write touched, in patch order. */
	readonly keys: readonly string[];
}

/**
 * The sub-object keys a PATCH merges per-key (matching the store's
 * update() sub-merge grammar). A patch naming one of these top-level
 * keys with an object value touches only the SUB-keys present.
 */
const SUB_MERGED: ReadonlySet<string> = new Set([
	"retry",
	"stream",
	"perModelThinking",
	"defaultProvider",
	"skills",
	"jobHistory",
	"builtinExtensions",
	"notifications",
]);

/**
 * Expand one PATCH body to the flattened registry paths it touches.
 * Top-level scalars map 1:1; `server` walks its nested sections; the
 * other sub-merged objects expand their present sub-keys (a `null`
 * sub-value clears exactly that key). Unknown paths are kept verbatim
 * (validation rejects them before this runs, so they never surface —
 * but keeping them makes the classification total, never lossy).
 */
export function touchedKeys(patch: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const [key, value] of Object.entries(patch)) {
		if (key === "server") {
			if (typeof value !== "object" || value === null) {
				out.push("server");
				continue;
			}
			for (const [serverKey, serverValue] of Object.entries(
				value as Record<string, unknown>,
			)) {
				const base = `server.${serverKey}`;
				if (
					(serverKey === "webui" ||
						serverKey === "compaction" ||
						serverKey === "memorySeam" ||
						serverKey === "providers" ||
						serverKey === "backup") &&
					typeof serverValue === "object" &&
					serverValue !== null
				) {
					for (const sub of Object.keys(serverValue as Record<string, unknown>)) {
						out.push(`${base}.${sub}`);
					}
					continue;
				}
				if (serverKey === "auth" && typeof serverValue === "object" && serverValue !== null) {
					for (const [authKey, authValue] of Object.entries(
						serverValue as Record<string, unknown>,
					)) {
						if (
							authKey === "proxy" &&
							typeof authValue === "object" &&
							authValue !== null
						) {
							for (const proxyKey of Object.keys(authValue as Record<string, unknown>)) {
								out.push(`server.auth.proxy.${proxyKey}`);
							}
							continue;
						}
						out.push(`server.auth.${authKey}`);
					}
					continue;
				}
				if (serverKey === "metrics" && typeof serverValue === "object" && serverValue !== null) {
					for (const sub of Object.keys(serverValue as Record<string, unknown>)) {
						out.push(`${base}.${sub}`);
					}
					continue;
				}
				out.push(base);
			}
			continue;
		}
		if (SUB_MERGED.has(key) && typeof value === "object" && value !== null) {
			for (const sub of Object.keys(value as Record<string, unknown>)) {
				out.push(`${key}.${sub}`);
			}
			continue;
		}
		out.push(key);
	}
	return out;
}

/**
 * Classify a write over the registry: which touched keys are live
 * (`applied`) and which restart (`pending`). A key with no registry
 * entry classifies as restart (the conservative default).
 */
export function classifyPatch(
	patch: Record<string, unknown>,
): ApplyOutcome {
	const keys = touchedKeys(patch);
	const applied: string[] = [];
	const pending: string[] = [];
	for (const key of keys) {
		if (applyOf(key) === "live") applied.push(key);
		else pending.push(key);
	}
	return { applied, pending, keys };
}

/**
 * The boot snapshot: every restart key's stored value, flattened to
 * comparable JSON strings (canonical-key ordering keeps object-value
 * comparisons stable regardless of key order in the file).
 */
export type SettingsBootSnapshot = ReadonlyMap<string, string>;

/** Canonical JSON of one value (object keys sorted, stable). */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, v) =>
		typeof v === "object" && v !== null && !Array.isArray(v)
			? Object.fromEntries(
					Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0,
					),
				)
			: v,
	);
}

/**
 * Take the boot snapshot: read the restart keys' values from the
 * CURRENT settings file. Called ONCE per boot, after the settings load
 * validates and before listen.
 */
export function snapshotRestartKeys(
	file: SettingsFile,
): SettingsBootSnapshot {
	const snapshot = new Map<string, string>();
	for (const entry of CORE_SETTING_KEYS) {
		if (entry.apply !== "restart") continue;
		snapshot.set(entry.key, canonicalAt(file, entry.key));
	}
	return snapshot;
}

/**
 * The pending-restart diff: restart keys whose stored value differs
 * from the boot snapshot. Registry order (stable, matches the audit).
 */
export function pendingRestart(
	file: SettingsFile,
	snapshot: SettingsBootSnapshot,
): string[] {
	const pending: string[] = [];
	for (const entry of CORE_SETTING_KEYS) {
		if (entry.apply !== "restart") continue;
		if (canonicalAt(file, entry.key) !== snapshot.get(entry.key)) {
			pending.push(entry.key);
		}
	}
	return pending;
}

/**
 * The CANONICAL JSON at one flattened dotted path: object keys
 * sorted (stable), `"undefined"` at any missing level — the exact
 * cell form the snapshot map stores, so the diff is one string
 * comparison per key (the per-key value shape is the store's
 * validation domain, never re-parsed here).
 */
function canonicalAt(file: SettingsFile, path: string): string {
	let node: unknown = file;
	for (const key of path.split(".")) {
		if (typeof node !== "object" || node === null) {
			return canonical(undefined);
		}
		node = (node as Record<string, unknown>)[key];
	}
	return canonical(node);
}

/**
 * The apply label one key reports (public re-export seam: routes and
 * tests import from this module's surface; `applyOf` is the registry's).
 */
export function settingApplyOf(key: string): SettingApply {
	return applyOf(key);
}

/**
 * Resolve the provider refresh cadence ENV-OVER-FILE (U4 §13.1's
 * re-arm): `SIGRUN_PROVIDER_REFRESH_MINUTES` when set, else the fresh
 * file value, else the code default — exactly `loadConfig`'s
 * resolution for the same key, read live for the scheduler re-arm.
 */
export function resolveRefreshMinutes(
	env: Readonly<Record<string, string | undefined>>,
	file: { read(): { server?: { providers?: { refreshIntervalMinutes?: number } } } },
): number {
	const fromEnv = env.SIGRUN_PROVIDER_REFRESH_MINUTES;
	if (fromEnv !== undefined && fromEnv !== "") {
		const parsed = Number(fromEnv);
		if (Number.isInteger(parsed) && parsed >= 0) return parsed;
	}
	return (
		file.read().server?.providers?.refreshIntervalMinutes ??
		DEFAULT_PROVIDER_REFRESH_MINUTES
	);
}
