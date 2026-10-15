import type { CompactionPolicy } from "@earendil-works/pi-durable";
import type { SettingsFile, ServerSettings } from "./harness/settings.js";

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
 */
export type BackupConfig =
	| { target: "s3"; bucket: string; prefix?: string; endpoint?: string }
	| { target: "path"; path: string };

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

export interface SigrunConfig {
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
	 * The webui channel-bundle directory (spec §4.1/§6, Task 20), resolved
	 * from `SIGRUN_WEBUI_BUNDLE` over the file's `server.webuiBundle` over
	 * the default `webui/dist`. Relative paths resolve against the process
	 * cwd (the repo/deploy root). An absent default bundle is a supported
	 * API-only deploy, while an explicit-but-missing bundle is a boot
	 * error (see {@link SigrunConfig.webuiBundleExplicit}).
	 */
	webuiBundle: string;
	/**
	 * True iff {@link SigrunConfig.webuiBundle} was configured EXPLICITLY
	 * (the env var or the file's `server.webuiBundle` — both count). The
	 * server fails loud when an explicit bundle path has no `index.html`
	 * (a misconfigured deploy intended the webui), and serves API-only
	 * when the DEFAULT path is absent (no webui was ever intended).
	 */
	webuiBundleExplicit: boolean;
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
}

/** The provider id used when the model spec carries no `provider/` prefix. */
export const DEFAULT_PROVIDER = "openai";

export const DEFAULT_STORAGE_PATH = "data/sigrun.db";
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
	if (path !== undefined && bucket !== undefined) {
		throw new Error(
			"SIGRUN_BACKUP_PATH and SIGRUN_BACKUP_S3_BUCKET are both set — exactly one backup target is allowed",
		);
	}
	if (path !== undefined) return { target: "path", path };
	if (bucket !== undefined) {
		return {
			target: "s3",
			bucket,
			...(prefix === undefined ? {} : { prefix }),
			...(endpoint === undefined ? {} : { endpoint }),
		};
	}
	return undefined;
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
	return {
		port: config.port,
		workspacePath: config.workspace.path,
		storagePath: config.storagePath,
		extensionsDir: config.extensionsDir,
		webuiBundle: config.webuiBundle,
		compaction: { ...config.compaction },
		memorySeam: { ...config.memorySeam },
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

	const envWebui = env.SIGRUN_WEBUI_BUNDLE?.trim() || undefined;
	const fileWebui = server?.webuiBundle;
	return {
		storagePath: env.SIGRUN_STORAGE_PATH || server?.storagePath || DEFAULT_STORAGE_PATH,
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
		backup: parseBackupConfig(env) ?? parseServerBackup(server?.backup),
		compaction: parseCompaction(env, server?.compaction),
		memorySeam: parseMemorySeam(env, server?.memorySeam),
		// Ruling 4: env wins; the file's `server.webuiBundle` next; the code
		// default last. A file value counts as EXPLICIT (missing index.html
		// is a boot error), exactly like a set env var.
		webuiBundle: envWebui ?? fileWebui ?? DEFAULT_WEBUI_BUNDLE,
		webuiBundleExplicit: envWebui !== undefined || fileWebui !== undefined,
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
): BackupConfig | undefined {
	if (backup === undefined) return undefined;
	// Property-presence narrowing: the union's two shapes are
	// optional-keyed, so `.path !== undefined` does not discriminate them
	// for TS — `in` does.
	if ("path" in backup) {
		if (backup.path === undefined) return undefined;
		return { target: "path", path: backup.path };
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
	};
}
