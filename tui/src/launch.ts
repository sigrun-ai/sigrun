/**
 * The TUI entry the CLI's default `launchTui` runs (Task 6): boot the
 * pi-tui fullscreen alt-screen renderer (task C1b — the terminal scrollback
 * is gone for the session; the app owns the viewport), mount the layout
 * root, and resolve when the user exits (ctrl+c). The CLI's `run`
 * lifecycle owns the shutdown from there — this promise resolving IS the
 * exit signal. There is no main-screen fallback.
 *
 * Layout (task C1b): `tui.setLayoutRoot(new VStack([...]))` — the body row
 * (`HStack`: the sidebar at basis 28, visible only at width ≥ 80, and the
 * pane wrapped in the follow-end PRIMARY ScrollView growing to fill), then
 * the interaction + ambient seam strips (basis "auto" — zero height when
 * empty), the composer Editor (basis "auto"), and the status bar pinned to
 * one line at the bottom (basis 1).
 *
 * Keybindings: BEFORE the screen is constructed, the alt-screen built-ins
 * the action layer will own are disabled (search, search next/previous,
 * previous/next prompt — the built-ins search raw lines and jump OSC 133
 * marks sigrun never emits); pageUp/pageDown/ctrl+home/ctrl+end scrolling
 * and the wheel stay. The shell's global input listener keeps ctrl+c
 * (exit), ctrl+o (answer mode), and Esc (abort a live run); task C3's
 * action layer reintroduces navigation — until then the composer is the
 * focus and the mouse drives the sidebar.
 *
 * Test seams (the shell itself needs a real terminal): `screen` injects
 * the screen constructor (tests assert TuiAltScreen's arguments), and
 * `terminal`/`fetchFn` inject the terminal and boot fetch. Production
 * callers pass none of them.
 */

import {
	getTerminalColorMode,
	HStack,
	Key,
	KeybindingsManager,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	setKeybindings,
	TUI_KEYBINDINGS,
	TuiAltScreen,
	VStack,
	type Component,
	type Terminal,
	type TUI,
	type TuiAltScreenOptions,
} from "@earendil-works/pi-tui";
import type { AccentName, ModeName, PaletteName } from "../../src/shared/themes.js";
import { SigrunClient, type FetchLike } from "./api.js";
import { createTuiTheme } from "./theme.js";
import { TuiApp } from "./ui/app.js";
import { StatusBar } from "./ui/status-bar.js";

/** The input-listener signature pi-tui's TUI uses. */
export type TuiInputListenerFn = (
	data: string,
) => { consume: boolean } | undefined;

/** The screen surface the launcher drives (a TuiAltScreen satisfies it). */
export interface TuiScreen extends Component {
	setLayoutRoot(component: Component | undefined): void;
	setFocus(component: Component | null): void;
	start(): void;
	stop(options?: { preserveScreen?: boolean }): void;
	requestRender(force?: boolean): void;
	addInputListener(listener: TuiInputListenerFn): () => void;
}

/**
 * The screen-constructor seam (task C1b): matches TuiAltScreen's
 * constructor signature so tests can record the arguments without a real
 * terminal. Production uses `TuiAltScreen` itself.
 */
export type TuiScreenFactory = (
	terminal: Terminal,
	showHardwareCursor?: boolean,
	logDirectory?: string,
	options?: TuiAltScreenOptions,
) => TuiScreen;

export interface LaunchTuiShellOptions {
	/** The server's base URL (`SigrunClient`'s `baseUrl`). */
	readonly baseUrl: string;
	/** The `X-Sigrun-User` identity; absent = the server's naive mode. */
	readonly user?: string;
	/** The UI refresh's tui.json fields (C1a threads them in from the CLI). */
	readonly palette?: PaletteName;
	readonly accent?: AccentName;
	readonly mode?: ModeName;
	/** Reserved for the keymap task; accepted, unused here. */
	readonly keymap?: "standard" | "vim" | "emacs";
	/** Reserved for the $EDITOR task; accepted, unused here. */
	readonly editor?: string;
	/** TEST SEAM: the screen constructor (defaults to TuiAltScreen). */
	readonly screen?: TuiScreenFactory;
	/** TEST SEAM: the terminal (defaults to ProcessTerminal). */
	readonly terminal?: Terminal;
	/** TEST SEAM: the boot fetch (defaults to the ambient fetch). */
	readonly fetchFn?: FetchLike;
}

/** The sidebar's fixed column basis, and the width gate below which it hides. */
const SIDEBAR_BASIS = 28;
const SIDEBAR_MIN_WIDTH = 80;

/**
 * Install the shell's keybinding set (task C1b): the alt-screen built-ins
 * for search and prompt jumps go dark — the action layer owns them (they
 * must target turns and move focus; the built-ins search raw lines and
 * jump OSC 133 marks sigrun never emits). Page/line/home/end scrolling
 * and the wheel stay. Must run BEFORE the screen is constructed.
 */
function installKeybindings(): void {
	setKeybindings(
		new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.altScreen.search": [],
			"tui.altScreen.searchNext": [],
			"tui.altScreen.searchPrevious": [],
			"tui.altScreen.previousPrompt": [],
			"tui.altScreen.nextPrompt": [],
		}),
	);
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
		...(options.fetchFn === undefined ? {} : { fetch: options.fetchFn }),
	});
	const terminal = options.terminal ?? new ProcessTerminal();
	// The alt-screen screen consults the global keybindings at construction
	// (its input listener), so the disables must be installed first.
	installKeybindings();
	const createScreen = options.screen ??
		((t, hw, log, opts): TuiAltScreen => new TuiAltScreen(t, hw, log, opts));
	const tui = createScreen(terminal, false, undefined, {
		mouse: true,
		copyOnSelect: true,
	});
	const theme = createTuiTheme({
		palette: options.palette ?? "polar-night",
		accent: options.accent ?? "baltic-amber",
		mode: options.mode ?? "dark",
		colorMode: getTerminalColorMode(),
	});
	const app = new TuiApp(client, {
		// The app needs pi-tui's TUI surface for the Editor + repaint
		// pings; the constructed screen provides it.
		tui: tui as unknown as TUI,
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

	// The fullscreen layout root (task C1b): the app owns the components
	// (TuiApp.render stays as the non-mounted fallback path); the launcher
	// composes them here. The pane sits in the follow-end PRIMARY scroll
	// view (the wheel + page keys target it); the status bar's mode chip
	// rides the theme's accent background (StatusBar owns that styling).
	const statusBar = new StatusBar({ theme });
	statusBar.set({
		mode: "attach",
		conversation: "",
		hints: ["ctrl+o answer", "esc abort", "ctrl+c quit"],
	});
	const body = new HStack([
		{
			component: app.sidebar,
			basis: SIDEBAR_BASIS,
			visible: (viewport) => viewport.width >= SIDEBAR_MIN_WIDTH,
		},
		{
			component: new ScrollView(app.pane, {
				follow: "end",
				primary: true,
				overscroll: "chain",
			}),
			grow: 1,
		},
	]);
	const root = new VStack([
		{ component: body, grow: 1 },
		{ component: app.interactions, basis: "auto" },
		{ component: app.ambient, basis: "auto" },
		{ component: app.editor, basis: "auto" },
		{ component: statusBar, basis: 1 },
	]);
	tui.setLayoutRoot(root);

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

	tui.setFocus(app.editor);
	tui.start();
	try {
		await done;
	} finally {
		app.dispose();
		tui.stop();
	}
}
