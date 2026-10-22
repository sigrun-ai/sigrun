/**
 * The views purity guards (the channel-contract rule) — over the shared
 * wire modules AND the fully-pure UI modules.
 *
 * `@sigrun/shared` (shared/src) is sigrun's channel contract: both
 * clients (webui — DOM-only, bundler resolution; tui — NodeNext) and the
 * server import it, and it is the intended basis for a generated OpenAPI
 * schema. Two contracts live side by side there (build-and-webui Task 1):
 *
 * - the WIRE modules (`views`, `session-meta`, `commands`,
 *   `interactions`, `ambient`, `settings`, `json`): types + pure
 *   constants. Imports and re-exports must be TYPE-ONLY and resolve
 *   inside `shared/src/` (a sibling `./…`, or a `../…` that stays under
 *   the root): a type-only reference erases at compile time and
 *   contributes no runtime, while any other import would drag a
 *   dependency only one client can load or resolve.
 * - the BLOCKS modules (`blocks/…`, U0): runtime code by design —
 *   `applyOps`, `lttb`, the icon names — pure and dependency-free, but
 *   VALUE imports and re-exports are the point. Every specifier (import
 *   or re-export) must resolve inside `shared/src/` (spec §4.1: “pure
 *   code with no imports outside `shared/`”); nothing else differs.
 * - the UI modules (`themes`, `turns`, `conversations`): fully pure — no
 *   imports of any kind, not even type-only siblings. They are consumed
 *   by BOTH clients from one source; any dependency would reintroduce
 *   the exact two-client drift these modules remove.
 *
 * The server's `src/server/views.ts` (the runtime half: the wire
 * serializer) is guarded too: `import type` from upstream packages only
 * (`@earendil-works/*`, `@sigrun/shared/*`), no runtime import of any
 * module (the JSONL_CONTENT_TYPE re-export from the shared package is
 * the sanctioned exception), no `node:` specifiers (the webui compiled
 * DOM-only against this file's types), and never the route module
 * (`./index.js`) — types move FROM the route module TO the contract,
 * never the reverse.
 *
 * This is a lint-style guard over the module TEXT, not a parser: the
 * regexes are deliberately simple and the modules' own conventions (one
 * import per statement, no inline string literals carrying "node:" or
 * "./index.js") keep them exact. A false positive here means the module
 * picked up a shape the guard can't see through — tighten the module,
 * not the guard.
 */

import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SHARED_SRC = join(__dirname, "..", "shared", "src");
const SERVER_VIEWS_PATH = join(__dirname, "..", "src", "server", "views.ts");

/** The UI-refresh modules: fully pure (no imports of any kind). */
const FULLY_PURE_MODULES = new Set([
	"themes.ts",
	"turns.ts",
	"conversations.ts",
]);

/** Every `.ts` file under `shared/src/` (recursively — the blocks
 *  subdirectory ships U0's runtime code there too). */
function sharedModuleSources(): { file: string; source: string }[] {
	const found: { file: string; source: string }[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name.endsWith(".ts")) {
				found.push({
					file: relative(SHARED_SRC, full),
					source: readFileSync(full, "utf8"),
				});
			}
		}
	};
	walk(SHARED_SRC);
	return found;
}

/** True when `specifier` (from the module at `file`) resolves to a file
 *  under `shared/src/` — sibling `./…` and parent `../…` alike. */
function resolvesInsideSharedSrc(file: string, specifier: string): boolean {
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
		return false;
	}
	const target = resolve(SHARED_SRC, file, "..", specifier);
	const rel = relative(SHARED_SRC, target);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// One import per statement; the `import ... from "specifier"` form only
// (no side-effect imports). Multiline named lists included.
const IMPORT_STATEMENTS = /^\s*import\s(.*?)\bfrom\s+"([^"]+)";/gms;

function importStatements(
	source: string,
): { head: string; specifier: string }[] {
	const found: { head: string; specifier: string }[] = [];
	for (const match of source.matchAll(IMPORT_STATEMENTS)) {
		found.push({ head: match[1], specifier: match[2] });
	}
	return found;
}

function exportFromStatements(
	source: string,
): { head: string; specifier: string }[] {
	const found: { head: string; specifier: string }[] = [];
	const EXPORT_FROM = /^\s*export\s([^;]*?)\bfrom\s+"([^"]+)";/gm;
	for (const match of source.matchAll(EXPORT_FROM)) {
		found.push({ head: match[1], specifier: match[2] });
	}
	return found;
}

describe("shared wire modules stay a type-only leaf", () => {
	// Top-level modules only: the `blocks/` subtree is runtime code with
	// its own class below (type-only would be a contradiction there).
	const wireModules = () =>
		sharedModuleSources().filter(
			({ file }) =>
				!FULLY_PURE_MODULES.has(file) && !file.startsWith(`blocks${sep}`),
		);

	it("has at least one wire module (the guard is not vacuous)", () => {
		expect(wireModules().length).toBeGreaterThan(0);
	});

	it("scans subdirectories: shared/src/blocks/ files are in the scanned set", () => {
		const files = sharedModuleSources().map(({ file }) => file);
		for (const expected of [
			join("blocks", "types.ts"),
			join("blocks", "ops.ts"),
			join("blocks", "icons.ts"),
			join("blocks", "lttb.ts"),
			join("blocks", "transport.ts"),
			join("blocks", "index.ts"),
		]) {
			expect(files, `shared/src/${expected} must be scanned`).toContain(expected);
		}
	});

	it("every import is `import type` — no runtime module imports", () => {
		for (const { file, source } of wireModules()) {
			const violations = importStatements(source).filter(
				(statement) => !statement.head.startsWith("type "),
			);
			expect(violations, `${file} must import type-only`).toEqual([]);
		}
	});

	it("every import specifier is a relative path resolving inside shared/src/ — no external packages", () => {
		for (const { file, source } of wireModules()) {
			const violations = importStatements(source).filter(
				(statement) => !resolvesInsideSharedSrc(file, statement.specifier),
			);
			expect(violations, `${file} must import inside shared/src/ only`).toEqual([]);
		}
	});

	it("every `export ... from` re-export is `export type`", () => {
		for (const { file, source } of wireModules()) {
			const violations = exportFromStatements(source).filter(
				(statement) => !statement.head.startsWith("type "),
			);
			expect(violations, `${file} must re-export type-only`).toEqual([]);
		}
	});

	it("no side-effect imports (`import \"...\"` with no bindings)", () => {
		for (const { file, source } of wireModules()) {
			expect(source, `${file} must have no side-effect imports`).not.toMatch(
				/^\s*import\s*["']/m,
			);
		}
	});

	it("no `node:` specifier anywhere", () => {
		for (const { file, source } of wireModules()) {
			expect(source, `${file} must not use node: specifiers`).not.toMatch(
				/"node:[^"]*"/,
			);
		}
	});
});

describe("shared blocks modules are pure shared-src-only runtime", () => {
	const blocksModules = () =>
		sharedModuleSources().filter(({ file }) => file.startsWith(`blocks${sep}`));

	it("has at least one blocks module (the guard is not vacuous)", () => {
		expect(blocksModules().length).toBeGreaterThan(0);
	});

	it("every import/re-export specifier resolves inside shared/src/ — no external packages", () => {
		for (const { file, source } of blocksModules()) {
			const violations = [
				...importStatements(source),
				...exportFromStatements(source),
			].filter((statement) => !resolvesInsideSharedSrc(file, statement.specifier));
			expect(violations, `${file} must import inside shared/src/ only`).toEqual([]);
		}
	});

	it("no side-effect imports (`import \"...\"` with no bindings)", () => {
		for (const { file, source } of blocksModules()) {
			expect(source, `${file} must have no side-effect imports`).not.toMatch(
				/^\s*import\s*["']/m,
			);
		}
	});

	it("no `node:` specifier anywhere", () => {
		for (const { file, source } of blocksModules()) {
			expect(source, `${file} must not use node: specifiers`).not.toMatch(
				/"node:[^"]*"/,
			);
		}
	});
});

describe("shared UI modules are fully pure (no imports at all)", () => {
	it("has at least one UI module (the guard is not vacuous)", () => {
		expect(sharedModuleSources().filter(({ file }) => FULLY_PURE_MODULES.has(file)).length).toBe(
			FULLY_PURE_MODULES.size,
		);
	});

	it("no import statement of any kind (type or value)", () => {
		for (const { file, source } of sharedModuleSources()) {
			if (!FULLY_PURE_MODULES.has(file)) continue;
			const violations = [...source.matchAll(/^\s*import\b/gm)];
			expect(violations, `${file} must not import`).toEqual([]);
		}
	});

	it("no re-export from another module (`export ... from`)", () => {
		for (const { file, source } of sharedModuleSources()) {
			if (!FULLY_PURE_MODULES.has(file)) continue;
			const EXPORT_FROM = /^\s*export\s[^;]*?\bfrom\s+"/gm;
			const violations = [...source.matchAll(EXPORT_FROM)];
			expect(violations, `${file} must not re-export`).toEqual([]);
		}
	});
});

describe("src/server/views.ts (the serializer half) purity", () => {
	const source = readFileSync(SERVER_VIEWS_PATH, "utf8");

	it("has at least one import (the guard is not vacuous)", () => {
		expect(importStatements(source).length).toBeGreaterThan(0);
	});

	it("no side-effect imports (`import \"...\"` with no bindings)", () => {
		expect(source).not.toMatch(/^\s*import\s*["']/m);
	});

	it("every `export ... from` re-export is `export type` (or the sanctioned JSONL_CONTENT_TYPE re-export)", () => {
		const violations = exportFromStatements(source).filter(
			(statement) =>
				!statement.head.startsWith("type ") &&
				// The one runtime re-export: the wire constant owned by the
				// shared package (a pure string constant, client-safe).
				!(
					statement.head.startsWith("{ JSONL_CONTENT_TYPE }") &&
					statement.specifier === "@sigrun/shared/views"
				),
		);
		expect(violations).toEqual([]);
	});

	it("every import is `import type` — no runtime module imports", () => {
		const violations = importStatements(source).filter(
			(statement) => !statement.head.startsWith("type "),
		);
		expect(violations).toEqual([]);
	});

	it("no `node:` specifier anywhere in the module", () => {
		expect(source).not.toMatch(/"node:[^"]*"/);
	});

	it("never imports the route module (no back-reference to index.js)", () => {
		const violations = importStatements(source).filter((statement) =>
			/(^|\/)index\.js$/.test(statement.specifier),
		);
		expect(violations).toEqual([]);
	});
});
