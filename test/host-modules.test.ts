/**
 * Single-copy host-module contract: the loader hands every extension
 * host-module links for the @earendil-works family, and a second, NESTED
 * copy of any of them under node_modules is the silent-failure class the
 * loader's host-module version guard exists to catch — objects from a
 * duplicate module pass structural typing but never the host's identity
 * checks. pi-durable pins its @earendil-works family exactly (1.3.0), so a
 * caret-resolved second version beside them is a bump gone wrong, not a
 * benign extra.
 *
 * Walks the installed tree directly — the root node_modules, every
 * workspace package's node_modules, and every nested node_modules inside an
 * installed package (where npm lands a conflicting version) — with no
 * `npm ls` shell-out: the contract is what is on disk.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The host modules sigrun and its extensions share through the loader. */
const HOST_MODULES = [
	"@earendil-works/pi-durable",
	"@earendil-works/pi-ai",
	"@earendil-works/chord",
	"@earendil-works/pi-codemode",
] as const;

/** `stat` as an existence check (no throw on missing). */
async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/**
 * Every installed copy of `moduleName`'s package.json across the repo's
 * node_modules directories, nested copies included.
 */
async function installedCopies(moduleName: string): Promise<string[]> {
	const rootPackage = JSON.parse(
		await readFile(join(REPO_ROOT, "package.json"), "utf8"),
	) as { workspaces?: string[] };
	// Seed: the root install plus each literal workspace entry's install
	// (glob-shaped entries would own no private node_modules here).
	const queue: string[] = [join(REPO_ROOT, "node_modules")];
	for (const entry of rootPackage.workspaces ?? []) {
		if (entry.includes("*")) continue;
		const candidate = join(REPO_ROOT, entry, "node_modules");
		if (await exists(candidate)) queue.push(candidate);
	}

	const found: string[] = [];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const modulesDir = queue.shift();
		if (modulesDir === undefined || seen.has(modulesDir)) continue;
		seen.add(modulesDir);

		const manifest = join(modulesDir, moduleName, "package.json");
		if (await exists(manifest)) found.push(manifest);

		// Enqueue nested installs inside every package directory here
		// (scoped packages one level deeper, through `@scope/name`).
		const packageDirs: string[] = [];
		for (const item of await readdir(modulesDir, { withFileTypes: true })) {
			if (!item.isDirectory()) continue;
			if (item.name.startsWith("@")) {
				for (const scoped of await readdir(
					join(modulesDir, item.name),
					{ withFileTypes: true },
				)) {
					if (scoped.isDirectory())
						packageDirs.push(join(modulesDir, item.name, scoped.name));
				}
			} else {
				packageDirs.push(join(modulesDir, item.name));
			}
		}
		for (const packageDir of packageDirs) {
			const nested = join(packageDir, "node_modules");
			if (await exists(nested)) queue.push(nested);
		}
	}
	return found;
}

test("exactly one installed copy of each @earendil-works host module", async () => {
	for (const moduleName of HOST_MODULES) {
		const copies = await installedCopies(moduleName);
		expect(
			copies,
			`${moduleName} must resolve to exactly one installed copy (nested duplicates are the silent identity-skew class the loader guard exists for)`,
		).toHaveLength(1);
	}
});

test("the @earendil-works host modules are installed at 1.3.0", async () => {
	for (const moduleName of HOST_MODULES) {
		const copies = await installedCopies(moduleName);
		expect(copies.length, moduleName).toBeGreaterThan(0);
		for (const manifest of copies) {
			const pkg = JSON.parse(await readFile(manifest, "utf8")) as {
				version: string;
			};
			expect(pkg.version, manifest).toBe("1.3.0");
		}
	}
});
