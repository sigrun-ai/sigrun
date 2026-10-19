/**
 * The settings bootstrap: `loadConfig(env, settingsFile)` precedence.
 *
 * The binding rulings (the publish/settings-bootstrap brief + the
 * 2026-10-13 config-surface rulings):
 * - env is parsed FIRST — an invalid env value fails loud even when the
 *   file carries a valid value for the same knob;
 * - env WINS: a file field applies only where the corresponding env
 *   variable is absent;
 * - the default model is REQUIRED from env (`SIGRUN_DEFAULT_MODEL`,
 *   deprecated alias `SIGRUN_MODEL`) OR the file's top-level
 *   `defaultModel` — no code default;
 * - extensions, the webui bundle selector, and the degenerate provider's
 *   baseUrl are file-configurable (top-level `extensions`, the
 *   `server.webui` section with its deprecated `server.webuiBundle`
 *   alias, `defaultProvider.baseUrl`) under env;
 * - `defaultWorkspacePath` puts the workspace default under the data
 *   root (spec §6.3: `<dataDir>/workspace`; chart/compose set the path
 *   explicitly);
 * - `envServerSection` projects ONLY env-set values into the file's
 *   `server` shape — what the first-boot bootstrap persists (ruling 5:
 *   defaults are never persisted, so later releases' default changes
 *   reach existing installs);
 * - `effectiveServerSection` classifies every resolved server key's
 *   source as env, file, or default (the `/v1/settings` `effective`
 *   block, spec §6.6).
 */

import { describe, expect, test, vi } from "vitest";
import { join } from "node:path";
import {
	DEFAULT_BACKUP_STALE_AFTER_HOURS,
	DEFAULT_COMPACTION,
	DEFAULT_MAX_UPLOAD_BYTES,
	DEFAULT_MEMORY_SEAM,
	DEFAULT_PORT,
	DEFAULT_PROVIDER_REFRESH_MINUTES,
	STORAGE_FILE_NAME,
	defaultWorkspacePath,
	effectiveServerSection,
	envServerSection,
	loadConfig,
	parseBackupConfig,
} from "../src/config.js";
import type { SettingsFile } from "../src/harness/settings.js";

const MODEL_ENV = { SIGRUN_DEFAULT_MODEL: "openai/gpt-4o" };

describe("loadConfig with a settings file (env over file over defaults)", () => {
	test("file server.port applies when SIGRUN_PORT is absent", () => {
		const file: SettingsFile = { server: { port: 4080 } };
		const config = loadConfig({ ...MODEL_ENV }, file);
		expect(config.port).toBe(4080);
	});

	test("env wins: SIGRUN_PORT 8080 over the file's 4080", () => {
		const file: SettingsFile = { server: { port: 4080 } };
		const config = loadConfig(
			{ ...MODEL_ENV, SIGRUN_PORT: "8080" },
			file,
		);
		expect(config.port).toBe(8080);
	});

	test("an invalid env value fails loud even with a valid file value", () => {
		const file: SettingsFile = { server: { port: 4080 } };
		expect(() =>
			loadConfig({ ...MODEL_ENV, SIGRUN_PORT: "abc" }, file),
		).toThrow(/SIGRUN_PORT/);
	});

	test("the default model is required from env or file (no code default)", () => {
		// Neither env nor file → fail loud, naming the env var.
		expect(() => loadConfig({}, { server: { port: 4080 } })).toThrow(
			/SIGRUN_DEFAULT_MODEL/,
		);
		expect(() => loadConfig({})).toThrow(/SIGRUN_DEFAULT_MODEL/);
		// The file's top-level defaultModel satisfies the requirement.
		const fromFile = loadConfig({}, { defaultModel: "acme/model-1" });
		expect(fromFile.models).toEqual({
			provider: "acme",
			modelId: "model-1",
		});
		// Env wins over the file.
		const fromEnv = loadConfig(
			{ SIGRUN_DEFAULT_MODEL: "openai/gpt-4o" },
			{ defaultModel: "acme/model-1" },
		);
		expect(fromEnv.models).toEqual({
			provider: "openai",
			modelId: "gpt-4o",
		});
		// A malformed file spec fails loud, naming the file key.
		expect(() =>
			loadConfig({}, { defaultModel: "acme/" }),
		).toThrow(/settings\.json defaultModel/);
	});

	test("deprecated alias SIGRUN_MODEL reads the model; SIGRUN_DEFAULT_MODEL wins over it", () => {
		const viaAlias = loadConfig({ SIGRUN_MODEL: "acme/model-1" });
		expect(viaAlias.models).toEqual({
			provider: "acme",
			modelId: "model-1",
		});
		const both = loadConfig({
			SIGRUN_MODEL: "acme/model-1",
			SIGRUN_DEFAULT_MODEL: "acme/model-2",
		});
		expect(both.models.modelId).toBe("model-2");
	});

	test("paths: file applies where env is absent; env wins per field", () => {
		const file: SettingsFile = {
			server: {
				workspacePath: "/srv/workspace",
				storagePath: "/srv/sigrun.db",
			},
		};
		const fromFile = loadConfig({ ...MODEL_ENV }, file);
		expect(fromFile.workspace).toEqual({
			type: "local",
			path: "/srv/workspace",
		});
		expect(fromFile.storagePath).toBe("/srv/sigrun.db");

		const mixed = loadConfig(
			{ ...MODEL_ENV, SIGRUN_STORAGE_PATH: "/env/db.sqlite" },
			file,
		);
		expect(mixed.storagePath).toBe("/env/db.sqlite");
		// The unset-in-env fields still come from the file.
		expect(mixed.workspace.path).toBe("/srv/workspace");

		// No file: the code defaults (the pre-file behavior, unchanged) —
		// except storagePath, whose default moved under the data root
		// (Task 6's clean break; see test/config-store-dirs.test.ts).
		const bare = loadConfig({ ...MODEL_ENV });
		expect(bare.port).toBe(DEFAULT_PORT);
		expect(bare.storagePath).toBe(join(bare.dataDir, STORAGE_FILE_NAME));
		expect(bare.workspace.path).toBe(defaultWorkspacePath(bare.dataDir));
	});

	test("compaction: env per-knob over file per-knob over defaults", () => {
		const file: SettingsFile = {
			server: {
				compaction: { reserveTokens: 4096, backgroundTokens: 0 },
			},
		};
		const fromFile = loadConfig({ ...MODEL_ENV }, file);
		expect(fromFile.compaction).toEqual({
			...DEFAULT_COMPACTION,
			reserveTokens: 4096,
			backgroundTokens: 0,
		});
		// Env wins the knob it sets; the file's other knobs still apply.
		const mixed = loadConfig(
			{ ...MODEL_ENV, SIGRUN_COMPACTION_RESERVE_TOKENS: "8192" },
			file,
		);
		expect(mixed.compaction.reserveTokens).toBe(8192);
		expect(mixed.compaction.backgroundTokens).toBe(0);
	});

	test("memory-seam knobs default when env + file are silent", () => {
		const config = loadConfig({ ...MODEL_ENV });
		expect(config.memorySeam).toEqual(DEFAULT_MEMORY_SEAM);
		expect(config.memorySeam).toEqual({
			hookDeadlineMs: 30000,
			idleThresholdMs: 600000,
			workerDeadlineMs: 600000,
			queueMax: 1000,
		});
	});

	test("memory-seam knobs parse from env", () => {
		const config = loadConfig({
			...MODEL_ENV,
			SIGRUN_HOOK_DEADLINE: "5000",
			SIGRUN_IDLE_THRESHOLD: "120000",
			SIGRUN_WORKER_DEADLINE: "300000",
			SIGRUN_QUEUE_MAX: "50",
		});
		expect(config.memorySeam).toEqual({
			hookDeadlineMs: 5000,
			idleThresholdMs: 120000,
			workerDeadlineMs: 300000,
			queueMax: 50,
		});
	});

	test("memory-seam knobs accept settings-file overrides (file over default; env over file)", () => {
		const file: SettingsFile = {
			server: { memorySeam: { idleThresholdMs: 120000, queueMax: 50 } },
		};
		// File applies where env is absent; unset knobs keep their defaults.
		const fromFile = loadConfig({ ...MODEL_ENV }, file);
		expect(fromFile.memorySeam.idleThresholdMs).toBe(120000);
		expect(fromFile.memorySeam.queueMax).toBe(50);
		expect(fromFile.memorySeam.hookDeadlineMs).toBe(30000);
		expect(fromFile.memorySeam.workerDeadlineMs).toBe(600000);
		// Env wins the knob it sets; the file's other knob still applies.
		const mixed = loadConfig(
			{ ...MODEL_ENV, SIGRUN_IDLE_THRESHOLD: "60000" },
			file,
		);
		expect(mixed.memorySeam.idleThresholdMs).toBe(60000);
		expect(mixed.memorySeam.queueMax).toBe(50);
	});

	test("invalid memory-seam knob values fail loud naming the variable", () => {
		for (const key of [
			"SIGRUN_HOOK_DEADLINE",
			"SIGRUN_IDLE_THRESHOLD",
			"SIGRUN_WORKER_DEADLINE",
			"SIGRUN_QUEUE_MAX",
		] as const) {
			for (const value of ["abc", "0", "-5"]) {
				// The compaction-knob convention: the error names the variable
				// and states the constraint (positive integer), with the raw value.
				expect(() => loadConfig({ ...MODEL_ENV, [key]: value })).toThrow(
					new RegExp(`^${key} must be a positive integer, got ${value}$`),
				);
			}
		}
	});

	test("backup: file target applies only when env configures none", () => {
		const file: SettingsFile = {
			server: {
				backup: { s3: { bucket: "b", prefix: "p/", endpoint: "https://s3.example.invalid" } },
			},
		};
		const fromFile = loadConfig({ ...MODEL_ENV }, file);
		expect(fromFile.backup).toEqual({
			target: "s3",
			bucket: "b",
			prefix: "p/",
			endpoint: "https://s3.example.invalid",
		});
		// Env's target wins wholesale (no per-field mixing across sources).
		const mixed = loadConfig(
			{ ...MODEL_ENV, SIGRUN_BACKUP_PATH: "/env/backups" },
			file,
		);
		expect(mixed.backup).toEqual({
			target: "path",
			path: "/env/backups",
		});
		// The env ambiguity error still fires with a file target present.
		expect(() =>
			loadConfig(
				{
					...MODEL_ENV,
					SIGRUN_BACKUP_PATH: "/env/backups",
					SIGRUN_BACKUP_S3_BUCKET: "env-bucket",
				},
				file,
			),
		).toThrow(/exactly one backup target/);
	});

	test("SIGRUN_BACKUP_S3_ENDPOINT maps into the s3 config", () => {
		const backup = parseBackupConfig({
			SIGRUN_BACKUP_S3_BUCKET: "b",
			SIGRUN_BACKUP_S3_ENDPOINT: "https://s3.example.invalid",
		});
		expect(backup).toEqual({
			target: "s3",
			bucket: "b",
			endpoint: "https://s3.example.invalid",
		});
	});

	test("backup: staleAfterHours resolves from the file over the 36 h default (no env var exists)", () => {
		expect(loadConfig({ ...MODEL_ENV }).backupStaleAfterHours).toBe(
			DEFAULT_BACKUP_STALE_AFTER_HOURS,
		);
		expect(DEFAULT_BACKUP_STALE_AFTER_HOURS).toBe(36);
		// The file tier sets it — riding EITHER target shape, and with no
		// target at all (the knob resolves regardless; health consults it
		// only when a target is configured).
		expect(
			loadConfig(
				{ ...MODEL_ENV },
				{ server: { backup: { path: "/x", staleAfterHours: 48 } } },
			).backupStaleAfterHours,
		).toBe(48);
		expect(
			loadConfig(
				{ ...MODEL_ENV },
				{ server: { backup: { s3: { bucket: "b" }, staleAfterHours: 12 } } },
			).backupStaleAfterHours,
		).toBe(12);
		expect(
			loadConfig(
				{ ...MODEL_ENV },
				{ server: { backup: { staleAfterHours: 6 } } },
			).backupStaleAfterHours,
		).toBe(6);
	});

	test("extensions: env CSV wins over the file's top-level array", () => {
		// File applies where env is absent.
		const fromFile = loadConfig(
			{ ...MODEL_ENV },
			{ extensions: ["@acme/ext-a", "@acme/ext-b"] },
		);
		expect(fromFile.extensions).toEqual(["@acme/ext-a", "@acme/ext-b"]);
		// Env wins over the file.
		const mixed = loadConfig(
			{ ...MODEL_ENV, SIGRUN_EXTENSIONS: "@acme/env-ext" },
			{ extensions: ["@acme/ext-a"] },
		);
		expect(mixed.extensions).toEqual(["@acme/env-ext"]);
		// A set-but-empty env still wins (empty list, not the file's list).
		const emptied = loadConfig(
			{ ...MODEL_ENV, SIGRUN_EXTENSIONS: "" },
			{ extensions: ["@acme/ext-a"] },
		);
		expect(emptied.extensions).toEqual([]);
		// Neither: empty.
		expect(loadConfig({ ...MODEL_ENV }).extensions).toEqual([]);
	});

	test("webui selector: env over file (legacy) over unset", () => {
		// File applies where env is absent — and counts as an explicit
		// selection at serve time (a missing bundle is a boot error, not
		// API-only).
		const fromFile = loadConfig(
			{ ...MODEL_ENV },
			{ server: { webuiBundle: "ui/dist" } },
		);
		expect(fromFile.webui.bundle).toBe("ui/dist");
		// Env wins.
		const mixed = loadConfig(
			{ ...MODEL_ENV, SIGRUN_WEBUI_BUNDLE: "env/ui" },
			{ server: { webuiBundle: "ui/dist" } },
		);
		expect(mixed.webui.bundle).toBe("env/ui");
		// A set-but-EMPTY env value counts as UNSET (the `?.trim() ||
		// undefined` normalization) — it falls through to the file slot,
		// never selecting "" as a literal (empty-string) bundle name.
		const emptyEnvFallsThrough = loadConfig(
			{ ...MODEL_ENV, SIGRUN_WEBUI_BUNDLE: "" },
			{ server: { webuiBundle: "ui/dist" } },
		);
		expect(emptyEnvFallsThrough.webui.bundle).toBe("ui/dist");
		const emptyEnvAlone = loadConfig({
			...MODEL_ENV,
			SIGRUN_WEBUI_BUNDLE: "",
		});
		expect(emptyEnvAlone.webui.bundle).toBeUndefined();
		// Neither: no selector at all (the built-in default bundle — serve
		// time reads absence, never a mirrored default value).
		const bare = loadConfig({ ...MODEL_ENV });
		expect(bare.webui.bundle).toBeUndefined();
		expect(bare.webui.enabled).toBe(true);
	});

	test("defaultProvider.baseUrl: env over file over undefined", () => {
		// File applies where env is absent.
		const fromFile = loadConfig(
			{ ...MODEL_ENV },
			{ defaultProvider: { baseUrl: "https://file.example/v1" } },
		);
		expect(fromFile.defaultProviderBaseUrl).toBe("https://file.example/v1");
		// Env wins over the file.
		const mixed = loadConfig(
			{ ...MODEL_ENV, OPENAI_BASE_URL: "https://env.example/v1" },
			{ defaultProvider: { baseUrl: "https://file.example/v1" } },
		);
		expect(mixed.defaultProviderBaseUrl).toBe("https://env.example/v1");
		// Neither: undefined (the provider layer applies the OpenAI default).
		expect(loadConfig({ ...MODEL_ENV }).defaultProviderBaseUrl).toBeUndefined();
	});

	test("env-only knobs have no file fallback", () => {
		const file: SettingsFile = { server: { port: 4080 } };
		const config = loadConfig({ ...MODEL_ENV }, file);
		// The file's server section carries no model/extensions keys at all
		// (the model and the extension list are TOP-LEVEL file keys; the
		// server section never carries them — validation rejects them).
		expect(config.extensions).toEqual([]);
		expect(config.webui.bundle).toBeUndefined();
		expect(config.models).toEqual({
			provider: "openai",
			modelId: "gpt-4o",
		});
	});
});

	describe("defaultWorkspacePath (spec §6.3: the workspace default rides the data root)", () => {
	test("SIGRUN_DATA_DIR anchors the workspace at <dataDir>/workspace", () => {
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "acme/m",
			SIGRUN_DATA_DIR: "/srv/data",
		});
		expect(config.workspace.path).toBe(join("/srv/data", "workspace"));
	});

	test("the bare default (no env, no file) is the data root's workspace", () => {
		const config = loadConfig({ ...MODEL_ENV });
		expect(config.workspace.path).toBe(join(config.dataDir, "workspace"));
	});

	test("SIGRUN_WORKSPACE_PATH still wins env-first", () => {
		const config = loadConfig(
			{ ...MODEL_ENV, SIGRUN_WORKSPACE_PATH: "/explicit/ws" },
			{ server: { workspacePath: "/file/ws" } },
		);
		expect(config.workspace.path).toBe("/explicit/ws");
	});
});

describe("envServerSection (the env-only bootstrap projection, ruling 5)", () => {
	test("empty env projects {} — no default is ever persisted", () => {
		expect(envServerSection({})).toEqual({});
	});

	test("SIGRUN_PORT alone → {port}", () => {
		expect(envServerSection({ SIGRUN_PORT: "4000" })).toEqual({ port: 4000 });
	});

	test("one compaction knob → a one-key sub-object, not the full section", () => {
		expect(
			envServerSection({ SIGRUN_COMPACTION_RESERVE_TOKENS: "9000" }),
		).toEqual({ compaction: { reserveTokens: 9000 } });
	});

	test("every table row maps, with its typed parser (values verbatim)", () => {
		const section = envServerSection({
			SIGRUN_PORT: "4000",
			SIGRUN_WORKSPACE_PATH: "/w",
			SIGRUN_STORAGE_PATH: "/s/sigrun.db",
			SIGRUN_DATA_DIR: "/d",
			SIGRUN_CACHE_DIR: "/c",
			SIGRUN_STATE_DIR: "/st",
			SIGRUN_WEBUI: "false",
			SIGRUN_WEBUI_BUNDLE: "/opt/ui",
			SIGRUN_COMPACTION_ENABLED: "false",
			SIGRUN_COMPACTION_RESERVE_TOKENS: "9000",
			SIGRUN_COMPACTION_KEEP_RECENT_TOKENS: "8000",
			SIGRUN_COMPACTION_BACKGROUND_TOKENS: "0",
			SIGRUN_HOOK_DEADLINE: "1000",
			SIGRUN_IDLE_THRESHOLD: "2000",
			SIGRUN_WORKER_DEADLINE: "3000",
			SIGRUN_QUEUE_MAX: "10",
			SIGRUN_PROVIDER_REFRESH_MINUTES: "0",
			SIGRUN_BACKUP_S3_BUCKET: "b",
			SIGRUN_BACKUP_S3_PREFIX: "p",
			SIGRUN_BACKUP_S3_ENDPOINT: "http://e",
			SIGRUN_MAX_UPLOAD_BYTES: "1024",
		});
		expect(section).toEqual({
			port: 4000,
			workspacePath: "/w",
			storagePath: "/s/sigrun.db",
			dataDir: "/d",
			cacheDir: "/c",
			stateDir: "/st",
			maxUploadBytes: 1024,
			webui: { enabled: false, bundle: "/opt/ui" },
			compaction: {
				enabled: false,
				reserveTokens: 9000,
				keepRecentTokens: 8000,
				backgroundTokens: 0,
			},
			memorySeam: {
				hookDeadlineMs: 1000,
				idleThresholdMs: 2000,
				workerDeadlineMs: 3000,
				queueMax: 10,
			},
			providers: { refreshIntervalMinutes: 0 },
			backup: { s3: { bucket: "b", prefix: "p", endpoint: "http://e" } },
		});
	});

	test("SIGRUN_BACKUP_PATH maps to the path target (the two-shape union)", () => {
		expect(envServerSection({ SIGRUN_BACKUP_PATH: "/backups" })).toEqual({
			backup: { path: "/backups" },
		});
	});

	test("SIGRUN_EXTENSIONS_DIR is not a table row — never projected", () => {
		expect(envServerSection({ SIGRUN_EXTENSIONS_DIR: "/x" })).toEqual({});
	});

	test("SIGRUN_EXTENSIONS_DIR warns and is absent from the config (deprecated)", () => {
		// §6.7: the knob is dead — parsed by nothing. It warns once and the
		// config carries no `extensionsDir` field at all.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const config = loadConfig({
				...MODEL_ENV,
				SIGRUN_EXTENSIONS_DIR: "/opt/sigrun/extensions",
			});
			expect(
				warn.mock.calls.some((call) =>
					String(call[0]).includes(
						"SIGRUN_EXTENSIONS_DIR is deprecated and ignored",
					),
				),
			).toBe(true);
			expect("extensionsDir" in config).toBe(false);
		} finally {
			warn.mockRestore();
		}
	});

	test("empty-string values count as unset (the loadConfig reading)", () => {
		expect(
			envServerSection({
				SIGRUN_PORT: "",
				SIGRUN_WEBUI: "",
				SIGRUN_WEBUI_BUNDLE: "",
				SIGRUN_STORAGE_PATH: "",
			}),
		).toEqual({});
	});

	test("SIGRUN_METRICS_PUBLIC parses strictly (W2 Task 8; default false, empty unset)", () => {
		// The metrics-scrape gate: strict true/false (the SIGRUN_WEBUI
		// pattern), env-only on this branch (W1 Task 1 owns the file tier),
		// default false, empty counts as unset.
		expect(loadConfig({ ...MODEL_ENV }).metricsPublic).toBe(false);
		expect(
			loadConfig({ ...MODEL_ENV, SIGRUN_METRICS_PUBLIC: "true" }).metricsPublic,
		).toBe(true);
		expect(
			loadConfig({ ...MODEL_ENV, SIGRUN_METRICS_PUBLIC: "false" }).metricsPublic,
		).toBe(false);
		// Case-insensitive + whitespace-tolerant, like SIGRUN_WEBUI.
		expect(
			loadConfig({ ...MODEL_ENV, SIGRUN_METRICS_PUBLIC: " TRUE " }).metricsPublic,
		).toBe(true);
		expect(
			loadConfig({ ...MODEL_ENV, SIGRUN_METRICS_PUBLIC: "" }).metricsPublic,
		).toBe(false);
		expect(() =>
			loadConfig({ ...MODEL_ENV, SIGRUN_METRICS_PUBLIC: "yes" }),
		).toThrow(/SIGRUN_METRICS_PUBLIC must be "true" or "false"/);
		// Env-only by design: no value is ever projected into the bootstrap's
		// server section (validateServer does not accept server.metrics yet —
		// W1 Task 1 adds that file tier).
		expect(envServerSection({ SIGRUN_METRICS_PUBLIC: "true" })).toEqual({});
	});

	test("invalid values fail loud naming the variable (the same parsers as loadConfig)", () => {
		expect(() => envServerSection({ SIGRUN_PORT: "abc" })).toThrow(
			/SIGRUN_PORT must be a positive integer/,
		);
		expect(() => envServerSection({ SIGRUN_WEBUI: "yes" })).toThrow(
			/SIGRUN_WEBUI must be "true" or "false"/,
		);
		expect(() =>
				envServerSection({ SIGRUN_COMPACTION_RESERVE_TOKENS: "0" }),
		).toThrow(/SIGRUN_COMPACTION_RESERVE_TOKENS must be a positive integer/);
		expect(() => envServerSection({ SIGRUN_QUEUE_MAX: "0" })).toThrow(
			/SIGRUN_QUEUE_MAX must be a positive integer/,
		);
		expect(() => envServerSection({ SIGRUN_MAX_UPLOAD_BYTES: "0" })).toThrow(
			/SIGRUN_MAX_UPLOAD_BYTES must be a positive integer/,
		);
		expect(() =>
			envServerSection({ SIGRUN_PROVIDER_REFRESH_MINUTES: "-1" }),
		).toThrow(/SIGRUN_PROVIDER_REFRESH_MINUTES must be a non-negative integer/);
	});

	test("booting twice with the same env yields equal loadConfig results", () => {
		const env = {
			...MODEL_ENV,
			SIGRUN_PORT: "4080",
			SIGRUN_BACKUP_S3_BUCKET: "b",
		};
		const first = loadConfig(env);
		// What a first boot persists (serve.ts): the env-set server keys
		// plus defaultModel — nothing else.
		const bootstrapped: SettingsFile = {
			defaultModel: "openai/gpt-4o",
			server: envServerSection(env),
		};
		// Second boot: env over the bootstrapped file resolves the same.
		const second = loadConfig(env, bootstrapped);
		expect(second).toEqual(first);
		// And the bootstrapped file alone (env dropped) carries the env-set
		// values forward — the persisted intent survives a reboot without env.
		const fromFile = loadConfig({ ...MODEL_ENV }, bootstrapped);
		expect(fromFile.port).toBe(4080);
		expect(fromFile.backup).toEqual({ target: "s3", bucket: "b" });
	});
});

describe("effectiveServerSection (the /v1/settings effective block, spec §6.6)", () => {
	test("classifies env, file, and default per flattened dotted key", () => {
		const env = { ...MODEL_ENV, SIGRUN_PORT: "4080" };
		const file: SettingsFile = {
			server: { compaction: { reserveTokens: 4096 } },
		};
		const config = loadConfig(env, file);
		const effective = effectiveServerSection(env, file.server, config);
		expect(effective["server.port"]).toEqual({ value: 4080, source: "env" });
		expect(effective["server.compaction.reserveTokens"]).toEqual({
			value: 4096,
			source: "file",
		});
		expect(effective["server.compaction.keepRecentTokens"]).toEqual({
			value: DEFAULT_COMPACTION.keepRecentTokens,
			source: "default",
		});
		expect(effective["server.webui.enabled"]).toEqual({
			value: true,
			source: "default",
		});
		expect(effective["server.maxUploadBytes"]).toEqual({
			value: DEFAULT_MAX_UPLOAD_BYTES,
			source: "default",
		});
		expect(effective["server.providers.refreshIntervalMinutes"]).toEqual({
			value: DEFAULT_PROVIDER_REFRESH_MINUTES,
			source: "default",
		});
		// Unset backup: no leaf keys at all.
		expect(
			Object.keys(effective).filter((key) => key.startsWith("server.backup")),
		).toEqual([]);
	});

	test("env wins over file for the same key", () => {
		const env = { ...MODEL_ENV, SIGRUN_PORT: "4080" };
		const file: SettingsFile = { server: { port: 9999 } };
		const config = loadConfig(env, file);
		const effective = effectiveServerSection(env, file.server, config);
		expect(effective["server.port"]).toEqual({ value: 4080, source: "env" });
	});

	test("the legacy webuiBundle file key counts as the file source for webui.bundle", () => {
		const file: SettingsFile = { server: { webuiBundle: "/ui" } };
		const config = loadConfig({ ...MODEL_ENV }, file);
		const effective = effectiveServerSection({}, file.server, config);
		expect(effective["server.webui.bundle"]).toEqual({
			value: "/ui",
			source: "file",
		});
	});

	test("a configured backup flattens to its target leaves", () => {
		const env = { ...MODEL_ENV, SIGRUN_BACKUP_S3_BUCKET: "b" };
		const config = loadConfig(env);
		const effective = effectiveServerSection(env, undefined, config);
		expect(effective["server.backup.s3.bucket"]).toEqual({
			value: "b",
			source: "env",
		});
	});
});
