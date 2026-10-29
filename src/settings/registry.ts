/**
 * The core settings key registry (UI-blocks U4 Task 1, spec §13.1,
 * ruling 18): ONE entry per key of `SettingsFile` (flattened dotted
 * paths for nested sections) declaring HOW the setting applies —
 *
 * - `live`: the value is read where it's used, at the time it's used.
 *   Saving it takes effect without a restart.
 * - `restart`: the value is read at boot. Saving stores it and marks it
 *   pending (the `pendingRestart` diff, src/settings/pending.ts).
 *
 * This SUPERSEDES core-hardening §5.7's blanket "every `server.*` key
 * is restart-required" (ruling 18): each core key is marked
 * individually, and the reasons below are the audit's one-line record
 * (the where-it's-read evidence for every entry).
 *
 * NOT here (deliberately — spec §13.1): the listen host (a launch
 * option: `serve` binds `0.0.0.0`, `run` binds `127.0.0.1`) and the
 * config dir (`SIGRUN_CONFIG_DIR`, env-only — it locates the settings
 * file itself). Neither is a stored setting.
 *
 * Extension-declared fields are also NOT here: they default to `live`
 * (§13.1); an extension marks a field `restart` when its factory reads
 * the value at load (Task 3's sections carry that).
 */

/** How one setting applies (spec §13.1). */
export type SettingApply = "live" | "restart";

/**
 * The settings-section vocabulary `section` names — informational
 * metadata for panels (which section renders the key); Task 4's core
 * sections and Task 3's extension sections own the actual rendering.
 */
export type SettingSection =
	| "general"
	| "tools"
	| "interface"
	| "advanced"
	| "providers"
	| "extensions"
	| "server";

/** One registry entry: the key, its apply rule, its section, the audit reason. */
export interface CoreSettingKey {
	/** The flattened dotted path (`"namingModel"`, `"server.port"`). */
	readonly key: string;
	readonly apply: SettingApply;
	readonly section: SettingSection;
	/** The audit's one-line record: where the value is read. */
	readonly reason: string;
}

/**
 * Every core key, in `SettingsFile` declaration order (top-level keys
 * first, then the `server.*` leaves). `test/settings-apply.test.ts`
 * pins this list against the TYPE with a compile-time tie: a key added
 * to `SettingsFile` without an entry here fails the suite naming it.
 */
export const CORE_SETTING_KEYS: readonly CoreSettingKey[] = [
	// ── HarnessSettings pass-throughs: pi-durable re-reads per boundary ──
	{
		key: "steeringMode",
		apply: "live",
		section: "general",
		reason: "pi-durable HarnessSettings pass-through, re-read at every resolution boundary",
	},
	{
		key: "followUpMode",
		apply: "live",
		section: "general",
		reason: "pi-durable HarnessSettings pass-through, re-read at every resolution boundary",
	},
	{
		key: "retry.enabled",
		apply: "live",
		section: "general",
		reason: "HarnessSettings.retry merge, re-read per resolution",
	},
	{
		key: "retry.maxRetries",
		apply: "live",
		section: "general",
		reason: "HarnessSettings.retry merge, re-read per resolution",
	},
	{
		key: "retry.baseDelayMs",
		apply: "live",
		section: "general",
		reason: "HarnessSettings.retry merge, re-read per resolution",
	},
	{
		key: "retry.maxAgentDelayMs",
		apply: "live",
		section: "general",
		reason: "HarnessSettings.retry merge, re-read per resolution",
	},
	{
		key: "stream.timeoutMs",
		apply: "live",
		section: "general",
		reason: "HarnessSettings.stream merge, re-read per resolution",
	},
	{
		key: "stream.maxRetries",
		apply: "live",
		section: "general",
		reason: "HarnessSettings.stream merge, re-read per resolution",
	},
	{
		key: "stream.maxRetryDelayMs",
		apply: "live",
		section: "general",
		reason: "HarnessSettings.stream merge, re-read per resolution",
	},
	// ── Per-use readers ──
	{
		key: "defaultTools",
		apply: "live",
		section: "tools",
		reason: "read per conversation create (storeAgentChange), so a PATCH reaches new conversations",
	},
	{
		key: "perModelThinking",
		apply: "live",
		section: "tools",
		reason: "read per conversation create and configure",
	},
	{
		key: "extensions",
		apply: "restart",
		section: "extensions",
		reason: "boot reconciliation: syncPackages installs/uninstalls and the loader resolves the list at boot",
	},
	{
		key: "jobs",
		apply: "restart",
		section: "advanced",
		reason: "boot reconciliation: the file job list resolves into job records at boot",
	},
	{
		key: "jobHistory.runs",
		apply: "live",
		section: "advanced",
		reason: "read per prune at run-settle (spec §8.1, ruling 14)",
	},
	{
		key: "jobHistory.revisions",
		apply: "live",
		section: "advanced",
		reason: "read per prune at revision-write (spec §8.1, ruling 14)",
	},
	{
		key: "defaultModel",
		apply: "restart",
		section: "general",
		reason: "boot model resolution: env over file resolves once into the served default",
	},
	{
		key: "namingModel",
		apply: "live",
		section: "general",
		reason: "read per settled run by the auto-namer (src/harness/naming.ts)",
	},
	{
		key: "defaultProvider.baseUrl",
		apply: "restart",
		section: "providers",
		reason: "the env-driven provider's endpoint resolves into the boot provider construction",
	},
	{
		key: "skills.sectionMaxBytes",
		apply: "live",
		section: "general",
		reason: "read per skills-section render (the live cap closure in boot)",
	},
	{
		key: "notifications.runSettled",
		apply: "live",
		section: "general",
		reason: "read per run.settled event by the notifications surface",
	},
	{
		key: "builtinExtensions.codemode",
		apply: "restart",
		section: "extensions",
		reason: "the built-in set resolves at boot (a disabled built-in never loads)",
	},
	{
		key: "builtinExtensions.mcp",
		apply: "restart",
		section: "extensions",
		reason: "the built-in set resolves at boot (a disabled built-in never loads)",
	},
	{
		key: "builtinExtensions.toolSearch",
		apply: "restart",
		section: "extensions",
		reason: "the built-in set resolves at boot (a disabled built-in never loads)",
	},
	{
		key: "builtinExtensions.oauth",
		apply: "restart",
		section: "extensions",
		reason: "the built-in set resolves at boot (a disabled built-in never loads)",
	},
	{
		key: "autoEnableCodemode",
		apply: "live",
		section: "tools",
		reason: "read at conversation create alongside defaultTools",
	},
	// ── server.* (each key marked individually — ruling 18) ──
	{
		key: "server.port",
		apply: "restart",
		section: "server",
		reason: "the listener binds at boot (serve's app.listen)",
	},
	{
		key: "server.workspacePath",
		apply: "restart",
		section: "server",
		reason: "boot-resolved workspace root (the workspace service is built once)",
	},
	{
		key: "server.storagePath",
		apply: "restart",
		section: "server",
		reason: "boot-resolved sqlite path (the storage opens once at boot)",
	},
	{
		key: "server.extensionsDir",
		apply: "restart",
		section: "server",
		reason: "deprecated path key (§6.7, accepted one release); root resolution is boot-time",
	},
	{
		key: "server.maxUploadBytes",
		apply: "restart",
		section: "server",
		reason: "route bodyLimit values are set at route registration (boot)",
	},
	{
		key: "server.maxFileReadBytes",
		apply: "restart",
		section: "server",
		reason: "the files/raw cap reads the boot-resolved config value per request",
	},
	{
		key: "server.dataDir",
		apply: "restart",
		section: "server",
		reason: "boot-resolved store root (resolveStoreRoots folds it once)",
	},
	{
		key: "server.cacheDir",
		apply: "restart",
		section: "server",
		reason: "boot-resolved store root",
	},
	{
		key: "server.stateDir",
		apply: "restart",
		section: "server",
		reason: "boot-resolved store root",
	},
	{
		key: "server.publicUrl",
		apply: "restart",
		section: "server",
		reason: "extension-route base URLs and notification deep links read the boot-resolved config",
	},
	{
		key: "server.webui.enabled",
		apply: "restart",
		section: "interface",
		reason: "the bundle resolves and mounts at serve time (boot)",
	},
	{
		key: "server.webui.bundle",
		apply: "restart",
		section: "interface",
		reason: "the bundle selection resolves at serve time (boot)",
	},
	{
		key: "server.webuiBundle",
		apply: "restart",
		section: "interface",
		reason: "deprecated alias of webui.bundle (one release); the selection resolves at serve time",
	},
	{
		key: "server.timezone",
		apply: "restart",
		section: "server",
		reason: "the jobs defaultTz resolves once into the schedule runtime at boot",
	},
	{
		key: "server.compaction.enabled",
		apply: "restart",
		section: "advanced",
		reason: "compaction policy resolves into the boot harness settings",
	},
	{
		key: "server.compaction.reserveTokens",
		apply: "restart",
		section: "advanced",
		reason: "compaction policy resolves into the boot harness settings",
	},
	{
		key: "server.compaction.keepRecentTokens",
		apply: "restart",
		section: "advanced",
		reason: "compaction policy resolves into the boot harness settings",
	},
	{
		key: "server.compaction.backgroundTokens",
		apply: "restart",
		section: "advanced",
		reason: "compaction policy resolves into the boot harness settings",
	},
	{
		key: "server.compaction.modelOverrides",
		apply: "restart",
		section: "advanced",
		reason: "compaction policy resolves into the boot harness settings",
	},
	{
		key: "server.memorySeam.hookDeadlineMs",
		apply: "restart",
		section: "advanced",
		reason: "the event bus's bounds are set at open (boot)",
	},
	{
		key: "server.memorySeam.idleThresholdMs",
		apply: "restart",
		section: "advanced",
		reason: "the event bus's idle detection arms at open (boot)",
	},
	{
		key: "server.memorySeam.workerDeadlineMs",
		apply: "restart",
		section: "advanced",
		reason: "the event bus's worker bound is set at open (boot)",
	},
	{
		key: "server.memorySeam.queueMax",
		apply: "restart",
		section: "advanced",
		reason: "the event bus's queue bound is set at open (boot)",
	},
	{
		key: "server.providers.refreshIntervalMinutes",
		apply: "live",
		section: "providers",
		reason: "the interval scheduler re-arms on change (the settings-changed wiring in boot)",
	},
	{
		key: "server.auth.methods",
		apply: "restart",
		section: "server",
		reason: "the auth pipeline's method list resolves once at server construction",
	},
	{
		key: "server.auth.sessionDays",
		apply: "live",
		section: "server",
		reason: "read from the live settings store when a login creates a session",
	},
	{
		key: "server.auth.proxy.trustedProxies",
		apply: "restart",
		section: "server",
		reason: "proxy trust resolves once into the pipeline's peer check",
	},
	{
		key: "server.auth.proxy.secretHeader",
		apply: "restart",
		section: "server",
		reason: "header names resolve once into the pipeline's forward-auth stage",
	},
	{
		key: "server.auth.proxy.userHeader",
		apply: "restart",
		section: "server",
		reason: "header names resolve once into the pipeline's forward-auth stage",
	},
	{
		key: "server.auth.proxy.groupsHeader",
		apply: "restart",
		section: "server",
		reason: "header names resolve once into the pipeline's forward-auth stage",
	},
	{
		key: "server.auth.proxy.nameHeader",
		apply: "restart",
		section: "server",
		reason: "header names resolve once into the pipeline's forward-auth stage",
	},
	{
		key: "server.auth.proxy.emailHeader",
		apply: "restart",
		section: "server",
		reason: "header names resolve once into the pipeline's forward-auth stage",
	},
	{
		key: "server.auth.proxy.autoProvision",
		apply: "restart",
		section: "server",
		reason: "provisioning posture resolves once at pipeline construction",
	},
	{
		key: "server.auth.adminGroups",
		apply: "restart",
		section: "server",
		reason: "the admin-group mapping resolves once at pipeline construction",
	},
	{
		key: "server.auth.allowedHosts",
		apply: "restart",
		section: "server",
		reason: "the Host allowlist resolves once at pipeline construction",
	},
	{
		key: "server.auth.allowedOrigins",
		apply: "restart",
		section: "server",
		reason: "the Origin allowlist resolves once at pipeline construction",
	},
	{
		key: "server.metrics.public",
		apply: "restart",
		section: "server",
		reason: "the /metrics route's public gate registers at boot",
	},
	{
		key: "server.dev",
		apply: "restart",
		section: "server",
		reason: "read from the boot config (meta, U1 gallery, U3 error bodies)",
	},
	{
		key: "server.supervised",
		apply: "restart",
		section: "server",
		reason:
			"read from the boot config (U4 §13.3): gates POST /v1/admin/restart and meta's supervised — and a write can only take effect at the NEXT boot, since the route it gates is this boot's",
	},
	{
		key: "server.backup.path",
		apply: "restart",
		section: "advanced",
		reason: "the backup target and honesty window resolve into the boot config's health",
	},
	{
		key: "server.backup.staleAfterHours",
		apply: "restart",
		section: "advanced",
		reason: "the backup honesty window resolves into the boot config's health",
	},
	{
		key: "server.backup.s3.bucket",
		apply: "restart",
		section: "advanced",
		reason: "the backup target resolves into the boot config's health",
	},
	{
		key: "server.backup.s3.prefix",
		apply: "restart",
		section: "advanced",
		reason: "the backup target resolves into the boot config's health",
	},
	{
		key: "server.backup.s3.endpoint",
		apply: "restart",
		section: "advanced",
		reason: "the backup target resolves into the boot config's health",
	},
];

/** The registry keyed by `key` (constant lookup for classification). */
const BY_KEY: ReadonlyMap<string, CoreSettingKey> = new Map(
	CORE_SETTING_KEYS.map((entry) => [entry.key, entry]),
);

/**
 * Classify one flattened key path. Keys the registry has not classified
 * read as `"restart"` (conservative: a boot-read default is the safe
 * assumption for an unclassified knob).
 */
export function applyOf(key: string): SettingApply {
	return BY_KEY.get(key)?.apply ?? "restart";
}
