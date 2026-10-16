/**
 * The TUI entry the CLI's default `launchTui` runs (Task 6): boot the
 * pi-tui main-screen renderer, mount the shell + composer, and resolve
 * when the user exits (ctrl+c). The CLI's `run` lifecycle owns the
 * shutdown from there — this promise resolving IS the exit signal.
 *
 * Pi's idiom: `TuiMainScreen` (the terminal owns scrollback) with the app
 * body added first and the composer `Editor` last — the editor anchors
 * the bottom as the final child, chat content scrolls above it. Focus
 * lands on the editor; the sidebar is driven by app-level keybindings
 * (Task 7+ owns richer focus swapping).
 *
 * Keybindings (the shell's global input listener, registered before the
 * editor sees input):
 * - ctrl+c: exit (raw mode eats SIGINT — the README's own pattern).
 * - ctrl+f: fork the active conversation at the latest entry (spec §8's
 *   v1 fork default), refresh the sidebar, switch to the fork.
 */

import {
	Key,
	matchesKey,
	ProcessTerminal,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { SigrunClient } from "./api.js";
import { TuiApp } from "./ui/app.js";

export interface LaunchTuiShellOptions {
	/** The server's base URL (`SigrunClient`'s `baseUrl`). */
	readonly baseUrl: string;
	/** The `X-Sigrun-User` identity; absent = the server's naive mode. */
	readonly user?: string;
}

/**
 * Run the shell against `baseUrl` until the user exits. Boot failures
 * (the initial refresh rejecting) propagate — the CLI prints and exits 1.
 */
export async function launchTuiShell(
	options: LaunchTuiShellOptions,
): Promise<void> {
	const client = new SigrunClient({
		baseUrl: options.baseUrl,
		...(options.user === undefined ? {} : { user: options.user }),
	});
	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal);
	const app = new TuiApp(client, {
		tui,
		watchOptions: {
			baseUrl: options.baseUrl,
			...(options.user === undefined ? {} : { user: options.user }),
		},
	});
	await app.refresh();

	const done = new Promise<void>((resolve) => {
		tui.addInputListener((data) => {
			if (matchesKey(data, Key.ctrl("c"))) {
				resolve();
				return { consume: true };
			}
			if (app.handleKeybinding(data)) {
				return { consume: true };
			}
			return undefined;
		});
	});

	tui.addChild(app);
	tui.addChild(app.editor);
	tui.setFocus(app.editor);
	tui.start();
	try {
		await done;
	} finally {
		app.dispose();
		tui.stop();
	}
}
