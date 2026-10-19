import type { CompactionPolicy } from "@earendil-works/pi-durable";
import { isAbsolute, join } from "node:path";
import type { SettingsFile, ServerSettings } from "./harness/settings.js";
import { resolveStoreRoots } from "./harness/stores.js";

/**
 * Sigrun configuration.
 *
 * Sigrun resolves configuration from environment variables over
 * `settings.json` over code defaults (env wins per setting). The three
 * knobs of the spec's design test are `SIGRUN_DEFAULT_MODEL`,
 * `OPENAI_BASE_URL`, and `OPENAI_API_KEY` — but only the model is read
 * here: the OpenAI-compat credentials are consumed by the env-driven
 * degenerate provider (`src/harness/providers`), which may be replaced
 * entirely by an extension-contributed provider that needs no OpenAI
 * credentials at all. `SIGRUN_MODEL` remains as a deprecated alias for
 * `SIGRUN_DEFAULT_MODEL` (one release cycle; a boot warning when used).
 */

/** The env var carrying the boot default model spec. */
export const DEFAULT_MODEL_ENV = "SIGRUN_DEFAULT_MODEL";

/** Deprecated alias for {@link DEFAULT_MODEL_ENV} (warns once per boot). */
export const DEPRECATED_MODEL_ENV = "SIGRUN_MODEL";

/**
 * The default model, parsed from `SIGRUN_DEFAULT_MODEL` (or the file's
 * top-level `defaultModel`).
 */
export interface SigrunModels {
	provider: string;
	modelId: string;
}

/**
 * Optional backup target (spec §4.3). Parsed from the backup env
 * variables by {@link parseBackupConfig}: `SIGRUN_BACKUP_PATH` (path
 * target) or `SIGRUN_BACKUP_S3_BUCKET` + optional
 * `SIGRUN_BACKUP_S3_PREFIX` (s3 target). Exactly one may be set — both
 * is a fail-loud config error (ambiguous target); neither leaves backup
 * unconfigured (sigrun runs fine and says so in `/v1/meta`).
 *
 * `sections` (Task 7, Ruling F): the per-section opt-in from
 * `SIGRUN_BACKUP_SECTIONS=config,secrets,data,state`. The key is
 * OPTIONAL and OMITTED when the env var is absent/empty — DB-only
 * deployments keep a byte-identical BackupConfig shape; absent means
 * all-false. `cache` is NEVER a section (the parse fails loud on the
 * name).
 */
export interface BackupSections {
	config: boolean;
	secrets: boolean;
	data: boolean;
	state: boolean;
}

export type BackupConfig =
	| { target: "s3"; bucket: string; prefix?: string; endpoint?: string; sections?: BackupSections }
	| { target: "path"; path: string; sections?: BackupSections };

/**
 * The static workspace every conversation resolves to (spec §4.5): a local
 * directory reached through the conversation's `ExecutionEnv`.
 */
export interface LocalWorkspace {
	readonly type: "local";
	readonly path: string;
}

/**
 * The memory-seam bounds (memory-seam Tasks 2-5, knobed in Task 6): the
 * side-lane hook deadline (`SIGRUN_HOOK_DEADLINE`, the per-handler cap
 * `drain` races against), the idle threshold (`SIGRUN_IDLE_THRESHOLD`,
 * quiet time before a conversation fires `conversationIdle`), the idle
 * worker deadline (`SIGRUN_WORKER_DEADLINE`, when the host stops waiting
 * for an abandoned `run()`), and the event queue bound
 * (`SIGRUN_QUEUE_MAX`, drop-oldest overflow). All positive integers.
 */
export interface MemorySeamConfig {
	/** `SIGRUN_HOOK_DEADLINE`, default 30000. */
	hookDeadlineMs: number;
	/** `SIGRUN_IDLE_THRESHOLD`, default 600000 (spec §2: 10 minutes). */
	idleThresholdMs: number;
	/** `SIGRUN_WORKER_DEADLINE`, default 600000 (spec §3: 10 minutes). */
	workerDeadlineMs: number;
	/** `SIGRUN_QUEUE_MAX`, default 1000. */
	queueMax: number;
}

/**
 * The provider runtime knobs (provider plugins Task 5): the interval
 * refresh cadence — how often the host-owned scheduler re-runs
 * `models.refresh()` over every dynamic provider after the boot
 * refresh (T4) populated the catalogs.
 */
export interface ProviderRuntimeConfig {
	/**
	 * The cadence in minutes, from `SIGRUN_PROVIDER_REFRESH_MINUTES` over
	 * the file's `server.providers.refreshIntervalMinutes` over
	 * {@link DEFAULT_PROVIDER_REFRESH_MINUTES}. `0` disables the
	 * scheduler (no timer).
	 */
	refreshIntervalMinutes: number;
}

/**
 * The webui channel surface (build-and-webui Task 4): the enable gate
 * and the bundle selector. `enabled` defaults true (`false` = a
 * positively API-only deploy); `bundle` is the SELECTOR — a string the
 * serve-time resolution (src/server/static.ts, Task 5) discriminates
 * syntactically into a contributed-bundle NAME or a directory PATH. Task
 * 4 only stores and validates it. `bundle` is ABSENT when nothing selects
 * (the built-in default bundle; an absent default stays the supported
 * API-only deploy).
 */
export interface WebuiConfig {
	/** From `SIGRUN_WEBUI` (strict true/false) over `server.webui.enabled`. */
	enabled: boolean;
	/**
	 * From `SIGRUN_WEBUI_BUNDLE` over `server.webui.bundle` over the
	 * legacy `server.webuiBundle` (deprecated alias, one release).
	 * `undefined` = nothing selects (the built-in default bundle).
	 */
	bundle?: string;
}

export interface SigrunConfig {
	/**
	 * The resolved store roots (extension-config-surfaces spec §4): the
	 * data, cache, and state directories, resolved once here through the
	 * one `resolveStoreRoots` chain (`SIGRUN_{DATA,CACHE,STATE}_DIR` over
	 * `$XDG_{DATA,CACHE,STATE}_HOME`/sigrun over the `~`-based spec
	 * defaults) with the file's `server.{dataDir,cacheDir,stateDir}`
	 * sitting between env and the default, exactly like
	 * {@link SigrunConfig.storagePath}'s precedence. The CONFIG root is
	 * deliberately absent here: `SIGRUN_CONFIG_DIR` keeps its existing
	 * meaning (the settings file's own location), resolved by its own
	 * call sites — this config must never rewire it.
	 */
	dataDir: string;
	cacheDir: string;
	stateDir: string;
	storagePath: string;
	models: SigrunModels;
	extensionsDir: string;
	/** Deploy-time extension package list (spec §4.1), parsed from `SIGRUN_EXTENSIONS` or the file's top-level `extensions`. */
	extensions: readonly string[];
	port: number;
	/** Root of the static local workspace (spec §4.5 `defaultWorkspace`). */
	workspace: LocalWorkspace;
	backup?: BackupConfig;
	/**
	 * The webui channel surface (build-and-webui Task 4): the enable gate
	 * (`SIGRUN_WEBUI` over `server.webui.enabled`, default true — `false`
	 * is the positive API-only deploy) and the bundle selector. The
	 * selector chain: `SIGRUN_WEBUI_BUNDLE` over the file's
	 * `server.webui.bundle` over the LEGACY `server.webuiBundle`
	 * (deprecated alias, one release) over the built-in default. The
	 * serve-time seam (`src/server/static.ts`, Task 5) resolves the
	 * selector: syntactic name/path discrimination, the contributed-bundle
	 * registry, and the default's package-root anchor.
	 */
	webui: WebuiConfig;
	/**
	 * The env-driven OpenAI-compatible provider's endpoint (ruling 7):
	 * `OPENAI_BASE_URL` over the file's `defaultProvider.baseUrl` over
	 * OpenAI's public API. Consumed by the degenerate provider
	 * (`src/harness/providers`), which falls back to its own code default
	 * when this is `undefined` (env unset + file unset).
	 */
	defaultProviderBaseUrl?: string;
	/**
	 * Context-management policy (spec §3.1), parsed from `SIGRUN_COMPACTION_*`
	 * and passed through `openHarness` into pi-durable's
	 * `HarnessSettings.compaction`. Defaults equal upstream's
	 * `DEFAULT_COMPACTION_POLICY`; `backgroundTokens > 0` keeps background
	 * compaction on (spec §3.1 "Background compaction on" — upstream starts
	 * one `backgroundTokens` below the blocking threshold; `0` disables it).
	 */
	compaction: CompactionPolicy;
	/**
	 * The memory-seam bounds (spec §2/§3), parsed from the
	 * `SIGRUN_{HOOK_DEADLINE,IDLE_THRESHOLD,WORKER_DEADLINE,QUEUE_MAX}`
	 * knobs and threaded into the event bus `EventBus.open` options at
	 * boot (Tasks 2-5 shipped them as temporary hardcoded constants).
	 */
	memorySeam: MemorySeamConfig;
	/**
	 * The provider runtime knobs (provider plugins Task 5): the interval
	 * refresh cadence, parsed from `SIGRUN_PROVIDER_REFRESH_MINUTES` over
	 * the file's `server.providers.refreshIntervalMinutes` over the
	 * default. Boot starts the scheduler when the resolved interval is
	 * greater than zero.
	 */
	providers: ProviderRuntimeConfig;
}

/** The provider id used when the model spec carries no `provider/` prefix. */
export const DEFAULT_PROVIDER = "openai";

/**
 * The SQLite DB file name under the resolved data root (the file itself
 * is `<dataDir>/<this>`; the old cwd-relative `"data/sigrun.db"` default
 * is RETIRED — the clean break, no migration machinery: only test DBs
 * ever lived at the old default, and chart/compose deploys pin absolute
 * `SIGRUN_STORAGE_PATH` values that stay verbatim).
 */
export const STORAGE_FILE_NAME = "sigrun.db";
export const DEFAULT_EXTENSIONS_DIR = "extensions";
export const DEFAULT_PORT = 3000;
/** Spec §4.5: core ships `{ defaultWorkspace: { type: "local", path: "/home/sigrun" } }`. */
export const DEFAULT_WORKSPACE_PATH = "/home/sigrun";
/** Spec §4.1/§6: the built webui workspace package's output. */
export const DEFAULT_WEBUI_BUNDLE = "webui/dist";

/**
 * Sigrun's compaction defaults, deliberately equal to pi-durable's
 * `DEFAULT_COMPACTION_POLICY`. Restated here rather than imported so the
 * equality is a checked decision (`test/compaction.test.ts` fails loudly if
 * upstream retunes and sigrun silently follows).
 *
 * These values presume a large-context default model (spec §3.1: "tuned
 * against the default model's window"); a small-window `SIGRUN_MODEL`
 * deployment must retune via `SIGRUN_COMPACTION_*`.
 */
export const DEFAULT_COMPACTION: CompactionPolicy = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	backgroundTokens: 32768,
};

/**
 * The memory-seam defaults (spec §2/§3): 30s hook deadline, 10-minute
 * idle threshold, 10-minute worker deadline, 1000-event queue bound.
 */
export const DEFAULT_MEMORY_SEAM: MemorySeamConfig = {
	hookDeadlineMs: 30_000,
	idleThresholdMs: 600_000,
	workerDeadlineMs: 600_000,
	queueMax: 1_000,
};

/** The env var carrying the interval refresh cadence (Task 5). */
export const PROVIDER_REFRESH_MINUTES_ENV = "SIGRUN_PROVIDER_REFRESH_MINUTES";

/** The interval refresh cadence default (minutes); `0` disables. */
export const DEFAULT_PROVIDER_REFRESH_MINUTES = 15;

export type Env = Record<string, string | undefined>;

/**
 * Parse one model spec into `{ provider, modelId }`.
 *
 * - `provider/model-id` pins the provider explicitly (first `/` splits;
 *   the model id may itself contain further path segments), or
 * - a bare `model-id` uses the env-driven OpenAI-compat provider
 *   (`openai`, the degenerate provider of spec §3).
 *
 * Shared by `loadConfig` and the provider collector so both parse
 * identically.
 *
 * @throws Error naming `source` (the env var or the file key) when the
 * spec is empty or has an empty provider or model id.
 */
export function parseModelSpec(
	spec: string,
	source = DEFAULT_MODEL_ENV,
): SigrunModels {
	const trimmed = spec.trim();
	if (!trimmed) {
		throw new Error(
			`${source} must be a non-empty model spec, e.g. openai/gpt-4o`,
		);
	}
	const slash = trimmed.indexOf("/");
	if (slash === -1) {
		return { provider: DEFAULT_PROVIDER, modelId: trimmed };
	}
	const provider = trimmed.slice(0, slash);
	const modelId = trimmed.slice(slash + 1);
	if (!provider || !modelId) {
		throw new Error(
			`${source} must have a non-empty provider and model id, got ${JSON.stringify(trimmed)}`,
		);
	}
	return { provider, modelId };
}

/**
 * Parse sigrun configuration from an environment (usually `process.env`),
 * over the settings file, over code defaults (env wins per setting).
 *
 * The default model is REQUIRED: `SIGRUN_DEFAULT_MODEL` (deprecated alias
 * `SIGRUN_MODEL`) wins, then the file's top-level `defaultModel` — with
 * neither, boot fails loud (see {@link parseModelSpec} for the format).
 * Optional overrides: `SIGRUN_STORAGE_PATH`, `SIGRUN_EXTENSIONS_DIR`,
 * `SIGRUN_EXTENSIONS`, `SIGRUN_PORT`, `SIGRUN_WORKSPACE_PATH`,
 * `SIGRUN_WEBUI_BUNDLE`, `OPENAI_BASE_URL`, the `SIGRUN_COMPACTION_*`
 * knobs of the context-management policy, and the backup target variables
 * (`SIGRUN_BACKUP_PATH` or `SIGRUN_BACKUP_S3_BUCKET`+
 * `SIGRUN_BACKUP_S3_PREFIX`; see {@link parseBackupConfig}).
 *
 * @throws Error naming `SIGRUN_DEFAULT_MODEL` when the model is missing
 * from both env and file, naming `SIGRUN_PORT` when it is set but not a
 * positive integer, naming the offending `SIGRUN_COMPACTION_*` variable
 * when set to an invalid value, and naming both backup variables when
 * they are both set (ambiguous backup target).
 */
export function parseExtensionList(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

/**
 * Warn once per process when the deprecated `SIGRUN_MODEL` alias supplied
 * the model. Module-level so repeated `loadConfig` calls in one boot (the
 * deploy entry resolves twice: bootstrap + final) print the warning once.
 */
let deprecatedModelWarned = false;
function warnDeprecatedModelEnv(): void {
	if (deprecatedModelWarned) return;
	deprecatedModelWarned = true;
	console.warn(
		"SIGRUN_MODEL is deprecated, use SIGRUN_DEFAULT_MODEL",
	);
}

/** Parse `SIGRUN_COMPACTION_ENABLED` ("true"/"false", case-insensitive). */
function parseCompactionEnabled(env: Env): boolean | undefined {
	const raw = env.SIGRUN_COMPACTION_ENABLED;
	if (raw === undefined || raw === "") return undefined;
	const lowered = raw.trim().toLowerCase();
	if (lowered === "true") return true;
	if (lowered === "false") return false;
	throw new Error(
		`SIGRUN_COMPACTION_ENABLED must be "true" or "false", got ${JSON.stringify(raw)}`,
	);
}

/**
 * Parse `SIGRUN_WEBUI` ("true"/"false", case-insensitive) — the webui
 * channel's enable gate, the `parseCompactionEnabled` pattern (strict:
 * empty counts as unset, anything else fails loud naming the variable).
 */
function parseWebuiEnabled(env: Env): boolean | undefined {
	const raw = env.SIGRUN_WEBUI;
	if (raw === undefined || raw === "") return undefined;
	const lowered = raw.trim().toLowerCase();
	if (lowered === "true") return true;
	if (lowered === "false") return false;
	throw new Error(
		`SIGRUN_WEBUI must be "true" or "false", got ${JSON.stringify(raw)}`,
	);
}

/**
 * Parse one `SIGRUN_COMPACTION_*` token count. `minimum` is 1 for all knobs
 * except `backgroundTokens`, where 0 is the designed "background off" value
 * (upstream starts a background compaction only when `backgroundTokens > 0`).
 */
function parseTokenCount(
	env: Env,
	key: "SIGRUN_COMPACTION_RESERVE_TOKENS" | "SIGRUN_COMPACTION_KEEP_RECENT_TOKENS" | "SIGRUN_COMPACTION_BACKGROUND_TOKENS",
	minimum: number,
): number | undefined {
	const raw = env[key];
	if (raw === undefined || raw === "") return undefined;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < minimum) {
		const constraint =
			minimum === 0
				? "a non-negative integer"
				: "a positive integer";
		throw new Error(`${key} must be ${constraint}, got ${raw}`);
	}
	return parsed;
}

/**
 * Parse the optional backup target (spec §4.3, Task 11).
 *
 * - `SIGRUN_BACKUP_PATH=<dir>` → `{ target: "path", path }`
 * - `SIGRUN_BACKUP_S3_BUCKET=<bucket>` (+ optional
 *   `SIGRUN_BACKUP_S3_PREFIX`) → `{ target: "s3", bucket, prefix? }`
 * - both set → throw (ambiguous target — a CronJob would otherwise ship
 *   backups to one target while the badge says the other)
 * - neither → `undefined` (backup unconfigured; a badge, not an error)
 *
 * Empty strings count as unset ("" is the shell's unset-adjacent value —
 * a manifest carrying `SIGRUN_BACKUP_PATH: ""` should boot unconfigured
 * the same as omitting the key, not crash).
 */
export function parseBackupConfig(env: Env): BackupConfig | undefined {
	const path = env.SIGRUN_BACKUP_PATH?.trim() || undefined;
	const bucket = env.SIGRUN_BACKUP_S3_BUCKET?.trim() || undefined;
	const prefix = env.SIGRUN_BACKUP_S3_PREFIX?.trim() || undefined;
	const endpoint = env.SIGRUN_BACKUP_S3_ENDPOINT?.trim() || undefined;
	const sections = parseBackupSections(env.SIGRUN_BACKUP_SECTIONS);
	if (path !== undefined && bucket !== undefined) {
		throw new Error(
			"SIGRUN_BACKUP_PATH and SIGRUN_BACKUP_S3_BUCKET are both set — exactly one backup target is allowed",
		);
	}
	if (path !== undefined) {
		return {
			target: "path",
			path,
			...(sections === undefined ? {} : { sections }),
		};
	}
	if (bucket !== undefined) {
		return {
			target: "s3",
			bucket,
			...(prefix === undefined ? {} : { prefix }),
			...(endpoint === undefined ? {} : { endpoint }),
			...(sections === undefined ? {} : { sections }),
		};
	}
	return undefined;
}

/**
 * Parse `SIGRUN_BACKUP_SECTIONS` (Task 7): a comma-separated list of
 * `config|secrets|data|state`. Absent/empty → `undefined` (Ruling F:
 * the BackupConfig carries NO `sections` key at all — the DB-only shape
 * stays byte-identical and absent means all-false). An unknown name
 * (`cache` is NEVER valid — it must never be backed up) throws naming
 * the offending token. Duplicates dedup (`config,config` == `config`).
 */
export function parseBackupSections(
	raw: string | undefined,
): BackupSections | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const sections: BackupSections = {
		config: false,
		secrets: false,
		data: false,
		state: false,
	};
	for (const token of raw.split(",")) {
		const name = token.trim();
		if (name === "") continue;
		if (!(name in sections)) {
			throw new Error(
				`SIGRUN_BACKUP_SECTIONS: unknown backup section "${name}" — valid sections are config,secrets,data,state (cache is never backed up)`,
			);
		}
		sections[name as keyof BackupSections] = true;
	}
	return sections;
}

function parseCompaction(
	env: Env,
	server?: ServerSettings["compaction"],
): CompactionPolicy {
	// Env parse first (a bad env value fails loud even when the file's
	// value is valid); a file field applies only where its env var is
	// absent; code defaults last.
	return {
		enabled:
			parseCompactionEnabled(env) ??
			server?.enabled ??
			DEFAULT_COMPACTION.enabled,
		reserveTokens:
			parseTokenCount(env, "SIGRUN_COMPACTION_RESERVE_TOKENS", 1) ??
			server?.reserveTokens ??
			DEFAULT_COMPACTION.reserveTokens,
		keepRecentTokens:
			parseTokenCount(env, "SIGRUN_COMPACTION_KEEP_RECENT_TOKENS", 1) ??
			server?.keepRecentTokens ??
			DEFAULT_COMPACTION.keepRecentTokens,
		backgroundTokens:
			parseTokenCount(env, "SIGRUN_COMPACTION_BACKGROUND_TOKENS", 0) ??
			server?.backgroundTokens ??
			DEFAULT_COMPACTION.backgroundTokens,
	};
}

/** The env var spelling each {@link MemorySeamConfig} field parses from. */
type MemorySeamEnvKey =
	| "SIGRUN_HOOK_DEADLINE"
	| "SIGRUN_IDLE_THRESHOLD"
	| "SIGRUN_WORKER_DEADLINE"
	| "SIGRUN_QUEUE_MAX";

/**
 * Parse one memory-seam positive-integer knob (the
 * `SIGRUN_COMPACTION_*` token-count pattern: fail loud naming the
 * variable on a non-numeric/zero/negative value, treat `""` as unset).
 */
function parseMemorySeamCount(env: Env, key: MemorySeamEnvKey): number | undefined {
	const raw = env[key];
	if (raw === undefined || raw === "") return undefined;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${key} must be a positive integer, got ${raw}`);
	}
	return parsed;
}

/**
 * Parse the interval refresh cadence (Task 5): `SIGRUN_PROVIDER_REFRESH_MINUTES`
 * — a NON-NEGATIVE integer (0 is the designed disable, unlike the
 * memory-seam positive-only knobs), `""` counts as unset, anything else
 * fails loud naming the variable. The file's `server.providers`
 * section applies where the env var is absent; the default last.
 */
function parseRefreshIntervalMinutes(
	env: Env,
	file?: number,
): number {
	const raw = env[PROVIDER_REFRESH_MINUTES_ENV];
	if (raw !== undefined && raw !== "") {
		const parsed = Number(raw);
		if (!Number.isInteger(parsed) || parsed < 0) {
			throw new Error(
				`${PROVIDER_REFRESH_MINUTES_ENV} must be a non-negative integer, got ${raw}`,
			);
		}
		return parsed;
	}
	return file ?? DEFAULT_PROVIDER_REFRESH_MINUTES;
}

function parseMemorySeam(
	env: Env,
	server?: ServerSettings["memorySeam"],
): MemorySeamConfig {
	// Same chain as parseCompaction: env parsed first (a bad env value
	// fails loud even when a file value would be valid), the settings
	// file's `server.memorySeam` section applies per-field where env is
	// absent, code defaults last.
	return {
		hookDeadlineMs:
			parseMemorySeamCount(env, "SIGRUN_HOOK_DEADLINE") ??
			server?.hookDeadlineMs ??
			DEFAULT_MEMORY_SEAM.hookDeadlineMs,
		idleThresholdMs:
			parseMemorySeamCount(env, "SIGRUN_IDLE_THRESHOLD") ??
			server?.idleThresholdMs ??
			DEFAULT_MEMORY_SEAM.idleThresholdMs,
		workerDeadlineMs:
			parseMemorySeamCount(env, "SIGRUN_WORKER_DEADLINE") ??
			server?.workerDeadlineMs ??
			DEFAULT_MEMORY_SEAM.workerDeadlineMs,
		queueMax:
			parseMemorySeamCount(env, "SIGRUN_QUEUE_MAX") ??
			server?.queueMax ??
			DEFAULT_MEMORY_SEAM.queueMax,
	};
}

/**
 * Project a resolved config into the settings file's `server` section —
 * the object `SettingsStore.bootstrap` persists on first boot. Defaults
 * are included deliberately (the bootstrap file records the full
 * effective server configuration, not just the overrides); the backup
 * target maps back to the file's two-shape union (absent target → the
 * key is omitted, so the file carries no empty `backup: {}`).
 */
export function resolvedServerSection(config: SigrunConfig): ServerSettings {
	const backup: ServerSettings["backup"] =
		config.backup === undefined
			? undefined
			: config.backup.target === "path"
				? { path: config.backup.path }
				: {
						s3: {
							bucket: config.backup.bucket,
							...(config.backup.prefix === undefined
								? {}
								: { prefix: config.backup.prefix }),
							...(config.backup.endpoint === undefined
								? {}
								: { endpoint: config.backup.endpoint }),
						},
					};
	// The webui keys are the ONE deliberate exception to "the file
	// records the full effective section" (build-and-webui Task 4's
	// review focus): a DEFAULTED webui is OMITTED entirely — persisting a
	// mirrored `webui/dist` (or an `enabled: true` half-section) would
	// read as an explicit selection on the NEXT boot, re-arming the
	// cwd-relative default bug and making absent-default → API-only
	// unreachable. A CONFIGURED webui records the new shape only; the
	// LEGACY `webuiBundle` key is never written (it is a read-side alias).
	const webui: ServerSettings["webui"] =
		config.webui.enabled === true && config.webui.bundle === undefined
			? undefined
			: {
					enabled: config.webui.enabled,
					...(config.webui.bundle === undefined
						? {}
						: { bundle: config.webui.bundle }),
				};
	return {
		port: config.port,
		workspacePath: config.workspace.path,
		storagePath: config.storagePath,
		extensionsDir: config.extensionsDir,
		dataDir: config.dataDir,
		cacheDir: config.cacheDir,
		stateDir: config.stateDir,
		...(webui === undefined ? {} : { webui }),
		compaction: { ...config.compaction },
		memorySeam: { ...config.memorySeam },
		providers: { ...config.providers },
		...(backup === undefined ? {} : { backup }),
	};
}

export function loadConfig(env: Env, settingsFile?: SettingsFile): SigrunConfig {
	// Env is parsed FIRST (fail-loud on an invalid env value even when the
	// file carries a valid one) and always WINS: a file field applies only
	// where the corresponding env variable is absent. Env-only knobs (never
	// file-configurable): `SIGRUN_CONFIG_DIR` (the file's own location) and
	// the OpenAI credentials (`OPENAI_API_KEY`, plus the sibling `auth.json`
	// the provider layer reads — settings.json never carries key material).
	const server = settingsFile?.server;

	// The boot default model (ruling 3): env wins, the file's top-level
	// `defaultModel` is next, and there is NO code default — the model is
	// genuinely required, so neither-source fails loud exactly like the
	// pre-file behavior. `SIGRUN_MODEL` is the deprecated alias: it reads
	// the same value (one release cycle) and warns once per boot when it
	// actually supplied the model.
	const envSpec =
		env.SIGRUN_DEFAULT_MODEL?.trim() || env.SIGRUN_MODEL?.trim();
	if (
		env.SIGRUN_DEFAULT_MODEL?.trim() === undefined &&
		env.SIGRUN_MODEL?.trim() !== undefined
	) {
		warnDeprecatedModelEnv();
	}
	const fileSpec = settingsFile?.defaultModel;
	if (!envSpec && fileSpec === undefined) {
		throw new Error(
			"SIGRUN_DEFAULT_MODEL or settings.json defaultModel is required " +
				"(format: provider/model-id, e.g. openai/gpt-4o)",
		);
	}
	const models = parseModelSpec(
		envSpec ?? (fileSpec as string),
		envSpec ? DEFAULT_MODEL_ENV : "settings.json defaultModel",
	);

	let port = server?.port ?? DEFAULT_PORT;
	if (env.SIGRUN_PORT !== undefined && env.SIGRUN_PORT !== "") {
		const parsed = Number(env.SIGRUN_PORT);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			throw new Error(`SIGRUN_PORT must be a positive integer, got ${env.SIGRUN_PORT}`);
		}
		port = parsed;
	}

	// The webui surface (build-and-webui Task 4). The bundle selector's
	// FOUR slots, first-set-wins: `SIGRUN_WEBUI_BUNDLE` (the env form,
	// deprecated in docs but still winning) over the file's
	// `server.webui.bundle` over the LEGACY `server.webuiBundle` (a
	// deprecated read-side alias, one release) over nothing (the built-in
	// default bundle — `webui.bundle` stays ABSENT so serve-time resolution
	// can tell "unset" from "set to the default's value"). The
	// enable gate is its own two-slot chain (strict env parse over the
	// file's `server.webui.enabled`, default true).
	const envWebui = env.SIGRUN_WEBUI_BUNDLE?.trim() || undefined;
	const fileWebui = server?.webui?.bundle ?? server?.webuiBundle;
	// The store roots (Task 6): the ONE resolution chain, applied per root
	// with the file's `server.*Dir` sitting between the env var and the
	// tier default — the same precedence shape as every other `server.*`
	// mirror. An env-or-file value wins VERBATIM (no suffix, no `~`
	// expansion); the fallback runs Task 1's resolver over the env. Env
	// `""` counts as unset (the stores module's own reading).
	const resolvedRoots = resolveStoreRoots(env);
	const rootDir = (kind: "data" | "cache" | "state"): string =>
		env[`SIGRUN_${kind.toUpperCase()}_DIR`] ||
		server?.[`${kind}Dir`] ||
		resolvedRoots[`${kind}Dir`];
	const dataDir = rootDir("data");
	const cacheDir = rootDir("cache");
	const stateDir = rootDir("state");
	// The DB default under the data root (clean break): a configured
	// `SIGRUN_STORAGE_PATH` (or the file's `server.storagePath`) — env over
	// file, `""`-means-unset — joins the DATA root when relative (the old
	// cwd-relative reading is retired); absolute values stay verbatim.
	const configuredStorage =
		env.SIGRUN_STORAGE_PATH || server?.storagePath || undefined;
	const storagePath =
		configuredStorage === undefined
			? join(dataDir, STORAGE_FILE_NAME)
			: isAbsolute(configuredStorage)
				? configuredStorage
				: join(dataDir, configuredStorage);
	return {
		dataDir,
		cacheDir,
		stateDir,
		storagePath,
		models,
		extensionsDir: env.SIGRUN_EXTENSIONS_DIR || server?.extensionsDir || DEFAULT_EXTENSIONS_DIR,
		// Ruling 1: env CSV wins; the file's top-level `extensions` array
		// next; empty otherwise.
		// Ruling 1: env CSV wins; the file's top-level `extensions` array
		// next; empty otherwise. The env path yields LOAD strings; the file
		// path may carry object entries — flatten to LOAD sources here (the
		// enabled:false filter happens at the loader, which owns load
		// decisions; the sync step consumed the full specs already).
		extensions:
			parseExtensionList(env.SIGRUN_EXTENSIONS) ??
			(settingsFile?.extensions ?? []).map((entry) =>
				typeof entry === "string" ? entry : entry.source,
			),
		port,
		workspace: {
			type: "local",
			path: env.SIGRUN_WORKSPACE_PATH || server?.workspacePath || DEFAULT_WORKSPACE_PATH,
		},
		// Sections (Task 7): `SIGRUN_BACKUP_SECTIONS` is env-only and
		// applies to the FILE-sourced target too — the env knob selects
		// WHAT to back up, the target may come from either tier.
		backup:
			parseBackupConfig(env) ??
			parseServerBackup(
				server?.backup,
				parseBackupSections(env.SIGRUN_BACKUP_SECTIONS),
			),
		compaction: parseCompaction(env, server?.compaction),
		memorySeam: parseMemorySeam(env, server?.memorySeam),
		providers: {
			refreshIntervalMinutes: parseRefreshIntervalMinutes(
				env,
				server?.providers?.refreshIntervalMinutes,
			),
		},
		// The webui surface (build-and-webui Task 4): the NEW shape the
		// serve-time seam resolves (Task 5, src/server/static.ts). `enabled`
		// is the strict env gate over the file's `server.webui.enabled`, default
		// true; `bundle` is the four-slot selector — ABSENT when nothing selects
		// (the built-in default bundle; serve-time resolution reads absence,
		// never a mirrored default value).
		webui: {
			enabled: parseWebuiEnabled(env) ?? server?.webui?.enabled ?? true,
			...((envWebui ?? fileWebui) === undefined
				? {}
				: { bundle: envWebui ?? fileWebui }),
		},
		// Ruling 7: the degenerate provider's endpoint. `undefined` when
		// neither env nor file sets it — the provider layer applies the
		// OpenAI public default there.
		defaultProviderBaseUrl:
			env.OPENAI_BASE_URL?.trim() || settingsFile?.defaultProvider?.baseUrl,
	};
}

/**
 * The backup target from the file's `server.backup` section, applied only
 * when env configures NO target (env wins — including the env's own
 * ambiguity error, which throws before this is consulted). The section is
 * already shape-validated by the settings store; a missing bucket fails
 * loud here the way the env parse would.
 */
function parseServerBackup(
	backup: ServerSettings["backup"],
	sections?: BackupSections,
): BackupConfig | undefined {
	if (backup === undefined) return undefined;
	// Property-presence narrowing: the union's two shapes are
	// optional-keyed, so `.path !== undefined` does not discriminate them
	// for TS — `in` does.
	if ("path" in backup) {
		if (backup.path === undefined) return undefined;
		return {
			target: "path",
			path: backup.path,
			...(sections === undefined ? {} : { sections }),
		};
	}
	if (!("s3" in backup)) return undefined;
	const s3 = backup.s3;
	if (s3 === undefined) return undefined;
	if (s3.bucket === undefined) {
		throw new Error("settings server.backup.s3.bucket is required when server.backup.s3 is set");
	}
	return {
		target: "s3",
		bucket: s3.bucket,
		...(s3.prefix === undefined ? {} : { prefix: s3.prefix }),
		...(s3.endpoint === undefined ? {} : { endpoint: s3.endpoint }),
		...(sections === undefined ? {} : { sections }),
	};
}
