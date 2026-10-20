/**
 * The sigrun settings store (Task 8a, pi parity spec: the settings file).
 *
 * SPLIT (build-and-webui Task 1): the settings-file TYPES
 * (`SettingsFile`, `ServerSettings`, `DefaultProviderSettings`,
 * `ExtensionSpec`) live in the `@sigrun/shared` package
 * (`shared/src/settings.ts` — the canonical declarations, re-exported
 * below); this module owns the store/validation RUNTIME.
 *
 * A JSON file at `~/.config/sigrun/settings.json` (the config-dir
 * convention; `SIGRUN_CONFIG_DIR` overrides the directory for hermetic
 * tests, matching the repo's env-override style). The store carries the
 * `HarnessSettings` pass-throughs (`steeringMode`, `followUpMode`,
 * `retry`, `stream`) plus sigrun's own resolved fields:
 *
 * - `defaultTools` — a tool-name filter applied at conversation-create
 *   time (the server reads it from the store, resolves the names against
 *   the registry, and passes them as `AgentChange.modelTools` objects —
 *   the MODEL-OFFERED filter, pi-durable 1.2.0; NOT the enabled filter,
 *   so filtered-out tools stay callable by nested calls).
 * - `perModelThinking` — per-model thinking-level overrides (`"provider/
 *   modelId": level`), applied by the server at conversation create and
 *   configure.
 * - `server` — the static boot configuration (port, workspace/storage/
 *   extensions paths, compaction policy, backup target). The file is the
 *   deployment default UNDER env: `loadConfig(env, file)` applies a
 *   `server.*` field only where the corresponding `SIGRUN_*` variable is
 *   absent. Changes to `server.*` require a restart (they resolve at
 *   boot, unlike the live steeringMode/retry/etc. pass-throughs).
 *
 * The remaining boot knobs are file-configurable too (the 2026-10-13
 * config-surface rulings): top-level `extensions` (the extension package
 * list), top-level `defaultModel` (the boot default model — env or file,
 * one is REQUIRED, no code default), `server.webuiBundle`, and
 * `defaultProvider.baseUrl` (the env-driven OpenAI-compatible provider's
 * endpoint). Env still wins per setting. Credentials live in the sibling
 * `auth.json` (see src/harness/auth.ts), never in this file. The file's
 * own location stays env-only (`SIGRUN_CONFIG_DIR`).
 *
 * Contract (pi-durable's own): "HarnessSettings is read at every
 * resolution and never copied." So the store is a GETTER, not a snapshot:
 * `harnessSettings()` re-reads the file on every call, and `openHarness`
 * passes a live object whose property getters fetch fresh values — a
 * PATCH becomes effective on the next submission/admission without a
 * restart.
 *
 * Absent file = all defaults (empty store). Malformed file = fail-loud
 * at boot (like `loadConfig`), with a distinct error for a well-formed
 * JSON object carrying wrong-shaped or unknown fields.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { resolveStoreRoots } from "./stores.js";
import { isIanaTimeZone, validateJobSpec } from "../jobs/spec.js";
import type {
	JobHistorySettings,
	ServerSettings,
	SettingsFile,
} from "@sigrun/shared/settings";

export type {
	DefaultProviderSettings,
	EffectiveServerSetting,
	ExtensionSpec,
	JobHistorySettings,
	ServerSettingSource,
	ServerSettings,
	SettingsFile,
} from "@sigrun/shared/settings";

export interface SettingsStoreOptions {
	/**
	 * The settings directory, default `~/.config/sigrun` (env override
	 * `SIGRUN_CONFIG_DIR`; tests pass a tmp dir).
	 */
	readonly dir?: string;
}

/** The queue modes pi-durable accepts (its `QueueMode`). */
const QUEUE_MODES: readonly string[] = ["all", "one-at-a-time"];

/** The thinking levels the configure surface accepts (pi-ai's union). */
const THINKING_LEVELS: readonly string[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** Every settable key (PATCH validation + GET projection). */
const SETTING_KEYS = [
	"steeringMode",
	"followUpMode",
	"retry",
	"stream",
	"defaultTools",
	"perModelThinking",
	"extensions",
	"jobs",
	"jobHistory",
	"defaultModel",
	"namingModel",
	"defaultProvider",
	"server",
] as const;

/**
 * Warn once per process when the deprecated `server.webuiBundle` alias
 * appears in a validated file (build-and-webui Task 4, one release):
 * `read()` validates on EVERY access (the live-getter contract), so an
 * ungated warn would fire per resolution. Module-level, like
 * `warnDeprecatedModelEnv` in src/config.ts.
 */
let deprecatedWebuiBundleWarned = false;
function warnDeprecatedWebuiBundle(): void {
	if (deprecatedWebuiBundleWarned) return;
	deprecatedWebuiBundleWarned = true;
	console.warn(
		"settings: server.webuiBundle is deprecated, use server.webui.bundle (reads as the same selector for one release)",
	);
}

/**
 * Warn once per process when the file carries the retired
 * `server.extensionsDir` key (§6.7): accepted for one release so existing
 * files keep validating, warned because nothing reads it.
 */
let deprecatedExtensionsDirWarned = false;
function warnDeprecatedExtensionsDir(): void {
	if (deprecatedExtensionsDirWarned) return;
	deprecatedExtensionsDirWarned = true;
	console.warn(
		"settings: server.extensionsDir is deprecated and ignored (nothing reads the extensions dir)",
	);
}

/**
 * Default settings directory: the ONE config-root chain
 * (`resolveStoreRoots`, spec Decision 3) — `SIGRUN_CONFIG_DIR` →
 * `$XDG_CONFIG_HOME`/sigrun → `~/.config/sigrun`.
 */
export function defaultSettingsDir(): string {
	return resolveStoreRoots(process.env).configDir;
}

/** Default file path: `<dir>/settings.json`. */
export function settingsPath(dir: string): string {
	return join(dir, "settings.json");
}

/**
 * A field-level validation error. The server maps these to 400
 * `invalid_field` + the offending key (matching the repo's other PATCH
 * surfaces); `openHarness`'s boot-time read lets them throw (fail loud).
 */
export class SettingsValidationError extends Error {
	constructor(readonly field: string, reason: string) {
		super(`settings: ${field} ${reason}`);
	}
}

/** Validate one `SettingsFile`-shaped object; every field checked in place. */
function validate(value: Record<string, unknown>): void {
	for (const key of Object.keys(value)) {
		if (!SETTING_KEYS.includes(key as (typeof SETTING_KEYS)[number])) {
			throw new SettingsValidationError(key, "is not a settable field");
		}
	}
	const queueMode = (field: string): void => {
		const v = value[field];
		if (
			v !== undefined &&
			(typeof v !== "string" || !QUEUE_MODES.includes(v))
		) {
			throw new SettingsValidationError(field, 'must be "all" or "one-at-a-time"');
		}
	};
	queueMode("steeringMode");
	queueMode("followUpMode");
	if (value.retry !== undefined) {
		const retry = value.retry;
		if (typeof retry !== "object" || retry === null || Array.isArray(retry)) {
			throw new SettingsValidationError("retry", "must be an object");
		}
		const retryRecord = retry as Record<string, unknown>;
		for (const key of Object.keys(retryRecord)) {
			if (!["enabled", "maxRetries", "baseDelayMs", "maxAgentDelayMs"].includes(key)) {
				throw new SettingsValidationError(`retry.${key}`, "is not a retry field");
			}
		}
		if (retryRecord.maxRetries !== undefined && !isNonNegativeInt(retryRecord.maxRetries)) {
			throw new SettingsValidationError("retry.maxRetries", "must be a non-negative integer");
		}
		if (retryRecord.baseDelayMs !== undefined && !isNonNegativeInt(retryRecord.baseDelayMs)) {
			throw new SettingsValidationError("retry.baseDelayMs", "must be a non-negative integer");
		}
		if (retryRecord.maxAgentDelayMs !== undefined && !isNonNegativeInt(retryRecord.maxAgentDelayMs)) {
			throw new SettingsValidationError("retry.maxAgentDelayMs", "must be a non-negative integer");
		}
		if (retryRecord.enabled !== undefined && typeof retryRecord.enabled !== "boolean") {
			throw new SettingsValidationError("retry.enabled", "must be a boolean");
		}
	}
	if (value.stream !== undefined) {
		const stream = value.stream;
		if (typeof stream !== "object" || stream === null || Array.isArray(stream)) {
			throw new SettingsValidationError("stream", "must be an object");
		}
		const streamRecord = stream as Record<string, unknown>;
		for (const key of Object.keys(streamRecord)) {
			if (!["timeoutMs", "maxRetries", "maxRetryDelayMs"].includes(key)) {
				throw new SettingsValidationError(`stream.${key}`, "is not a stream field");
			}
		}
		for (const key of ["timeoutMs", "maxRetries", "maxRetryDelayMs"]) {
			if (streamRecord[key] !== undefined && !isNonNegativeInt(streamRecord[key])) {
				throw new SettingsValidationError(`stream.${key}`, "must be a non-negative integer");
			}
		}
	}
	if (value.defaultTools !== undefined) {
		const tools = value.defaultTools;
		if (
			!Array.isArray(tools) ||
			tools.some((name) => typeof name !== "string" || name === "")
		) {
			throw new SettingsValidationError("defaultTools", "must be an array of tool names");
		}
	}
	if (value.perModelThinking !== undefined) {
		const perModel = value.perModelThinking;
		if (typeof perModel !== "object" || perModel === null || Array.isArray(perModel)) {
			throw new SettingsValidationError("perModelThinking", "must be an object");
		}
		for (const [model, level] of Object.entries(perModel)) {
			if (
				typeof level !== "string" ||
				!THINKING_LEVELS.includes(level)
			) {
				throw new SettingsValidationError(
					`perModelThinking.${model}`,
					`must be one of ${THINKING_LEVELS.join(", ")}`,
				);
			}
		}
	}
	if (value.extensions !== undefined) {
		const extensions = value.extensions;
		if (!Array.isArray(extensions)) {
			throw new SettingsValidationError(
				"extensions",
				"must be an array of extension specifiers",
			);
		}
		for (const entry of extensions) {
			if (typeof entry === "string") {
				if (entry === "") {
					throw new SettingsValidationError(
						"extensions",
						"must not contain an empty specifier",
					);
				}
				continue;
			}
			if (typeof entry !== "object" || entry === null) {
				throw new SettingsValidationError(
					"extensions",
					"each entry must be a string or an object",
				);
			}
			const spec = entry as Record<string, unknown>;
			if (typeof spec.source !== "string" || spec.source === "") {
				throw new SettingsValidationError(
					"extensions",
					"object entries need a non-empty source",
				);
			}
			for (const key of ["entry", "ref"] as const) {
				const v = spec[key];
				if (v !== undefined && (typeof v !== "string" || v === "")) {
					throw new SettingsValidationError(
						"extensions",
						`object entry ${key} must be a non-empty string when present`,
					);
				}
			}
			if (
				spec.enabled !== undefined &&
				typeof spec.enabled !== "boolean"
			) {
				throw new SettingsValidationError(
					"extensions",
					"object entry enabled must be a boolean",
				);
			}
			const known = new Set(["source", "entry", "ref", "enabled"]);
			for (const key of Object.keys(spec)) {
				if (!known.has(key)) {
					throw new SettingsValidationError(
						"extensions",
						`unknown object-entry key: ${key}`,
					);
				}
			}
		}
	}
	// The file-declared job list (jobs §8.3): each entry is a full
	// `validateJobSpec` run (the §8.2 grammar), plus the source-level
	// rules — duplicate names are a validation error, and the whole list
	// is restart-required like `extensions` (boot reconciliation owns it).
	if (value.jobs !== undefined) {
		const jobs = value.jobs;
		if (!Array.isArray(jobs)) {
			throw new SettingsValidationError("jobs", "must be an array of job specs");
		}
		const seen = new Set<string>();
		for (const entry of jobs) {
			const result = validateJobSpec(entry);
			if (!result.ok) {
				throw new SettingsValidationError(
					`jobs`,
					`${result.field} ${result.message}`,
				);
			}
			if (seen.has(result.spec.name)) {
				throw new SettingsValidationError(
					"jobs",
					`duplicate job name "${result.spec.name}"`,
				);
			}
			seen.add(result.spec.name);
		}
	}
	// The live job-history retention knobs (§8.1, ruling 14): both
	// positive integers when present.
	if (value.jobHistory !== undefined) {
		const jobHistory = asRecord(value.jobHistory);
		if (jobHistory === undefined) {
			throw new SettingsValidationError("jobHistory", "must be an object");
		}
		checkKeys("jobHistory.", jobHistory, ["runs", "revisions"]);
		for (const key of ["runs", "revisions"] as const) {
			const v = jobHistory[key];
			if (v !== undefined && !isPositiveInt(v)) {
				throw new SettingsValidationError(
					`jobHistory.${key}`,
					"must be a positive integer",
				);
			}
		}
	}
	if (value.defaultModel !== undefined) {
		const spec = value.defaultModel;
		if (typeof spec !== "string" || spec.trim() === "") {
			throw new SettingsValidationError(
				"defaultModel",
				"must be a non-empty provider/model-id string",
			);
		}
		// Same fail-loud spec rules as SIGRUN_DEFAULT_MODEL
		// (config.parseModelSpec), with the file key named in the error.
		const trimmed = spec.trim();
		const slash = trimmed.indexOf("/");
		if (
			slash !== -1 &&
			(trimmed.slice(0, slash) === "" || trimmed.slice(slash + 1) === "")
		) {
			throw new SettingsValidationError(
				"defaultModel",
				"must have a non-empty provider and model id",
			);
		}
	}
	if (value.namingModel !== undefined && value.namingModel !== false) {
		// Exactly defaultModel's spec rules, plus the `false` disable flag
		// (checked before the string checks, so only the spec shapes fall
		// through to them).
		const spec = value.namingModel;
		if (typeof spec !== "string" || spec.trim() === "") {
			throw new SettingsValidationError(
				"namingModel",
				"must be a non-empty provider/model-id string or false",
			);
		}
		const trimmed = spec.trim();
		const slash = trimmed.indexOf("/");
		if (
			slash !== -1 &&
			(trimmed.slice(0, slash) === "" || trimmed.slice(slash + 1) === "")
		) {
			throw new SettingsValidationError(
				"namingModel",
				"must have a non-empty provider and model id",
			);
		}
	}
	if (value.defaultProvider !== undefined) {
		const provider = asRecord(value.defaultProvider);
		if (provider === undefined) {
			throw new SettingsValidationError("defaultProvider", "must be an object");
		}
		checkKeys("defaultProvider.", provider, ["baseUrl"]);
		if (provider.baseUrl !== undefined && !isNonEmptyString(provider.baseUrl)) {
			throw new SettingsValidationError(
				"defaultProvider.baseUrl",
				"must be a non-empty string",
			);
		}
	}
	if (value.server !== undefined) {
		validateServer(value.server);
	}
}

/**
 * Validate the `server` section in place (the rules mirror `src/config.ts`'s
 * env parsing exactly: port a positive integer, paths non-empty strings,
 * compaction token counts integers with the same minimums —
 * `backgroundTokens` keeps its designed "0 = background off" minimum —
 * backup exactly one of the two target shapes, like the env XOR rule).
 */
function validateServer(server: unknown): void {
	const record = asRecord(server);
	if (record === undefined) {
		throw new SettingsValidationError("server", "must be an object");
	}
	checkKeys("server.", record, [
		"port",
		"workspacePath",
		"storagePath",
		"extensionsDir",
		"maxUploadBytes",
		"maxFileReadBytes",
		"dataDir",
		"cacheDir",
		"stateDir",
		"timezone",
		"webui",
		"webuiBundle",
		"compaction",
		"memorySeam",
		"providers",
		"auth",
		"metrics",
		"backup",
	]);
	// The jobs default timezone (§8.2): an IANA name — `Intl` accepts
	// exactly the names croner's evaluation path resolves, and throws on
	// everything else, so the gate is one construction. Narrowed to a
	// string first: `asRecord`'s unknown value type flows `null` here
	// otherwise.
	const timezone =
		record.timezone === undefined || record.timezone === null
			? undefined
			: (record.timezone as string);
	if (timezone !== undefined && !isIanaTimeZone(timezone)) {
		throw new SettingsValidationError(
			"server.timezone",
			`must be an IANA name (got ${JSON.stringify(record.timezone)})`,
		);
	}
	if (record.port !== undefined && !isPositiveInt(record.port)) {
		throw new SettingsValidationError("server.port", "must be a positive integer");
	}
	// The upload knob (spec §6.2): same rule as the env parse — a positive
	// integer; `Math.ceil(max*4/3)+4096` derives the base64/import limits.
	if (
		record.maxUploadBytes !== undefined &&
		!isPositiveInt(record.maxUploadBytes)
	) {
		throw new SettingsValidationError(
			"server.maxUploadBytes",
			"must be a positive integer",
		);
	}
	// The raw file-read cap (spec §7.8): same rule as the upload knob — a
	// positive integer.
	if (
		record.maxFileReadBytes !== undefined &&
		!isPositiveInt(record.maxFileReadBytes)
	) {
		throw new SettingsValidationError(
			"server.maxFileReadBytes",
			"must be a positive integer",
		);
	}
	for (const key of ["workspacePath", "storagePath", "extensionsDir", "dataDir", "cacheDir", "stateDir"]) {
		if (record[key] !== undefined && !isNonEmptyString(record[key])) {
			throw new SettingsValidationError(`server.${key}`, "must be a non-empty string");
		}
	}
	// The retired `extensionsDir` key (§6.7) stays ACCEPTED for one
	// release (existing files keep validating) but warns — never throws —
	// exactly like the legacy `webuiBundle` alias below; nothing reads it.
	if (record.extensionsDir !== undefined) {
		warnDeprecatedExtensionsDir();
	}
	// The webui channel surface (build-and-webui Task 4). The LEGACY
	// `webuiBundle` key stays ACCEPTED for one release (a read-side alias
	// for `webui.bundle` in config resolution) but warns — never throws —
	// so existing deployments' files keep booting while Task 7's docs
	// migrate them.
	if (record.webuiBundle !== undefined) {
		if (!isNonEmptyString(record.webuiBundle)) {
			throw new SettingsValidationError("server.webuiBundle", "must be a non-empty string");
		}
		warnDeprecatedWebuiBundle();
	}
	if (record.webui !== undefined) {
		const webui = asRecord(record.webui);
		if (webui === undefined) {
			throw new SettingsValidationError("server.webui", "must be an object");
		}
		checkKeys("server.webui.", webui, ["enabled", "bundle"]);
		if (webui.enabled !== undefined && typeof webui.enabled !== "boolean") {
			throw new SettingsValidationError("server.webui.enabled", "must be a boolean");
		}
		// Non-empty only — name/path discrimination is Task 5's
		// serve-time concern, not a file-validation rule.
		if (webui.bundle !== undefined && !isNonEmptyString(webui.bundle)) {
			throw new SettingsValidationError("server.webui.bundle", "must be a non-empty string");
		}
	}
	if (record.compaction !== undefined) {
		const compaction = asRecord(record.compaction);
		if (compaction === undefined) {
			throw new SettingsValidationError("server.compaction", "must be an object");
		}
		checkKeys("server.compaction.", compaction, [
			"enabled",
			"reserveTokens",
			"keepRecentTokens",
			"backgroundTokens",
		]);
		if (compaction.enabled !== undefined && typeof compaction.enabled !== "boolean") {
			throw new SettingsValidationError("server.compaction.enabled", "must be a boolean");
		}
		for (const key of ["reserveTokens", "keepRecentTokens", "backgroundTokens"] as const) {
			const v = compaction[key];
			if (v === undefined) continue;
			// backgroundTokens' minimum is 0 — the designed "background off"
			// value, same as `SIGRUN_COMPACTION_BACKGROUND_TOKENS`.
			const minimum = key === "backgroundTokens" ? 0 : 1;
			if (
				typeof v !== "number" ||
				!Number.isInteger(v) ||
				v < minimum
			) {
				throw new SettingsValidationError(
					`server.compaction.${key}`,
					minimum === 0 ? "must be a non-negative integer" : "must be a positive integer",
				);
			}
		}
	}
	if (record.memorySeam !== undefined) {
		const memorySeam = asRecord(record.memorySeam);
		if (memorySeam === undefined) {
			throw new SettingsValidationError("server.memorySeam", "must be an object");
		}
		checkKeys("server.memorySeam.", memorySeam, [
			"hookDeadlineMs",
			"idleThresholdMs",
			"workerDeadlineMs",
			"queueMax",
		]);
		for (const key of [
			"hookDeadlineMs",
			"idleThresholdMs",
			"workerDeadlineMs",
			"queueMax",
		] as const) {
			const v = memorySeam[key];
			if (v !== undefined && !isPositiveInt(v)) {
				throw new SettingsValidationError(
					`server.memorySeam.${key}`,
					"must be a positive integer",
				);
			}
		}
	}
	if (record.providers !== undefined) {
		const providers = asRecord(record.providers);
		if (providers === undefined) {
			throw new SettingsValidationError("server.providers", "must be an object");
		}
		checkKeys("server.providers.", providers, ["refreshIntervalMinutes"]);
		if (
			providers.refreshIntervalMinutes !== undefined &&
			!isNonNegativeInt(providers.refreshIntervalMinutes)
		) {
			throw new SettingsValidationError(
				"server.providers.refreshIntervalMinutes",
				"must be a non-negative integer",
			);
		}
	}
	if (record.auth !== undefined) {
		const auth = asRecord(record.auth);
		if (auth === undefined) {
			throw new SettingsValidationError("server.auth", "must be an object");
		}
		checkKeys("server.auth.", auth, [
			"methods",
			"proxy",
			"adminGroups",
			"allowedHosts",
			"allowedOrigins",
		]);
		if (auth.methods !== undefined) {
			if (
				!Array.isArray(auth.methods) ||
				auth.methods.some((m) => m !== "token" && m !== "proxy")
			) {
				throw new SettingsValidationError(
					"server.auth.methods",
					'must be an array of "token" and/or "proxy"',
				);
			}
		}
		if (auth.proxy !== undefined) {
			const proxy = asRecord(auth.proxy);
			if (proxy === undefined) {
				throw new SettingsValidationError("server.auth.proxy", "must be an object");
			}
			// `secret` is deliberately NOT in the list: the shared secret is a
			// credential, env-only (SIGRUN_PROXY_SECRET) — key material never
			// lives in the settings file (auth.json's monopoly).
			checkKeys("server.auth.proxy.", proxy, [
				"trustedProxies",
				"secretHeader",
				"userHeader",
				"groupsHeader",
				"nameHeader",
				"emailHeader",
				"autoProvision",
			]);
			if (proxy.trustedProxies !== undefined && !isNonEmptyStringArray(proxy.trustedProxies)) {
				throw new SettingsValidationError(
					"server.auth.proxy.trustedProxies",
					"must be an array of non-empty CIDR/IP strings",
				);
			}
			for (const key of ["secretHeader", "userHeader", "groupsHeader", "nameHeader", "emailHeader"] as const) {
				if (proxy[key] !== undefined && !isNonEmptyString(proxy[key])) {
					throw new SettingsValidationError(
						`server.auth.proxy.${key}`,
					"must be a non-empty string",
				);
			}
			}
			if (proxy.autoProvision !== undefined && typeof proxy.autoProvision !== "boolean") {
				throw new SettingsValidationError(
					"server.auth.proxy.autoProvision",
					"must be a boolean",
				);
			}
		}
		for (const key of ["adminGroups", "allowedHosts", "allowedOrigins"] as const) {
			if (auth[key] !== undefined && !isNonEmptyStringArray(auth[key])) {
				throw new SettingsValidationError(
					`server.auth.${key}`,
					"must be an array of non-empty strings",
				);
			}
		}
	}
	if (record.metrics !== undefined) {
		const metrics = asRecord(record.metrics);
		if (metrics === undefined) {
			throw new SettingsValidationError("server.metrics", "must be an object");
		}
		checkKeys("server.metrics.", metrics, ["public"]);
		if (metrics.public !== undefined && typeof metrics.public !== "boolean") {
			throw new SettingsValidationError("server.metrics.public", "must be a boolean");
		}
	}
	if (record.backup !== undefined) {
		const backup = asRecord(record.backup);
		if (backup === undefined) {
			throw new SettingsValidationError("server.backup", "must be an object");
		}
		checkKeys("server.backup.", backup, ["path", "s3", "staleAfterHours"]);
		if (backup.path !== undefined && backup.s3 !== undefined) {
			throw new SettingsValidationError(
				"server.backup",
				"must carry exactly one target (path or s3, not both)",
			);
		}
		// §6.8: the honesty knob — a positive NUMBER (not integer-only:
		// a sub-hour window like 0.5 is a legal tuning), defaulting to 36
		// at resolution; not a target, so it may ride either shape or sit
		// alone (a no-target backup section holding only the knob is inert).
		if (
			backup.staleAfterHours !== undefined &&
			!isPositiveNumber(backup.staleAfterHours)
		) {
			throw new SettingsValidationError(
				"server.backup.staleAfterHours",
				"must be a positive number",
			);
		}
		if (backup.path !== undefined && !isNonEmptyString(backup.path)) {
			throw new SettingsValidationError("server.backup.path", "must be a non-empty string");
		}
		if (backup.s3 !== undefined) {
			const s3 = asRecord(backup.s3);
			if (s3 === undefined) {
				throw new SettingsValidationError("server.backup.s3", "must be an object");
			}
			checkKeys("server.backup.s3.", s3, ["bucket", "prefix", "endpoint"]);
			if (!isNonEmptyString(s3.bucket)) {
				throw new SettingsValidationError(
					"server.backup.s3.bucket",
					"is required (and must be a non-empty string) when server.backup.s3 is set",
				);
			}
			for (const key of ["prefix", "endpoint"]) {
				if (s3[key] !== undefined && !isNonEmptyString(s3[key])) {
					throw new SettingsValidationError(`server.backup.s3.${key}`, "must be a non-empty string");
				}
			}
		}
	}
}

function isNonNegativeInt(value: unknown): boolean {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0
	);
}

/** A positive integer (the `server.port` rule, mirroring `SIGRUN_PORT`). */
function isPositiveInt(value: unknown): boolean {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value > 0
	);
}

/** A positive finite number (§6.8's `server.backup.staleAfterHours`). */
function isPositiveNumber(value: unknown): boolean {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value > 0
	);
}

/** A non-empty string (the file's path/string fields). */
function isNonEmptyString(value: unknown): boolean {
	return typeof value === "string" && value !== "";
}

function isNonEmptyStringArray(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every((entry) => isNonEmptyString(entry))
	);
}

/** An enumerable record (not null, not an array). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Every key not in `allowed` → a `SettingsValidationError` naming it. */
function checkKeys(
	prefix: string,
	record: Record<string, unknown>,
	allowed: readonly string[],
	reason = "is not a settable field",
): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) {
			throw new SettingsValidationError(`${prefix}${key}`, reason);
		}
	}
}

/**
 * A file-backed settings store. All reads go through `read()` — fresh
 * file contents every call, so a PATCH from another process or a hand
 * edit lands on the next resolution.
 */
export class SettingsStore {
	readonly path: string;

	constructor(options: SettingsStoreOptions = {}) {
		this.path = settingsPath(options.dir ?? defaultSettingsDir());
	}

	/** The current settings; absent file = `{}` (all defaults). */
	read(): SettingsFile {
		if (!existsSync(this.path)) return {};
		const raw = readFileSync(this.path, "utf8");
		return this.parse(raw);
	}

	/**
	 * First-boot initialization (the settings bootstrap, ruling 5 /
	 * spec §6.6): when the file is ABSENT, write ONLY what the
	 * environment set — the env-sourced `server` fields (the
	 * `envServerSection` projection) plus the top-level `extensions`
	 * list and `defaultModel` when env supplied them. Defaults are
	 * NEVER persisted, so later releases' default changes reach existing
	 * installs; a `server` section with zero entries is omitted entirely
	 * (a nothing-env-set boot writes at most the top-level keys). When
	 * the file already exists (any content), bootstrap is a no-op: the
	 * file is never overwritten, and env vars continue to win over it on
	 * the next boot (env-over-file precedence). Idempotent: bootstrapping
	 * twice leaves the file byte-identical.
	 */
	bootstrap(
		resolvedServer: ServerSettings,
		resolved?: {
			readonly extensions?: readonly string[];
			readonly defaultModel?: string;
		},
	): void {
		if (existsSync(this.path)) return;
		mkdirSync(dirname(this.path), { recursive: true });
		const file: SettingsFile = {
			...(resolved?.extensions !== undefined
				? { extensions: resolved.extensions }
				: {}),
			...(resolved?.defaultModel !== undefined
				? { defaultModel: resolved.defaultModel }
				: {}),
			...(Object.keys(resolvedServer).length === 0
				? {}
				: { server: resolvedServer }),
		};
		writeFileSync(
			this.path,
			`${JSON.stringify(file, null, "\t")}\n`,
		);
	}

	/**
	 * Parse file contents. A malformed file throws fail-loud — at boot
	 * `openHarness` surfaces this exactly like a bad `SIGRUN_*` value
	 * (the same fail-loud posture as `loadConfig`).
	 */
	parse(raw: string): SettingsFile {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (cause) {
			throw new Error(
				`settings: ${this.path} is not valid JSON (${
					cause instanceof Error ? cause.message : String(cause)
				})`,
			);
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error(
				`settings: ${this.path} must contain a JSON object`,
			);
		}
		const value = parsed as Record<string, unknown>;
		validate(value);
		return value as SettingsFile;
	}

	/**
	 * Merge `patch` over the current settings and persist. An explicit
	 * `null` value clears the key; a sub-object field merges per-key
	 * (`null` inside a sub-object clears that sub-field). Returns the
	 * new effective settings.
	 *
	 * @throws SettingsValidationError naming the offending field.
	 */
		update(patch: Record<string, unknown>): SettingsFile {
		const merged: Record<string, unknown> = {
			...this.read(),
		} as Record<string, unknown>;
		for (const [key, value] of Object.entries(patch)) {
			if (!SETTING_KEYS.includes(key as (typeof SETTING_KEYS)[number])) {
				throw new SettingsValidationError(key, "is not a settable field");
			}
			if (value === null) {
				delete merged[key];
				continue;
			}
			if (
				(key === "retry" || key === "stream") &&
				typeof value === "object" &&
				value !== null
			) {
				// Sub-merge: PATCH {retry: {maxRetries: 0}} preserves other
				// retry fields; a null sub-field clears just that one.
				const sub: Record<string, unknown> = {
					...((merged[key] as Record<string, unknown>) ?? {}),
				};
				for (const [subKey, subValue] of Object.entries(
					value as Record<string, unknown>,
				)) {
					if (subValue === null) delete sub[subKey];
					else sub[subKey] = subValue;
				}
				if (Object.keys(sub).length === 0) delete merged[key];
				else merged[key] = sub;
				continue;
			}
			if (
				key === "server" &&
				typeof value === "object" &&
				value !== null
			) {
				// Server sub-merge: PATCH {server: {port: 4080}} preserves the
				// rest of the section (including the bootstrap-written fields);
				// `compaction`/`memorySeam`/`providers`/`webui`/`auth`/`metrics`
				// sub-merge one level deeper (`auth.proxy` two levels); `backup`
				// replaces wholesale (it is a discriminated union — a partial
				// union merge could mix a path target with an s3 one).
				const incoming = asRecord(value);
				if (incoming === undefined) {
					throw new SettingsValidationError("server", "must be an object");
				}
				const sub: Record<string, unknown> = {
					...((merged.server as Record<string, unknown>) ?? {}),
				};
					for (const [subKey, subValue] of Object.entries(incoming)) {
						if (subValue === null) delete sub[subKey];
						else if (
							subKey === "compaction" &&
							typeof subValue === "object"
						) {
							const mergedCompaction: Record<string, unknown> = {
								...((sub.compaction as Record<string, unknown>) ?? {}),
							};
							for (const [compKey, compValue] of Object.entries(
								subValue as Record<string, unknown>,
							)) {
								if (compValue === null) delete mergedCompaction[compKey];
								else mergedCompaction[compKey] = compValue;
							}
							if (Object.keys(mergedCompaction).length === 0) delete sub.compaction;
							else sub.compaction = mergedCompaction;
						} else if (
							subKey === "memorySeam" &&
							typeof subValue === "object"
						) {
							// Same sub-merge as compaction: a flat record, merged per-key
							// (a wholesale replace would silently drop unset knobs).
							const mergedSeam: Record<string, unknown> = {
								...((sub.memorySeam as Record<string, unknown>) ?? {}),
							};
							for (const [seamKey, seamValue] of Object.entries(
								subValue as Record<string, unknown>,
							)) {
								if (seamValue === null) delete mergedSeam[seamKey];
								else mergedSeam[seamKey] = seamValue;
							}
							if (Object.keys(mergedSeam).length === 0) delete sub.memorySeam;
							else sub.memorySeam = mergedSeam;
						} else if (
							subKey === "providers" &&
							typeof subValue === "object"
						) {
							// Same sub-merge for the provider runtime knobs: a flat
							// record merged per-key (the refresh cadence PATCH never
							// drops the section's other server fields).
							const mergedProviders: Record<string, unknown> = {
								...((sub.providers as Record<string, unknown>) ?? {}),
							};
							for (const [provKey, provValue] of Object.entries(
								subValue as Record<string, unknown>,
							)) {
								if (provValue === null) delete mergedProviders[provKey];
								else mergedProviders[provKey] = provValue;
							}
							if (Object.keys(mergedProviders).length === 0) delete sub.providers;
							else sub.providers = mergedProviders;
					} else if (
						subKey === "webui" &&
						typeof subValue === "object"
					) {
						// Same sub-merge for the webui channel section (build-and-webui
						// Task 4): PATCH {server:{webui:{enabled:false}}} preserves a
						// previously set bundle — a wholesale replace would silently
						// drop the operator's selector.
						const mergedWebui: Record<string, unknown> = {
							...((sub.webui as Record<string, unknown>) ?? {}),
						};
						for (const [webuiKey, webuiValue] of Object.entries(
							subValue as Record<string, unknown>,
						)) {
							if (webuiValue === null) delete mergedWebui[webuiKey];
							else mergedWebui[webuiKey] = webuiValue;
						}
						if (Object.keys(mergedWebui).length === 0) delete sub.webui;
						else sub.webui = mergedWebui;
					} else if (
						subKey === "auth" &&
						typeof subValue === "object"
					) {
						// The auth section (core-hardening W1) sub-merges per-key like
						// webui, with `proxy` one level deeper still: PATCH
						// {server:{auth:{proxy:{autoProvision:false}}}} preserves a
						// stored trustedProxies — a wholesale replace would silently
						// turn a proxy deployment into "trust no one" (or worse, keep
						// trusting with different headers).
						const mergedAuth: Record<string, unknown> = {
							...((sub.auth as Record<string, unknown>) ?? {}),
						};
						for (const [authKey, authValue] of Object.entries(
							subValue as Record<string, unknown>,
						)) {
							if (authValue === null) delete mergedAuth[authKey];
							else if (
								authKey === "proxy" &&
								typeof authValue === "object"
							) {
								const mergedProxy: Record<string, unknown> = {
									...((mergedAuth.proxy as Record<string, unknown>) ?? {}),
								};
								for (const [proxyKey, proxyValue] of Object.entries(
									authValue as Record<string, unknown>,
								)) {
									if (proxyValue === null) delete mergedProxy[proxyKey];
									else mergedProxy[proxyKey] = proxyValue;
								}
								if (Object.keys(mergedProxy).length === 0) delete mergedAuth.proxy;
								else mergedAuth.proxy = mergedProxy;
							} else mergedAuth[authKey] = authValue;
						}
						if (Object.keys(mergedAuth).length === 0) delete sub.auth;
						else sub.auth = mergedAuth;
					} else if (
						subKey === "metrics" &&
						typeof subValue === "object"
					) {
						const mergedMetrics: Record<string, unknown> = {
							...((sub.metrics as Record<string, unknown>) ?? {}),
						};
						for (const [metricsKey, metricsValue] of Object.entries(
							subValue as Record<string, unknown>,
						)) {
							if (metricsValue === null) delete mergedMetrics[metricsKey];
							else mergedMetrics[metricsKey] = metricsValue;
						}
						if (Object.keys(mergedMetrics).length === 0) delete sub.metrics;
						else sub.metrics = mergedMetrics;
					} else sub[subKey] = subValue;
				}
				if (Object.keys(sub).length === 0) delete merged.server;
				else merged.server = sub;
				continue;
			}
			if (
				key === "defaultProvider" &&
				typeof value === "object" &&
				value !== null
			) {
				// Same sub-merge as retry/stream: a null sub-field clears just
				// that field of the provider section.
				const sub: Record<string, unknown> = {
					...((merged[key] as Record<string, unknown>) ?? {}),
				};
				for (const [subKey, subValue] of Object.entries(
					value as Record<string, unknown>,
				)) {
					if (subValue === null) delete sub[subKey];
					else sub[subKey] = subValue;
				}
				if (Object.keys(sub).length === 0) delete merged[key];
				else merged[key] = sub;
				continue;
			}
			if (
				key === "perModelThinking" &&
				typeof value === "object" &&
				value !== null
			) {
				// Same sub-merge for the model-ref map: a null level clears
				// that model's override.
				const sub: Record<string, unknown> = {
					...((merged[key] as Record<string, unknown>) ?? {}),
				};
				for (const [model, level] of Object.entries(
					value as Record<string, unknown>,
				)) {
					if (level === null) delete sub[model];
					else sub[model] = level;
				}
				if (Object.keys(sub).length === 0) delete merged[key];
				else merged[key] = sub;
				continue;
			}
			merged[key] = value;
		}
		validate(merged);
		const file = merged as SettingsFile;
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${JSON.stringify(file, null, "\t")}\n`);
		return file;
	}

	/**
	 * A live `HarnessSettings` object for `openHarness`: every property
	 * reads the file AT ACCESS TIME, so pi-durable's per-resolution
	 * `resolveSettings()` observes PATCHed changes without a restart.
	 * Called once per harness boot; the returned object must never be
	 * copied or snapshotted (pi-durable's contract) — `openHarness`
	 * composes it getter-preserving (caller seam first, file second),
	 * never via a spread, which would freeze the boot values.
	 */
	harnessSettings(): {
		readonly steeringMode?: "all" | "one-at-a-time";
		readonly followUpMode?: "all" | "one-at-a-time";
		readonly retry?: SettingsFile["retry"];
		readonly stream?: SettingsFile["stream"];
	} {
		const store = this;
		// Eager validation: a malformed file throws HERE, at boot (the
		// fail-loud posture), even though the getters below defer their
		// first read to pi-durable's first resolution.
		store.read();
		return {
			get steeringMode() {
				return store.read().steeringMode;
			},
			get followUpMode() {
				return store.read().followUpMode;
			},
			get retry() {
				return store.read().retry;
			},
			get stream() {
				return store.read().stream;
			},
		};
	}
}