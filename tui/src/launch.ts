#!/usr/bin/env node
/**
 * The TUI entry the CLI's default `launchTui` runs (Task 6): boot the
 * pi-tui fullscreen alt-screen renderer (task C1b — the terminal scrollback
 * is gone for the session; the app owns the viewport), mount the layout
 * root, and resolve when the user exits (ctrl+c). The CLI's `run`
 * lifecycle owns the shutdown from there — this promise resolving IS the
 * exit signal. There is no main-screen fallback.
 *
 * As of build-and-webui Task 2 this file is ALSO the package's bin
 * (`sigrun-tui` → `dist/launch.js`): the CLI no longer imports
 * `launchTuiShell` in-process — it spawns this bin as a child process
 * (`node <resolved dist/launch.js>`), passing the resolved server URL,
 * user, and tui.json UI fields as `--flags`. Run standalone, the bin
 * resolves them itself: `--server`/`SIGRUN_SERVER` (default
 * `http://localhost:$SIGRUN_PORT` or 3000) and `--user`/`SIGRUN_USER`.
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
import {
	isAccentName,
	isPaletteName,
	type AccentName,
	type ModeName,
	type PaletteName,
} from "@sigrun/shared/themes";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SigrunClient, SigrunApiError, type FetchLike } from "./api.js";
import { watchEvents } from "./sse.js";
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
	/**
	 * The bearer token (Task 7): `authorization: Bearer` on every client
	 * request and the stream connect. The launcher sources it from env
	 * `SIGRUN_TOKEN` — a credential never rides argv.
	 */
	readonly token?: string;
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
		...(options.token === undefined ? {} : { token: options.token }),
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
		// SAFETY: TuiAltScreen implements TUI's render/input surface (pi-tui's
		// own TUI is exactly this shape); the seam type only narrows tests.
		tui: tui as unknown as TUI,
		watchOptions: {
			baseUrl: options.baseUrl,
			...(options.user === undefined ? {} : { user: options.user }),
			...(options.token === undefined ? {} : { token: options.token }),
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
	// SAFETY: same TuiAltScreen-as-TUI surface as the TuiApp seam above.
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
			// The main slot (U4 Task 4 round-2): the conversation pane in
			// the steady state, the settings view while one is open — the
			// slot swaps, so settings renders in the body's own column.
			component: new ScrollView(app.mainContent, {
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
	// U3 Task 5: the sidebar's Views group loads with the conversations
	// (one /v1/extensions GET per boot; failures fail quiet).
	void app.sidebar.refreshViews().catch(() => {});

	// The host events subscription (core hardening W3 Task 4, spec §7.4):
	// ONE stream per process replaces the poll timers — `conversation.*`
	// refetches the sidebar listing, `interaction.*` kicks the prompter,
	// `ambient.changed` refetches the ambient chrome. A transport failure
	// surfaces as a pane notice (the same posture as the conversation
	// watcher's stream-health wiring); the events stream only NUDGES, so
	// a dropped frame heals on the next event.
	const unwatchEvents = watchEvents(
		{
			onEvent: (event) => {
				if (
					event.type === "conversation.created" ||
					event.type === "conversation.changed"
				) {
					void app.refresh().catch(() => {}); // a failed refetch fails quiet
				} else if (
					event.type === "interaction.pending" ||
					event.type === "interaction.settled"
				) {
					app.interactions.kick();
				} else if (event.type === "ambient.changed") {
					app.ambient.kick(event.conversationId);
				} else if (event.type === "surface.changed") {
					// U3 Task 5: fan the EXT surface event out to the open view's
					// transport (the hub matches slug+id+k). The CHAT shape (U5
					// Task 2/4: conversationId+entryId, no k) names a block in a
					// conversation — it fans to the app's ChatSurfaceHub, which
					// the inline block surfaces subscribe through.
					if ("slug" in event) {
						app.dispatchSurfaceChanged(event);
					} else if ("conversationId" in event) {
						app.dispatchChatSurfaceChanged(event);
					}
				}
			},
			onError: (message) => app.pane.showNotice(message),
			// U3 Task 5 (§7.3): the hello frame's streamId is the watcher
			// entry's stream — open ext-view transports send it as
			// X-Sigrun-Stream. A reconnect's new id re-registers on the
			// next fetch.
			onHello: (streamId) => app.setEventsStreamId(streamId),
		},
		{
			baseUrl: options.baseUrl,
			...(options.user === undefined ? {} : { user: options.user }),
			...(options.token === undefined ? {} : { token: options.token }),
		},
	);

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
		unwatchEvents();
		app.dispose();
		tui.stop();
	}
}

/**
 * The `sigrun-tui` bin's usage line (parse failures print it + the
 * reason, exit 1).
 */
const TUI_USAGE_TEXT = `usage: sigrun-tui [--server <url>] [--user <name>]
       [--palette <name>] [--accent <name>] [--mode dark|light]
       [--keymap standard|vim|emacs] [--editor <command>]`;

/**
 * The flags {@link tuiMain} accepts. The CLI passes the fields it
 * resolved (tui.json + its own flags) through these; a standalone
 * invocation may pass any subset.
 */
export interface TuiLaunchArgs {
	readonly server?: string;
	readonly user?: string;
	readonly palette?: PaletteName;
	readonly accent?: AccentName;
	readonly mode?: ModeName;
	readonly keymap?: "standard" | "vim" | "emacs";
	readonly editor?: string;
}

/** Every flag {@link parseTuiLaunchArgs} accepts, with its validator. */
const TUI_FLAGS: Record<
	string,
	(value: string) => TuiLaunchArgs[keyof TuiLaunchArgs] | undefined
> = {
	"--server": (value) => (value === "" ? undefined : value),
	"--user": (value) => (value === "" ? undefined : value),
	"--palette": (value) => (isPaletteName(value) ? value : undefined),
	"--accent": (value) => (isAccentName(value) ? value : undefined),
	"--mode": (value) =>
		value === "dark" || value === "light" ? value : undefined,
	"--keymap": (value) =>
		value === "standard" || value === "vim" || value === "emacs"
			? value
			: undefined,
	"--editor": (value) => (value === "" ? undefined : value),
};

/**
 * Parse the bin's argv (post-`node` slices): every entry must be a known
 * flag followed by a value. A validator returning `undefined` means the
 * VALUE was malformed for that flag (not a parse-usage error) — it is
 * reported naming the flag's expected form.
 */
export function parseTuiLaunchArgs(argv: readonly string[]): TuiLaunchArgs {
	const args: {
		[K in keyof TuiLaunchArgs]?: TuiLaunchArgs[K] | undefined
	} = {};
	let index = 0;
	while (index < argv.length) {
		const flag = argv[index] as string;
		const parse = TUI_FLAGS[flag];
		if (parse === undefined) {
			throw new Error(`unknown argument ${JSON.stringify(flag)}\n${TUI_USAGE_TEXT}`);
		}
		const raw = argv[index + 1];
		if (raw === undefined || raw.startsWith("--")) {
			throw new Error(`${flag} requires a value\n${TUI_USAGE_TEXT}`);
		}
		const value = parse(raw);
		if (value === undefined) {
			throw new Error(`${flag} does not accept ${JSON.stringify(raw)}\n${TUI_USAGE_TEXT}`);
		}
		// SAFETY: each TUI_FLAGS entry's validator only returns the value
		// type its key names (the Record's value union is exactly the
		// per-flag literal unions of TuiLaunchArgs).
		(args as Record<string, unknown>)[flag.slice(2)] = value;
		index += 2;
	}
	return args;
}

/**
 * The standalone default server URL: `http://localhost:$SIGRUN_PORT`
 * (3000 when unset). A malformed `SIGRUN_PORT` fails loud naming the
 * variable — the same posture as the core CLI's port parsing.
 */
function defaultBaseUrl(env: NodeJS.ProcessEnv): string {
	const raw = env.SIGRUN_PORT;
	let port = 3000;
	if (raw !== undefined && raw !== "") {
		port = Number(raw);
		if (!Number.isInteger(port) || port <= 0) {
			throw new Error(`SIGRUN_PORT must be a positive integer, got ${raw}`);
		}
	}
	return `http://localhost:${port}`;
}

/**
 * Resolve the bin's launch options from its parsed flags + environment
 * (Task 7): server (`--server` > `SIGRUN_SERVER` > the localhost default),
 * user (`--user` > `SIGRUN_USER`), token (`SIGRUN_TOKEN` ONLY — there is
 * deliberately no `--token` flag; a credential never rides argv), and
 * the tui.json UI fields the CLI threads through as flags.
 */
export function launchOptionsFrom(
	args: TuiLaunchArgs,
	env: NodeJS.ProcessEnv,
): LaunchTuiShellOptions {
	const token = env.SIGRUN_TOKEN?.trim();
	return {
		baseUrl: args.server ?? env.SIGRUN_SERVER ?? defaultBaseUrl(env),
		...(args.user === undefined && env.SIGRUN_USER === undefined
			? {}
			: { user: (args.user ?? env.SIGRUN_USER) as string }),
		...(token === undefined || token === "" ? {} : { token }),
		...(args.palette === undefined ? {} : { palette: args.palette }),
		...(args.accent === undefined ? {} : { accent: args.accent }),
		...(args.mode === undefined ? {} : { mode: args.mode }),
		...(args.keymap === undefined ? {} : { keymap: args.keymap }),
		...(args.editor === undefined ? {} : { editor: args.editor }),
	};
}

/**
 * The dedicated startup-failure message for a server still in its
 * unclaimed state (Task 7): a standalone `sigrun-tui` that hits the
 * setup gate exits with the `sigrun attach` onboarding hint instead of
 * a bare 403. Any other failure maps to `undefined` (the generic path).
 */
export function tuiStartupMessage(error: unknown): string | undefined {
	if (error instanceof SigrunApiError && error.status === 403) {
		const body = error.body as { error?: unknown } | undefined;
		if (body?.error === "setup_required") {
			return "server is not set up — run `sigrun attach` to onboard";
		}
	}
	return undefined;
}

/**
 * The bin's `main`: resolve the launch options (flags + env, see
 * {@link launchOptionsFrom}) and run {@link launchTuiShell}. Returns the
 * process exit code (0 clean; 1 on a usage error or a boot failure,
 * with the message printed — the setup-gate failure carries its own
 * `sigrun attach` onboarding hint).
 */
export async function tuiMain(
	argv: readonly string[] = process.argv.slice(2),
	env: NodeJS.ProcessEnv = process.env,
	io: { error(text: string): void } = { error: (text) => console.error(text) },
): Promise<number> {
	let args: TuiLaunchArgs;
	try {
		args = parseTuiLaunchArgs(argv);
	} catch (error) {
		io.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
	try {
		await launchTuiShell(launchOptionsFrom(args, env));
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const startup = tuiStartupMessage(error);
		io.error(
			startup === undefined
				? message.startsWith("sigrun-tui:")
					? message
					: `sigrun-tui: ${message}`
				: `sigrun-tui: ${startup}`,
		);
		return 1;
	}
}

// Script detection (the bin entry): only run main when node invoked THIS
// file (dist/launch.js) — an import (tests, the old in-process path)
// leaves it inert. npm bin entries are SYMLINKS (…/.bin/sigrun-tui → the
// package's dist/launch.js): node realpaths the main module by default
// (import.meta.url is the REAL path) while process.argv[1] keeps the
// INVOKED path — the comparison must realpath the argv side, or a
// .bin/npx invocation never matches and the bin exits 0 silently.
/** Realpath argv[1], or undefined when it is not a file on disk (an
 * argv[1] that doesn't exist can never be this module — e.g. exotic
 * wrapper invocations). */
function invokedEntryPath(): string | undefined {
	if (process.argv[1] === undefined) return undefined;
	try {
		return realpathSync(process.argv[1]);
	} catch {
		return undefined;
	}
}

const invokedEntry = invokedEntryPath();
const invokedAsBin =
	invokedEntry !== undefined &&
	import.meta.url === pathToFileURL(invokedEntry).href;
if (invokedAsBin) {
	void tuiMain().then((code) => {
		process.exit(code);
	});
}
