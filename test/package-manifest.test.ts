/**
 * Release-manifest hygiene (release-0.1 Task 3): asserts the published
 * package shape for every manifest in the workspace — the npm-facing
 * Global Constraints, pinned here so a stray edit cannot silently
 * regress the 0.1.0 tarballs:
 *
 * - the published family names (`@sigrun/sigrun`, `@sigrun/shared`,
 *   `@sigrun/tui`) with `publishConfig` access/provenance and no
 *   `private: true` (webui is the documented exception: a private build
 *   input, never published);
 * - exact intra-family pins (`0.1.0`, never `*`/ranges) so a published
 *   @sigrun/sigrun can never resolve a newer family member than tested;
 * - core's `files` whitelist (the runnable tarball: `dist` +
 *   `webui/dist` + the docs files; deploy assets live on GitHub, not in
 *   the tarball);
 * - the five built-in extension dependencies. Working-tree spec is
 *   `file:../sigrun-ext-*` (the dev shape —
 *   npm refuses registry-spec + `overrides: file:` for direct deps,
 *   EOVERRIDE); the publish-time rewrite flips these to exact versions
 *   before `npm publish`, which is the only published shape this test
 *   accepts beyond the dev shape.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface LockPackage {
	version?: string;
	resolved?: string;
	dependencies?: Record<string, string>;
}

interface MinimalManifest {
	name?: string;
	version?: string;
	private?: boolean;
	license?: string;
	engines?: { node?: string };
	publishConfig?: Record<string, unknown>;
	files?: string[];
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	repository?: { type?: string; url?: string; directory?: string };
	bugs?: { url?: string };
	homepage?: string;
	bin?: Record<string, string>;
	exports?: Record<string, unknown>;
}

function manifest(path: string): MinimalManifest {
	return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as MinimalManifest;
}

function lockPackage(path: string): LockPackage {
	const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
		packages: Record<string, LockPackage>;
	};
	const entry = lock.packages[path];
	expect(entry, `package-lock.json has ${path}`).toBeDefined();
	return entry;
}

const PUBLISH_CONFIG = { access: "public", provenance: true };
const NODE_ENGINE = ">=22.19.0";

/** The published family members and their exact-version dep specs. */
const FAMILY = ["@sigrun/shared", "@sigrun/tui", "@sigrun/ext-codemode", "@sigrun/ext-gateway", "@sigrun/ext-mcp", "@sigrun/ext-tool-search", "@sigrun/oauth"] as const;

/** The dev-shape-or-published spec for a built-in extension dependency. */
function builtinSpec(repo: string): RegExp {
	return new RegExp(`^(0\\.[0-9]+\\.[0-9]+|file:\\.\\./${repo})$`);
}

describe("package manifests (release-0.1 Global Constraints)", () => {
	const root = manifest("../package.json");
	const shared = manifest("../shared/package.json");
	const tui = manifest("../tui/package.json");
	const webui = manifest("../webui/package.json");

	test("core: @sigrun/sigrun, published, exact family pins, tarball-only files", () => {
		expect(root.name).toBe("@sigrun/sigrun");
		expect(root.private).toBeUndefined();
		expect(root.license).toBe("MIT");
		expect(root.engines?.node).toBe(NODE_ENGINE);
		expect(root.publishConfig).toEqual(PUBLISH_CONFIG);
		expect(root.bin).toEqual({ sigrun: "dist/cli.js" });
		expect(Object.keys(root.exports ?? {}).sort()).toEqual([
			".",
			"./blocks",
			"./extension",
		]);
		expect(root.repository).toEqual({
			type: "github",
			url: "git+https://github.com/sigrun-ai/sigrun.git",
		});
		expect(root.bugs?.url).toBe("https://github.com/sigrun-ai/sigrun/issues");
		expect(root.homepage).toBe("https://github.com/sigrun-ai/sigrun#readme");
		// The runnable tarball only: deploy assets (scripts/docker/charts/
		// Dockerfile) ship via the GitHub repo, never npm.
		expect(root.files).toEqual([
			"dist",
			"webui/dist",
			"THIRD_PARTY_NOTICES.md",
			"README.md",
			"LICENSE",
			"CHANGELOG.md",
			"CONTEXT.md",
		]);
		// Exact intra-family pins.
		expect(root.dependencies?.["@sigrun/shared"]).toBe("0.1.2");
		expect(root.optionalDependencies).toEqual({ "@sigrun/tui": "0.1.1" });
		// The built-ins resolve from core's own tree under their scoped
		// names (src/harness/builtins.ts keys on these).
		expect(root.dependencies?.["@sigrun/ext-codemode"]).toMatch(builtinSpec("sigrun-ext-codemode"));
		expect(root.dependencies?.["@sigrun/ext-gateway"]).toMatch(builtinSpec("sigrun-ext-gateway"));
		expect(root.dependencies?.["@sigrun/ext-mcp"]).toMatch(builtinSpec("sigrun-ext-mcp"));
		expect(root.dependencies?.["@sigrun/ext-tool-search"]).toMatch(builtinSpec("sigrun-ext-tool-search"));
		expect(root.dependencies?.["@sigrun/oauth"]).toMatch(builtinSpec("sigrun-ext-oauth"));
	});

	test("OAuth's lock package node carries its runtime dependency for clean installs", () => {
		expect(lockPackage("node_modules/@sigrun/oauth")).toMatchObject({
			version: "0.1.0",
			resolved: "file:../sigrun-ext-oauth",
			dependencies: { oauth4webapi: "3.8.8" },
		});
		expect(lockPackage("node_modules/oauth4webapi")).toMatchObject({
			version: "3.8.8",
			resolved: "https://registry.npmjs.org/oauth4webapi/-/oauth4webapi-3.8.8.tgz",
		});
	});

	test("shared: published leaf with directory-qualified repository", () => {
		expect(shared.name).toBe("@sigrun/shared");
		expect(shared.private).toBeUndefined();
		expect(shared.license).toBe("MIT");
		expect(shared.engines?.node).toBe(NODE_ENGINE);
		expect(shared.publishConfig).toEqual(PUBLISH_CONFIG);
		expect(shared.files).toEqual(["dist", "CHANGELOG.md"]);
		expect(shared.repository).toEqual({
			type: "github",
			url: "git+https://github.com/sigrun-ai/sigrun.git",
			directory: "shared",
		});
		expect(shared.dependencies).toBeUndefined();
	});

	test("tui: published workspace package, exact shared pin", () => {
		expect(tui.name).toBe("@sigrun/tui");
		expect(tui.private).toBeUndefined();
		expect(tui.license).toBe("MIT");
		expect(tui.engines?.node).toBe(NODE_ENGINE);
		expect(tui.publishConfig).toEqual(PUBLISH_CONFIG);
		expect(tui.files).toEqual(["dist", "CHANGELOG.md"]);
		expect(tui.dependencies?.["@sigrun/shared"]).toBe("0.1.2");
		expect(tui.bin).toEqual({ "sigrun-tui": "dist/launch.js" });
		expect(tui.repository).toEqual({
			type: "github",
			url: "git+https://github.com/sigrun-ai/sigrun.git",
			directory: "tui",
		});
	});

	test("webui: stays a private build input (never published)", () => {
		// The webui bundle ships inside core's tarball (webui/dist); the
		// workspace package itself is never published — private, no
		// publishConfig, no publish metadata.
		expect(webui.name).toBe("@sigrun/webui");
		expect(webui.private).toBe(true);
		expect(webui.publishConfig).toBeUndefined();
	});

	test("no intra-family ranges: every family pin is exact", () => {
		const manifests = [
			["package.json", root],
			["shared/package.json", shared],
			["tui/package.json", tui],
			["webui/package.json", webui],
		] as const;
		for (const [path, pkg] of manifests) {
			const deps = {
				...(pkg.dependencies ?? {}),
				...(pkg.devDependencies ?? {}),
				...(pkg.optionalDependencies ?? {}),
			};
			for (const [name, spec] of Object.entries(deps)) {
				if ((FAMILY as readonly string[]).includes(name)) {
					// webui's private dev shape may use the workspace link;
					// every published manifest pins exactly.
					if (path === "webui/package.json") continue;
					expect(spec, `${path}: ${name}`).toMatch(/^(0\.[0-9]+\.[0-9]+|file:\.\.\/sigrun-ext-[a-z-]+)$/);
				}
			}
		}
	});
});
