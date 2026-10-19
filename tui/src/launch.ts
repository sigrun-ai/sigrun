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
	KeybindingsManager,
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
import type { AccentName, ModeName, PaletteName } from "@sigrun/shared/themes";
import { SigrunClient, type FetchLike } from "./api.js";
import { createStandardKeymap } from "./keymaps/standard.js";
import { createVimKeymap } from "./keymaps/vim.js";
import { createEmacsKeymap } from "./keymaps/emacs.js";
import type { Keymap } from "./keymaps/types.js";
import { createTuiTheme } from "./theme.js";
import { TuiApp } from "./ui/app.js";
import { showHelp } from "./ui/help.js";
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
	/** The keymap (C3); defaults to the standard one. */
	readonly keymap?: "standard" | "vim" | "emacs";
	/** The tui.json `editor` field (C1); a vim-family value feeds edit-in-vim. */
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
		...(options.editor === undefined ? {} : { editor: options.editor }),
		theme,
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
	// C3/C4/C5: the keymap comes from the tui.json `keymap` option
	// (standard is the default). The vim `:` Tab completion merges the
	// slash catalog — a shared array the keymap reads live, filled by the
	// fetch below.
	const vimCatalogNames: string[] = [];
	const keymap: Keymap =
		options.keymap === "vim"
			? createVimKeymap({ catalogNames: vimCatalogNames })
			: options.keymap === "emacs"
				? createEmacsKeymap()
				: createStandardKeymap();
	// C5: the bar's hint cluster is the keymap's `hints(ctx)` — the app
	// re-polls it on every focus change (and after each key below, so a
	// vim mode change repaints too). Boot paints the composer-focused
	// steady state.
	app.hintsProvider = () => keymap.hints(app.keyContext());
	statusBar.set({
		mode: "attach",
		conversation: "",
		hints: keymap.hints({ focus: "composer", busy: false, autocompleteOpen: false, overlayOpen: false }),
	});
	// C3: the app flashes copy/configure/help/search through the bar.
	app.setStatusBar(statusBar);
	// C5: the `help` action opens the key reference overlay for the
	// active keymap (the app owns the overlayOpen bookkeeping).
	app.helpOverlay = (onClose) =>
		showHelp(tui as unknown as TUI, keymap, { onClose });
	if (keymap.name === "vim") {
		statusBar.set({ ...statusBar.getState(), mode: keymap.modeLabel() ?? "attach" });
		const vim = keymap as ReturnType<typeof createVimKeymap>;
		// Post edit-in-vim the keymap follows the composer focus back to INSERT.
		app.enterInsertMode = () => vim.enterInsertMode();
		// The `:` Tab completion also completes the slash catalog (fire-and-
		// forget: completion works on the vim table until the fetch lands).
		void app
			.slashCommandNames()
			.then((names) => vimCatalogNames.push(...names))
			.catch(() => {}); // a failed catalog fetch degrades completion only
	}
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

	// The sidebar polls the listing (C2): names/ages/forks drift while
	// the TUI is open, and the summary fields ride the ONE list request.
	// Unref'd so the timer never holds the process open; dispose clears it.
	const poll = setInterval(() => {
		void app.refresh().catch(() => {}); // a failed poll fails quiet
	}, 10_000);
	poll.unref();

	const done = new Promise<void>((resolve) => {
		app.onQuit = resolve;
		tui.addInputListener((data) => {
			// The seam prompts (answer mode, the search overlay) own their
			// keys before the keymap sees them.
			if (app.handleKeybinding(data)) {
				return { consume: true };
			}
			// C3: the keymap decides — dispatch, consume, or pass through
			// to the focused component (the composer owns the rest).
			const result = keymap.handle(data, app.keyContext());
			if (result === "pass") return undefined;
			if (result !== "consume") void app.dispatch(result);
			// C4: the vim keymap's mode chip + ":" command line repaint after
			// each key (the app polls — the keymap owns the buffer).
			if (keymap.name === "vim") {
				const vim = keymap as ReturnType<typeof createVimKeymap>;
				app.renderCommandLine(vim.getCommandLine(), vim.modeLabel());
			}
			// C5: a key may change the keymap's hint state (vim mode, focus
			// via dispatch) — re-poll the hints after every handled key.
			app.refreshHints();
			return { consume: true };
		});
	});

	tui.setFocus(app.editor);
	tui.start();
	try {
		await done;
	} finally {
		clearInterval(poll);
		app.dispose();
		tui.stop();
	}
}
