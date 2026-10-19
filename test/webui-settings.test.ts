/**
 * The webui channel settings surface (build-and-webui Task 4):
 * `server.webui {enabled, bundle}` becomes a first-class settings
 * section and `SIGRUN_WEBUI` gates it, while the legacy
 * `server.webuiBundle` reads as a deprecated alias for one release.
 *
 * The binding rulings (the spec's webui-config surface):
 * - `SIGRUN_WEBUI` parses STRICTLY (true/false only; "" counts as unset;
 *   anything else fails loud naming the variable — the
 *   `SIGRUN_COMPACTION_ENABLED` pattern);
 * - the bundle selector resolves env (`SIGRUN_WEBUI_BUNDLE`) over
 *   `server.webui.bundle` over the LEGACY `server.webuiBundle` over the
 *   default — and Task 4 only STORES the selector (name/path
 *   discrimination is Task 5's serve-time resolution);
 * - the store's `update()` sub-merges `server.webui` per key, so a
 *   PATCH of `enabled` never drops a set `bundle`;
 * - a DEFAULTED first boot persists NEITHER webui key (the omission is
 *   the whole point: a mirrored default would read as an explicit
 *   selection on the next boot and make absent-default → API-only
 *   unreachable).
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { loadConfig, resolvedServerSection } from "../src/config.js";
import { SettingsStore, settingsPath } from "../src/harness/settings.js";
import type { SettingsFile } from "../src/harness/settings.js";

const MODEL_ENV = { SIGRUN_DEFAULT_MODEL: "openai/gpt-4o" };

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

/** A store over a fresh tmp dir (recorded for afterAll teardown). */
function freshStore(): { store: SettingsStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "sigrun-webui-settings-"));
	dirs.push(dir);
	return { store: new SettingsStore({ dir }), dir };
}

describe("SIGRUN_WEBUI (the enabled gate)", () => {
	test("SIGRUN_WEBUI=false parses strict (true/false only, '' unset, else throws)", () => {
		// "false" gates the channel; "TRUE" is accepted case-insensitively.
		expect(
			loadConfig({ ...MODEL_ENV, SIGRUN_WEBUI: "false" }).webui,
		).toEqual({ enabled: false });
		expect(
			loadConfig({ ...MODEL_ENV, SIGRUN_WEBUI: "TRUE" }).webui,
		).toEqual({ enabled: true });
		// Empty counts as unset: the default (enabled) applies.
		expect(
			loadConfig({ ...MODEL_ENV, SIGRUN_WEBUI: "" }).webui,
		).toEqual({ enabled: true });
		// Anything else fails loud naming the variable — even when the
		// file carries a valid value for the same knob (env parsed first).
		expect(() =>
			loadConfig(
				{ ...MODEL_ENV, SIGRUN_WEBUI: "yes" },
				{ server: { webui: { enabled: false } } },
			),
		).toThrow(/SIGRUN_WEBUI/);
		// Unset env: the file's server.webui.enabled applies, then the
		// default true.
		expect(
			loadConfig({ ...MODEL_ENV }, { server: { webui: { enabled: false } } })
				.webui,
		).toEqual({ enabled: false });
		expect(loadConfig({ ...MODEL_ENV }).webui).toEqual({ enabled: true });
	});

	test("PATCH {server:{webui:{enabled:false}}} preserves an existing bundle", () => {
		const { store } = freshStore();
		store.update({ server: { webui: { bundle: "ui/dist" } } });
		store.update({ server: { webui: { enabled: false } } });
		expect(store.read().server?.webui).toEqual({
			bundle: "ui/dist",
			enabled: false,
		});
		// A null sub-field clears just that key; the section survives.
		store.update({ server: { webui: { enabled: null } } });
		expect(store.read().server?.webui).toEqual({ bundle: "ui/dist" });
		// Clearing both keys drops the section itself.
		store.update({ server: { webui: { bundle: null } } });
		expect(store.read().server?.webui).toBeUndefined();
	});
});

describe("the legacy server.webuiBundle alias", () => {
	test("legacy server.webuiBundle reads as server.webui.bundle with a deprecation warn", () => {
		// The warn is once-per-process (the SIGRUN_MODEL precedent): this
		// file's FIRST validation of a legacy-carrying file is spied here.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { store, dir } = freshStore();
			// The store accepts the legacy key (validation warns, never
			// throws) and loadConfig honors it as the selector.
			store.update({ server: { webuiBundle: "legacy/dist" } });
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("webuiBundle is deprecated"),
			);
			expect(store.read().server?.webuiBundle).toBe("legacy/dist");
			// Repeated validations warn once more never (the once gate).
			store.read();
			expect(warn).toHaveBeenCalledTimes(1);
			// Resolution: the legacy key supplies the selector.
			const config = loadConfig(
				{ ...MODEL_ENV },
				JSON.parse(
					readFileSync(settingsPath(dir), "utf8"),
				) as SettingsFile,
			);
			expect(config.webui).toEqual({ enabled: true, bundle: "legacy/dist" });
			// The serve-time seam keeps its resolved pair (Task 5 consumes
			// the new shape; the old fields stay coherent through the alias).
			expect(config.webuiBundle).toBe("legacy/dist");
			expect(config.webuiBundleExplicit).toBe(true);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("the bundle selector precedence", () => {
	test("precedence: env > server.webui.bundle > legacy server.webuiBundle > default", () => {
		// Default: no selector at all (the built-in bundle, Task 5).
		expect(loadConfig({ ...MODEL_ENV }).webui).toEqual({ enabled: true });
		expect(loadConfig({ ...MODEL_ENV }).webuiBundle).toBe("webui/dist");
		// Legacy slot applies when nothing else is set.
		expect(
			loadConfig({ ...MODEL_ENV }, { server: { webuiBundle: "legacy/dist" } })
				.webui.bundle,
		).toBe("legacy/dist");
		// The new key beats the legacy alias.
		expect(
			loadConfig(
				{ ...MODEL_ENV },
				{
					server: {
						webui: { bundle: "new/dist" },
						webuiBundle: "legacy/dist",
					},
				},
			).webui.bundle,
		).toBe("new/dist");
		// The env var beats both file keys (it stays the env form of the
		// selector, deprecated in docs only).
		expect(
			loadConfig(
				{ ...MODEL_ENV, SIGRUN_WEBUI_BUNDLE: "env/dist" },
				{
					server: {
						webui: { bundle: "new/dist" },
						webuiBundle: "legacy/dist",
					},
				},
			).webui.bundle,
		).toBe("env/dist");
		// A configured value EQUAL to the default keeps the default's
		// semantics (Task 3's classification) through every slot.
		const mirrored = loadConfig(
			{ ...MODEL_ENV },
			{ server: { webui: { bundle: "webui/dist" } } },
		);
		expect(mirrored.webuiBundleExplicit).toBe(false);
	});

	test("invalid enabled/bundle values fail validation naming the field", () => {
		const { store } = freshStore();
		const bad: Array<[Record<string, unknown>, RegExp]> = [
			[{ server: { webui: "off" } }, /server\.webui/],
			[{ server: { webui: { enabled: "yes" } } }, /server\.webui\.enabled/],
			[{ server: { webui: { bundle: 42 } } }, /server\.webui\.bundle/],
			[{ server: { webui: { bundle: "" } } }, /server\.webui\.bundle/],
			[{ server: { webui: { theme: "dark" } } }, /server\.webui\.theme/],
		];
		for (const [patch, pattern] of bad) {
			expect(() => store.update(patch)).toThrow(pattern);
		}
	});
});

describe("the bootstrap omission", () => {
	test("a defaulted first boot writes neither webui key (pinned here)", async () => {
		// A fully-defaulted config: enabled true, no selector. The
		// bootstrap projection omits BOTH `webui` and the legacy
		// `webuiBundle` — a mirrored default would read as an explicit
		// selection on the next boot (re-arming the cwd-relative default
		// and making absent-default → API-only unreachable).
		const defaulted = loadConfig({ ...MODEL_ENV });
		const section = resolvedServerSection(defaulted);
		expect(section.webui).toBeUndefined();
		expect(section.webuiBundle).toBeUndefined();
		// End to end: the persisted first-boot file carries neither key.
		const { store, dir } = freshStore();
		store.bootstrap(section, {
			defaultModel: "openai/gpt-4o",
		});
		const persisted = JSON.parse(
			readFileSync(settingsPath(dir), "utf8"),
		) as SettingsFile;
		expect(persisted.server?.webui).toBeUndefined();
		expect(persisted.server?.webuiBundle).toBeUndefined();
		// The file re-resolves to the same defaults (round-trip stable).
		expect(loadConfig({ ...MODEL_ENV }, persisted).webui).toEqual({
			enabled: true,
		});

		// A CONFIGURED boot records the new shape only — never the legacy
		// key — and omits the defaulted half of the section.
		const gated = resolvedServerSection(
			loadConfig({ ...MODEL_ENV, SIGRUN_WEBUI: "false" }),
		);
		expect(gated.webui).toEqual({ enabled: false });
		const selected = resolvedServerSection(
			loadConfig({ ...MODEL_ENV, SIGRUN_WEBUI_BUNDLE: "/opt/sigrun-ui" }),
		);
		expect(selected.webui).toEqual({ enabled: true, bundle: "/opt/sigrun-ui" });
		// And the recorded section re-resolves identically without env.
		const reResolved = loadConfig(
			{ ...MODEL_ENV },
			{ server: selected },
		);
		expect(reResolved.webui.bundle).toBe("/opt/sigrun-ui");
		expect(reResolved.webuiBundleExplicit).toBe(true);
	});
});
