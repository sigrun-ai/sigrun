/**
 * The settings bootstrap: `loadConfig(env, settingsFile)` precedence.
 *
 * The binding rulings (the publish/settings-bootstrap brief):
 * - env is parsed FIRST — an invalid env value fails loud even when the
 *   file carries a valid value for the same knob;
 * - env WINS: a `server.*` file field applies only where the
 *   corresponding `SIGRUN_*` variable is absent;
 * - `SIGRUN_MODEL`/`SIGRUN_EXTENSIONS`/`SIGRUN_WEBUI_BUNDLE`/
 *   `SIGRUN_CONFIG_DIR` stay env-only (no file fallback) — and
 *   `SIGRUN_MODEL` remains REQUIRED;
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

const MODEL_ENV = { SIGRUN_MODEL: "openai/gpt-4o" };

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

	test("SIGRUN_MODEL stays required (no file fallback)", () => {
		expect(() => loadConfig({}, { server: { port: 4080 } })).toThrow(
			/SIGRUN_MODEL/,
		);
		expect(() => loadConfig({})).toThrow(/SIGRUN_MODEL/);
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

	test("env-only knobs have no file fallback", () => {
		const file: SettingsFile = { server: { port: 4080 } };
		const config = loadConfig({ ...MODEL_ENV }, file);
		// The file's server section carries no model/extensions/webui keys
		// at all — and the resolution ignores any it would hypothetically
		// find elsewhere in the file (validation rejects unknown keys, but
		// loadConfig never consults anything but `server`).
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
		// Second boot: env over the bootstrapped file resolves the same.
		const second = loadConfig(env, { server: section });
		expect(second).toEqual(first);
		// Env dropped: the bootstrapped file alone reproduces the section.
		const fromFile = loadConfig({ ...MODEL_ENV }, { server: section });
		expect(fromFile.port).toBe(4080);
		expect(fromFile.backup).toEqual({ target: "s3", bucket: "b" });
	});
});
