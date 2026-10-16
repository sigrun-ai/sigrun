/**
 * The store-root env surface on `loadConfig` (extension-config-surfaces
 * Task 6): the three dir fields (`dataDir`/`cacheDir`/`stateDir`) resolve
 * through Task 1's `resolveStoreRoots` (env explicit over `$XDG_*_HOME`
 * over the `~`-based spec default — never duplicated here), and the DB
 * default moves under the data root (the CLEAN BREAK: no
 * `data/sigrun.db` cwd-relative default, no migration; absolute
 * `SIGRUN_STORAGE_PATH` values stay verbatim, relative ones join the
 * data root).
 *
 * `resolveStoreRoots` consults `os.homedir()` (which reads `process.env.HOME`
 * at call time) — the tier-3 tier — so these tests pin `HOME` to a
 * synthetic literal and restore it, exactly like `test/stores-resolution.test.ts`.
 * The tests own their literals: `acme/` names, `.example` hosts, no real
 * user paths.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { resolveStoreRoots } from "../src/harness/stores.js";
import type { SettingsFile } from "../src/harness/settings.js";

const MODEL_ENV = { SIGRUN_DEFAULT_MODEL: "openai/gpt-4o" };

/** The synthetic home every default-tier assertion joins against. */
const HOME = "/tmp/acme-home";

// os.homedir() reads HOME per call on POSIX.
beforeEach(() => {
	process.env.HOME = HOME;
});

afterEach(() => {
	delete process.env.HOME;
});

describe("loadConfig store dirs (data/cache/state)", () => {
	test("explicit env wins, verbatim (one field, others default independently)", () => {
		const config = loadConfig({
			...MODEL_ENV,
			SIGRUN_DATA_DIR: "/explicit/acme-data",
		});
		expect(config.dataDir).toBe("/explicit/acme-data");
		// No tier leakage: the untouched roots resolve their own defaults.
		expect(config.cacheDir).toBe(join(HOME, ".cache", "sigrun"));
		expect(config.stateDir).toBe(join(HOME, ".local/state", "sigrun"));
	});

	test("SIGRUN_CACHE_DIR and SIGRUN_STATE_DIR resolve through the same chain", () => {
		const config = loadConfig({
			...MODEL_ENV,
			SIGRUN_CACHE_DIR: "/explicit/acme-cache",
			SIGRUN_STATE_DIR: "/explicit/acme-state",
		});
		expect(config.cacheDir).toBe("/explicit/acme-cache");
		expect(config.stateDir).toBe("/explicit/acme-state");
		// The data root still fell through to the XDG/home chain.
		expect(config.dataDir).toBe(join(HOME, ".local/share", "sigrun"));
	});

	test("unset → the XDG/HOME chain (XDG tier appends /sigrun)", () => {
		const config = loadConfig({
			...MODEL_ENV,
			XDG_DATA_HOME: "/xdg/acme-data",
			XDG_CACHE_HOME: "/xdg/acme-cache",
			XDG_STATE_HOME: "/xdg/acme-state",
		});
		expect(config.dataDir).toBe("/xdg/acme-data/sigrun");
		expect(config.cacheDir).toBe("/xdg/acme-cache/sigrun");
		expect(config.stateDir).toBe("/xdg/acme-state/sigrun");
	});

	test("all unset → the $HOME spec defaults (absolute, /sigrun-suffixed)", () => {
		const config = loadConfig({ ...MODEL_ENV });
		expect(config.dataDir).toBe(join(HOME, ".local/share", "sigrun"));
		expect(config.cacheDir).toBe(join(HOME, ".cache", "sigrun"));
		expect(config.stateDir).toBe(join(HOME, ".local/state", "sigrun"));
		for (const dir of [config.dataDir, config.cacheDir, config.stateDir]) {
			expect(isAbsolute(dir)).toBe(true);
			expect(dir.endsWith("/sigrun")).toBe(true);
		}
	});

	test("homedir() tracks the synthetic HOME (the fixture is honest)", () => {
		expect(homedir()).toBe(HOME);
	});

	test("the config fields match resolveStoreRoots for the same env (no duplicate chain)", () => {
		const env = {
			...MODEL_ENV,
			XDG_DATA_HOME: "/xdg/acme-data",
			SIGRUN_STATE_DIR: "/explicit/acme-state",
		};
		const config = loadConfig(env);
		const roots = resolveStoreRoots(env);
		expect(config.dataDir).toBe(roots.dataDir);
		expect(config.cacheDir).toBe(roots.cacheDir);
		expect(config.stateDir).toBe(roots.stateDir);
	});
});

describe("the DB default under the data root (clean break)", () => {
	test("SIGRUN_STORAGE_PATH absent → <dataDir>/sigrun.db", () => {
		const config = loadConfig({ ...MODEL_ENV });
		expect(config.storagePath).toBe(join(config.dataDir, "sigrun.db"));
		expect(config.storagePath).toBe(
			join(HOME, ".local/share", "sigrun", "sigrun.db"),
		);
	});

	test("a relative SIGRUN_STORAGE_PATH joins the data root", () => {
		const config = loadConfig({
			...MODEL_ENV,
			SIGRUN_DATA_DIR: "/explicit/acme-data",
			SIGRUN_STORAGE_PATH: "acme.db",
		});
		expect(config.storagePath).toBe("/explicit/acme-data/acme.db");
	});

	test("an absolute SIGRUN_STORAGE_PATH stays verbatim (deploy shapes unaffected)", () => {
		const config = loadConfig({
			...MODEL_ENV,
			SIGRUN_STORAGE_PATH: "/data/sigrun.db",
		});
		expect(config.storagePath).toBe("/data/sigrun.db");
	});

	test("a file-relative storagePath joins the data root too (the file's server.storagePath mirrors the env)", () => {
		const file: SettingsFile = { server: { storagePath: "acme.db" } };
		const config = loadConfig(
			{ ...MODEL_ENV, SIGRUN_DATA_DIR: "/explicit/acme-data" },
			file,
		);
		expect(config.storagePath).toBe("/explicit/acme-data/acme.db");
	});

	test("no cwd-relative data/sigrun.db default anywhere (the clean break)", () => {
		// The old default was the cwd-relative "data/sigrun.db"; the new
		// default is always an absolute path under the resolved data root.
		const config = loadConfig({ ...MODEL_ENV });
		expect(config.storagePath).not.toBe("data/sigrun.db");
		expect(isAbsolute(config.storagePath)).toBe(true);
	});
});

describe("settings.json server.* mirrors for the store dirs", () => {
	test("the file's server.dataDir applies where the env var is absent", () => {
		const file: SettingsFile = {
			server: {
				dataDir: "/file/acme-data",
				cacheDir: "/file/acme-cache",
				stateDir: "/file/acme-state",
			},
		};
		const config = loadConfig({ ...MODEL_ENV }, file);
		expect(config.dataDir).toBe("/file/acme-data");
		expect(config.cacheDir).toBe("/file/acme-cache");
		expect(config.stateDir).toBe("/file/acme-state");
	});

	test("env wins per field over the file", () => {
		const file: SettingsFile = {
			server: {
				dataDir: "/file/acme-data",
				cacheDir: "/file/acme-cache",
			},
		};
		const config = loadConfig(
			{ ...MODEL_ENV, SIGRUN_CACHE_DIR: "/env/acme-cache" },
			file,
		);
		expect(config.dataDir).toBe("/file/acme-data");
		expect(config.cacheDir).toBe("/env/acme-cache");
	});
});
