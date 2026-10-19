/**
 * Task 1: the core tool surface — coding tools (read/write/edit/bash, with
 * the image-read wrapper) and the hand-written search tools
 * (find/grep/ls), installed by `openHarness` for every conversation.
 *
 * Coverage follows the plan's testable lines:
 *
 * - registration: `openHarness` installs both extensions (registry + the
 *   resolved agent's offered tools);
 * - end-to-end (the brief: "read/write/edit/bash work end-to-end via the
 *   server"): a real temp workspace, the faux provider scripting real tool
 *   rounds, assertions against BOTH the disk and the serialized §5 view
 *   (`GET /v1/conversations/:id`) — including the edit result's
 *   `details.diff` on the wire (the webui diff view's input);
 * - image reads: reading a PNG returns inline `ImageContent` (base64 +
 *   sniffed mime), not upstream's `unsupported_image` error;
 * - find/grep/ls: results honor `.gitignore` (pruned directories,
 *   negation, `*.log`), grep skips binary files and reports cwd-relative
 *   `path:line:text` hits;
 * - edge behavior via direct tool execution (a real `NodeExecutionEnv`
 *   rooted at a temp dir — the tools only use `api.env`): result caps,
 *   invalid regex, ls-on-a-file, missing-file reads.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import {
	findTool,
	grepTool,
	isIgnoredPath,
	lsTool,
	parseGitignore,
} from "../src/harness/tools.js";
import type { ProviderContributor } from "../src/harness/providers/index.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import type { FastifyInstance } from "fastify";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";

/** The canonical 1×1 transparent PNG (sniffable as image/png upstream). */
const PNG_1X1_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * A minimal 24-bit 1×1 BMP: the 54-byte header (BITMAPINFOHEADER, planes 1,
 * bpp 24) plus one 4-byte BGR pixel row. Upstream sniffs it as image/bmp but
 * has no inline support for BMP, so the wrapper's rescue path carries it.
 */
const BMP_1X1 = (() => {
	const header = Buffer.alloc(54);
	header.write("BM", 0, "ascii"); // 0-1: signature
	header.writeUInt32LE(58, 2); // 2-5: file size (header + one pixel)
	header.writeUInt32LE(54, 10); // 10-13: pixel data offset
	header.writeUInt32LE(40, 14); // 14-17: BITMAPINFOHEADER size
	header.writeInt32LE(1, 18); // 18-21: width
	header.writeInt32LE(1, 22); // 22-25: height
	header.writeUInt16LE(1, 26); // 26-27: color planes
	header.writeUInt16LE(24, 28); // 28-29: bits per pixel
	return Buffer.concat([header, Buffer.from([0x00, 0x00, 0xff, 0x00])]); // BGR + pad
})();

/** One hermetic boot: harness + faux provider + server + real temp workspace. */
interface TestServer {
	app: FastifyInstance;
	opened: OpenedHarness;
	/** The configured workspace directory (distinct from the storage db dir). */
	workspace: string;
}

/**
 * Boot a harness whose workspace is a fresh temp directory. The faux
 * provider's scripted responses drive real tool rounds through the
 * conversation's env.
 */
async function bootToolsServer(responses: unknown[]): Promise<TestServer> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-tools-"));
	const workspace = join(dir, "ws");
	await mkdir(workspace, { recursive: true });
	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses(responses as never);
	const contributor: ProviderContributor = {
		name: "ext-faux",
		providers: [{ provider: faux.provider }],
	};
	const config = loadConfig({
		SIGRUN_DEFAULT_MODEL: "faux/m",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_AUTH: "none",
		SIGRUN_WORKSPACE_PATH: workspace,
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		extensions: [contributor],
		env: {},
	});
	// API-only shape (channels: []): the gate OFF, never depending on a
	// built webui bundle (server.test.ts's hermetic override).
	const app = await createServer(opened, {
		...config,
		webui: { ...config.webui, enabled: false },
	});
	const teardown = async () => {
		await app.close();
		await opened.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	};
	cleanups.push(teardown);
	return { app, opened, workspace };
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const teardown of cleanups.splice(0)) await teardown();
});

/** One tool-call round the model "emits". */
function toolRound(
	...calls: { name: string; args: JsonObject }[]
) {
	return fauxAssistantMessage(
		calls.map((call) => fauxToolCall(call.name, call.args)),
		{ stopReason: "toolUse" },
	);
}

/** Run one conversation turn through the harness; wait for settlement. */
async function runTurn(
	opened: OpenedHarness,
	content: string,
): Promise<number> {
	const root = await opened.harness.root(BACKGROUND_CONTEXT, {
		agent: { model: opened.defaultModel },
	});
	const submission = await root.submit(
		{ type: "input", content: [{ type: "text", text: content }] },
		BACKGROUND_CONTEXT,
	);
	const settled = await submission.wait(BACKGROUND_CONTEXT);
	expect(settled.status).toBe("done");
	return root.id;
}

/** The conversation's serialized §5 view (entries + docs). */
async function getView(app: FastifyInstance, id: number) {
	const response = await app.inject({
		method: "GET",
		url: `/v1/conversations/${id}`,
	});
	expect(response.statusCode).toBe(200);
	return response.json() as {
		entries: {
			kind: string;
			model?: {
				role: string;
				content: { type: string; text?: string }[];
				toolName?: string;
				isError?: boolean;
				details?: unknown;
			}[];
		}[];
	};
}

/** The tool-result entry of `tool`, from a serialized view. */
function toolResult(
	view: Awaited<ReturnType<typeof getView>>,
	tool: string,
) {
	const entry = view.entries
		.filter((candidate) => candidate.kind === "pi.tool-result")
		.flatMap((candidate) => candidate.model ?? [])
		.find((message) => message.role === "toolResult" && message.toolName === tool);
	expect(entry).toBeDefined();
	return entry as NonNullable<typeof entry>;
}

/** The text content of a tool result. */
function resultText(message: { content: { type: string; text?: string }[] }) {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/**
 * The text output of a DIRECT execution result (`ToolExecutionResult`,
 * whose model-facing field is `output` since pi-durable 1.2.0).
 */
function resultOutput(result: {
	output?: { type: string; text?: string }[];
}) {
	return (result.output ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

// ---------------------------------------------------------------------------
// Registration (T1a/T1b install)
// ---------------------------------------------------------------------------

describe("core tool registration", () => {
	test("openHarness installs coding + search tools and offers them to agents", async () => {
		const { opened } = await bootToolsServer([fauxAssistantMessage("ok")]);
		const names = opened.registry
			.snapshot()
			.tools()
			.map((entry) => entry.tool.name);
		for (const name of [
			"read",
			"write",
			"edit",
			"bash",
			"find",
			"grep",
			"ls",
		]) {
			expect(names).toContain(name);
		}
		const root = await opened.harness.root(BACKGROUND_CONTEXT, {
			agent: { model: opened.defaultModel },
		});
		const agent = await root.agent(BACKGROUND_CONTEXT);
		expect(agent.tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining([
				"read",
				"write",
				"edit",
				"bash",
				"find",
				"grep",
				"ls",
			]),
		);
	});
});

// ---------------------------------------------------------------------------
// Coding tools end-to-end (T1a) + image reads (T1c)
// ---------------------------------------------------------------------------

describe("coding tools end-to-end", () => {
	test("write → bash → edit → read execute against the real workspace", async () => {
		const { app, opened, workspace } = await bootToolsServer([
			toolRound(
				{ name: "write", args: { path: "notes/greeting.txt", content: "hello world" } },
				{ name: "bash", args: { command: "printf sigrun-bash-ok" } },
			),
			toolRound({
				name: "edit",
				args: {
					path: "notes/greeting.txt",
					edits: [{ oldText: "hello", newText: "goodbye" }],
				},
			}),
			toolRound({ name: "read", args: { path: "notes/greeting.txt" } }),
			fauxAssistantMessage("all done"),
		]);
		const id = await runTurn(opened, "use the tools");
		const view = await getView(app, id);

		// Disk state: the file was written then edited.
		const { readFile } = await import("node:fs/promises");
		expect(await readFile(join(workspace, "notes/greeting.txt"), "utf8")).toBe(
			"goodbye world",
		);

		// The write and bash results are clean and carry their output.
		const write = toolResult(view, "write");
		expect(write.isError).not.toBe(true);
		expect(resultText(write)).toContain("greeting.txt");
		const bash = toolResult(view, "bash");
		expect(bash.isError).not.toBe(true);
		expect(resultText(bash)).toContain("sigrun-bash-ok");

		// The edit result carries the diff in details — the webui diff view's
		// wire input (T1d).
		const edit = toolResult(view, "edit");
		expect(edit.isError).not.toBe(true);
		expect(edit.details).toMatchObject({
			diff: expect.stringContaining("+") as unknown,
		});

		// The read result returns the edited text (image wrapper passthrough).
		const read = toolResult(view, "read");
		expect(read.isError).not.toBe(true);
		expect(resultText(read)).toContain("goodbye world");
	});

	test("reading an image returns inline image content, not an error (T1c)", async () => {
		const png = Buffer.from(PNG_1X1_BASE64, "base64");
		const { app, opened, workspace } = await bootToolsServer([
			toolRound({ name: "read", args: { path: "pic.png" } }),
			fauxAssistantMessage("seen it"),
		]);
		await writeFile(join(workspace, "pic.png"), png);
		const id = await runTurn(opened, "read the picture");
		const view = await getView(app, id);
		const read = toolResult(view, "read");
		expect(read.isError).not.toBe(true);
		const image = read.content.find((block) => block.type === "image") as
			| { type: "image"; data: string; mimeType: string }
			| undefined;
		expect(image).toBeDefined();
		expect(image?.mimeType).toBe("image/png");
		expect(Buffer.from(image?.data ?? "", "base64")).toEqual(png);
	});

	test("reading a BMP returns inline image content via the wrapper's rescue (T1c)", async () => {
		const bmp = BMP_1X1;
		const { app, opened, workspace } = await bootToolsServer([
			toolRound({ name: "read", args: { path: "pic.bmp" } }),
			fauxAssistantMessage("seen it"),
		]);
		await writeFile(join(workspace, "pic.bmp"), bmp);
		const id = await runTurn(opened, "read the picture");
		const view = await getView(app, id);
		const read = toolResult(view, "read");
		expect(read.isError).not.toBe(true);
		const image = read.content.find((block) => block.type === "image") as
			| { type: "image"; data: string; mimeType: string }
			| undefined;
		expect(image).toBeDefined();
		// Upstream's sniff of the BMP header yields image/bmp; the wrapper's
		// advertised contract rescues upstream's unsupported_image error and
		// returns the bytes as inline image content (Ruling X pins the wrapper).
		expect(image?.mimeType).toBe("image/bmp");
		expect(Buffer.from(image?.data ?? "", "base64")).toEqual(bmp);
	});
});

// ---------------------------------------------------------------------------
// Search tools (T1b) — .gitignore honoring end-to-end
// ---------------------------------------------------------------------------

describe("search tools end-to-end", () => {
	test("find/grep/ls honor .gitignore and report cwd-relative results", async () => {
		const { app, opened, workspace } = await bootToolsServer([
			toolRound(
				{ name: "find", args: { pattern: "*.ts" } },
				{ name: "grep", args: { pattern: "TODO" } },
				{ name: "ls", args: {} },
			),
			fauxAssistantMessage("searched"),
		]);
		await mkdir(join(workspace, "src"), { recursive: true });
		await mkdir(join(workspace, "ignored"), { recursive: true });
		await writeFile(
			join(workspace, ".gitignore"),
			"ignored/\n*.log\n!keep.log\n",
		);
		await writeFile(
			join(workspace, "src", "a.ts"),
			"hello TODO world\nplain line\n",
		);
		await writeFile(join(workspace, "ignored", "hidden.ts"), "TODO hidden");
		await writeFile(join(workspace, "noise.log"), "TODO in log");
		await writeFile(join(workspace, "keep.log"), "TODO kept");
		await writeFile(
			join(workspace, "pic.png"),
			Buffer.from(PNG_1X1_BASE64, "base64"),
		);

		const id = await runTurn(opened, "search the workspace");
		const view = await getView(app, id);

		// find: *.ts at any depth, ignored/ pruned, .log filtered.
		const find = toolResult(view, "find");
		expect(resultText(find)).toContain("src/a.ts");
		expect(resultText(find)).not.toContain("hidden.ts");
		expect(resultText(find)).not.toContain("noise.log");

		// grep: cwd-relative path:line:text; ignored + log files not searched;
		// the PNG is skipped as binary.
		const grep = toolResult(view, "grep");
		expect(resultText(grep)).toContain("src/a.ts:1:hello TODO world");
		expect(resultText(grep)).not.toContain("hidden");
		expect(resultText(grep)).not.toContain("noise.log");
		expect(resultText(grep)).toContain("1 binary file(s) skipped");

		// ls: filtered listing (kind + name), negated keep.log present.
		const ls = toolResult(view, "ls");
		expect(resultText(ls)).toContain("directory\tsrc");
		expect(resultText(ls)).toContain("file\t.gitignore");
		expect(resultText(ls)).toContain("file\tkeep.log");
		expect(resultText(ls)).not.toContain("noise.log");
		expect(resultText(ls)).not.toContain("ignored");
	});
});

// ---------------------------------------------------------------------------
// Direct-execution edges (real NodeExecutionEnv, no model round)
// ---------------------------------------------------------------------------

/** A temp workspace + a tool api stub carrying its env. */
async function tempEnv(): Promise<{
	api: ToolExecutionApi;
	dir: string;
	cleanup: () => Promise<void>;
}> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-tools-direct-"));
	const env = new NodeExecutionEnv({ cwd: dir });
	return {
		api: { env } as unknown as ToolExecutionApi,
		dir,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

describe("search tool edges (direct execution)", () => {
	test("find caps results at 200 with a truncation note", async () => {
		const { api, dir, cleanup } = await tempEnv();
		try {
			for (let index = 0; index < 205; index++) {
				await writeFile(
					join(dir, `f${String(index).padStart(3, "0")}.txt`),
					"x",
				);
			}
			const result = await findTool.execute(
				{ pattern: "*.txt" },
				api,
				BACKGROUND_CONTEXT,
			);
			const text = resultOutput(result);
			expect(text).toContain("capped at 200 results");
			expect((text.match(/\.txt/g) ?? []).length).toBe(200);
		} finally {
			await cleanup();
		}
	});

	test("find with a path searches under it and prefixes output paths", async () => {
		const { api, dir, cleanup } = await tempEnv();
		try {
			await mkdir(join(dir, "src"), { recursive: true });
			await writeFile(join(dir, "src", "a.ts"), "x");
			await writeFile(join(dir, "top.ts"), "x");
			const result = await findTool.execute(
				{ pattern: "*.ts", path: "src" },
				api,
				BACKGROUND_CONTEXT,
			);
			const text = resultOutput(result);
			expect(text).toContain("src/a.ts");
			expect(text).not.toContain("top.ts");
		} finally {
			await cleanup();
		}
	});

	test("find rejects a non-directory path", async () => {
		const { api, dir, cleanup } = await tempEnv();
		try {
			await writeFile(join(dir, "file.txt"), "x");
			const result = await findTool.execute(
				{ pattern: "*", path: "file.txt" },
				api,
				BACKGROUND_CONTEXT,
			);
			expect(result.isError).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("grep rejects an invalid pattern without touching the workspace", async () => {
		const { api, cleanup } = await tempEnv();
		try {
			const result = await grepTool.execute(
				{ pattern: "([unclosed" },
				api,
				BACKGROUND_CONTEXT,
			);
			expect(result.isError).toBe(true);
			expect(resultOutput(result)).toContain("invalid pattern");
		} finally {
			await cleanup();
		}
	});

	test("grep caps matches and truncates long lines", async () => {
		const { api, dir, cleanup } = await tempEnv();
		try {
			// One file whose lines each match, past the cap; plus one huge line.
			const lines = Array.from(
				{ length: 205 },
				(_, index) => `hit ${index}`,
			);
			await writeFile(join(dir, "many.txt"), lines.join("\n"));
			await writeFile(join(dir, "long.txt"), `hit ${"y".repeat(400)}`);
			const result = await grepTool.execute(
				{ pattern: "hit" },
				api,
				BACKGROUND_CONTEXT,
			);
			const text = resultOutput(result);
			expect(text).toContain("capped at 200 matches");
			expect((text.match(/hit/g) ?? []).length).toBeLessThanOrEqual(202); // 200 hits + the note
			expect(text).toContain("…");
		} finally {
			await cleanup();
		}
	});

	test("ls lists without .gitignore when none exists, hiding .git", async () => {
		const { api, dir, cleanup } = await tempEnv();
		try {
			await mkdir(join(dir, ".git"), { recursive: true });
			await writeFile(join(dir, ".git", "config"), "x");
			await writeFile(join(dir, "plain.txt"), "x");
			const result = await lsTool.execute({}, api, BACKGROUND_CONTEXT);
			const text = resultOutput(result);
			expect(text).toContain("file\tplain.txt");
			expect(text).not.toContain("config");
		} finally {
			await cleanup();
		}
	});

	test("ls on a file is an explicit error", async () => {
		const { api, dir, cleanup } = await tempEnv();
		try {
			await writeFile(join(dir, "file.txt"), "x");
			const result = await lsTool.execute(
				{ path: "file.txt" },
				api,
				BACKGROUND_CONTEXT,
			);
			expect(result.isError).toBe(true);
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// gitignore matcher units (the documented subset)
// ---------------------------------------------------------------------------

describe("gitignore matcher (documented subset)", () => {
	test("blank lines and comments are skipped; negation is last-wins", () => {
		const rules = parseGitignore("# comment\n\n*.log\n!keep.log\n");
		expect(isIgnoredPath(rules, "noise.log", false)).toBe(true);
		expect(isIgnoredPath(rules, "keep.log", false)).toBe(false);
		expect(isIgnoredPath(rules, "src/a.ts", false)).toBe(false);
	});

	test("unanchored patterns match at any depth; anchored ones from the root", () => {
		const rules = parseGitignore("build/\n/root-only.txt\n");
		expect(isIgnoredPath(rules, "build", true)).toBe(true);
		expect(isIgnoredPath(rules, "src/build", true)).toBe(true);
		// An ignored ancestor directory ignores everything below it (git's
		// documented rule) — even a file the directory rule never matches.
		expect(isIgnoredPath(rules, "build/file.txt", false)).toBe(true);
		// Directory-only rules never match a same-named FILE directly.
		expect(isIgnoredPath(rules, "build.txt", false)).toBe(false);
		expect(isIgnoredPath(rules, "root-only.txt", false)).toBe(true);
		expect(isIgnoredPath(rules, "src/root-only.txt", false)).toBe(false);
	});

	test("** spans directories; a leading ** matches zero of them", () => {
		const rules = parseGitignore("**/tmp\nsrc/**/*.gen.ts\n");
		expect(isIgnoredPath(rules, "tmp", false)).toBe(true);
		expect(isIgnoredPath(rules, "a/b/tmp", false)).toBe(true);
		expect(isIgnoredPath(rules, "src/x.gen.ts", false)).toBe(true);
		expect(isIgnoredPath(rules, "src/a/b/x.gen.ts", false)).toBe(true);
		expect(isIgnoredPath(rules, "lib/x.gen.ts", false)).toBe(false);
	});
});
