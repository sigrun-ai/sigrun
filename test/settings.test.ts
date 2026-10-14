/**
 * Task 8a: the settings store (file-backed, live).
 *
 * The binding rulings:
 * - absent file → all defaults (the empty store)
 * - malformed file → throws (fail-loud at boot, loadConfig's posture)
 * - write → read-back round-trips
 *
 * Plus the liveness ruling: `harnessSettings()` is a getter-backed
 * object, so a file change is visible on the NEXT read (never a boot-time
 * snapshot), and PATCH validation names the offending field.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
	defaultSettingsDir,
	SettingsStore,
	SettingsValidationError,
	settingsPath,
} from "../src/harness/settings.js";

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

/** A store over a fresh tmp dir (recorded for afterAll teardown). */
function freshStore(): { store: SettingsStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "sigrun-settings-"));
	dirs.push(dir);
	return { store: new SettingsStore({ dir }), dir };
}

describe("SettingsStore", () => {
	test("an absent file reads as the empty store (all defaults)", () => {
		const { store } = freshStore();
		expect(store.read()).toEqual({});
	});

	test("the default dir is ~/.config/sigrun (env-overridable)", () => {
		// SIGRUN_CONFIG_DIR wins when set (the hermetic seam / deploy knob).
		const before = process.env.SIGRUN_CONFIG_DIR;
		process.env.SIGRUN_CONFIG_DIR = "/tmp/override-dir";
		try {
			expect(defaultSettingsDir()).toBe("/tmp/override-dir");
		} finally {
			if (before === undefined) delete process.env.SIGRUN_CONFIG_DIR;
			else process.env.SIGRUN_CONFIG_DIR = before;
		}
		// Absent: the config-dir convention.
		if (process.env.SIGRUN_CONFIG_DIR === undefined) {
			expect(defaultSettingsDir()).toContain(
				join(".config", "sigrun"),
			);
		}
	});

	test("a malformed file throws fail-loud (bad JSON, non-object)", async () => {
		const { store, dir } = freshStore();
		const file = settingsPath(dir);
		await writeFile(file, "{not json", "utf8");
		expect(() => store.read()).toThrow(/not valid JSON/);
		await writeFile(file, "[1, 2, 3]", "utf8");
		expect(() => store.read()).toThrow(/must contain a JSON object/);
	});

	test("an unknown or wrong-shaped field throws naming the field", async () => {
		const { store, dir } = freshStore();
		const file = settingsPath(dir);
		await writeFile(file, '{"compaction": {}}', "utf8");
		// compaction is deliberately NOT in the store (config owns it).
		expect(() => store.read()).toThrow(SettingsValidationError);
		await writeFile(file, '{"steeringMode": "sometimes"}', "utf8");
		expect(() => store.read()).toThrow(/steeringMode/);
		await writeFile(file, '{"defaultTools": ["read", 42]}', "utf8");
		expect(() => store.read()).toThrow(/defaultTools/);
		await writeFile(
			file,
			'{"perModelThinking": {"faux/m": "sideways"}}',
			"utf8",
		);
		expect(() => store.read()).toThrow(/perModelThinking\.faux\/m/);
	});

	test("update merges, persists, and reads back", () => {
		const { store } = freshStore();
		const after = store.update({ steeringMode: "all" });
		expect(after.steeringMode).toBe("all");
		// Read-back: a FRESH store over the same file sees it too (the
		// other-process/hand-edit story).
		expect(store.read().steeringMode).toBe("all");
		// Merge: a second PATCH preserves the first key.
		store.update({ followUpMode: "all" });
		expect(store.read()).toEqual({
			steeringMode: "all",
			followUpMode: "all",
		});
	});

	test("null clears a key; sub-objects merge per-field and null-clear", () => {
		const { store } = freshStore();
		store.update({ retry: { maxRetries: 5, baseDelayMs: 500 } });
		// Sub-merge: only the named sub-field changes.
		store.update({ retry: { maxRetries: 0 } });
		expect(store.read().retry).toEqual({
			maxRetries: 0,
			baseDelayMs: 500,
		});
		// Null sub-field clears just that one; null key clears the whole key.
		store.update({ retry: { maxRetries: null } });
		expect(store.read().retry).toEqual({ baseDelayMs: 500 });
		store.update({ retry: null });
		expect(store.read().retry).toBeUndefined();
		// perModelThinking: the same sub-merge over model refs.
		store.update({
			perModelThinking: { "faux/m": "high", "openai/gpt-4o": "low" },
		});
		store.update({ perModelThinking: { "faux/m": null } });
		expect(store.read().perModelThinking).toEqual({ "openai/gpt-4o": "low" });
	});

	test("update rejects an unknown key and wrong types naming the field", () => {
		const { store } = freshStore();
		expect(() => store.update({ compaction: {} })).toThrow(
			SettingsValidationError,
		);
		expect(() => store.update({ steeringMode: "sometimes" })).toThrow(
			/steeringMode/,
		);
		expect(() => store.update({ defaultTools: "read" })).toThrow(
			/defaultTools/,
		);
		// A rejected update persisted nothing.
		expect(store.read()).toEqual({});
	});

	test("the persisted file is pretty JSON at <dir>/settings.json", () => {
		const { store, dir } = freshStore();
		store.update({ steeringMode: "all" });
		const raw = readFileSync(settingsPath(dir), "utf8");
		expect(JSON.parse(raw)).toEqual({ steeringMode: "all" });
	});

	test("harnessSettings() is live: a file change lands on the next read", async () => {
		const { store, dir } = freshStore();
		const live = store.harnessSettings();
		expect(live.steeringMode).toBeUndefined();
		// A PATCH through the same store (what /v1/settings does)…
		store.update({ steeringMode: "all", followUpMode: "all" });
		// …is visible through the SAME live object with NO re-boot —
		// pi-durable's per-resolution reads observe the change.
		expect(live.steeringMode).toBe("all");
		expect(live.followUpMode).toBe("all");
		// And a hand edit (the other-process story) too.
		await writeFile(
			settingsPath(dir),
			'{"steeringMode": "one-at-a-time"}',
			"utf8",
		);
		expect(live.steeringMode).toBe("one-at-a-time");
		expect(live.followUpMode).toBeUndefined();
	});

	test("settingsPath joins the dir", () => {
		expect(settingsPath("/x/y")).toBe(join("/x/y", "settings.json"));
	});

	test("bootstrap writes the resolved server section only when the file is absent", async () => {
		const { store, dir } = freshStore();
		const section = {
			port: 3000,
			workspacePath: "/home/sigrun",
			storagePath: "data/sigrun.db",
			extensionsDir: "extensions",
			webuiBundle: "webui/dist",
			compaction: {
				enabled: true,
				reserveTokens: 16384,
				keepRecentTokens: 20000,
				backgroundTokens: 32768,
			},
		};
		store.bootstrap(section);
		const first = readFileSync(settingsPath(dir), "utf8");
		// Pretty JSON + trailing newline, `{ server: ... }` exactly.
		expect(JSON.parse(first)).toEqual({ server: section });
		expect(first.endsWith("\n")).toBe(true);
		// Idempotent: a second bootstrap (even with different values)
		// leaves the file byte-identical.
		store.bootstrap({ port: 9999 });
		expect(readFileSync(settingsPath(dir), "utf8")).toBe(first);
		// A hand-edited file is never overwritten either.
		await writeFile(settingsPath(dir), '{"steeringMode": "all"}', "utf8");
		store.bootstrap(section);
		expect(readFileSync(settingsPath(dir), "utf8")).toBe(
			'{"steeringMode": "all"}',
		);
	});

	test("bootstrap writes the resolved extensions list and defaultModel (the file records reality)", async () => {
		const { store, dir } = freshStore();
		const section = {
			port: 3000,
			workspacePath: "/home/sigrun",
			storagePath: "data/sigrun.db",
			extensionsDir: "extensions",
			webuiBundle: "webui/dist",
			compaction: {
				enabled: true,
				reserveTokens: 16384,
				keepRecentTokens: 20000,
				backgroundTokens: 32768,
			},
		};
		store.bootstrap(section, {
			extensions: ["@acme/ext-a"],
			defaultModel: "openai/gpt-4o",
		});
		expect(JSON.parse(readFileSync(settingsPath(dir), "utf8"))).toEqual({
			extensions: ["@acme/ext-a"],
			defaultModel: "openai/gpt-4o",
			server: section,
		});
		// A bare boot (no env model, no extensions env) writes the section
		// alone — the model stays file-required.
		const bare = freshStore();
		bare.store.bootstrap(section);
		expect(
			JSON.parse(readFileSync(settingsPath(bare.dir), "utf8")),
		).toEqual({ server: section });
	});

	test("the server section validates (read + update)", async () => {
		const { store, dir } = freshStore();
		const file = settingsPath(dir);
		// Good shape round-trips.
		store.update({
			server: {
				port: 4080,
				compaction: { reserveTokens: 4096, backgroundTokens: 0 },
				backup: { s3: { bucket: "b", prefix: "p/" } },
			},
		});
		expect(store.read().server?.port).toBe(4080);
		expect(store.read().server?.backup).toEqual({
			s3: { bucket: "b", prefix: "p/" },
		});
		// Bad shapes throw naming the field (same error class as the rest).
		const bad: Array<[Record<string, unknown>, RegExp]> = [
			[{ server: { port: 0 } }, /server\.port/],
			[{ server: { port: "4080" } }, /server\.port/],
			[{ server: { workspacePath: 42 } }, /server\.workspacePath/],
			[{ server: { webuiBundle: 42 } }, /server\.webuiBundle/],
			[{ server: { compaction: { enabled: "yes" } } }, /server\.compaction\.enabled/],
			[{ server: { compaction: { reserveTokens: 0 } } }, /server\.compaction\.reserveTokens/],
			[{ server: { compaction: { backgroundTokens: -1 } } }, /server\.compaction\.backgroundTokens/],
			[{ server: { backup: { path: "/x", s3: { bucket: "b" } } } }, /server\.backup/],
			[{ server: { backup: { s3: {} } } }, /server\.backup\.s3\.bucket/],
			// The model, extension list, and provider endpoint are NOT
			// server.* keys (they are top-level file fields / auth.json).
			[{ server: { model: "openai/gpt-4o" } }, /server\.model/],
			[{ server: { extensions: ["a"] } }, /server\.extensions/],
		];
		for (const [patch, pattern] of bad) {
			expect(() => store.update(patch)).toThrow(pattern);
		}
		// Rejected updates persisted nothing; the file on disk fails loud
		// at read the same way (fail-loud at boot).
		await writeFile(file, '{"server": {"port": "abc"}}', "utf8");
		expect(() => store.read()).toThrow(/server\.port/);
	});

	test("the new top-level sections validate (extensions, defaultModel, defaultProvider)", async () => {
		const { store, dir } = freshStore();
		// Good shapes round-trip.
		store.update({
			extensions: ["@acme/ext-a", "./local-ext"],
			defaultModel: "acme/model-1",
			defaultProvider: { baseUrl: "https://gw.example/v1" },
		});
		expect(store.read().extensions).toEqual(["@acme/ext-a", "./local-ext"]);
		expect(store.read().defaultModel).toBe("acme/model-1");
		expect(store.read().defaultProvider).toEqual({
			baseUrl: "https://gw.example/v1",
		});
		// Bad shapes throw naming the field.
		const bad: Array<[Record<string, unknown>, RegExp]> = [
			[{ extensions: "@acme/ext-a" }, /extensions/],
			[{ extensions: ["a", ""] }, /extensions/],
			[{ extensions: ["a", 42] }, /extensions/],
			[{ defaultModel: "" }, /defaultModel/],
			[{ defaultModel: "  " }, /defaultModel/],
			[{ defaultModel: 42 }, /defaultModel/],
			[{ defaultModel: "acme/" }, /defaultModel/],
			[{ defaultModel: "/m" }, /defaultModel/],
			[{ defaultProvider: "https://gw.example/v1" }, /defaultProvider/],
			[{ defaultProvider: { apiKey: "k" } }, /defaultProvider\.apiKey/],
			[{ defaultProvider: { baseUrl: "" } }, /defaultProvider\.baseUrl/],
		];
		for (const [patch, pattern] of bad) {
			expect(() => store.update(patch)).toThrow(pattern);
		}
		// The file on disk fails loud at read the same way.
		await writeFile(settingsPath(dir), '{"defaultModel": "acme/"}', "utf8");
		expect(() => store.read()).toThrow(/defaultModel/);
		await writeFile(settingsPath(dir), '{"extensions": [42]}', "utf8");
		expect(() => store.read()).toThrow(/extensions/);
	});

	test("defaultProvider PATCHes sub-merge; null clears a sub-field", () => {
		const { store } = freshStore();
		store.update({ defaultProvider: { baseUrl: "https://gw.example/v1" } });
		expect(store.read().defaultProvider?.baseUrl).toBe(
			"https://gw.example/v1",
		);
		store.update({ defaultProvider: { baseUrl: null } });
		expect(store.read().defaultProvider).toBeUndefined();
		// Top-level keys null-clear wholesale, like the other sections.
		store.update({
			extensions: ["@acme/ext-a"],
			defaultModel: "acme/model-1",
		});
		store.update({ extensions: null, defaultModel: null });
		expect(store.read().extensions).toBeUndefined();
		expect(store.read().defaultModel).toBeUndefined();
	});

	test("server PATCHes sub-merge: the bootstrap fields survive a port PATCH", () => {
		const { store } = freshStore();
		store.bootstrap({
			port: 3000,
			workspacePath: "/home/sigrun",
			storagePath: "data/sigrun.db",
			extensionsDir: "extensions",
			webuiBundle: "webui/dist",
			compaction: {
				enabled: true,
				reserveTokens: 16384,
				keepRecentTokens: 20000,
				backgroundTokens: 32768,
			},
		});
		store.update({ server: { port: 4080 } });
		const server = store.read().server;
		expect(server?.port).toBe(4080);
		expect(server?.workspacePath).toBe("/home/sigrun");
		expect(server?.compaction?.reserveTokens).toBe(16384);
		// Compaction sub-merge one level deeper.
		store.update({ server: { compaction: { reserveTokens: 4096 } } });
		expect(store.read().server?.compaction).toEqual({
			enabled: true,
			reserveTokens: 4096,
			keepRecentTokens: 20000,
			backgroundTokens: 32768,
		});
		// Null clears one server field; the section survives.
		store.update({ server: { extensionsDir: null } });
		expect(store.read().server?.extensionsDir).toBeUndefined();
		expect(store.read().server?.port).toBe(4080);
		// Clearing every key drops the section itself.
		store.update({ server: null });
		expect(store.read().server).toBeUndefined();
	});
});