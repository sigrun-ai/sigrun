import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isVimFamily, resolveVimEditor, editInVim, VIM_NAMES } from "../src/editor-launch.js";

let dirs: string[] = [];
function makeTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "editor-launch-test-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function fakeTui(calls: string[]) {
	return {
		stop() { calls.push("stop"); },
		start() { calls.push("start"); },
		requestRender(_force?: boolean) { calls.push("requestRender"); },
	};
}

describe("isVimFamily", () => {
	it("accepts vim-family basenames, rejects others", () => {
		expect(VIM_NAMES).toEqual(["vim", "nvim", "vi"]);
		expect(isVimFamily("/opt/bin/nvim -u NONE")).toBe(true);
		expect(isVimFamily("nano")).toBe(false);
		expect(isVimFamily("/usr/bin/vimdiff")).toBe(false);
		expect(isVimFamily("vi")).toBe(true);
	});
});

describe("resolveVimEditor", () => {
	it("falls back to PATH when env editor is not vim-family", () => {
		const result = resolveVimEditor({
			env: { EDITOR: "nano" },
			which: (n) => (n === "vim" ? "/usr/bin/vim" : undefined),
		});
		expect(result).toBe("/usr/bin/vim");
	});

	it("returns undefined when nothing vim-family is found", () => {
		const result = resolveVimEditor({
			env: { EDITOR: "nano" },
			which: () => undefined,
		});
		expect(result).toBeUndefined();
	});

	it("configured vim editor wins and PATH is never consulted", () => {
		const result = resolveVimEditor({
			configured: "/usr/bin/vi",
			env: {},
			which: () => { throw new Error("should not consult PATH"); },
		});
		expect(result).toBe("/usr/bin/vi");
	});

	it("env.VISUAL beats env.EDITOR when vim-family", () => {
		const result = resolveVimEditor({
			env: { VISUAL: "nvim", EDITOR: "vi" },
			which: () => { throw new Error("should not consult PATH"); },
		});
		expect(result).toBe("nvim");
	});
});

describe("editInVim", () => {
	it("round-trips edited text and balances tui calls in order", () => {
		const dir = makeTmp();
		const calls: string[] = [];
		const stub: typeof import("node:child_process").spawnSync = ((cmd: string, args: string[]) => {
			expect(cmd).toBe("/opt/bin/nvim");
			expect(args).toEqual(["-u", "NONE", expect.stringMatching(/sigrun-prompt-.*\.md$/)]);
			const file = args[args.length - 1];
			expect(readFileSync(file, "utf8")).toBe("original text");
			writeFileSync(file, "new text");
			return { status: 0 };
		}) as any;

		const result = editInVim({
			text: "original text",
			editor: "/opt/bin/nvim -u NONE",
			tui: fakeTui(calls),
			spawnSync: stub,
			tmpDir: dir,
		});
		expect(result).toEqual({ ok: true, text: "new text" });
		expect(calls).toEqual(["stop", "start", "requestRender"]);
	});

	it("returns failure on non-zero exit, still balanced, temp unlinked", () => {
		const dir = makeTmp();
		const calls: string[] = [];
		let file: string | undefined;
		const stub: any = (_cmd: string, args: string[]) => {
			file = args[args.length - 1];
			return { status: 1 };
		};
		const result = editInVim({
			text: "draft",
			editor: "vim",
			tui: fakeTui(calls),
			spawnSync: stub,
			tmpDir: dir,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(typeof result.reason).toBe("string");
		expect(calls).toEqual(["stop", "start", "requestRender"]);
		expect(file).toBeDefined();
		expect(existsSync(file!)).toBe(false);
	});

	it("returns failure when the file is deleted by the editor", () => {
		const dir = makeTmp();
		const calls: string[] = [];
		const stub: any = (_cmd: string, args: string[]) => {
			rmSync(args[args.length - 1]);
			return { status: 0 };
		};
		const result = editInVim({
			text: "draft",
			editor: "vim",
			tui: fakeTui(calls),
			spawnSync: stub,
			tmpDir: dir,
		});
		expect(result.ok).toBe(false);
		expect(calls).toEqual(["stop", "start", "requestRender"]);
	});

	it("temp file naming: under tmpDir, sigrun-prompt-*.md, seeded with original text", () => {
		const dir = makeTmp();
		const stub: any = (_cmd: string, args: string[]) => {
			const file = args[args.length - 1];
			expect(file.startsWith(join(dir, "sigrun-prompt-"))).toBe(true);
			expect(file.endsWith(".md")).toBe(true);
			expect(readFileSync(file, "utf8")).toBe("the draft body");
			return { status: 0 };
		};
		const result = editInVim({
			text: "the draft body",
			editor: "vi",
			tui: fakeTui([]),
			spawnSync: stub,
			tmpDir: dir,
		});
		expect(result).toEqual({ ok: true, text: "the draft body" });
	});
});
