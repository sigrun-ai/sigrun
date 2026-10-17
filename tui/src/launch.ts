/**
 * The TUI entry the CLI's default `launchTui` runs (Task 6): boot the
 * pi-tui main-screen renderer, mount the shell + composer, and resolve
 * when the user exits (ctrl+c). The CLI's `run` lifecycle owns the
 * shutdown from there — this promise resolving IS the exit signal.
 *
 * Pi's idiom: `TuiMainScreen` (the terminal owns scrollback) with the app
 * body added first and the composer `Editor` last — the editor anchors
 * the bottom as the final child, chat content scrolls above it. Focus
 * lands on the editor; ctrl+b moves keys to the sidebar and back (the
 * app routes them — pi-tui focus stays on the editor).
 *
 * Keybindings (the shell's global input listener, registered before the
 * editor sees input):
 * - ctrl+c: exit (raw mode eats SIGINT — the README's own pattern).
 * - ctrl+b: toggle sidebar focus (the conversation switcher).
 * - ctrl+f: fork the active conversation at the latest entry (spec §8's
 *   v1 fork default), refresh the sidebar, switch to the fork.
 *
 * Stream health (fix wave F5): the watcher's error/open callbacks become
 * pane notices on TRANSITIONS only — the first failure shows
 * "stream: disconnected", the next successful (re)connect shows
 * "stream: reconnected"; a reconnect storm repeats neither.
 */

import {
	Key,
	matchesKey,
	ProcessTerminal,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { AccentName, ModeName, PaletteName } from "../../src/shared/themes.js";
import { SigrunClient } from "./api.js";
import { TuiApp } from "./ui/app.js";

export interface LaunchTuiShellOptions {
	/** The server's base URL (`SigrunClient`'s `baseUrl`). */
	readonly baseUrl: string;
	/** The `X-Sigrun-User` identity; absent = the server's naive mode. */
	readonly user?: string;
	/**
	 * The UI refresh's tui.json fields (C1a threads them in from the CLI).
	 * ACCEPT-AND-IGNORE for now: C1b's launcher rework consumes them
	 * (palette/accent/mode build the theme; keymap/editor later).
	 */
	readonly palette?: PaletteName;
	readonly accent?: AccentName;
	readonly mode?: ModeName;
	readonly keymap?: "standard" | "vim" | "emacs";
	readonly editor?: string;
}

/**
 * The stream-health transition notices (fix wave F5): state-deduped, so a
 * reconnect storm shows ONE "disconnected" and ONE "reconnected", never a
 * pane full of retries. Exported for the unit test (the shell itself needs
 * a real terminal).
 */
export function createStreamHealthNotices(notify: (message: string) => void): {
	onError(): void;
	onOpen(): void;
} {
	let down = false;
	return {
		onError() {
			if (down) return;
			down = true;
			notify("stream: disconnected");
		},
		onOpen() {
			if (!down) return;
			down = false;
			notify("stream: reconnected");
		},
	};
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
	// Fix wave F5: surface stream transport health as transition notices.
	const streamHealth = createStreamHealthNotices((message) =>
		app.pane.showNotice(message),
	);
	app.onWatchError = streamHealth.onError;
	app.onWatchOpen = streamHealth.onOpen;
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
