/**
 * The `@sigrun/tui` package contract (build-and-webui Task 2).
 *
 * `@sigrun/tui` is the publishable SPAWNED terminal client: the CLI no
 * longer imports the tui in-process — it spawns this package's
 * `sigrun-tui` bin (`node <resolved dist/launch.js>`) as a child process.
 * This test pins the packaging invariants the spawn depends on:
 *
 * - `tsc -p tsconfig.build.json` emits `dist/launch.js` from
 *   `src/launch.ts` (the bin's compiled entry — a stale or missing build
 *   fails loud here, not as a cryptic child-process crash);
 * - the manifest maps the `sigrun-tui` bin at that entry, is publishable
 *   (not private, ships `dist`), and declares its REAL runtime
 *   dependencies (`@earendil-works/pi-tui`, `@sigrun/shared`) — the
 *   workspace currently relies on root hoisting, which an installed copy
 *   does not have.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const TUI_ROOT = join(__dirname, "..");
/** The tsc launcher (typescript's `bin/tsc` runs under plain node). */
const TSC = join(
	dirname(require.resolve("typescript/package.json")),
	"bin",
	"tsc",
);

function buildTui(): void {
	execFileSync(process.execPath, [TSC, "-p", "tsconfig.build.json"], {
		cwd: TUI_ROOT,
	});
}

describe("tui packaging (Task 2: the spawned @sigrun/tui bin)", () => {
	it("builds to dist with a bin entry", () => {
		buildTui();
		expect(existsSync(join(TUI_ROOT, "dist", "launch.js"))).toBe(true);
		const manifest = JSON.parse(
			readFileSync(join(TUI_ROOT, "package.json"), "utf8"),
		) as {
			bin?: Record<string, string>;
			private?: boolean;
			files?: string[];
			dependencies?: Record<string, string>;
		};
		// The spawn contract: bin name → the compiled launch entry.
		expect(manifest.bin?.["sigrun-tui"]).toBe("dist/launch.js");
	});

	it("is publishable and ships dist", () => {
		const manifest = JSON.parse(
			readFileSync(join(TUI_ROOT, "package.json"), "utf8"),
		) as { private?: boolean; files?: string[] };
		expect(manifest.private).toBeUndefined();
		expect(manifest.files).toContain("dist");
	});

	it("declares the real runtime dependencies (no root-hoisting reliance)", () => {
		const manifest = JSON.parse(
			readFileSync(join(TUI_ROOT, "package.json"), "utf8"),
		) as { dependencies?: Record<string, string> };
		// The forms match the root manifest's entries for the same packages.
		expect(manifest.dependencies?.["@earendil-works/pi-tui"]).toBeDefined();
		expect(manifest.dependencies?.["@sigrun/shared"]).toBeDefined();
	});

	it("the emitted bin starts with a node shebang (npm bin executables)", () => {
		buildTui();
		const head = readFileSync(join(TUI_ROOT, "dist", "launch.js"), "utf8");
		expect(head.startsWith("#!/usr/bin/env node")).toBe(true);
	});

	it("runs main when invoked through a symlinked .bin entry (regression)", () => {
		// npm bin entries are SYMLINKS (…/.bin/sigrun-tui → the package's
		// dist/launch.js). Node realpaths the main module by default — so
		// import.meta.url inside the bin is the REAL path — while
		// process.argv[1] keeps the INVOKED symlink path. If the bin-entry
		// detection compares those two raw, a .bin/npx invocation mismatches,
		// main never runs, and the process exits 0 SILENTLY (the published
		// bin's canonical invocation). Reproduce that exact shape here: spawn
		// the built bin THROUGH a symlink and prove main ran — the unknown
		// flag makes tuiMain print usage and exit 1, which only happens if
		// the entry detection matched.
		buildTui();
		const dir = mkdtempSync(join(tmpdir(), "sigrun-tui-bin-"));
		try {
			const link = join(dir, "sigrun-tui");
			symlinkSync(join(TUI_ROOT, "dist", "launch.js"), link);
			const result = spawnSync(process.execPath, [link, "--nonsense"], {
				encoding: "utf8",
			});
			// Silent exit 0 (status 0, empty stderr) is the regression.
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("unknown argument");
			expect(result.stderr).toContain("usage: sigrun-tui");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
