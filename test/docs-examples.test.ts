/**
 * The docs examples contract (UI-blocks U6 Task 4): every TypeScript
 * code block in docs/extending.md tagged `ts check` must TYPE-CHECK
 * against the real `@sigrun/sigrun/blocks` builder surface — the exact
 * imports an extension author writes (src/blocks/index.ts, the
 * host-linked copy of the block set). A docs drift (a renamed builder,
 * a removed prop) fails this suite instead of reaching a reader.
 *
 * Method: extract each fenced block whose info string is exactly
 * `ts check` (a near-miss info string — one carrying the word `check`
 * without being exactly `ts check`, e.g. `ts  check` or
 * `ts check title=...` — throws, so a typo fails loudly instead of
 * silently dropping the block from coverage), write it to a scratch
 * tsconfig project under a temp dir, and run the repo's own `tsc`
 * (typescript 7 — the JS compiler API is gone, so the check shells
 * out; tsc 7 native-compile speed keeps this cheap) with a paths
 * mapping resolving `@sigrun/sigrun/blocks` to `src/blocks/index.ts`.
 * The published `exports` entry points at `dist/`, which is gitignored
 * and built by CI before tests run; the source mapping keeps this suite
 * independent of build order. Scratch files land under `os.tmpdir()`
 * (never the repo, so a failed run leaves nothing behind) and are
 * removed in all outcomes.
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
		if (open === null) {
			at += 1;
			continue;
		}
		const info = open[1]?.trim() ?? "";
		if (info !== "ts check") {
			// Near-miss guard: an info string carrying the word `check`
			// that is not exactly `ts check` is a typo, not a plain block
			// — fail loudly so coverage cannot silently shrink.
			if (/(^|\s)check(\s|$)/.test(info)) {
				throw new Error(
					`docs/extending.md:${at + 1}: info string ${JSON.stringify(open[1])} looks like a ` +
						"checked-example fence but is not exactly `ts check`",
				);
			}
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

/**
 * The bind() guard: card/field slots take `Bindable<T>` — a literal
 * `"./label"` type-checks (a string IS a bindable literal) but binds
 * nothing; the author's card would literally read "./label". Any
 * string literal starting with `./` inside a checked block must be an
 * argument of `bind(...)`.
 */
export function findUnboundRelativePointers(
	example: CheckedExample,
): readonly { line: number; literal: string }[] {
	const out: { line: number; literal: string }[] = [];
	const stringLiteral = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
	for (const match of example.source.matchAll(stringLiteral)) {
		const literal = match[2];
		if (!literal.startsWith("./")) continue;
		const at = match.index;
		if (at === undefined) continue;
		// Allow only a direct `bind(` call wrapping this literal.
		const before = example.source.slice(Math.max(0, at - 8), at);
		if (/bind\(\s*$/.test(before)) continue;
		const line = example.source.slice(0, at).split("\n").length;
		out.push({ line, literal });
	}
	return out;
}

describe("docs/extending.md `ts check` examples", () => {
	const markdown = readFileSync(docPath, "utf8");
	const examples = extractCheckedExamples(markdown);

	it("finds at least one checked example", () => {
		expect(examples.length).toBeGreaterThan(0);
	});

	it("never leaves a relative pointer literal unbound (bind() guard)", () => {
		const offenders = examples.flatMap((example) =>
			findUnboundRelativePointers(example).map(
				(hit) =>
					`example ${example.index} (docs/extending.md:${example.line + hit.line}): ` +
					`string literal ${JSON.stringify(hit.literal)} is not an argument of bind(...)`,
			),
		);
		expect(offenders).toEqual([]);
	});

	for (const example of examples) {
		it(`example ${example.index} (docs/extending.md:${example.line}) type-checks`, () => {
			const result = checkExample(example);
			expect(result.ok, result.output).toBe(true);
		});
	}
});
