import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
	.split("\0").filter(Boolean);
const PRIVATE_DIRS = ["test-results/", "docs/superpowers/", "docs/interaction-seam-survey/"];
const EXEMPT = new Set(["test/public-tree.test.ts"]);

describe("public tree hygiene", () => {
	test("no tracked file lives under a private or artifact dir", () => {
		expect(tracked.filter((p) => PRIVATE_DIRS.some((d) => p.startsWith(d)))).toEqual([]);
	});
	test("no tracked text file links into the private planning docs", () => {
		const hits = tracked
			.filter((p) => !EXEMPT.has(p) && /\.(ts|tsx|md|json|ya?ml|mjs|js)$/.test(p))
			.filter((p) => /docs\/superpowers|interaction-seam-survey/.test(readFileSync(`${ROOT}${p}`, "utf8")));
		expect(hits).toEqual([]);
	});
	test("playwright pins outputDir so a run from any cwd lands in the ignored path", () => {
		expect(readFileSync(`${ROOT}webui/playwright.config.ts`, "utf8")).toMatch(/outputDir:\s*"test-results"/);
	});
});
