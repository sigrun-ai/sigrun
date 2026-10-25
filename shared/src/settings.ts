/**
 * The settings-file TYPES (Task 8a, pi parity spec: the settings file) —
 * the persisted `SettingsFile` shape and its sections.
 *
 * The CANONICAL type declarations live here (the shared leaf package);
 * `src/harness/settings.ts` imports them (type-only) for the store/
 * validation runtime. The `GET/PATCH /v1/settings` wire serves this
 * shape verbatim (`SettingsResponse` = `SettingsFile` + the
 * server-computed `toolRoster`; see `@sigrun/shared/views`), so both
 * clients read these fields straight off the wire.
 *
 * The file is a JSON document at `<config-dir>/settings.json`. It
 * carries the `HarnessSettings` pass-throughs (`steeringMode`,
 * `followUpMode`, `retry`, `stream`) plus sigrun's own resolved fields
 * (`defaultTools`, `perModelThinking`, `extensions`, `jobs`, `jobHistory`,
 * `defaultModel`, `namingModel`, `defaultProvider`, `server`). Credentials
 * never live here (they live in the sibling `auth.json`).
 */

import type { JobSpec } from "./jobs.js";

/**
 * One entry of the unified `extensions` list: an install-and-load
 * declaration. The string form is shorthand for `{source}`; the object
 * form adds the git/entry/enabled knobs. See the `extensions` field
 * docblock on {@link SettingsFile} for the full grammar.
 */
export type ExtensionSpec =
	| string
	| {
			/** The source: npm specifier, bare name, file:/path, or git source. */
			readonly source: string;
			/** Entry-point override (path relative to the resolved source root). */
			readonly entry?: string;
			/** Git ref (same as the `@ref` suffix, spelled out). */
			readonly ref?: string;
			/** Default true; `false` = directory state retained, not loaded. */
			readonly enabled?: boolean;
	  };

/**
 * The job-history retention limits (spec §8.1, ruling 14), applied per
 * job at run-settle and revision-write: keep the newest `runs` run
 * records and the newest `revisions` revisions (plus any revision a
 * retained run references). Live settings — both positive integers,
 * default 50.
 */
export interface JobHistorySettings {
	readonly runs?: number;
	readonly revisions?: number;
}

/**
 * The `server` section: static boot configuration mirrored from the
 * `SIGRUN_*` env knobs. Every field is optional; a present field is the
 * deployment default applied when the corresponding env var is ABSENT
 * (env always wins, validated first). Not here: the extensions list and
 * the model (top-level fields of {@link SettingsFile}).
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
	 * `SIGRUN_MAX_UPLOAD_BYTES` — a positive integer. The raw-upload
	 * PUT route's body limit; the base64 POST and the JSONL import derive
	 * theirs from it (the 4/3 base64 inflation plus the JSON wrapper).
	 * Default 64 MiB (spec §6.2).
	 */
	readonly maxUploadBytes?: number;
	/**
	 * `SIGRUN_MAX_FILE_READ_BYTES` — a positive integer. The raw
	 * file-read cap (`GET .../files/raw`): 413 `file_too_large` beyond
	 * it. Default 16 MiB (spec §7.8) — the agent writes workspace
	 * files, so nothing else bounds them.
	 */
	readonly maxFileReadBytes?: number;
	/**
	 * `SIGRUN_DATA_DIR` — a non-empty path. Applied where the env var is
	 * absent; the env-or-file value wins VERBATIM (no `/sigrun` suffix),
	 * exactly like the stores resolver's explicit tier. The DB default
	 * and relative `SIGRUN_STORAGE_PATH` values resolve under this root.
	 */
	readonly dataDir?: string;
	/** `SIGRUN_CACHE_DIR` — a non-empty path, verbatim (see `dataDir`). */
	readonly cacheDir?: string;
	/** `SIGRUN_STATE_DIR` — a non-empty path, verbatim (see `dataDir`). */
	readonly stateDir?: string;
	/**
	 * `SIGRUN_PUBLIC_URL` (core hardening W5 Task 2, spec §9.2): the
	 * deployment's absolute base URL — http(s) with a hostname, any
	 * trailing slash stripped at resolution. `undefined` when neither
	 * env nor file sets it; the extension-route adapter bases handlers'
	 * absolute `Request` URLs on it and notification deep links are
	 * omitted without it.
	 */
	publicUrl?: string;
	/**
	 * The webui channel's gate + bundle selector (build-and-webui Task 4):
	 * `SIGRUN_WEBUI` maps to `enabled` (strict true/false parse), the
	 * selector comes from `SIGRUN_WEBUI_BUNDLE` over `bundle` over the
	 * legacy `webuiBundle` (deprecated alias, one release). Both keys are
	 * OPTIONAL — the settings bootstrap OMITS the section entirely when
	 * fully defaulted (a mirrored default would read as an explicit
	 * selection on the next boot and make absent-default → API-only
	 * unreachable).
	 */
	readonly webui?: {
		/** `SIGRUN_WEBUI` — boolean, default true. `false` = API-only. */
		readonly enabled?: boolean;
		/**
		 * The bundle selector (non-empty string): a contributed-bundle NAME
		 * or a PATH, discriminated syntactically at serve time (Task 5).
		 * Absent = the built-in default bundle.
		 */
		readonly bundle?: string;
	};
	/**
	 * DEPRECATED ALIAS for `webui.bundle` (build-and-webui Task 4), kept
	 * for one release: `SIGRUN_WEBUI_BUNDLE` over `webui.bundle` over THIS
	 * key over the default. Accepted by validation with a deprecation
	 * warn; the bootstrap never writes it.
	 *
	 * @deprecated use `webui.bundle`
	 */
	readonly webuiBundle?: string;
	/**
	 * The timezone `SIGRUN_TIMEZONE` mirrors (jobs §8.2): an IANA name —
	 * the default timezone for cron schedules that declare none (default:
	 * the process TZ). Validated as an IANA name (an `Intl.DateTimeFormat`
	 * construction succeeds).
	 */
	readonly timezone?: string;
	/** The `SIGRUN_COMPACTION_*` policy knobs. */
	readonly compaction?: {
		readonly enabled?: boolean;
		readonly reserveTokens?: number;
		readonly keepRecentTokens?: number;
		readonly backgroundTokens?: number;
	};
	/**
	 * The memory-seam bounds (memory-seam Task 6), mirroring the
	 * `SIGRUN_{HOOK_DEADLINE,IDLE_THRESHOLD,WORKER_DEADLINE,QUEUE_MAX}`
	 * env knobs — each a positive integer applied per-field where the
	 * corresponding env var is absent.
	 */
	readonly memorySeam?: {
		readonly hookDeadlineMs?: number;
		readonly idleThresholdMs?: number;
		readonly workerDeadlineMs?: number;
		readonly queueMax?: number;
	};
	/** The multi-user execution jail (M1). `mode` and `osUsers` are restart-required. */
	readonly isolation?: {
		/** `SIGRUN_ISOLATION` — auto, always, or off; default auto. */
		readonly mode?: "auto" | "always" | "off";
		/** Per-user uid/gid isolation; default false. */
		readonly osUsers?: boolean;
		/** Idle worker lifetime in minutes; default 10. */
		readonly workerIdleMinutes?: number;
	};
	/**
	 * The provider plugins' runtime knobs (provider plugins Task 5):
	 * `SIGRUN_PROVIDER_REFRESH_MINUTES` — the interval refresh cadence
	 * in minutes, a non-negative integer where `0` disables the
	 * scheduler. Applied per-field where the env var is absent.
	 */
	readonly providers?: {
		readonly refreshIntervalMinutes?: number;
	};
	/**
	 * The auth surface (core-hardening W1, spec §5.2/§5.3): the
	 * authenticator method list, the forward-auth (proxy) config, the
	 * admin group mapping, and the Host/Origin allowlists. Mirrors the
	 * `SIGRUN_AUTH`/`SIGRUN_AUTH_TRUSTED_PROXIES` env knobs (the env
	 * service token `SIGRUN_API_TOKEN` and the shared secret
	 * `SIGRUN_PROXY_SECRET` are ENV-ONLY credentials — validation rejects
	 * a `secret` key here, key material never lives in this file).
	 * `methods` ABSENT means derive from the listen host (`[]` on
	 * loopback, `["token"]` otherwise) — which is why a defaulted auth
	 * section is omitted from the bootstrap projection entirely (an
	 * explicit `methods: []` would read as intent on the next boot).
	 */
	readonly auth?: {
		/** `SIGRUN_AUTH` — csv of `token`/`proxy`; absent = derive from the listen host. */
		readonly methods?: readonly ("token" | "proxy")[];
		/** Browser-session lifetime in days. Positive integer; default 30; LIVE. */
		readonly sessionDays?: number;
		readonly proxy?: { readonly trustedProxies?: readonly string[]; readonly secretHeader?: string;
			readonly userHeader?: string; readonly groupsHeader?: string; readonly nameHeader?: string;
			readonly emailHeader?: string; readonly autoProvision?: boolean };
		readonly adminGroups?: readonly string[];
		readonly allowedHosts?: readonly string[];
		readonly allowedOrigins?: readonly string[];
	};
	/**
	 * `/metrics` exposure (core-hardening W1): `SIGRUN_METRICS_PUBLIC`
	 * over this key, default `false` (a principal is required). Omitted
	 * from the bootstrap projection when defaulted (the webui pattern).
	 */
	readonly metrics?: { readonly public?: boolean };
	/**
	 * The development flag (spec §14.2/§14.4): `SIGRUN_DEV` (strict
	 * true/false — the spec's `SIGRUN_DEV=1` form reads as true) over this
	 * key, default `false`. Surfaces on `GET /v1/meta` (`dev`); gates the
	 * U1 blocks gallery, U3's development error bodies, and U4.
	 */
	readonly dev?: boolean;
	/**
	 * The supervised flag (UI-blocks U4 Task 2, spec §13.3):
	 * `SIGRUN_SUPERVISED` (strict true/false, `1`/`0` accepted) over this
	 * key, default `false`. `true` promises a supervisor restarts the
	 * process after an intentional `exit 0` — the Helm chart and docker
	 * compose set the env (both restart the container); the Dockerfile
	 * deliberately does NOT. Gates `POST /v1/admin/restart`; `/v1/meta`
	 * reports it (`supervised`).
	 */
	readonly supervised?: boolean;
	/**
	 * The backup target — exactly one of the two shapes (mirroring the
	 * env rule: `SIGRUN_BACKUP_PATH` XOR `SIGRUN_BACKUP_S3_BUCKET`), plus
	 * the §6.8 honesty knob: `staleAfterHours`, how old the
	 * `backup/last-success.json` marker may be before `health.backup`
	 * reports `"degraded"` (positive number; no env var exists — file or
	 * the 36 h code default).
	 */
	readonly backup?:
		| { readonly path?: string; readonly staleAfterHours?: number }
		| {
				readonly s3?: {
					readonly bucket?: string;
					readonly prefix?: string;
					readonly endpoint?: string;
				};
				readonly staleAfterHours?: number;
			};
}

/**
 * Which tier supplied a resolved server key (the `/v1/settings`
 * `effective` block, spec §6.6): the env var was set (`"env"`), the
 * settings file's `server` section set it (`"file"`), or neither and
 * the code default applied (`"default"`).
 */
export type ServerSettingSource = "env" | "file" | "default";

/**
 * One `effective` entry: the RESOLVED value (what boot actually used)
 * plus the {@link ServerSettingSource} that won. Keys are flattened
 * dotted paths (`"server.port"`, `"server.compaction.reserveTokens"`).
 */
export interface EffectiveServerSetting {
	readonly value: unknown;
	readonly source: ServerSettingSource;
}

/**
 * The degenerate env-driven provider's static configuration (ruling 7).
 * Only the endpoint is here — credentials live in `auth.json`.
 */
export interface DefaultProviderSettings {
	/** `OPENAI_BASE_URL` — a non-empty URL. */
	readonly baseUrl?: string;
}

/**
 * The skills surface's settings (core hardening W5 Task 4, spec §9.4) —
 * live, read per skills-section render.
 */
export interface SkillsSettings {
	/** The rendered-section byte cap (default 4096, notice included). */
	readonly sectionMaxBytes?: number;
}

/**
 * The notifications surface's settings (core hardening W5 Task 6, spec
 * §9.6) — live, read per event.
 */
export interface NotificationsSettings {
	/**
	 * When a `run.settled` notification fires: `"unwatched"` (default)
	 * only when no client stream is attached to the conversation (the
	 * away-from-desk case), `"cron"` only for job-run conversations,
	 * `"always"` every settle, `"never"` none.
	 */
	readonly runSettled?: "unwatched" | "cron" | "always" | "never";
}

/**
 * The built-in extensions toggles (Task 2, pi parity): codemode, MCP and
 * tool search ship WITH core. Each key defaults to `true`; `false`
 * removes the built-in entirely (absent from `/v1/extensions`, its config
 * ignored with one log line). RESTART-REQUIRED: the built-in set resolves
 * at boot, like `extensions`.
 */
export interface BuiltinExtensionsSettings {
	readonly codemode?: boolean;
	readonly mcp?: boolean;
	readonly toolSearch?: boolean;
	/** Gateway (gateway C3): the built-in engine, default true. */
	readonly gateway?: boolean;
}

/**
 * The persisted shape: HarnessSettings pass-throughs + sigrun fields.
 */
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
	/**
	 * Sigrun: tool-name filter applied at conversation creation; maps to
	 * pi-durable 1.3.0's `AgentChange.modelTools` (the model-offered
	 * filter — never the enabled filter `AgentChange.tools`).
	 */
	readonly defaultTools?: readonly string[];
	/**
	 * Sigrun: per-model thinking-level overrides, keyed by
	 * `"provider/modelId"`.
	 */
	readonly perModelThinking?: Readonly<Record<string, string>>;
	/**
	 * Sigrun: the unified extension list — each entry is the DESIRED
	 * INSTALL+LOAD state (one list, no install/load split). Entry forms:
	 *
	 * - a string: an npm specifier ("name", "name@range",
	 *   "@scope/name@range"), a bare name (app-tree/vendor shorthand,
	 *   load-only), a `file:`/absolute path (loaded in place, nothing
	 *   installed), or a git source ("git:host/path" or an https git
	 *   URL, with an optional `@ref` suffix) — cloned into
	 *   `<config-dir>/git/` and loaded after entry discovery.
	 * - an object: `{ source, entry?, ref?, enabled? }` — the explicit
	 *   form. `entry` overrides entry discovery (path relative to the
	 *   resolved source root); `ref` is the git ref (same as the `@ref`
	 *   suffix, spelled out); `enabled: false` keeps the directory
	 *     state but does not load (the installed-but-disabled case).
	 *
	 * npm + git entries are installed/fetched at boot by `syncPackages`
	 * into the packages/git dirs under the config dir; REMOVING an entry
	 * uninstalls it. Applied when `SIGRUN_EXTENSIONS` is absent.
	 * Changes require a restart.
	 */
	readonly extensions?: readonly ExtensionSpec[];
	/**
	 * Sigrun: the file-declared job list (spec §8.3 — the `file` source).
	 * Each entry is a `JobSpec` validated with `validateJobSpec` (the
	 * jobs §8.2 grammar); names double as the id suffix (`file:<name>`).
	 * Duplicate names are a validation error. Restart-required: like
	 * `extensions`, the list resolves at boot reconciliation.
	 */
	readonly jobs?: readonly JobSpec[];
	/**
	 * Sigrun: per-job history retention (spec §8.1, ruling 14) — LIVE
	 * (read per prune, not restart-required): keep the newest `runs` run
	 * records and the newest `revisions` revisions per job, plus any
	 * revision a retained run references. Both positive integers,
	 * default 50 each.
	 */
	readonly jobHistory?: JobHistorySettings;
	/**
	 * Sigrun: the boot default model (ruling 3), a non-empty
	 * `provider/model-id` spec parsed exactly like `SIGRUN_DEFAULT_MODEL`
	 * (bare id implies the `openai` provider). Applied when the env var is
	 * absent; REQUIRED overall — neither env nor file is a fail-loud boot
	 * error, no code default.
	 */
	readonly defaultModel?: string;
	/**
	 * Sigrun: the model the auto-namer (UI refresh A2) completes through, a
	 * non-empty `provider/model-id` spec validated exactly like
	 * `defaultModel`, or `false` to disable automatic naming. Absent = the
	 * boot default model. Read live per settled run, so a PATCH reaches the
	 * next naming call without a restart.
	 */
	readonly namingModel?: string | false;
	/**
	 * Sigrun: the env-driven OpenAI-compatible provider's endpoint
	 * (ruling 7), applied when `OPENAI_BASE_URL` is absent.
	 */
	readonly defaultProvider?: DefaultProviderSettings;
	/**
	 * Sigrun: the skills surface's knob (core hardening W5 Task 4, spec
	 * §9.4). `sectionMaxBytes` caps the rendered skills section (default
	 * 4096, truncation notice included). LIVE — read per render, so a
	 * PATCH reaches the next prompt without a restart.
	 */
	readonly skills?: SkillsSettings;
	/**
	 * Sigrun: the notifications surface's knob (core hardening W5 Task 6,
	 * spec §9.6). `runSettled` gates when a settled run notifies (default
	 * `"unwatched"`). LIVE — read per event, so a PATCH reaches the next
	 * settle without a restart.
	 */
	readonly notifications?: NotificationsSettings;
	/**
	 * Sigrun: the built-in extensions toggles (Task 2). Each defaults to
	 * `true`. RESTART-REQUIRED (resolved at boot).
	 */
	readonly builtinExtensions?: BuiltinExtensionsSettings;
	/**
	 * Sigrun: the MCP-driven auto-enable (Task 2, ruling 4). Default
	 * `true`: when at least one enabled MCP server's effective exposure is
	 * `codemode`, the `codemode` tool stays in the default model-offered
	 * set for newly created conversations; when any is `deferred`,
	 * `tool_search` stays offered. `false` turns both arms off. An
	 * explicit `defaultTools` filter always wins (auto-enable only edits
	 * the DEFAULT set). LIVE — read at conversation create, like
	 * `defaultTools`.
	 */
	readonly autoEnableCodemode?: boolean;
	/**
	 * Sigrun: the static boot configuration (see {@link ServerSettings}).
	 * Deployment defaults under env — changes require a restart.
	 */
	readonly server?: ServerSettings;
}
