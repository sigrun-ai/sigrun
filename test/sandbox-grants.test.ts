/**
 * Multi-user M1 Task 3: grant paths are resolved through realpath BEFORE
 * either direction of a containment check. Core-owned directories are not
 * extension directories; the source guard keeps that distinction visible.
 */

import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import type { DirectoryUser } from "../src/harness/identity/users.js";
import { RESERVED_EXTENSION_SLUGS } from "../src/harness/reserved-sections.js";
import type { ManagedPaths } from "../src/sandbox/grants.js";
import { revalidate, validateGrantPath } from "../src/sandbox/grants.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(): Promise<{ dir: string; managed: ManagedPaths }> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-grants-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const managed: ManagedPaths = {
		roots: {
			configDir: join(dir, "config"),
			dataDir: join(dir, "data"),
			cacheDir: join(dir, "cache"),
			stateDir: join(dir, "state"),
		},
		storagePath: join(dir, "data", "sigrun.db"),
		coreRoot: join(dir, "core"),
		userAreas: (user) => join(dir, "data", "users", user),
	};
	await Promise.all(
		[...Object.values(managed.roots), managed.coreRoot].map((path) =>
			mkdir(path, { recursive: true }),
		),
	);
	return { dir, managed };
}

function reason(path: string, managed: ManagedPaths, user = "alice"): string {
	const result = validateGrantPath(path, { managed, user });
	expect(result.ok).toBe(false);
	return result.ok ? "" : result.reason;
}

describe("validateGrantPath", () => {
	test("refuses / and each ancestor-or-equal protected path with a specific reason", async () => {
		const { dir, managed } = await fixture();
		expect(reason("/", managed)).toContain("configDir");
		expect(reason(managed.roots.configDir, managed)).toContain("configDir");
		expect(reason(dir, managed)).toContain("configDir");
		const storageParent = dirname(managed.storagePath);
		expect(reason(storageParent, managed)).toContain("dataDir");
		await mkdir(join(dir, "data", "users"));
		expect(reason(join(dir, "data"), managed)).toContain("dataDir");
		expect(reason(join(dir, "data", "users"), managed)).toContain("dataDir/users");
		expect(reason(managed.coreRoot, managed)).toContain("coreRoot");
	});

	test("refuses paths inside config/state/cache and core, but not all of dataDir", async () => {
		const { managed } = await fixture();
		for (const [root, label] of [
			[managed.roots.configDir, "configDir"],
			[managed.roots.stateDir, "stateDir"],
			[managed.roots.cacheDir, "cacheDir"],
			[managed.coreRoot, "coreRoot"],
		] as const) {
			const child = join(root, "child");
			await mkdir(child);
			expect(reason(child, managed)).toContain(label);
		}
		const storage = managed.storagePath;
		await mkdir(dirname(storage), { recursive: true });
		await mkdir(storage);
		expect(reason(storage, managed)).toContain("storagePath");
		const storageChild = join(storage, "child");
		await mkdir(storageChild);
		expect(reason(storageChild, managed)).toContain("storagePath");
		const dataWorkspace = join(managed.roots.dataDir, "workspace");
		await mkdir(dataWorkspace);
		expect(validateGrantPath(dataWorkspace, { managed, user: "alice" })).toEqual({
			ok: true,
			realpath: await realpath(dataWorkspace),
		});
	});

	test("permits only alice's own user area", async () => {
		const { managed } = await fixture();
		const own = managed.userAreas("alice");
		await mkdir(join(own, "workspace"), { recursive: true });
		expect(
			validateGrantPath(join(own, "workspace"), { managed, user: "alice" }),
		).toEqual({ ok: true, realpath: await realpath(join(own, "workspace")) });
		expect(reason(join(own, "workspace"), managed, "bob")).toContain(
			"another user's area",
		);
	});

	test("an existing foreign data extension is protected in both directions", async () => {
		const { managed } = await fixture();
		const extension = join(managed.roots.dataDir, "acme-ext");
		const child = join(extension, "child");
		await mkdir(child, { recursive: true });
		expect(reason(extension, managed)).toBe(
			`path is or contains extension directory ${await realpath(extension)}`,
		);
		expect(reason(child, managed)).toBe(
			`path is inside extension directory ${await realpath(extension)}`,
		);
	});

	test("a symlinked own area does not confer access to another user's target", async () => {
		const { managed } = await fixture();
		const bob = managed.userAreas("bob");
		await mkdir(join(bob, "workspace"), { recursive: true });
		await symlink(bob, managed.userAreas("alice"), "dir");
		const throughAlice = join(managed.userAreas("alice"), "workspace");
		expect(await realpath(throughAlice)).toBe(await realpath(join(bob, "workspace")));
		expect(reason(throughAlice, managed, "alice")).toBe(
			"path is inside another user's area",
		);
	});

	test("core-owned data dirs are not foreign extensions", async () => {
		const { managed } = await fixture();
		for (const name of ["workspace", "models", "users"]) {
			const child = join(managed.roots.dataDir, name, "child");
			await mkdir(child, { recursive: true });
			if (name === "users") {
				expect(reason(child, managed)).toContain("another user's area");
			} else {
				expect(validateGrantPath(child, { managed, user: "alice" }).ok).toBe(true);
			}
		}
	});

	test("a symlink to config is refused after realpath; an ordinary symlink stores its realpath", async () => {
		const { dir, managed } = await fixture();
		const link = join(dir, "config-link");
		await symlink(managed.roots.configDir, link, "dir");
		expect(reason(link, managed)).toContain("configDir");
		const target = join(dir, "outside");
		await mkdir(target);
		const ordinary = join(dir, "ordinary-link");
		await symlink(target, ordinary, "dir");
		expect(validateGrantPath(ordinary, { managed, user: "alice" })).toEqual({
			ok: true,
			realpath: await realpath(target),
		});
	});

	test("missing and relative paths fail closed", async () => {
		const { managed } = await fixture();
		expect(reason(join(managed.roots.dataDir, "missing"), managed)).toContain(
			"does not exist or cannot be resolved",
		);
		expect(reason("workspace", managed)).toBe("path must be absolute");
	});
});

test("coreRoot itself and a child are refused even when it is not a store ancestor", async () => {
	const { dir, managed } = await fixture();
	const core = join(dir, "separate-core");
	await mkdir(join(core, "child"), { recursive: true });
	const separate = { ...managed, coreRoot: core };
	expect(reason(core, separate)).toBe("path is or contains coreRoot");
	expect(reason(join(core, "child"), separate)).toBe("path is inside coreRoot");
});

test("revalidate fails after dataDir moves underneath an existing grant", async () => {
	const { dir, managed } = await fixture();
	const workspace = join(dir, "workspace");
	await mkdir(workspace);
	const record: DirectoryUser = {
		user: "alice",
		admin: false,
		createdAt: 1,
		source: "cli",
		workspace,
		grants: [{ path: workspace, access: "rw" }],
	};
	expect(revalidate(record, managed)).toEqual({ ok: true });
	const moved: ManagedPaths = {
		...managed,
		roots: { ...managed.roots, dataDir: join(workspace, "new-data") },
	};
	expect(revalidate(record, moved)).toEqual({
		ok: false,
		reason: expect.stringContaining("dataDir"),
	});
});

/** Find join calls without letting an unterminated call cross a statement. */
function joinCalls(source: string): Array<{ args: string; end: number }> {
	const calls: Array<{ args: string; end: number }> = [];
	for (const match of source.matchAll(/\bjoin\s*\(/g)) {
		const argsStart = match.index + match[0].length;
		let depth = 1;
		for (let index = argsStart; index < source.length; index++) {
			const char = source[index];
			if (char === ";") break;
			if (char === "(") depth++;
			if (char !== ")") continue;
			depth--;
			if (depth === 0) {
				calls.push({ args: source.slice(argsStart, index), end: index });
				break;
			}
		}
	}
	return calls;
}

/** Extract only literal directory arguments to node:path.join. */
export function coreDirectoryLiterals(source: string): string[] {
	const roots = new Set([
		"configDir",
		"dataDir",
		"cacheDir",
		"stateDir",
		"dir",
		"current",
	]);
	const directories: string[] = [];
	for (const call of joinCalls(source)) {
		const { args } = call;
		const literals = [...args.matchAll(/"([^"\\]+)"/g)].map((item) => item[1]);
		if (literals.length === 0) continue;
		const root = args.slice(0, args.indexOf(literals[0] ? `"${literals[0]}"` : ""));
		if (![...roots].some((name) => new RegExp(`\\b${name}\\b`).test(root))) continue;
		// A later literal with a file extension means the first literal is an
		// intermediate segment, not the direct directory this call constructs.
		if (literals.slice(1).some((literal) => /\.[a-z0-9]+$/i.test(literal))) {
			continue;
		}
		const directory = literals[0];
		if (
			directory === undefined ||
			/\.[a-z0-9]+$/i.test(directory) ||
			directory.includes("/") ||
			directory.startsWith(".") ||
			directory.startsWith("@") ||
			directory === "node_modules" ||
			directory === "dist" ||
			directory === "target" ||
			directory === "release"
		) {
			continue;
		}
		directories.push(directory);
	}
	return directories;
}

describe("reserved extension slugs", () => {
	test("the source guard finds known core dirs and no filenames are swept in", async () => {
		const root = fileURLToPath(new URL("../src/", import.meta.url));
		const found = new Set<string>();
		async function walk(dir: string): Promise<void> {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) await walk(path);
				else if (entry.name.endsWith(".ts")) {
					for (const literal of coreDirectoryLiterals(await readFile(path, "utf8"))) {
						found.add(literal);
					}
				}
			}
		}
		await walk(root);
		for (const known of ["workspace", "models", "skills", "prompts", "packages", "git"]) {
			expect(found.has(known), `source guard did not find ${known}`).toBe(true);
		}
		expect(found.has("auth.json")).toBe(false);
		expect(found.has("settings.json")).toBe(false);
		const reserved = new Set<string>(RESERVED_EXTENSION_SLUGS);
		expect([...found].filter((literal) => !reserved.has(literal))).toEqual([]);
	});

	test("the extractor is non-vacuous and discriminates directories from files", () => {
		const source = [
			'const a = join(configDir, "packages");',
			'const b = join(dataDir, "models");',
			'const c = join(configDir, "settings.json");',
			'const d = join(unresolvedRoot, "not-core-owned");',
			'const e = join(configDir, "nested", "package.json");',
			'const f = join(configDir,\n  "new-core-dir"\n);',
		].join("\n");
		expect(coreDirectoryLiterals(source)).toEqual([
			"packages",
			"models",
			"new-core-dir",
		]);
	});
});
