import type { CompactionPolicy } from "@earendil-works/pi-durable";

/**
 * Sigrun configuration.
 *
 * Sigrun is configured entirely through environment variables. The three
 * variables of the spec's design test are `OPENAI_BASE_URL`,
 * `OPENAI_API_KEY`, and `SIGRUN_MODEL` — but only `SIGRUN_MODEL` is read
 * here: the OpenAI-compat credentials are consumed by the env-driven
 * degenerate provider (Task 2), which may be replaced entirely by an
 * extension-contributed provider that needs no OpenAI credentials at all.
 */

/** The default model, parsed from `SIGRUN_MODEL`. */
export interface SigrunModels {
	provider: string;
	modelId: string;
}

/**
 * Optional backup target (spec §4.3). Parsing is wired when the backup
 * capability lands; the type is fixed here so `SigrunConfig` is stable.
 */
export type BackupConfig =
	| { target: "s3"; bucket: string; prefix?: string }
	| { target: "path"; path: string };

/**
 * The static workspace every conversation resolves to (spec §4.5): a local
 * directory reached through the conversation's `ExecutionEnv`.
 */
export interface LocalWorkspace {
	readonly type: "local";
	readonly path: string;
}

export interface SigrunConfig {
	storagePath: string;
	models: SigrunModels;
	extensionsDir: string;
	/** Deploy-time extension package list (spec §4.1), parsed from `SIGRUN_EXTENSIONS`. */
	extensions: readonly string[];
	port: number;
	/** Root of the static local workspace (spec §4.5 `defaultWorkspace`). */
	workspace: LocalWorkspace;
	backup?: BackupConfig;
	/**
	 * Context-management policy (spec §3.1), parsed from `SIGRUN_COMPACTION_*`
	 * and passed through `openHarness` into pi-durable's
	 * `HarnessSettings.compaction`. Defaults equal upstream's
	 * `DEFAULT_COMPACTION_POLICY`; `backgroundTokens > 0` keeps background
	 * compaction on (spec §3.1 "Background compaction on" — upstream starts
	 * one `backgroundTokens` below the blocking threshold; `0` disables it).
	 */
	compaction: CompactionPolicy;
}

/** The provider id used when `SIGRUN_MODEL` carries no `provider/` prefix. */
export const DEFAULT_PROVIDER = "openai";

export const DEFAULT_STORAGE_PATH = "data/sigrun.db";
export const DEFAULT_EXTENSIONS_DIR = "extensions";
export const DEFAULT_PORT = 3000;
/** Spec §4.5: core ships `{ defaultWorkspace: { type: "local", path: "/home/sigrun" } }`. */
export const DEFAULT_WORKSPACE_PATH = "/home/sigrun";

/**
 * Sigrun's compaction defaults, deliberately equal to pi-durable's
 * `DEFAULT_COMPACTION_POLICY`. Restated here rather than imported so the
 * equality is a checked decision (`test/compaction.test.ts` fails loudly if
 * upstream retunes and sigrun silently follows).
 */
export const DEFAULT_COMPACTION: CompactionPolicy = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	backgroundTokens: 32768,
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
 * @throws Error naming `SIGRUN_MODEL` when the spec is empty or has an
 * empty provider or model id.
 */
export function parseModelSpec(spec: string): SigrunModels {
	const trimmed = spec.trim();
	if (!trimmed) {
		throw new Error(
			"SIGRUN_MODEL must be a non-empty model spec, e.g. openai/gpt-4o",
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
			`SIGRUN_MODEL must have a non-empty provider and model id, got ${JSON.stringify(trimmed)}`,
		);
	}
	return { provider, modelId };
}

/**
 * Parse sigrun configuration from an environment (usually `process.env`).
 *
 * `SIGRUN_MODEL` is required and selects the default model (see
 * `parseModelSpec` for the format). Optional overrides:
 * `SIGRUN_STORAGE_PATH`, `SIGRUN_EXTENSIONS_DIR`, `SIGRUN_EXTENSIONS`,
 * `SIGRUN_PORT`, `SIGRUN_WORKSPACE_PATH`, and the `SIGRUN_COMPACTION_*`
 * knobs of the context-management policy.
 *
 * @throws Error naming `SIGRUN_MODEL` when it is missing or empty, naming
 * `SIGRUN_PORT` when it is set but not a positive integer, and naming the
 * offending `SIGRUN_COMPACTION_*` variable when set to an invalid value.
 */
export function parseExtensionList(raw: string | undefined): string[] {
	if (raw === undefined || raw.trim() === "") return [];
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
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

function parseCompaction(env: Env): CompactionPolicy {
	return {
		enabled: parseCompactionEnabled(env) ?? DEFAULT_COMPACTION.enabled,
		reserveTokens:
			parseTokenCount(env, "SIGRUN_COMPACTION_RESERVE_TOKENS", 1) ??
			DEFAULT_COMPACTION.reserveTokens,
		keepRecentTokens:
			parseTokenCount(env, "SIGRUN_COMPACTION_KEEP_RECENT_TOKENS", 1) ??
			DEFAULT_COMPACTION.keepRecentTokens,
		backgroundTokens:
			parseTokenCount(env, "SIGRUN_COMPACTION_BACKGROUND_TOKENS", 0) ??
			DEFAULT_COMPACTION.backgroundTokens,
	};
}

export function loadConfig(env: Env): SigrunConfig {
	const modelSpec = env.SIGRUN_MODEL?.trim();
	if (!modelSpec) {
		throw new Error(
			"SIGRUN_MODEL is required (format: provider/model-id, e.g. openai/gpt-4o)",
		);
	}

	const models = parseModelSpec(modelSpec);

	let port = DEFAULT_PORT;
	if (env.SIGRUN_PORT !== undefined && env.SIGRUN_PORT !== "") {
		const parsed = Number(env.SIGRUN_PORT);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			throw new Error(`SIGRUN_PORT must be a positive integer, got ${env.SIGRUN_PORT}`);
		}
		port = parsed;
	}

	return {
		storagePath: env.SIGRUN_STORAGE_PATH || DEFAULT_STORAGE_PATH,
		models,
		extensionsDir: env.SIGRUN_EXTENSIONS_DIR || DEFAULT_EXTENSIONS_DIR,
		extensions: parseExtensionList(env.SIGRUN_EXTENSIONS),
		port,
		workspace: {
			type: "local",
			path: env.SIGRUN_WORKSPACE_PATH || DEFAULT_WORKSPACE_PATH,
		},
		compaction: parseCompaction(env),
	};
}
