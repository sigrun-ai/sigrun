import { spawnSync as realSpawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const VIM_NAMES: readonly string[] = ["vim", "nvim", "vi"];

/** True when the basename of the first whitespace-separated token is a vim binary. */
export function isVimFamily(command: string): boolean {
	const first = command.trim().split(/\s+/)[0];
	if (!first) return false;
	return VIM_NAMES.includes(basename(first));
}

/**
 * Resolve a vim-family editor: configured → VISUAL → EDITOR (each used only
 * when vim-family), then nvim/vim/vi on PATH. Undefined when nothing qualifies.
 */
export function resolveVimEditor(opts: {
	configured?: string;
	env: NodeJS.ProcessEnv;
	which(name: string): string | undefined;
}): string | undefined {
	for (const candidate of [opts.configured, opts.env.VISUAL, opts.env.EDITOR]) {
		if (candidate && isVimFamily(candidate)) return candidate;
	}
	for (const name of ["nvim", "vim", "vi"]) {
		const found = opts.which(name);
		if (found) return found;
	}
	return undefined;
}

/**
 * Edit `text` in a vim-family editor via a temp file, suspending the TUI for
 * the duration. The temp file is always removed; on failure the draft is
 * untouched and stop/start remain balanced.
 */
export function editInVim(opts: {
	text: string;
	editor: string;
	tui: { stop(): void; start(): void; requestRender(force?: boolean): void };
	spawnSync?: typeof import("node:child_process").spawnSync;
	tmpDir?: string;
}): { ok: true; text: string } | { ok: false; reason: string } {
	const spawn = opts.spawnSync ?? realSpawnSync;
	const file = join(
		opts.tmpDir ?? tmpdir(),
		`sigrun-prompt-${randomBytes(8).toString("hex")}.md`,
	);
	writeFileSync(file, opts.text, { encoding: "utf8", mode: 0o600 });
	// The editor string splits on whitespace — quoted paths with spaces in
	// the command or its arguments are NOT supported (a known limitation).
	const [command, ...args] = opts.editor.trim().split(/\s+/);
	try {
		opts.tui.stop();
		const result = spawn(command, [...args, file], { stdio: "inherit" });
		if (result.error) {
			return { ok: false, reason: `editor failed to launch: ${result.error.message}` };
		}
		if (result.status !== 0) {
			return { ok: false, reason: `editor exited with status ${result.status}` };
		}
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			return { ok: false, reason: "edited file missing or unreadable" };
		}
		return { ok: true, text };
	} finally {
		opts.tui.start();
		opts.tui.requestRender(true);
		try {
			unlinkSync(file);
		} catch {
			// already gone (editor deleted it) — nothing to clean up
		}
	}
}
