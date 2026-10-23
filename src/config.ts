import { isIanaTimeZone } from "./jobs/spec.js";
import type { CompactionPolicy } from "@earendil-works/pi-durable";
import { isAbsolute, join } from "node:path";
import type {
	EffectiveServerSetting,
	SettingsFile,
	ServerSettings,
} from "./harness/settings.js";
import { resolveStoreRoots } from "./harness/stores.js";
import { isLoopbackHost } from "./server/auth/loopback.js";

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

/**
 * The auth surface (core-hardening W1, spec §5.2/§5.3): what the Task 3
 * pipeline authenticates with and what the Host/Origin checks accept.
 * Parsed from the `SIGRUN_AUTH*` env knobs over the file's `server.auth`
 * section by {@link parseAuth}; the effective method list (with the
 * listen-host default applied) is {@link effectiveMethods}.
 */
export interface AuthConfig {
	/**
	 * The explicit authenticator list, in try order. `undefined` = derive
	 * from the listen host (`[]` on loopback, `["token"]` otherwise —
	 * {@link effectiveMethods}); an explicit `[]` disables authentication
	 * (the config override; the pipeline warns on non-loopback binds).
	 */
	methods: readonly ("token" | "proxy")[] | undefined;
	/**
	 * The forward-auth (proxy) method's config. `trustedProxies` is the
	 * CIDR allowlist the peer must fall in; the header names default to
	 * Authelia's (`Remote-*`); `secretHeader` names the shared-secret
	 * header whose VALUE is `secret` (env-only).
	 */
	proxy: { trustedProxies: readonly string[]; secretHeader?: string; secret?: string;
		userHeader: string; groupsHeader: string; nameHeader: string; emailHeader: string; autoProvision: boolean };
	/** Proxy groups intersecting these grant admin (never persisted). */
	adminGroups: readonly string[];
	/** Extra `Host` values accepted by the §5.5 Host check. */
	allowedHosts?: readonly string[];
	/** Extra `Origin` values accepted by the §5.5 Origin check. */
	allowedOrigins?: readonly string[];
	/**
	 * The env service token (`SIGRUN_API_TOKEN` + `SIGRUN_API_TOKEN_USER`,
	 * default user `"sigrun"`), env-only — a credential, like `proxy.secret`.
	 */
	serviceToken?: { token: string; user: string };
}

export interface SigrunConfig {
	/**
	 * The deployment's absolute base URL (core hardening W5 Task 2,
	 * spec §9.2): `SIGRUN_PUBLIC_URL` over the file's
	 * `server.publicUrl` — an absolute http(s) URL with trailing
	 * slashes stripped, `undefined` when neither source sets it. The
	 * extension-route adapter bases the handlers' absolute `Request`
	 * URLs on it (else `http://<Host header>`); notification deep links
	 * are omitted without it.
	 */
	publicUrl?: string;
	/**
	 * The upload/import body-limit knob (spec §6.2):
	 * `SIGRUN_MAX_UPLOAD_BYTES` over the file's `server.maxUploadBytes`
	 * over {@link DEFAULT_MAX_UPLOAD_BYTES} (64 MiB). The raw PUT route
	 * uses it verbatim as its Fastify `bodyLimit`; the base64 POST and the
	 * JSONL import use {@link base64BodyLimit} (the 4/3 base64 inflation
	 * of the capped content plus the JSON wrapper). Over any of them the
	 * app-level error handler answers `413 {error:"too_large", maxBytes}`.
	 */
	maxUploadBytes: number;
	/**
	 * The raw file-read cap (spec §7.8, core hardening W3 Task 7):
	 * `SIGRUN_MAX_FILE_READ_BYTES` over the file's
	 * `server.maxFileReadBytes` over {@link DEFAULT_MAX_FILE_READ_BYTES}
	 * (16 MiB). `GET .../files/raw` serves at most this many bytes per
	 * file (413 `file_too_large` beyond it) — the agent writes workspace
	 * files, so nothing else bounds them.
	 */
	maxFileReadBytes: number;
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
	/** Deploy-time extension package list (spec §4.1), parsed from `SIGRUN_EXTENSIONS` or the file's top-level `extensions`. */
	extensions: readonly string[];
	port: number;
	/** Root of the static local workspace (spec §4.5 `defaultWorkspace`). */
	workspace: LocalWorkspace;
	backup?: BackupConfig;
	/**
	 * The backup honesty window (§6.8): `server.backup.staleAfterHours`
	 * from the settings file over {@link DEFAULT_BACKUP_STALE_AFTER_HOURS}
	 * (36). Consumed by the meta route's `health.backup` derivation — a
	 * configured target whose last-success marker is absent or older than
	 * this many hours reports `"degraded"`. Meaningful only when
	 * {@link backup} is configured, but resolved unconditionally.
	 */
	backupStaleAfterHours: number;
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
	/**
	 * The auth surface (core-hardening W1), parsed from
	 * `SIGRUN_AUTH`/`SIGRUN_AUTH_TRUSTED_PROXIES`/`SIGRUN_PROXY_SECRET`/
	 * `SIGRUN_API_TOKEN` over the file's `server.auth` section. Consumed
	 * by the Task 3 pipeline via {@link effectiveMethods}.
	 */
	auth: AuthConfig;
	/** `/metrics` without a principal — `SIGRUN_METRICS_PUBLIC` (strict) over `server.metrics.public`, default false. */
	metricsPublic: boolean;
	/**
	 * The development flag (spec §14.2/§14.4): `SIGRUN_DEV` (strict
	 * true/false — `1`/`0` read as true/false, matching the spec's
	 * `SIGRUN_DEV=1` phrasing) over the file's `server.dev`, default
	 * `false`. Surfaces on `GET /v1/meta`; U1's gallery, U3's error bodies
	 * and U4 consume it.
	 */
	dev: boolean;
	/**
	 * The jobs default timezone (§8.2): `SIGRUN_TIMEZONE` over the file's
	 * `server.timezone` over the process TZ
	 * (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Cron schedules
	 * that declare no `timezone` resolve in this one; an invalid name fails
	 * LOUD at boot (the same `isIanaTimeZone` gate the spec validator runs).
	 */
	timezone: string;
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
export const DEFAULT_PORT = 3000;
/** Spec §4.1/§6: the built webui workspace package's output. */
export const DEFAULT_WEBUI_BUNDLE = "webui/dist";

/**
 * The workspace default (spec §6.3/R5): `<dataDir>/workspace` — the
 * static workspace rides the SAME root chain as every other durable
 * path instead of the old fixed `/home/sigrun` (a container-image
 * assumption that leaked into every non-container boot). Chart and
 * compose deploys set `SIGRUN_WORKSPACE_PATH` explicitly and are
 * unaffected. Used only as the LAST tier of the workspace resolution
 * (`SIGRUN_WORKSPACE_PATH` over `server.workspacePath` over this) — a
 * default that is never persisted (spec §6.6).
 */
export function defaultWorkspacePath(dataDir: string): string {
	return join(dataDir, "workspace");
}

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

/** The env var carrying the upload body-limit knob (spec §6.2). */
export const MAX_UPLOAD_BYTES_ENV = "SIGRUN_MAX_UPLOAD_BYTES";

/** The env var carrying the deployment's absolute base URL (W5 Task 2). */
export const PUBLIC_URL_ENV = "SIGRUN_PUBLIC_URL";

/**
 * Whether `value` parses as an ABSOLUTE http(s) URL with a hostname
 * (the `server.publicUrl` grammar, W5 Task 2) — the shared predicate
 * behind {@link parsePublicUrl} and the settings-file validation
 * (src/harness/settings.ts), so both gates accept the same shapes.
 */
export function isAbsoluteHttpUrl(value: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	return (
		(parsed.protocol === "http:" || parsed.protocol === "https:") &&
		parsed.hostname !== ""
	);
}

/**
 * Parse one `server.publicUrl` / `SIGRUN_PUBLIC_URL` value (W5 Task 2,
 * spec §9.2): an absolute http(s) URL — validated by
 * {@link isAbsoluteHttpUrl} — with any TRAILING SLASHES stripped (the
 * value consumers concatenate paths onto,
 * `${server.publicUrl}/v1/ext/<slug>/…`). Unset/empty → `undefined`;
 * anything else fails loud naming `source`.
 */
export function parsePublicUrl(
	raw: string | undefined,
	source: string,
): string | undefined {
	const trimmed = raw?.trim() ?? "";
	if (trimmed === "") return undefined;
	if (!isAbsoluteHttpUrl(trimmed)) {
		throw new Error(
			`${source} must be an absolute http(s) URL, got ${JSON.stringify(raw)}`,
		);
	}
	return trimmed.replace(/\/+$/, "");
}

/** The upload knob's default (spec §6.2): 64 MiB. */
export const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/** The env var carrying the raw file-read cap (spec §7.8). */
export const MAX_FILE_READ_BYTES_ENV = "SIGRUN_MAX_FILE_READ_BYTES";

/** The raw file-read cap's default (spec §7.8): 16 MiB. */
export const DEFAULT_MAX_FILE_READ_BYTES = 16 * 1024 * 1024;

/**
 * Parse `SIGRUN_MAX_FILE_READ_BYTES` (spec §7.8) — the strict
 * positive-integer pattern (the `SIGRUN_MAX_UPLOAD_BYTES` posture): `""`
 * counts as unset, anything non-integer or ≤ 0 fails loud naming the
 * variable. The file's `server.maxFileReadBytes` applies where the env
 * var is absent; the 16 MiB default last.
 */
function parseMaxFileReadBytes(env: Env, file?: number): number {
	return (
		parsePositiveIntEnv(env, MAX_FILE_READ_BYTES_ENV) ??
		file ??
		DEFAULT_MAX_FILE_READ_BYTES
	);
}

/**
 * The body limit the base64 POST upload and the JSONL import routes use
 * (spec §6.2, verbatim): `Math.ceil(max*4/3)+4096` — the base64 inflation
 * of the knob-capped content plus headroom for the JSON wrapper (the
 * POST body) or the JSONL text itself (import).
 */
export function base64BodyLimit(maxUploadBytes: number): number {
	return Math.ceil((maxUploadBytes * 4) / 3) + 4096;
}

/** The interval refresh cadence default (minutes); `0` disables. */
export const DEFAULT_PROVIDER_REFRESH_MINUTES = 15;

/**
 * The auth defaults (spec §5.2/§5.3 + the plan's Global Constraints):
 * no explicit method list (derive from the listen host), no trusted
 * proxies, Authelia's `Remote-*` header names, auto-provision on, no
 * admin groups. Credentials (`proxy.secret`, `serviceToken`) are never
 * defaulted — they exist only when env provides them.
 */
export const DEFAULT_AUTH: AuthConfig = {
	methods: undefined,
	proxy: {
		trustedProxies: [],
		userHeader: "Remote-User",
		groupsHeader: "Remote-Groups",
		nameHeader: "Remote-Name",
		emailHeader: "Remote-Email",
		autoProvision: true,
	},
	adminGroups: [],
};

/**
 * The effective authenticator list (spec §5.2's defaults ruling): an
 * explicit `methods` always wins (including `[]` on a non-loopback
 * bind — the config override); otherwise `[]` on a loopback listen
 * host and `["token"]` on any other. The Task 3 pipeline calls this
 * once at boot with the bound host.
 */
export function effectiveMethods(
	auth: AuthConfig,
	listenHost: string,
): readonly ("token" | "proxy")[] {
	if (auth.methods !== undefined) return auth.methods;
	return isLoopbackHost(listenHost) ? [] : ["token"];
}

/**
 * The backup honesty window's default (§6.8): how old the
 * `backup/last-success.json` marker may be, in hours, before a CONFIGURED
 * backup target reports `health.backup: "degraded"`. File-only knob
 * (`server.backup.staleAfterHours`) — no env var exists — over this
 * default. 36 h tolerates a nightly Cadence missing one run before the
 * badge flips.
 */
export const DEFAULT_BACKUP_STALE_AFTER_HOURS = 36;

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
 * Optional overrides: `SIGRUN_STORAGE_PATH`, `SIGRUN_EXTENSIONS`,
 * `SIGRUN_PORT`, `SIGRUN_WORKSPACE_PATH`,
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

/**
 * Warn once per process when the retired `SIGRUN_EXTENSIONS_DIR` env var
 * is set (§6.7: the knob was parsed but never read — the config carries no
 * `extensionsDir` field at all now). Same once-per-process guard as the
 * `SIGRUN_MODEL` alias.
 */
let extensionsDirWarned = false;
function warnDeprecatedExtensionsDirEnv(): void {
	if (extensionsDirWarned) return;
	extensionsDirWarned = true;
	console.warn("SIGRUN_EXTENSIONS_DIR is deprecated and ignored");
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
 * Parse `SIGRUN_METRICS_PUBLIC` ("true"/"false", case-insensitive) — the
 * `parseWebuiEnabled` pattern: strict, empty counts as unset, anything
 * else fails loud naming the variable.
 */
function parseMetricsPublic(env: Env): boolean | undefined {
	const raw = env.SIGRUN_METRICS_PUBLIC;
	if (raw === undefined || raw === "") return undefined;
	const lowered = raw.trim().toLowerCase();
	if (lowered === "true") return true;
	if (lowered === "false") return false;
	throw new Error(
		`SIGRUN_METRICS_PUBLIC must be "true" or "false", got ${JSON.stringify(raw)}`,
	);
}

/**
 * Parse `SIGRUN_DEV` (§14.2/§14.4): "true"/"false" case-insensitive, plus
 * the spec's own `SIGRUN_DEV=1`/`=0` shell form. Strict otherwise — `yes`
 * or any other value fails loud naming the variable (the pattern above).
 */
function parseDev(env: Env): boolean | undefined {
	const raw = env.SIGRUN_DEV;
	if (raw === undefined || raw === "") return undefined;
	const lowered = raw.trim().toLowerCase();
	if (lowered === "true" || lowered === "1") return true;
	if (lowered === "false" || lowered === "0") return false;
	throw new Error(
		`SIGRUN_DEV must be "true" or "false" (or 1/0), got ${JSON.stringify(raw)}`,
	);
}

/**
 * Parse `SIGRUN_AUTH`: a csv of `token`/`proxy` (order preserved,
 * duplicates dropped), `none` ALONE as the empty list (authentication
 * disabled), unset/empty as `undefined` (derive from the listen host).
 * Anything else fails loud naming the variable and the raw value — the
 * `parseCompactionEnabled` pattern.
 */
function parseAuthMethods(
	env: Env,
): readonly ("token" | "proxy")[] | undefined {
	const raw = env.SIGRUN_AUTH;
	if (raw === undefined || raw === "") return undefined;
	const methods: ("token" | "proxy")[] = [];
	let sawNone = false;
	for (const entry of raw.split(",")) {
		const name = entry.trim();
		if (name === "") continue;
		if (name === "none") {
			if (sawNone || methods.length > 0) {
				throw new Error(
					`SIGRUN_AUTH "none" must appear alone, got ${JSON.stringify(raw)}`,
				);
			}
			sawNone = true;
			continue;
		}
		if (name !== "token" && name !== "proxy") {
			throw new Error(
				`SIGRUN_AUTH must be a comma-separated list of "token" and/or "proxy" (or "none" alone), got ${JSON.stringify(raw)}`,
			);
		}
		if (sawNone) {
			throw new Error(
				`SIGRUN_AUTH "none" must appear alone, got ${JSON.stringify(raw)}`,
			);
		}
		if (!methods.includes(name)) methods.push(name);
	}
	if (sawNone) return [];
	// Only commas/whitespace: unset, not an empty method list (`none` is
	// the positive spelling for that).
	return methods.length > 0 ? methods : undefined;
}

/**
 * Parse `SIGRUN_AUTH_TRUSTED_PROXIES`: a csv of CIDR/IP strings. Unset or
 * empty is `undefined` (the file's `server.auth.proxy.trustedProxies`
 * applies then); comma-only degenerate input parses as the explicit
 * empty list (which fails the `proxy` cross-check below, never
 * "trust everyone").
 */
function parseTrustedProxies(env: Env): readonly string[] | undefined {
	const raw = env.SIGRUN_AUTH_TRUSTED_PROXIES;
	if (raw === undefined || raw === "") return undefined;
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

/**
 * Resolve {@link AuthConfig}: env over the file's `server.auth` section
 * per field. The env-only credentials (`SIGRUN_PROXY_SECRET` →
 * `proxy.secret`, `SIGRUN_API_TOKEN` → `serviceToken`) have NO file
 * fallback (validation rejects a file `secret` key; tokens never lived
 * in the settings file). Fails loud when `proxy` is a method but no
 * trusted range is configured — an unscoped proxy method would trust
 * everyone (spec §5.3's boot error).
 */
function parseAuth(env: Env, server?: ServerSettings["auth"]): AuthConfig {
	const methods = parseAuthMethods(env) ?? server?.methods;
	const trustedProxies =
		parseTrustedProxies(env) ?? server?.proxy?.trustedProxies ?? [];
	if (methods?.includes("proxy") && trustedProxies.length === 0) {
		throw new Error(
			'server.auth methods include "proxy" but trustedProxies is empty — ' +
				"set SIGRUN_AUTH_TRUSTED_PROXIES or server.auth.proxy.trustedProxies " +
				'(a proxy method with no trusted range would trust everyone)',
		);
	}
	const token = env.SIGRUN_API_TOKEN?.trim() || undefined;
	const secret = env.SIGRUN_PROXY_SECRET?.trim() || undefined;
	return {
		methods,
		proxy: {
			trustedProxies,
			...(server?.proxy?.secretHeader === undefined
				? {}
				: { secretHeader: server.proxy.secretHeader }),
			...(secret === undefined ? {} : { secret }),
			userHeader: server?.proxy?.userHeader ?? DEFAULT_AUTH.proxy.userHeader,
			groupsHeader:
				server?.proxy?.groupsHeader ?? DEFAULT_AUTH.proxy.groupsHeader,
			nameHeader: server?.proxy?.nameHeader ?? DEFAULT_AUTH.proxy.nameHeader,
			emailHeader:
				server?.proxy?.emailHeader ?? DEFAULT_AUTH.proxy.emailHeader,
			autoProvision: server?.proxy?.autoProvision ?? true,
		},
		adminGroups: server?.adminGroups ?? [],
		...(server?.allowedHosts === undefined
			? {}
			: { allowedHosts: server.allowedHosts }),
		...(server?.allowedOrigins === undefined
			? {}
			: { allowedOrigins: server.allowedOrigins }),
		...(token === undefined
			? {}
			: {
					serviceToken: {
						token,
					user: env.SIGRUN_API_TOKEN_USER?.trim() || "sigrun",
					},
			}),
	};
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
 * Parse one STRICT positive-integer env knob (the `SIGRUN_PORT`
 * posture): `""` counts as unset, anything non-integer or ≤ 0 fails
 * loud naming the variable. Shared by `loadConfig` and
 * {@link envServerSection} so both parse identically.
 */
function parsePositiveIntEnv(env: Env, key: string): number | undefined {
	const raw = env[key];
	if (raw === undefined || raw === "") return undefined;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${key} must be a positive integer, got ${raw}`);
	}
	return parsed;
}

/**
 * Parse one STRICT non-negative-integer env knob (0 is a designed
 * value): the {@link parsePositiveIntEnv} posture with the floor at 0.
 */
function parseNonNegativeIntEnv(env: Env, key: string): number | undefined {
	const raw = env[key];
	if (raw === undefined || raw === "") return undefined;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${key} must be a non-negative integer, got ${raw}`);
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
	return (
		parseNonNegativeIntEnv(env, PROVIDER_REFRESH_MINUTES_ENV) ??
		file ??
		DEFAULT_PROVIDER_REFRESH_MINUTES
	);
}

/**
 * Parse `SIGRUN_MAX_UPLOAD_BYTES` (spec §6.2) — the strict positive-integer
 * pattern (the `SIGRUN_PORT` posture): `""` counts as unset, anything
 * non-integer or ≤ 0 fails loud naming the variable. The file's
 * `server.maxUploadBytes` applies where the env var is absent; the 64 MiB
 * default last.
 */
function parseMaxUploadBytes(env: Env, file?: number): number {
	return (
		parsePositiveIntEnv(env, MAX_UPLOAD_BYTES_ENV) ??
		file ??
		DEFAULT_MAX_UPLOAD_BYTES
	);
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

/** The `BackupConfig` → file-shape projection (the two-shape union). */
function backupFileShape(config: BackupConfig): ServerSettings["backup"] {
	return config.target === "path"
		? { path: config.path }
		: {
				s3: {
					bucket: config.bucket,
					...(config.prefix === undefined ? {} : { prefix: config.prefix }),
					...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
				},
			};
}

/** Copy only the defined entries; `undefined` when none survive. */
function pickDefined(
	source: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined) out[key] = value;
	}
	return Object.keys(out).length === 0 ? undefined : out;
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
	// `auth`/`metrics` are the SECOND intent-shaped exception (the webui
	// pattern, core-hardening W1): a DEFAULTED auth is omitted entirely —
	// a mirrored `methods: []` would read as "authentication disabled"
	// intent on the next boot, when the derived default is `[]` ONLY on a
	// loopback bind (a fact the file cannot see). A CONFIGURED auth
	// records only the non-default keys, and the env-only credentials
	// (`proxy.secret`, `serviceToken`) are NEVER written — key material
	// stays in env/auth.json.
	const proxy = config.auth.proxy;
	const proxySection:
		| NonNullable<NonNullable<ServerSettings["auth"]>["proxy"]>
		| undefined =
		proxy.trustedProxies.length > 0 ||
		proxy.secretHeader !== undefined ||
		proxy.userHeader !== DEFAULT_AUTH.proxy.userHeader ||
		proxy.groupsHeader !== DEFAULT_AUTH.proxy.groupsHeader ||
		proxy.nameHeader !== DEFAULT_AUTH.proxy.nameHeader ||
		proxy.emailHeader !== DEFAULT_AUTH.proxy.emailHeader ||
		proxy.autoProvision !== true
			? {
					...(proxy.trustedProxies.length > 0
						? { trustedProxies: [...proxy.trustedProxies] }
						: {}),
					...(proxy.secretHeader === undefined
						? {}
						: { secretHeader: proxy.secretHeader }),
					...(proxy.userHeader !== DEFAULT_AUTH.proxy.userHeader
						? { userHeader: proxy.userHeader }
						: {}),
					...(proxy.groupsHeader !== DEFAULT_AUTH.proxy.groupsHeader
						? { groupsHeader: proxy.groupsHeader }
						: {}),
					...(proxy.nameHeader !== DEFAULT_AUTH.proxy.nameHeader
						? { nameHeader: proxy.nameHeader }
						: {}),
					...(proxy.emailHeader !== DEFAULT_AUTH.proxy.emailHeader
						? { emailHeader: proxy.emailHeader }
						: {}),
					...(proxy.autoProvision !== true
						? { autoProvision: proxy.autoProvision }
						: {}),
				}
			: undefined;
	const auth: ServerSettings["auth"] | undefined =
		config.auth.methods !== undefined ||
		proxySection !== undefined ||
		config.auth.adminGroups.length > 0 ||
		config.auth.allowedHosts !== undefined ||
		config.auth.allowedOrigins !== undefined
			? {
					...(config.auth.methods === undefined
						? {}
						: { methods: [...config.auth.methods] }),
					...(proxySection === undefined ? {} : { proxy: proxySection }),
					...(config.auth.adminGroups.length > 0
						? { adminGroups: [...config.auth.adminGroups] }
						: {}),
					...(config.auth.allowedHosts === undefined
						? {}
						: { allowedHosts: [...config.auth.allowedHosts] }),
					...(config.auth.allowedOrigins === undefined
						? {}
						: { allowedOrigins: [...config.auth.allowedOrigins] }),
				}
			: undefined;
	const metrics: ServerSettings["metrics"] | undefined = config.metricsPublic
		? { public: true }
		: undefined;
	// The development flag (§14.2/§14.4) follows the metrics pattern: a
	// DEFAULTED dev is omitted (persisting `dev: false` would be noise),
	// a dev deployment records it (an operator-visible intent marker).
	const dev: ServerSettings["dev"] = config.dev === true ? true : undefined;
	return {
		port: config.port,
		workspacePath: config.workspace.path,
		storagePath: config.storagePath,
		dataDir: config.dataDir,
		cacheDir: config.cacheDir,
		stateDir: config.stateDir,
		...(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }),
		...(webui === undefined ? {} : { webui }),
		compaction: { ...config.compaction },
		memorySeam: { ...config.memorySeam },
		providers: { ...config.providers },
		...(auth === undefined ? {} : { auth }),
		...(metrics === undefined ? {} : { metrics }),
		...(dev === undefined ? {} : { dev }),
		...(backup === undefined ? {} : { backup }),
	};
}

/**
 * Project the ENV-SET server values into the settings file's `server`
 * section — the object the first-boot bootstrap persists (ruling 5 /
 * spec §6.6: the file records INTENT, not reality). Only keys whose env
 * var is set (non-empty) appear; defaults are never projected, so later
 * releases' default changes reach existing installs. Each value uses
 * the SAME typed parser `loadConfig` uses (an invalid env value fails
 * loud here exactly as it would at resolution). `SIGRUN_EXTENSIONS_DIR`
 * is RETIRED (§6.7): set → one deprecation warning, then ignored — the
 * config carries no `extensionsDir` field at all.
 *
 * The env-var → key table:
 *
 * | env var | key |
 * |---|---|
 * | `SIGRUN_PORT` | `port` |
 * | `SIGRUN_WORKSPACE_PATH` | `workspacePath` |
 * | `SIGRUN_STORAGE_PATH` | `storagePath` |
 * | `SIGRUN_DATA_DIR` | `dataDir` |
 * | `SIGRUN_CACHE_DIR` | `cacheDir` |
 * | `SIGRUN_STATE_DIR` | `stateDir` |
 * | `SIGRUN_WEBUI` | `webui.enabled` |
 * | `SIGRUN_WEBUI_BUNDLE` | `webui.bundle` |
 * | `SIGRUN_COMPACTION_ENABLED` | `compaction.enabled` |
 * | `SIGRUN_COMPACTION_RESERVE_TOKENS` | `compaction.reserveTokens` |
 * | `SIGRUN_COMPACTION_KEEP_RECENT_TOKENS` | `compaction.keepRecentTokens` |
 * | `SIGRUN_COMPACTION_BACKGROUND_TOKENS` | `compaction.backgroundTokens` |
 * | `SIGRUN_HOOK_DEADLINE` | `memorySeam.hookDeadlineMs` |
 * | `SIGRUN_IDLE_THRESHOLD` | `memorySeam.idleThresholdMs` |
 * | `SIGRUN_WORKER_DEADLINE` | `memorySeam.workerDeadlineMs` |
 * | `SIGRUN_QUEUE_MAX` | `memorySeam.queueMax` |
 * | `SIGRUN_PROVIDER_REFRESH_MINUTES` | `providers.refreshIntervalMinutes` |
 * | `SIGRUN_BACKUP_*` | `backup` |
 * | `SIGRUN_MAX_UPLOAD_BYTES` | `maxUploadBytes` |
 * | `SIGRUN_MAX_FILE_READ_BYTES` | `maxFileReadBytes` |
 * | `SIGRUN_PUBLIC_URL` | `publicUrl` |
 */
export function envServerSection(env: Env): ServerSettings {
	const section: Record<string, unknown> = {};
	const port = parsePositiveIntEnv(env, "SIGRUN_PORT");
	if (port !== undefined) section.port = port;
	// Paths: verbatim when set — the exact reading `loadConfig` applies
	// (`""` counts as unset; no trimming, no suffixing).
	for (const [key, envKey] of [
		["workspacePath", "SIGRUN_WORKSPACE_PATH"],
		["storagePath", "SIGRUN_STORAGE_PATH"],
		["dataDir", "SIGRUN_DATA_DIR"],
		["cacheDir", "SIGRUN_CACHE_DIR"],
		["stateDir", "SIGRUN_STATE_DIR"],
	] as const) {
		const value = env[envKey] || undefined;
		if (value !== undefined) section[key] = value;
	}
	const maxUploadBytes = parsePositiveIntEnv(env, MAX_UPLOAD_BYTES_ENV);
	if (maxUploadBytes !== undefined) section.maxUploadBytes = maxUploadBytes;
	const maxFileReadBytes = parsePositiveIntEnv(env, MAX_FILE_READ_BYTES_ENV);
	if (maxFileReadBytes !== undefined) {
		section.maxFileReadBytes = maxFileReadBytes;
	}
	const publicUrl = parsePublicUrl(env[PUBLIC_URL_ENV], PUBLIC_URL_ENV);
	if (publicUrl !== undefined) section.publicUrl = publicUrl;
	const webui = pickDefined({
		enabled: parseWebuiEnabled(env),
		bundle: env.SIGRUN_WEBUI_BUNDLE?.trim() || undefined,
	});
	if (webui !== undefined) section.webui = webui;
	const compaction = pickDefined({
		enabled: parseCompactionEnabled(env),
		reserveTokens: parseTokenCount(env, "SIGRUN_COMPACTION_RESERVE_TOKENS", 1),
		keepRecentTokens: parseTokenCount(env, "SIGRUN_COMPACTION_KEEP_RECENT_TOKENS", 1),
		backgroundTokens: parseTokenCount(env, "SIGRUN_COMPACTION_BACKGROUND_TOKENS", 0),
	});
	if (compaction !== undefined) section.compaction = compaction;
	const memorySeam = pickDefined({
		hookDeadlineMs: parseMemorySeamCount(env, "SIGRUN_HOOK_DEADLINE"),
		idleThresholdMs: parseMemorySeamCount(env, "SIGRUN_IDLE_THRESHOLD"),
		workerDeadlineMs: parseMemorySeamCount(env, "SIGRUN_WORKER_DEADLINE"),
		queueMax: parseMemorySeamCount(env, "SIGRUN_QUEUE_MAX"),
	});
	if (memorySeam !== undefined) section.memorySeam = memorySeam;
	const refreshIntervalMinutes = parseNonNegativeIntEnv(
		env,
		PROVIDER_REFRESH_MINUTES_ENV,
	);
	if (refreshIntervalMinutes !== undefined) {
		section.providers = { refreshIntervalMinutes };
	}
	const backup = parseBackupConfig(env);
	if (backup !== undefined) section.backup = backupFileShape(backup);
	// The jobs default timezone (§8.2): `SIGRUN_TIMEZONE` — verbatim when
	// set (validated as an IANA name by the settings/store consumers).
	const timezone = env.SIGRUN_TIMEZONE?.trim() || undefined;
	if (timezone !== undefined) section.timezone = timezone;
	// The development flag (§14.2/§14.4) — a flat boolean, projected only
	// when the env var is set (a defaulted dev is never persisted: it
	// would read as intent on the next boot).
	const dev = parseDev(env);
	if (dev !== undefined) section.dev = dev;
	return section as ServerSettings;
}


/**
 * Build the `/v1/settings` `effective` block (spec §6.6): every server
 * section key — flattened to its dotted wire name (`"server.port"`,
 * `"server.compaction.reserveTokens"`, …) — with the RESOLVED value
 * (from the config boot actually used) and the SOURCE that won:
 * `"env"` when {@link envServerSection} projects the key (the env var
 * was set), else `"file"` when the file's `server` section sets it
 * (the LEGACY `webuiBundle` key counts as the file source for
 * `webui.bundle` — it resolves as the same selector), else `"default"`.
 * This generalizes the build spec's webui-key special case: since the
 * bootstrap no longer persists defaults, the block is where the full
 * resolved section (and each key's provenance) is visible. Unset
 * optional keys (`webui.bundle`, the `backup` leaves) are omitted —
 * there is no resolved value to report.
 */
export function effectiveServerSection(
	env: Env,
	fileServer: ServerSettings | undefined,
	config: SigrunConfig,
): Record<string, EffectiveServerSetting> {
	const envSection = envServerSection(env);
	const leaf = (source: unknown, path: readonly string[]): boolean => {
		let node: unknown = source;
		for (const key of path) {
			if (typeof node !== "object" || node === null) return false;
			node = (node as Record<string, unknown>)[key];
		}
		return node !== undefined;
	};
	const sourceOf = (
		path: readonly string[],
		legacyFileKeys: readonly string[] = [],
	): "env" | "file" | "default" => {
		if (leaf(envSection, path)) return "env";
		if (
			fileServer !== undefined &&
			(leaf(fileServer, path) ||
				legacyFileKeys.some((key) => leaf(fileServer, [key])))
		) {
			return "file";
		}
		return "default";
	};
	const out: Record<string, EffectiveServerSetting> = {};
	const emit = (
		key: string,
		value: unknown,
		path: readonly string[],
		legacyFileKeys: readonly string[] = [],
	): void => {
		out[`server.${key}`] = { value, source: sourceOf(path, legacyFileKeys) };
	};

	emit("port", config.port, ["port"]);
	emit("workspacePath", config.workspace.path, ["workspacePath"]);
	emit("storagePath", config.storagePath, ["storagePath"]);
	emit("maxUploadBytes", config.maxUploadBytes, ["maxUploadBytes"]);
	emit("maxFileReadBytes", config.maxFileReadBytes, ["maxFileReadBytes"]);
	emit("dataDir", config.dataDir, ["dataDir"]);
	emit("cacheDir", config.cacheDir, ["cacheDir"]);
	emit("stateDir", config.stateDir, ["stateDir"]);
	if (config.publicUrl !== undefined) {
		emit("publicUrl", config.publicUrl, ["publicUrl"]);
	}
	emit("webui.enabled", config.webui.enabled, ["webui", "enabled"]);
	if (config.webui.bundle !== undefined) {
		emit("webui.bundle", config.webui.bundle, ["webui", "bundle"], [
			"webuiBundle",
		]);
	}
	emit("compaction.enabled", config.compaction.enabled, [
		"compaction",
		"enabled",
	]);
	emit(
		"compaction.reserveTokens",
		config.compaction.reserveTokens,
		["compaction", "reserveTokens"],
	);
	emit(
		"compaction.keepRecentTokens",
		config.compaction.keepRecentTokens,
		["compaction", "keepRecentTokens"],
	);
	emit(
		"compaction.backgroundTokens",
		config.compaction.backgroundTokens,
		["compaction", "backgroundTokens"],
	);
	emit(
		"memorySeam.hookDeadlineMs",
		config.memorySeam.hookDeadlineMs,
		["memorySeam", "hookDeadlineMs"],
	);
	emit(
		"memorySeam.idleThresholdMs",
		config.memorySeam.idleThresholdMs,
		["memorySeam", "idleThresholdMs"],
	);
	emit(
		"memorySeam.workerDeadlineMs",
		config.memorySeam.workerDeadlineMs,
		["memorySeam", "workerDeadlineMs"],
	);
	emit("memorySeam.queueMax", config.memorySeam.queueMax, [
		"memorySeam",
		"queueMax",
	]);
	emit(
		"providers.refreshIntervalMinutes",
		config.providers.refreshIntervalMinutes,
		["providers", "refreshIntervalMinutes"],
	);
	emit("dev", config.dev, ["dev"]);
	if (config.backup?.target === "path") {
		emit("backup.path", config.backup.path, ["backup", "path"]);
		emit(
			"backup.staleAfterHours",
			config.backupStaleAfterHours,
			["backup", "staleAfterHours"],
		);
	} else if (config.backup?.target === "s3") {
		emit("backup.s3.bucket", config.backup.bucket, [
			"backup",
			"s3",
			"bucket",
		]);
		if (config.backup.prefix !== undefined) {
			emit("backup.s3.prefix", config.backup.prefix, [
				"backup",
				"s3",
				"prefix",
			]);
		}
		if (config.backup.endpoint !== undefined) {
			emit("backup.s3.endpoint", config.backup.endpoint, [
				"backup",
				"s3",
				"endpoint",
			]);
		}
		emit(
			"backup.staleAfterHours",
			config.backupStaleAfterHours,
			["backup", "staleAfterHours"],
		);
	}
	return out;
}

export function loadConfig(env: Env, settingsFile?: SettingsFile): SigrunConfig {
	// Env is parsed FIRST (fail-loud on an invalid env value even when the
	// file carries a valid one) and always WINS: a file field applies only
	// where the corresponding env variable is absent. Env-only knobs (never
	// file-configurable): `SIGRUN_CONFIG_DIR` (the file's own location) and
	// the OpenAI credentials (`OPENAI_API_KEY`, plus the sibling `auth.json`
	// the provider layer reads — settings.json never carries key material).
	const server = settingsFile?.server;

	// §6.7: `SIGRUN_EXTENSIONS_DIR` is retired — the knob was parsed but
	// never read. Set (non-empty) → one warning, then ignored; the file's
	// `server.extensionsDir` likewise only warns (src/harness/settings.ts).
	if (env.SIGRUN_EXTENSIONS_DIR) {
		warnDeprecatedExtensionsDirEnv();
	}

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
	const envPort = parsePositiveIntEnv(env, "SIGRUN_PORT");
	if (envPort !== undefined) {
		port = envPort;
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
		maxUploadBytes: parseMaxUploadBytes(env, server?.maxUploadBytes),
		maxFileReadBytes: parseMaxFileReadBytes(env, server?.maxFileReadBytes),
		// W5 Task 2 (spec §9.2): the deployment's absolute base URL — env
		// parsed first (fail loud on an invalid env value even when the
		// file carries a valid one), the file's `server.publicUrl` next,
		// unset when neither source sets it.
		publicUrl:
			parsePublicUrl(env[PUBLIC_URL_ENV], PUBLIC_URL_ENV) ??
			parsePublicUrl(server?.publicUrl, "server.publicUrl"),
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
			// Spec §6.3: the default rides the data root (<dataDir>/workspace);
			// env over file over that — and the default is never persisted
			// (spec §6.6, the envServerSection projection).
			path:
			env.SIGRUN_WORKSPACE_PATH ||
			server?.workspacePath ||
			defaultWorkspacePath(dataDir),
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
		// §6.8: the honesty window — file-only tier over the 36 h default
		// (no env var exists for this key).
		backupStaleAfterHours:
			server?.backup?.staleAfterHours ?? DEFAULT_BACKUP_STALE_AFTER_HOURS,
		compaction: parseCompaction(env, server?.compaction),
		memorySeam: parseMemorySeam(env, server?.memorySeam),
		providers: {
			refreshIntervalMinutes: parseRefreshIntervalMinutes(
				env,
				server?.providers?.refreshIntervalMinutes,
			),
		},
		auth: parseAuth(env, server?.auth),
		metricsPublic:
			parseMetricsPublic(env) ?? server?.metrics?.public ?? false,
		// The development flag (§14.2/§14.4): strict env parse over the
		// file's `server.dev`, default false.
		dev: parseDev(env) ?? server?.dev ?? false,
		// The jobs default timezone (§8.2): env over file over the process
		// TZ, validated loud (a bad name would otherwise crash the scheduler
		// at evaluation time instead of failing boot).
		timezone: resolveTimezone(
			env.SIGRUN_TIMEZONE?.trim() || server?.timezone,
		),
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
 * The jobs default timezone resolution (§8.2): env over file over the
 * process TZ. A configured name that is not IANA fails LOUD — the same
 * gate `validateJobSpec` runs on a spec's own `timezone`.
 */
function resolveTimezone(configured: string | undefined): string {
	const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
	if (configured === undefined || configured === "") return fallback;
	if (!isIanaTimeZone(configured)) {
		throw new Error(
			`SIGRUN_TIMEZONE / server.timezone must be an IANA name (got ${JSON.stringify(configured)})`,
		);
	}
	return configured;
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
