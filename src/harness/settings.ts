/**
 * The sigrun settings store (Task 8a, pi parity spec: the settings file).
 *
 * A JSON file at `~/.config/sigrun/settings.json` (the config-dir
 * convention; `SIGRUN_CONFIG_DIR` overrides the directory for hermetic
 * tests, matching the repo's env-override style). The store carries the
 * `HarnessSettings` pass-throughs (`steeringMode`, `followUpMode`,
 * `retry`, `stream`) plus sigrun's own resolved fields:
 *
 * - `defaultTools` — a tool-name filter applied at conversation-create
 *   time (the server reads it from the store and passes it as
 *   `agent.tools` names to pi-durable's `AgentChange.tools`).
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
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * The `server` section: static boot configuration mirrored from the
 * `SIGRUN_*` env knobs of `src/config.ts`. Every field is optional; a
 * present field is the deployment default applied when the corresponding
 * env var is ABSENT (env always wins, validated first). Not here:
 * `webuiBundle`, the extensions list, and the model (all env-only).
 */
export interface ServerSettings {
	/** `SIGRUN_PORT` — a positive integer. */
	readonly port?: number;
	/** `SIGRUN_WORKSPACE_PATH` — a non-empty path. */
	readonly workspacePath?: string;
	/** `SIGRUN_STORAGE_PATH` — a non-empty path. */
	readonly storagePath?: string;
	/** `SIGRUN_EXTENSIONS_DIR` — a non-empty path. */
	readonly extensionsDir?: string;
	/**
	 * `SIGRUN_WEBUI_BUNDLE` — a non-empty path. Relative paths resolve
	 * against the process cwd, like the env var. A present value counts as
	 * an EXPLICIT bundle (missing `index.html` is a boot error), exactly
	 * like a set env var.
	 */
	readonly webuiBundle?: string;
	/** The `SIGRUN_COMPACTION_*` policy knobs. */
	readonly compaction?: {
		readonly enabled?: boolean;
		readonly reserveTokens?: number;
		readonly keepRecentTokens?: number;
		readonly backgroundTokens?: number;
	};
	/**
	 * The backup target — exactly one of the two shapes (mirroring the
	 * env rule: `SIGRUN_BACKUP_PATH` XOR `SIGRUN_BACKUP_S3_BUCKET`).
	 */
	readonly backup?:
		| { readonly path?: string }
		| {
				readonly s3?: {
					readonly bucket?: string;
					readonly prefix?: string;
					readonly endpoint?: string;
				};
		  };
}

/**
 * The degenerate env-driven provider's static configuration (ruling 7).
 * Only the endpoint is here — credentials live in `auth.json`.
 */
export interface DefaultProviderSettings {
	/** `OPENAI_BASE_URL` — a non-empty URL. */
	readonly baseUrl?: string;
}

/** The persisted shape: HarnessSettings pass-throughs + sigrun fields. */
export interface SettingsFile {
	/** pi-durable `HarnessSettings.steeringMode`. */
	readonly steeringMode?: "all" | "one-at-a-time";
	/** pi-durable `HarnessSettings.followUpMode`. */
	readonly followUpMode?: "all" | "one-at-a-time";
	/** pi-durable `HarnessSettings.retry` (partial policy, merged over defaults). */
	readonly retry?: {
		readonly enabled?: boolean;
		readonly maxRetries?: number;
		readonly baseDelayMs?: number;
		readonly maxAgentDelayMs?: number;
	};
	/** pi-durable `HarnessSettings.stream` (partial, merged over defaults). */
	readonly stream?: {
		readonly timeoutMs?: number;
		readonly maxRetries?: number;
		readonly maxRetryDelayMs?: number;
	};
	/** Sigrun: tool-name filter applied at conversation creation. */
	readonly defaultTools?: readonly string[];
	/**
	 * Sigrun: per-model thinking-level overrides, keyed by
	 * `"provider/modelId"`.
	 */
	readonly perModelThinking?: Readonly<Record<string, string>>;
	/**
	 * Sigrun: the extension LOAD list (ruling 1) — non-empty package
	 * specifiers, applied when `SIGRUN_EXTENSIONS` is absent. Changes
	 * require a restart (extensions load at boot).
	 */
	readonly extensions?: readonly string[];
	/**
	 * Sigrun: the extension INSTALL list — non-empty npm package
	 * specifiers (`"name"`, `"name@range"`, `"@scope/name@range"`, a
	 * `file:` path) installed into the packages dir
	 * (`<config-dir>/packages/`) at boot by `syncPackages`. FILE-ONLY
	 * (installing is not an env-shaped act — there is no
	 * `SIGRUN_PACKAGES`) and never written by the settings bootstrap
	 * (the package dir's own `package.json` is the resolved state).
	 * Distinct from `extensions` (the LOAD list): a package may be
	 * installed-but-not-loaded, and a loaded extension may come from
	 * somewhere else (a dev checkout, an image-bundled package).
	 * Changes require a restart.
	 */
	readonly packages?: readonly string[];
	/**
	 * Sigrun: the boot default model (ruling 3), a non-empty
	 * `provider/model-id` spec parsed exactly like `SIGRUN_DEFAULT_MODEL`
	 * (bare id implies the `openai` provider). Applied when the env var is
	 * absent; REQUIRED overall — neither env nor file is a fail-loud boot
	 * error, no code default.
	 */
	readonly defaultModel?: string;
	/**
	 * Sigrun: the env-driven OpenAI-compatible provider's endpoint
	 * (ruling 7), applied when `OPENAI_BASE_URL` is absent.
	 */
	readonly defaultProvider?: DefaultProviderSettings;
	/**
	 * Sigrun: the static boot configuration (see {@link ServerSettings}).
	 * Deployment defaults under env — changes require a restart.
	 */
	readonly server?: ServerSettings;
}

/** Every settable key (PATCH validation + GET projection). */
const SETTING_KEYS = [
	"steeringMode",
	"followUpMode",
	"retry",
	"stream",
	"defaultTools",
	"perModelThinking",
	"extensions",
	"packages",
	"defaultModel",
	"defaultProvider",
	"server",
] as const;

/** Default settings directory (`~/.config/sigrun`). */
export function defaultSettingsDir(): string {
	return process.env.SIGRUN_CONFIG_DIR !== undefined &&
		process.env.SIGRUN_CONFIG_DIR !== ""
		? process.env.SIGRUN_CONFIG_DIR
		: join(homedir(), ".config", "sigrun");
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
		if (
			!Array.isArray(extensions) ||
			extensions.some(
				(entry) => typeof entry !== "string" || entry === "",
			)
		) {
			throw new SettingsValidationError(
				"extensions",
				"must be an array of non-empty package specifiers",
			);
		}
	}
	if (value.packages !== undefined) {
		const packages = value.packages;
		if (
			!Array.isArray(packages) ||
			packages.some(
				(entry) => typeof entry !== "string" || entry === "",
			)
		) {
			throw new SettingsValidationError(
				"packages",
				"must be an array of non-empty package specifiers",
			);
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
		"webuiBundle",
		"compaction",
		"backup",
	]);
	if (record.port !== undefined && !isPositiveInt(record.port)) {
		throw new SettingsValidationError("server.port", "must be a positive integer");
	}
	for (const key of ["workspacePath", "storagePath", "extensionsDir", "webuiBundle"]) {
		if (record[key] !== undefined && !isNonEmptyString(record[key])) {
			throw new SettingsValidationError(`server.${key}`, "must be a non-empty string");
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
	if (record.backup !== undefined) {
		const backup = asRecord(record.backup);
		if (backup === undefined) {
			throw new SettingsValidationError("server.backup", "must be an object");
		}
		checkKeys("server.backup.", backup, ["path", "s3"]);
		if (backup.path !== undefined && backup.s3 !== undefined) {
			throw new SettingsValidationError(
				"server.backup",
				"must carry exactly one target (path or s3, not both)",
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

/** A non-empty string (the file's path/string fields). */
function isNonEmptyString(value: unknown): boolean {
	return typeof value === "string" && value !== "";
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
	 * First-boot initialization (the settings bootstrap): when the file is
	 * ABSENT, write the RESOLVED boot configuration — `server` (the
	 * section `loadConfig` resolved from env + code defaults), plus the
	 * top-level `extensions` list and `defaultModel` when the env provided
	 * them — so the file exists from boot one as an operator-visible,
	 * hand-editable record of reality (ruling 9: the file records what
	 * boot actually resolved, env-provided or defaulted). When the file
	 * already exists (any content), bootstrap is a no-op: the file is
	 * never overwritten, and env vars continue to win over it on the next
	 * boot (env-over-file precedence). Idempotent: bootstrapping twice
	 * leaves the file byte-identical.
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
			server: resolvedServer,
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
				// `compaction` sub-merges one level deeper; `backup` replaces
				// wholesale (it is a discriminated union — a partial union merge
				// could mix a path target with an s3 one).
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