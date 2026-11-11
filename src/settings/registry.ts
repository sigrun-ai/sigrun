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

import { applyOf as schemaApplyOf } from "./schema/keywords.js";
// This cycle is benign: core-schema's generateForm import does not call
// registry.applyOf during module initialization; apply lookups run later.
import { coreProperty } from "./core-schema.js";

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

/** One registry entry: the key, its section, and the audit reason. Apply lives in the schema. */
export interface CoreSettingKey {
	/** The flattened dotted path (`"namingModel"`, `"server.port"`). */
	readonly key: string;
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
		section: "general",
		reason: "pi-durable HarnessSettings pass-through, re-read at every resolution boundary",
	},
	{
		key: "followUpMode",
		section: "general",
		reason: "pi-durable HarnessSettings pass-through, re-read at every resolution boundary",
	},
	{
		key: "retry.enabled",
		section: "general",
		reason: "HarnessSettings.retry merge, re-read per resolution",
	},
	{
		key: "retry.maxRetries",
		section: "general",
		reason: "HarnessSettings.retry merge, re-read per resolution",
	},
	{
		key: "retry.baseDelayMs",
		section: "general",
		reason: "HarnessSettings.retry merge, re-read per resolution",
	},
	{
		key: "retry.maxAgentDelayMs",
		section: "general",
		reason: "HarnessSettings.retry merge, re-read per resolution",
	},
	{
		key: "stream.timeoutMs",
		section: "general",
		reason: "HarnessSettings.stream merge, re-read per resolution",
	},
	{
		key: "stream.maxRetries",
		section: "general",
		reason: "HarnessSettings.stream merge, re-read per resolution",
	},
	{
		key: "stream.maxRetryDelayMs",
		section: "general",
		reason: "HarnessSettings.stream merge, re-read per resolution",
	},
	// ── Per-use readers ──
	{
		key: "defaultTools",
		section: "tools",
		reason: "read per conversation create (storeAgentChange), so a PATCH reaches new conversations",
	},
	{
		key: "perModelThinking",
		section: "tools",
		reason: "read per conversation create and configure",
	},
	{
		key: "extensions",
		section: "extensions",
		reason: "boot reconciliation: syncPackages installs/uninstalls and the loader resolves the list at boot",
	},
	{
		key: "jobs",
		section: "advanced",
		reason: "boot reconciliation: the file job list resolves into job records at boot",
	},
	{
		key: "jobHistory.runs",
		section: "advanced",
		reason: "read per prune at run-settle (spec §8.1, ruling 14)",
	},
	{
		key: "jobHistory.revisions",
		section: "advanced",
		reason: "read per prune at revision-write (spec §8.1, ruling 14)",
	},
	{
		key: "jobDefaults.maxTurns",
		section: "advanced",
		reason: "read per fire: the new-conversation run's fallback turn limit (default 150)",
	},
	{
		key: "defaultModel",
		section: "general",
		reason: "boot model resolution: env over file resolves once into the served default",
	},
	{
		key: "namingModel",
		section: "general",
		reason: "read per settled run by the auto-namer (src/harness/naming.ts)",
	},
	{
		key: "decisionModel",
		section: "general",
		reason: "read per host.decisions.evaluate call by the decision registry (src/harness/decisions.ts)",
	},
	{
		key: "embeddingModel",
		section: "advanced",
		reason: "read per host.embeddings.embed call by the embedding registry (src/harness/embeddings.ts)",
	},
	{
		key: "embeddings.localModels",
		section: "advanced",
		reason: "deprecated: migrated to localProviders by the openHarness locality migration (src/server/locality-migration.ts)",
	},
	{
		key: "localProviders",
		section: "providers",
		reason: "read live per locality check through the one locality resolver (src/harness/locality.ts)",
	},
	{
		key: "decisions.tool",
		section: "tools",
		reason: "read at each decision_evaluate tool call (default off)",
	},
	{
		key: "defaultProvider.baseUrl",
		section: "providers",
		reason: "the env-driven provider's endpoint resolves into the boot provider construction",
	},
	{
		key: "skills.sectionMaxBytes",
		section: "general",
		reason: "read per skills-section render (the live cap closure in boot)",
	},
	{
		key: "notifications.runSettled",
		section: "general",
		reason: "read per run.settled event by the notifications surface",
	},
	{
		key: "builtinExtensions.codemode",
		section: "extensions",
		reason: "the built-in set resolves at boot (a disabled built-in never loads)",
	},
	{
		key: "builtinExtensions.mcp",
		section: "extensions",
		reason: "the built-in set resolves at boot (a disabled built-in never loads)",
	},
	{
		key: "builtinExtensions.toolSearch",
		section: "extensions",
		reason: "the built-in set resolves at boot (a disabled built-in never loads)",
	},
	{
		key: "builtinExtensions.gateway",
		section: "extensions",
		reason: "the built-in set resolves at boot (a disabled built-in never loads)",
	},
	{
		key: "builtinExtensions.oauth",
		section: "extensions",
		reason: "the built-in set resolves at boot (a disabled built-in never loads)",
	},
	{
		key: "builtinExtensions.curator",
		section: "extensions",
		reason: "the built-in set resolves at boot (a disabled built-in never loads)",
	},
	{
		key: "autoEnableCodemode",
		section: "tools",
		reason: "read at conversation create alongside defaultTools",
	},
	// ── server.* (each key marked individually — ruling 18) ──
	{
		key: "server.port",
		section: "server",
		reason: "the listener binds at boot (serve's app.listen)",
	},
	{
		key: "server.workspacePath",
		section: "server",
		reason: "boot-resolved workspace root (the workspace service is built once)",
	},
	{
		key: "server.storagePath",
		section: "server",
		reason: "boot-resolved sqlite path (the storage opens once at boot)",
	},
	{
		key: "server.extensionsDir",
		section: "server",
		reason: "deprecated path key (§6.7, accepted one release); root resolution is boot-time",
	},
	{
		key: "server.maxUploadBytes",
		section: "server",
		reason: "route bodyLimit values are set at route registration (boot)",
	},
	{
		key: "server.maxFileReadBytes",
		section: "server",
		reason: "the files/raw cap reads the boot-resolved config value per request",
	},
	{
		key: "server.dataDir",
		section: "server",
		reason: "boot-resolved store root (resolveStoreRoots folds it once)",
	},
	{
		key: "server.cacheDir",
		section: "server",
		reason: "boot-resolved store root",
	},
	{
		key: "server.stateDir",
		section: "server",
		reason: "boot-resolved store root",
	},
	{
		key: "server.publicUrl",
		section: "server",
		reason: "extension-route base URLs and notification deep links read the boot-resolved config",
	},
	{
		key: "server.webui.enabled",
		section: "interface",
		reason: "the bundle resolves and mounts at serve time (boot)",
	},
	{
		key: "server.webui.bundle",
		section: "interface",
		reason: "the bundle selection resolves at serve time (boot)",
	},
	{
		key: "server.webuiBundle",
		section: "interface",
		reason: "deprecated alias of webui.bundle (one release); the selection resolves at serve time",
	},
	{
		key: "server.timezone",
		section: "server",
		reason: "the jobs defaultTz resolves once into the schedule runtime at boot",
	},
	{
		key: "server.compaction.enabled",
		section: "advanced",
		reason: "compaction policy resolves into the boot harness settings",
	},
	{
		key: "server.compaction.reserveTokens",
		section: "advanced",
		reason: "compaction policy resolves into the boot harness settings",
	},
	{
		key: "server.compaction.keepRecentTokens",
		section: "advanced",
		reason: "compaction policy resolves into the boot harness settings",
	},
	{
		key: "server.compaction.backgroundTokens",
		section: "advanced",
		reason: "compaction policy resolves into the boot harness settings",
	},
	{
		key: "server.compaction.modelOverrides",
		section: "advanced",
		reason: "compaction policy resolves into the boot harness settings",
	},
	{
		key: "server.memorySeam.hookDeadlineMs",
		section: "advanced",
		reason: "the event bus's bounds are set at open (boot)",
	},
	{
		key: "server.memorySeam.idleThresholdMs",
		section: "advanced",
		reason: "the event bus's idle detection arms at open (boot)",
	},
	{
		key: "server.memorySeam.workerDeadlineMs",
		section: "advanced",
		reason: "the event bus's worker bound is set at open (boot)",
	},
	{
		key: "server.memorySeam.queueMax",
		section: "advanced",
		reason: "the event bus's queue bound is set at open (boot)",
	},
	{
		key: "server.decisions.timeoutMs",
		section: "providers",
		reason: "the decision registry reads the settings' timeoutMs per evaluate call (src/harness/decisions.ts)",
	},
	{
		key: "server.embeddings.timeoutMs",
		section: "advanced",
		reason: "the embedding registry reads the settings' timeout cap per call (src/harness/embeddings.ts)",
	},
	{
		key: "server.providers.refreshIntervalMinutes",
		section: "providers",
		reason: "the interval scheduler re-arms on change (the settings-changed wiring in boot)",
	},
	{
		key: "server.auth.methods",
		section: "server",
		reason: "the auth pipeline's method list resolves once at server construction",
	},
	{
		key: "server.auth.sessionDays",
		section: "server",
		reason: "read from the live settings store when a login creates a session",
	},
	{
		key: "server.auth.proxy.trustedProxies",
		section: "server",
		reason: "proxy trust resolves once into the pipeline's peer check",
	},
	{
		key: "server.auth.proxy.secretHeader",
		section: "server",
		reason: "header names resolve once into the pipeline's forward-auth stage",
	},
	{
		key: "server.auth.proxy.userHeader",
		section: "server",
		reason: "header names resolve once into the pipeline's forward-auth stage",
	},
	{
		key: "server.auth.proxy.groupsHeader",
		section: "server",
		reason: "header names resolve once into the pipeline's forward-auth stage",
	},
	{
		key: "server.auth.proxy.nameHeader",
		section: "server",
		reason: "header names resolve once into the pipeline's forward-auth stage",
	},
	{
		key: "server.auth.proxy.emailHeader",
		section: "server",
		reason: "header names resolve once into the pipeline's forward-auth stage",
	},
	{
		key: "server.auth.proxy.autoProvision",
		section: "server",
		reason: "provisioning posture resolves once at pipeline construction",
	},
	{
		key: "server.auth.adminGroups",
		section: "server",
		reason: "the admin-group mapping resolves once at pipeline construction",
	},
	{
		key: "server.auth.allowedHosts",
		section: "server",
		reason: "the Host allowlist resolves once at pipeline construction",
	},
	{
		key: "server.auth.allowedOrigins",
		section: "server",
		reason: "the Origin allowlist resolves once at pipeline construction",
	},
	{
		key: "server.metrics.public",
		section: "server",
		reason: "the /metrics route's public gate registers at boot",
	},
	{
		key: "server.dev",
		section: "server",
		reason: "read from the boot config (meta, U1 gallery, U3 error bodies)",
	},
	{
		key: "server.supervised",
		section: "server",
		reason:
			"read from the boot config (U4 §13.3): gates POST /v1/admin/restart and meta's supervised — and a write can only take effect at the NEXT boot, since the route it gates is this boot's",
	},
	{
		key: "server.backup.path",
		section: "advanced",
		reason: "the backup target and honesty window resolve into the boot config's health",
	},
	{
		key: "server.backup.staleAfterHours",
		section: "advanced",
		reason: "the backup honesty window resolves into the boot config's health",
	},
	{
		key: "server.backup.s3.bucket",
		section: "advanced",
		reason: "the backup target resolves into the boot config's health",
	},
	{
		key: "server.backup.s3.prefix",
		section: "advanced",
		reason: "the backup target resolves into the boot config's health",
	},
	{
		key: "server.backup.s3.endpoint",
		section: "advanced",
		reason: "the backup target resolves into the boot config's health",
	},
];

/** The registry keyed by `key`, with apply derived from the core schema. */
const BY_KEY: ReadonlyMap<string, CoreSettingKey & { readonly apply: SettingApply }> = new Map(
	CORE_SETTING_KEYS.map((entry) => {
		const property = coreProperty(entry.key);
		if (property === undefined) throw new Error(`core registry: no schema property for ${entry.key}`);
		return [entry.key, { ...entry, apply: schemaApplyOf(property) }];
	}),
);

/**
 * Classify one flattened key path. Keys the registry has not classified
 * read as `"restart"` (conservative: a boot-read default is the safe
 * assumption for an unclassified knob).
 */
export function applyOf(key: string): SettingApply {
	return BY_KEY.get(key)?.apply ?? "restart";
}
