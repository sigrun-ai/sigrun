/**
 * Task 2: the chart settings seeder — `docker/seed-settings.sh`, the
 * GitOps re-assert for chart-owned config (image workflow spec §4).
 *
 * Contract under test (argv are JSON strings the chart renders via
 * toJson — never omitted; empty means `[]`/`{}`):
 *
 *   seed-settings.sh CONFIG_DIR FLEET_JSON SETTINGS_JSON EXT_SETTINGS_JSON
 *
 * - SETTINGS_JSON merges into CONFIG_DIR/settings.json: foreign keys
 *   preserved, chart keys overwritten WHOLESALE (a sub-key removed from
 *   values must vanish from the file on next boot — the revert half of
 *   GitOps), and `extensions` set to the FLEET_JSON array (an EMPTY
 *   fleet still writes `extensions: []`: removing an extension from
 *   values removes it from the file).
 * - Each slug in EXT_SETTINGS_JSON seeds CONFIG_DIR/settings/<slug>.json
 *   ONLY if absent — after first boot the extension owns the file (the
 *   server-mediated settings store writes there at runtime), so a
 *   values re-assert must never clobber it.
 * - Malformed argv JSON exits nonzero naming the argument (fail loud:
 *   a bad chart render CrashLoops the initContainer, never half-seeds).
 *
 * The script runs through `sh` (git keeps docker/*.sh mode 0644 — the
 * image chmods at COPY time; the test must not depend on the exec bit)
 * and jq is the parser (already a runtime image dep, Task 1).
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

/** Repo root (test/ → ..): where docker/seed-settings.sh lives. */
const REPO_ROOT = join(import.meta.dirname, "..");

/** The script under test (executed via `sh`, see file header). */
const SCRIPT = join(REPO_ROOT, "docker", "seed-settings.sh");

/** One seeder invocation's observable outcome (never throws — the
 * assertions own what "failed" means per test). */
interface RunResult {
	readonly code: number;
	readonly stderr: string;
}

/** execFile the seeder with its four positional argv. */
function run(
	configDir: string,
	fleet: string,
	settings: string,
	extSettings: string,
): Promise<RunResult> {
	return new Promise((resolve) => {
		execFile(
			"sh",
			[SCRIPT, configDir, fleet, settings, extSettings],
			{ timeout: 30_000 },
			(error, _stdout, stderr) => {
				resolve({
					code:
						error === null
							? 0
							: typeof error.code === "number"
								? error.code
								: 1,
					stderr,
				});
			},
		);
	});
}

/** Read + parse one JSON file the seeder wrote (throws if unreadable —
 * every test wants exactly that loudness). */
async function readJson(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

test(
	"empty config: creates the tree, seeds settings.json (fleet + chart settings) and per-slug files",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-seed-fresh-"));
		// The config dir itself is ABSENT: a fresh volume must not need a
		// pre-created tree (mkdir -p inside the script owns config/ AND
		// config/settings/).
		const configDir = join(dir, "config");
		try {
			const result = await run(
				configDir,
				'["@sigrun/memory-markdown@^0.1.0"]',
				'{"builtinExtensions":{"mcp":true,"codemode":true,"toolSearch":true}}',
				'{"memory-markdown":{"noteRoot":"/data/notes"}}',
			);
			expect(result.code).toBe(0);
			expect(result.stderr).toBe("");
			expect(await readJson(join(configDir, "settings.json"))).toEqual({
				builtinExtensions: {
					mcp: true,
					codemode: true,
					toolSearch: true,
				},
				extensions: ["@sigrun/memory-markdown@^0.1.0"],
			});
			expect(
				await readJson(join(configDir, "settings", "memory-markdown.json")),
			).toEqual({ noteRoot: "/data/notes" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"re-assert: foreign keys survive, chart keys are overwritten wholesale, extensions replaced",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-seed-merge-"));
		const configDir = join(dir, "config");
		await mkdir(join(configDir, "settings"), { recursive: true });
		// `server` + `operatorKey` are FOREIGN (admin-API/operator writes
		// the chart knows nothing about); `builtinExtensions` is a CHART
		// key whose values-declared object DROPS a sub-key (`toolSearch`)
		// that the file carries — the wholesale-overwrite half of the
		// contract; `extensions` is stale fleet state the new list replaces.
		await writeFile(
			join(configDir, "settings.json"),
			JSON.stringify({
				server: { port: 3123, host: "127.0.0.1" },
				operatorKey: "keep-me",
				builtinExtensions: { mcp: true, toolSearch: true },
				extensions: ["stale-ext@0.0.1"],
			}),
		);
		try {
			const result = await run(
				configDir,
				'["@sigrun/memory-markdown@^0.1.0"]',
				'{"builtinExtensions":{"mcp":false}}',
				"{}",
			);
			expect(result.code).toBe(0);
			expect(await readJson(join(configDir, "settings.json"))).toEqual({
				server: { port: 3123, host: "127.0.0.1" },
				operatorKey: "keep-me",
				builtinExtensions: { mcp: false },
				extensions: ["@sigrun/memory-markdown@^0.1.0"],
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"seed-once: an existing settings/<slug>.json is untouched; absent slugs are seeded",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-seed-once-"));
		const configDir = join(dir, "config");
		await mkdir(join(configDir, "settings"), { recursive: true });
		// The operator (or the extension's own surface) moved noteRoot
		// after first boot — the seeder must leave the file byte-identical
		// in CONTENT, while a slug with no file yet gets seeded.
		const owned = join(configDir, "settings", "memory-markdown.json");
		const ownedContent = `${JSON.stringify({
			noteRoot: "/custom/operator/path",
		})}\n`;
		await writeFile(owned, ownedContent);
		try {
			const result = await run(
				configDir,
				"[]",
				"{}",
				'{"memory-markdown":{"noteRoot":"/data/notes"},"sample-ext":{"alpha":1}}',
			);
			expect(result.code).toBe(0);
			// Seed-once: unchanged, verbatim (not even reformatted).
			expect(await readFile(owned, "utf8")).toBe(ownedContent);
			// The absent slug WAS seeded with its declared object.
			expect(
				await readJson(join(configDir, "settings", "sample-ext.json")),
			).toEqual({ alpha: 1 });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"empty fleet still re-asserts extensions: [] (removal semantics)",
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-seed-empty-"));
		const configDir = join(dir, "config");
		await mkdir(configDir, { recursive: true });
		await writeFile(
			join(configDir, "settings.json"),
			JSON.stringify({ extensions: ["gone-ext@1.0.0"] }),
		);
		try {
			// The chart passes [] — never omits the argument. Removing an
			// extension from values REMOVES it from the file.
			const result = await run(configDir, "[]", "{}", "{}");
			expect(result.code).toBe(0);
			expect(await readJson(join(configDir, "settings.json"))).toEqual({
				extensions: [],
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("malformed argv JSON fails loud, naming the argument", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-seed-badjson-"));
	const configDir = join(dir, "config");
	try {
		// Unparseable fleet: nonzero, and the message NAMES the argument
		// (a chart render bug must point at the offending values key).
		const unparseable = await run(
			configDir,
			"{not-json",
			"{}",
			"{}",
		);
		expect(unparseable.code).not.toBe(0);
		expect(unparseable.stderr).toMatch(/FLEET_JSON/);

		// Wrong SHAPE parses but is rejected equally loudly: the fleet
		// must be an array, per-extension settings an object.
		const wrongShape = await run(configDir, "{}", "[]", '{"a-slug": 7}');
		expect(wrongShape.code).not.toBe(0);
		expect(wrongShape.stderr).toMatch(/FLEET_JSON/);
		expect(wrongShape.stderr).toMatch(/SETTINGS_JSON/);
		expect(wrongShape.stderr).toMatch(/EXT_SETTINGS_JSON/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
