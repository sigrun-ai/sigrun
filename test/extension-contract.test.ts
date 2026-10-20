/**
 * Core hardening W5 Task 1: the ONE documented contract type,
 * `sigrun/extension` (spec §9.1 — types-in-main-package ruling).
 *
 * The subpath is TYPES-ONLY: `npm run build` emits `dist/extension.d.ts`
 * with no runtime `.js` beside it, and the emitted declarations import
 * only the contract allowlist (`@earendil-works/pi-durable`,
 * `@earendil-works/pi-ai`, `@sigrun/shared/*`) — the same packages the
 * loader links into an extension packages dir, so a consumer needs
 * nothing else to type-check against the contract.
 *
 * The consumer check compiles a real fixture factory result and host
 * usage against the EMITTED d.ts through a `paths` mapping (the stand-in
 * for an installed `sigrun` package's exports map) — the way an
 * extension package consumes the contract at ITS compile time.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/** Repo root (test/ → ..): where `npm run build` emits dist/. */
const REPO_ROOT = realpathSync(join(import.meta.dirname, ".."));

/** The consumer fixture dir (its own tsconfig maps `sigrun/extension`). */
const CONSUMER = join(REPO_ROOT, "test", "fixtures", "contract-consumer");

/** Run the root build (shared workspace build, root tsc, then the
 * contract declaration pass). Per-test like test/build.test.ts: each
 * test proves the CURRENT tree builds. */
function build(): void {
	execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "pipe" });
}

/** The repo's own tsc, invoked the way an external consumer would. */
function typecheckConsumer(): void {
	execFileSync(
		process.execPath,
		[
			join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"),
			"--noEmit",
			"-p",
			join(CONSUMER, "tsconfig.json"),
		],
		{ cwd: REPO_ROOT, stdio: "pipe" },
	);
}

describe("sigrun/extension (the documented contract type)", () => {
	test("npm run build emits dist/extension.d.ts with NO runtime extension.js", () => {
		rmSync(join(REPO_ROOT, "dist"), { recursive: true, force: true });
		build();
		expect(existsSync(join(REPO_ROOT, "dist", "extension.d.ts"))).toBe(true);
		// Types-only subpath: no runtime entry may exist beside the d.ts —
		// importing "sigrun/extension" at runtime fails loud by design.
		expect(existsSync(join(REPO_ROOT, "dist", "extension.js"))).toBe(false);
	}, 240_000);

	test("the emitted d.ts imports only the contract allowlist", () => {
		const declarations = readFileSync(
			join(REPO_ROOT, "dist", "extension.d.ts"),
			"utf8",
		);
		// Declaration lines only (anchored): doc-comment code snippets may
		// legitimately mention other specifiers — they import nothing.
		const specifiers = [
			...declarations.matchAll(/^(?:import|export)[^\n]*?from\s+"([^"]+)"/gm),
		].map((match) => match[1]!);
		// A non-empty import surface is the point: the contract references
		// real shared/upstream types, never a re-declared copy.
		expect(specifiers.length).toBeGreaterThan(0);
		for (const specifier of specifiers) {
			expect(
				specifier.startsWith("@earendil-works/pi-durable") ||
					specifier.startsWith("@earendil-works/pi-ai") ||
					specifier.startsWith("@sigrun/shared/"),
				`disallowed import "${specifier}" in dist/extension.d.ts`,
			).toBe(true);
		}
	});

	test("a consumer fixture type-checks against the emitted d.ts", () => {
		build();
		expect(() => typecheckConsumer()).not.toThrow();
	}, 240_000);
});
