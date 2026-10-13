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
 *   time (the server reads it from the store, resolves the names against
 *   the registry, and passes them as `AgentChange.modelTools` objects —
 *   the MODEL-OFFERED filter, pi-durable 1.2.0; NOT the enabled filter,
 *   so filtered-out tools stay callable by nested calls).
 * - `perModelThinking` — per-model thinking-level overrides (`"provider/
 *   modelId": level`), applied by the server at conversation create and
 *   configure.
 *
 * `compaction` is deliberately NOT here: it already flows from
 * `SIGRUN_COMPACTION_*` env through `openHarness`.
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
}

/** Every settable key (PATCH validation + GET projection). */
const SETTING_KEYS = [
	"steeringMode",
	"followUpMode",
	"retry",
	"stream",
	"defaultTools",
	"perModelThinking",
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
}

function isNonNegativeInt(value: unknown): boolean {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0
	);
}

/** Deep copy through JSON (the file is JSON-shaped data only). */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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