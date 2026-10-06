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
	port: number;
	/** Root of the static local workspace (spec §4.5 `defaultWorkspace`). */
	workspace: LocalWorkspace;
	backup?: BackupConfig;
}

/** The provider id used when `SIGRUN_MODEL` carries no `provider/` prefix. */
export const DEFAULT_PROVIDER = "openai";

export const DEFAULT_STORAGE_PATH = "data/sigrun.db";
export const DEFAULT_EXTENSIONS_DIR = "extensions";
export const DEFAULT_PORT = 3000;
/** Spec §4.5: core ships `{ defaultWorkspace: { type: "local", path: "/home/sigrun" } }`. */
export const DEFAULT_WORKSPACE_PATH = "/home/sigrun";

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
 * `SIGRUN_STORAGE_PATH`, `SIGRUN_EXTENSIONS_DIR`, `SIGRUN_PORT`,
 * `SIGRUN_WORKSPACE_PATH`.
 *
 * @throws Error naming `SIGRUN_MODEL` when it is missing or empty, and
 * naming `SIGRUN_PORT` when it is set but not a positive integer.
 */
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
		port,
		workspace: {
			type: "local",
			path: env.SIGRUN_WORKSPACE_PATH || DEFAULT_WORKSPACE_PATH,
		},
	};
}
