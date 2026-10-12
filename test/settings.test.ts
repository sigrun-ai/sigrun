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
});