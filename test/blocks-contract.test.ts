/** The public blocks export ships real declarations and an external consumer
 * resolves those declarations through the package export. */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..");

test("@sigrun/sigrun/blocks packs declarations and type-checks a consumer", () => {
	const dir = mkdtempSync(join(tmpdir(), "sigrun-blocks-contract-"));
	try {
		const dist = join(dir, "dist");
		execFileSync(
			process.execPath,
			[join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", join(ROOT, "tsconfig.extension.json"), "--outDir", dist],
			{ cwd: ROOT, stdio: "pipe" },
		);
		const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
			exports: { "./blocks": { types: string } };
		};
		copyFileSync(join(ROOT, "dist", "blocks", "index.js"), join(dist, "blocks", "index.js"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({
			...manifest,
			files: ["dist"],
			dependencies: {},
			optionalDependencies: {},
		}));
		expect(existsSync(join(dir, manifest.exports["./blocks"].types))).toBe(true);

		const packed = JSON.parse(execFileSync(
			"npm", ["pack", "--dry-run", "--json", "--ignore-scripts"],
			{ cwd: dir, encoding: "utf8" },
		)) as [{ files: { path: string }[] }];
		expect(packed[0].files.map((file) => file.path)).toContain("dist/blocks/index.d.ts");

		const consumer = join(dir, "consumer");
		mkdirSync(consumer);
		mkdirSync(join(dir, "node_modules", "@sigrun"), { recursive: true });
		symlinkSync(dir, join(dir, "node_modules", "@sigrun", "sigrun"), "dir");
		writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
			compilerOptions: {
				strict: true,
				target: "ES2023",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				noEmit: true,
				skipLibCheck: true,
				types: [join(ROOT, "node_modules", "@types", "node")],
				paths: {
					"@sigrun/shared/*": [join(ROOT, "shared", "dist") + "/*"],
				},
			},
		}));
		writeFileSync(
			join(consumer, "consumer.ts"),
			'import { markdown, tree, validateTree } from "@sigrun/sigrun/blocks";\nconst value = tree(markdown({ markdown: "ok" }));\nvalidateTree(value, { placement: "settings", handlers: new Set() });\n',
		);
		expect(() => execFileSync(
			process.execPath,
			[join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", join(consumer, "tsconfig.json")],
			{ cwd: ROOT, stdio: "inherit" },
		)).not.toThrow();
		const require = createRequire(join(dir, "consumer", "package.json"));
		expect(require.resolve("@sigrun/sigrun/blocks")).toBe(join(dist, "blocks", "index.js"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000);
