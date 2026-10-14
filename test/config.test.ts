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
 * - extensions, webuiBundle, and the degenerate provider's baseUrl are
 *   file-configurable (top-level `extensions`, `server.webuiBundle`,
 *   `defaultProvider.baseUrl`) under env;
 * - `resolvedServerSection` projects a resolved config (defaults
 *   included) into the file's `server` shape — what the first-boot
 *   bootstrap persists.
 */

import { describe, expect, test } from "vitest";
import {
	DEFAULT_COMPACTION,
	DEFAULT_EXTENSIONS_DIR,
	DEFAULT_PORT,
	DEFAULT_STORAGE_PATH,
	DEFAULT_WORKSPACE_PATH,
	loadConfig,
	parseBackupConfig,
	resolvedServerSection,
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
				extensionsDir: "/srv/extensions",
			},
		};
		const fromFile = loadConfig({ ...MODEL_ENV }, file);
		expect(fromFile.workspace).toEqual({
			type: "local",
			path: "/srv/workspace",
		});
		expect(fromFile.storagePath).toBe("/srv/sigrun.db");
		expect(fromFile.extensionsDir).toBe("/srv/extensions");

		const mixed = loadConfig(
			{ ...MODEL_ENV, SIGRUN_STORAGE_PATH: "/env/db.sqlite" },
			file,
		);
		expect(mixed.storagePath).toBe("/env/db.sqlite");
		// The unset-in-env fields still come from the file.
		expect(mixed.workspace.path).toBe("/srv/workspace");
		expect(mixed.extensionsDir).toBe("/srv/extensions");

		// No file: the code defaults (the pre-file behavior, unchanged).
		const bare = loadConfig({ ...MODEL_ENV });
		expect(bare.port).toBe(DEFAULT_PORT);
		expect(bare.storagePath).toBe(DEFAULT_STORAGE_PATH);
		expect(bare.workspace.path).toBe(DEFAULT_WORKSPACE_PATH);
		expect(bare.extensionsDir).toBe(DEFAULT_EXTENSIONS_DIR);
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

	test("webuiBundle: env over file over default; file value is explicit", () => {
		// File applies where env is absent — and counts as EXPLICIT (a
		// missing bundle is a boot error, not API-only).
		const fromFile = loadConfig(
			{ ...MODEL_ENV },
			{ server: { webuiBundle: "ui/dist" } },
		);
		expect(fromFile.webuiBundle).toBe("ui/dist");
		expect(fromFile.webuiBundleExplicit).toBe(true);
		// Env wins and is also explicit.
		const mixed = loadConfig(
			{ ...MODEL_ENV, SIGRUN_WEBUI_BUNDLE: "env/ui" },
			{ server: { webuiBundle: "ui/dist" } },
		);
		expect(mixed.webuiBundle).toBe("env/ui");
		expect(mixed.webuiBundleExplicit).toBe(true);
		// Neither: the code default, implicit (default-missing = API-only).
		const bare = loadConfig({ ...MODEL_ENV });
		expect(bare.webuiBundle).toBe("webui/dist");
		expect(bare.webuiBundleExplicit).toBe(false);
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
		expect(config.webuiBundle).toBe("webui/dist");
		expect(config.webuiBundleExplicit).toBe(false);
		expect(config.models).toEqual({
			provider: "openai",
			modelId: "gpt-4o",
		});
	});
});

describe("resolvedServerSection (the bootstrap projection)", () => {
	test("includes the defaults (the file records the full effective section)", () => {
		const section = resolvedServerSection(loadConfig({ ...MODEL_ENV }));
		expect(section).toEqual({
			port: DEFAULT_PORT,
			workspacePath: DEFAULT_WORKSPACE_PATH,
			storagePath: DEFAULT_STORAGE_PATH,
			extensionsDir: DEFAULT_EXTENSIONS_DIR,
			webuiBundle: "webui/dist",
			compaction: { ...DEFAULT_COMPACTION },
		});
	});

	test("round-trips through loadConfig: bootstrap values re-resolve identically", () => {
		const env = {
			...MODEL_ENV,
			SIGRUN_PORT: "4080",
			SIGRUN_BACKUP_S3_BUCKET: "b",
		};
		const first = loadConfig(env);
		const section = resolvedServerSection(first);
		// Second boot: env over the bootstrapped file resolves the same,
		// EXCEPT webuiBundleExplicit — the bootstrap records the resolved
		// (default) webuiBundle in the file, and a file value counts as
		// explicit by design (ruling 4: the file records reality; recording
		// the default path makes the API-only fallback unreachable while
		// the file carries it — the documented bootstrap behavior).
		const second = loadConfig(env, { server: section });
		expect(second).toEqual({ ...first, webuiBundleExplicit: true });
		// Env dropped: the bootstrapped file alone reproduces the section.
		const fromFile = loadConfig({ ...MODEL_ENV }, { server: section });
		expect(fromFile.port).toBe(4080);
		expect(fromFile.backup).toEqual({ target: "s3", bucket: "b" });
	});
});
