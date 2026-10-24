/**
 * The docs examples contract (UI-blocks U6 Task 4): every TypeScript
 * code block in docs/extending.md tagged `ts check` must TYPE-CHECK
 * against the real `@sigrun/sigrun/blocks` builder surface — the exact
 * imports an extension author writes (src/blocks/index.ts, the
 * host-linked copy of the block set). A docs drift (a renamed builder,
 * a removed prop) fails this suite instead of reaching a reader.
 *
 * Method: extract each fenced block whose info string is exactly
 * `ts check`, write it to a scratch tsconfig project under a temp dir,
 * and run the repo's own `tsc` (typescript 7 — the JS compiler API is
 * gone, so the check shells out; tsc 7 native-compile speed keeps this
 * cheap) with a paths mapping resolving `@sigrun/sigrun/blocks` to
 * `src/blocks/index.ts`. The published `exports` entry points at
 * `dist/`, which is gitignored — the test must be green on a pristine
 * checkout. Scratch files land under `os.tmpdir()` (never the repo, so
 * a failed run leaves nothing behind) and are removed in all outcomes.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const docPath = join(root, "docs", "extending.md");
const tscBin = join(root, "node_modules", "typescript", "bin", "tsc");

interface CheckedExample {
	/** 1-based index among `ts check` blocks, for failure messages. */
	readonly index: number;
	/** The doc line the fence opens on (1-based), for failure messages. */
	readonly line: number;
	readonly source: string;
}

/** Extract every ```ts check fence, in document order. */
export function extractCheckedExamples(markdown: string): readonly CheckedExample[] {
	const out: CheckedExample[] = [];
	const fence = /^```(\S[^\n]*)?$/;
	const lines = markdown.split("\n");
	let at = 0;
	while (at < lines.length) {
		const open = fence.exec(lines[at]);
		if (open === null || open[1]?.trim() !== "ts check") {
			at += 1;
			continue;
		}
		const startLine = at + 1; // 1-based line of the opening fence
		const body: string[] = [];
		at += 1;
		while (at < lines.length && lines[at] !== "```") {
			body.push(lines[at]);
			at += 1;
		}
		if (at >= lines.length) {
			throw new Error(`unclosed \`\`\`ts check fence opened at docs/extending.md:${startLine}`);
		}
		out.push({ index: out.length + 1, line: startLine, source: body.join("\n") });
		at += 1;
	}
	return out;
}

/** Compile one example with the repo's tsc; returns stderr+stdout on failure. */
function checkExample(example: CheckedExample): { ok: boolean; output: string } {
	const scratch = mkdtempSync(join(tmpdir(), "sigrun-docs-example-"));
	try {
		writeFileSync(join(scratch, "example.ts"), example.source);
		// Mirror the repo tsconfig (strict, NodeNext) with the one deviation
		// the docs surface needs: the authoring subpath resolves to source.
		writeFileSync(
			join(scratch, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					target: "ES2023",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					esModuleInterop: true,
					skipLibCheck: true,
					noEmit: true,
					types: ["node"],
					typeRoots: [join(root, "node_modules", "@types")],
					paths: {
						"@sigrun/sigrun/blocks": [join(root, "src", "blocks", "index.ts")],
					},
				},
				include: ["example.ts"],
			}),
		);
		const run = spawnSync(process.execPath, [tscBin, "-p", join(scratch, "tsconfig.json")], {
			cwd: scratch,
			encoding: "utf8",
		});
		const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
		return { ok: run.status === 0, output };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

describe("docs/extending.md `ts check` examples", () => {
	const markdown = readFileSync(docPath, "utf8");
	const examples = extractCheckedExamples(markdown);

	it("finds at least one checked example", () => {
		expect(examples.length).toBeGreaterThan(0);
	});

	for (const example of examples) {
		it(`example ${example.index} (docs/extending.md:${example.line}) type-checks`, () => {
			const result = checkExample(example);
			expect(result.ok, result.output).toBe(true);
		});
	}
});
