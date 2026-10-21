/**
 * Guard (release 0.1): no CODE references the deleted placeholder gating
 * extension package. It was never pushed to a remote and never published;
 * docs and specs may keep the concept, and the seam doc keeps its
 * filename — code may cite that doc by its PATH string, which is the one
 * permitted match — but everything else in the scanned trees must be free
 * of the word.
 *
 * The scanned trees are exactly the code trees: src/, test/, webui/src,
 * webui/e2e, tui/src, shared/src. `test/` includes this file, so the
 * pattern and the permitted doc filename are built from parts — no
 * literal in this file can match itself.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["src", "test", "webui/src", "webui/e2e", "tui/src", "shared/src"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".json"]);

// Built from parts so this file's own source does not trip the guard.
const WORD = ["app", "roval"].join("");
const PATTERN = new RegExp(WORD, "i");
// The seam doc's filename: the one permitted citation (a path, not the
// deleted package).
const PERMITTED_DOC_FILENAME = `${WORD}-ux-seams.md`;

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			yield* walk(full);
		} else if (EXTENSIONS.has(extname(entry.name))) {
			yield full;
		}
	}
}

test("no code references the deleted placeholder gating package", () => {
	const violations: string[] = [];
	for (const scanDir of SCAN_DIRS) {
		const abs = join(ROOT, scanDir);
		if (!existsSync(abs)) continue;
		for (const file of walk(abs)) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, index) => {
				if (PATTERN.test(line.split(PERMITTED_DOC_FILENAME).join(""))) {
					violations.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
				}
			});
		}
	}
	expect(violations, violations.join("\n")).toEqual([]);
});
