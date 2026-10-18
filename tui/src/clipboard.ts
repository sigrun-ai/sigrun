/**
 * Terminal clipboard (Task C3, UI refresh): OSC 52 writes the system
 * clipboard through the terminal emulator. Inside tmux the sequence must
 * be DCS-wrapped with every ESC doubled, or tmux eats it.
 *
 * `copyToTerminal` writes the sequence to the terminal; the app flashes
 * "Copied" in the status bar on top of this.
 */

/** The environment slice the tmux detection reads. */
export interface ClipboardEnv {
	readonly TMUX?: string;
}

/** The OSC 52 sequence for `text` (base64 UTF-8), tmux-wrapped when needed. */
export function osc52(text: string, env: ClipboardEnv = process.env): string {
	const seq = `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
	if (env.TMUX === undefined || env.TMUX === "") return seq;
	return `\x1bPtmux;\x1b${seq.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/** The terminal surface the copy needs (pi-tui's `Terminal.write`). */
export interface ClipboardTerminal {
	write(data: string): void;
}

/** Write `text` to the system clipboard via the terminal. */
export function copyToTerminal(
	terminal: ClipboardTerminal,
	text: string,
	env: ClipboardEnv = process.env,
): void {
	terminal.write(osc52(text, env));
}
