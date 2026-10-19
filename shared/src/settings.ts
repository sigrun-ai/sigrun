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
 * (`defaultTools`, `perModelThinking`, `extensions`, `defaultModel`,
 * `namingModel`, `defaultProvider`, `server`). Credentials never live
 * here (they live in the sibling `auth.json`).
 */

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
	/**
	 * Sigrun: tool-name filter applied at conversation creation; maps to
	 * pi-durable 1.2.0's `AgentChange.modelTools` (the model-offered
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
	 * Sigrun: the static boot configuration (see {@link ServerSettings}).
	 * Deployment defaults under env — changes require a restart.
	 */
	readonly server?: ServerSettings;
}
