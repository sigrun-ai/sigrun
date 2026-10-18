/**
 * The views.ts purity guard (the channel-contract rule) — and the
 * `src/shared/*.ts` purity guard (Task B1, UI refresh).
 *
 * `src/server/views.ts` is sigrun's sole wire-type leaf: both clients
 * (webui — DOM-only, bundler resolution; tui — NodeNext) import it
 * directly, and it is the intended basis for a generated OpenAPI schema.
 * To keep that true, the module must stay PURE:
 *
 * - every import is `import type` (no runtime module imports — a runtime
 *   import would drag server-only code into client bundles), and there
 *   are no side-effect imports (`import "..."` — the same drag with no
 *   names to lint);
 * - every `export ... from` re-export is `export type` (a runtime
 *   re-export drags the source module in exactly like a runtime import);
 * - no `node:` specifiers anywhere (the webui compiles without
 *   `@types/node`);
 * - never an import from the route module (`./index.js`) — types move
 *   FROM the route module TO views.ts, never the reverse.
 *
 * This is a lint-style guard over the module TEXT, not a parser: the
 * regexes are deliberately simple and the module's own conventions (one
 * import per statement, no inline string literals carrying "node:" or
 * "./index.js") keep them exact. A false positive here means the module
 * picked up a shape the guard can't see through — tighten the module,
 * not the guard.
 *
 * `src/shared/*.ts` is under a stricter contract: the UI-refresh shared
 * modules (themes, turns, conversations) are consumed by BOTH clients
 * from one source, so they may not import anything at all — no runtime
 * imports, no `import type`, no re-exports. A type dependency would
 * reintroduce the exact two-client drift these modules remove. Guarded
 * over the module TEXT the same lint-style way.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const VIEWS_PATH = join(__dirname, "..", "src", "server", "views.ts");
const source = readFileSync(VIEWS_PATH, "utf8");

const SHARED_DIR = join(__dirname, "..", "src", "shared");

function sharedModuleSources(): { file: string; source: string }[] {
	return readdirSync(SHARED_DIR)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => ({
			file: name,
			source: readFileSync(join(SHARED_DIR, name), "utf8"),
		}));
}

// One import per statement; the `import ... from "specifier"` form only
// (views.ts has no side-effect imports). Multiline named lists included.
const IMPORT_STATEMENTS = /^\s*import\s(.*?)\bfrom\s+"([^"]+)";/gms;

function importStatements(): { head: string; specifier: string }[] {
	const found: { head: string; specifier: string }[] = [];
	for (const match of source.matchAll(IMPORT_STATEMENTS)) {
		found.push({ head: match[1], specifier: match[2] });
	}
	return found;
}

describe("views.ts channel-contract purity", () => {
	it("has at least one import (the guard is not vacuous)", () => {
		expect(importStatements().length).toBeGreaterThan(0);
	});

	it("no side-effect imports (`import \"...\"` with no bindings)", () => {
		expect(source).not.toMatch(/^\s*import\s*["']/m);
	});

	it("every `export ... from` re-export is `export type`", () => {
		// `[^;]` keeps the match inside one statement — an `export interface`
		// body carries semicolons, so the scan cannot span from a local
		// declaration forward to some distant re-export's `from`.
		const EXPORT_FROM = /^\s*export\s([^;]*?)\bfrom\s+"([^"]+)";/gm;
		const violations = [...source.matchAll(EXPORT_FROM)].filter(
			(match) => !match[1].startsWith("type "),
		);
		expect(violations).toEqual([]);
	});

	it("every import is `import type` — no runtime module imports", () => {
		const violations = importStatements().filter(
			(statement) => !statement.head.startsWith("type "),
		);
		expect(violations).toEqual([]);
	});

	it("no `node:` specifier anywhere in the module", () => {
		expect(source).not.toMatch(/"node:[^"]*"/);
	});

	it("never imports the route module (no back-reference to index.js)", () => {
		const violations = importStatements().filter((statement) =>
			/(^|\/)index\.js$/.test(statement.specifier),
		);
		expect(violations).toEqual([]);
	});
});

describe("src/shared modules are fully pure (no imports at all)", () => {
	it("has at least one shared module (the guard is not vacuous)", () => {
		expect(sharedModuleSources().length).toBeGreaterThan(0);
	});

	it("no import statement of any kind (type or value)", () => {
		for (const { file, source: text } of sharedModuleSources()) {
			const violations = [...text.matchAll(/^\s*import\b/gm)];
			expect(violations, `${file} must not import`).toEqual([]);
		}
	});

	it("no re-export from another module (`export ... from`)", () => {
		for (const { file, source: text } of sharedModuleSources()) {
			const EXPORT_FROM = /^\s*export\s[^;]*?\bfrom\s+"/gm;
			const violations = [...text.matchAll(EXPORT_FROM)];
			expect(violations, `${file} must not re-export`).toEqual([]);
		}
	});
});
