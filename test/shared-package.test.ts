/**
 * The `@sigrun/shared` package contract (build-and-webui Task 1).
 *
 * `@sigrun/shared` is the publishable leaf package both clients (webui,
 * tui) and the server import — theme tokens, turn/conversation shaping,
 * and the §5 wire types. This test pins the EXTRACTION invariants:
 *
 * - the package resolves from the workspace root through its `exports`
 *   map to the BUILT `dist/` output (a stale or missing build fails
 *   loud here, not silently in a client);
 * - the modules no longer live under `src/shared/` (the old in-tree
 *   location — a file reappearing there means a consumer's relative
 *   import resurrected it);
 * - the package is publishable: not `private`, ships `dist`, and every
 *   documented subpath export exists.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const REPO_ROOT = join(__dirname, "..");
const OLD_SHARED_DIR = join(REPO_ROOT, "src", "shared");
const PACKAGE_ROOT = join(REPO_ROOT, "shared");

describe("@sigrun/shared resolves to the built package", () => {
	it("resolves ./themes through the exports map to dist/", () => {
		const resolved = require.resolve("@sigrun/shared/themes");
		expect(resolved).toContain(join("shared", "dist", "themes.js"));
	});

	it("resolves every wire/shape module through the exports map", () => {
		for (const subpath of [
			"conversations",
			"turns",
			"session-meta",
			"commands",
			"interactions",
			"ambient",
			"settings",
			"views",
		]) {
			const resolved = require.resolve(`@sigrun/shared/${subpath}`);
			expect(resolved, `@sigrun/shared/${subpath}`).toContain(
				join("shared", "dist", `${subpath}.js`),
			);
		}
	});

	it("serves the theme data at runtime (the built module is real)", async () => {
		const themes = await import("@sigrun/shared/themes");
		expect(Object.keys(themes.PALETTES).length).toBeGreaterThan(0);
		expect(themes.ACCENTS).toBeDefined();
	});

	it("serves the turn shaping at runtime", async () => {
		const turns = await import("@sigrun/shared/turns");
		expect(typeof turns.groupTurns).toBe("function");
		expect(typeof turns.activityLabel).toBe("function");
	});
});

describe("the moved modules no longer live under src/shared", () => {
	it("src/shared does not exist", () => {
		expect(existsSync(OLD_SHARED_DIR)).toBe(false);
	});

	it("the package sources live under shared/src", () => {
		for (const module of [
			"themes.ts",
			"conversations.ts",
			"turns.ts",
			"json.ts",
			"session-meta.ts",
			"commands.ts",
			"interactions.ts",
			"ambient.ts",
			"settings.ts",
			"views.ts",
		]) {
			expect(existsSync(join(PACKAGE_ROOT, "src", module)), module).toBe(true);
		}
	});
});

	describe("the package is publishable", () => {
	const manifest = JSON.parse(
		readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
	) as Record<string, unknown>;

	it("is not private and ships dist", () => {
		expect(manifest.name).toBe("@sigrun/shared");
		expect(manifest.private).toBeUndefined();
		expect(manifest.files).toEqual(["dist"]);
	});

	it("declares every consumed subpath in exports", () => {
		const exportsMap = manifest.exports as Record<string, unknown>;
		for (const subpath of [
			"./themes",
			"./conversations",
			"./turns",
			"./session-meta",
			"./commands",
			"./interactions",
			"./ambient",
			"./settings",
			"./views",
		]) {
			expect(exportsMap[subpath], `exports[${subpath}]`).toBeDefined();
		}
	});

	it("the built declaration files exist next to the js output", () => {
		const resolved = require.resolve("@sigrun/shared/views");
		const declaration = join(dirname(resolved), "views.d.ts");
		expect(existsSync(declaration)).toBe(true);
	});
});
