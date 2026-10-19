/**
 * The launcher shell construction (task C1b): `launchTuiShell` boots a
 * fullscreen TuiAltScreen (mouse on, copy-on-select on), disables the
 * alt-screen built-ins the action layer will own (search + prompt jumps),
 * and mounts the layout root — sidebar (width-gated), a follow-end primary
 * ScrollView around the pane, the auto-height seams, the composer, and the
 * status bar pinned at basis 1.
 *
 * The real screen needs a live terminal, so the tests inject the screen
 * constructor (the `screen` seam on `launchTuiShell`'s options) and stub
 * the terminal/boot fetch — construction is asserted, pixels are not.
 */

import { describe, expect, test } from "vitest";
import {
	HStack,
	ScrollView,
	TuiAltScreen,
	VStack,
	type StackEntry,
	type Terminal,
} from "@earendil-works/pi-tui";
import { launchTuiShell, type TuiScreenFactory } from "../src/launch.js";
import { StatusBar } from "../src/ui/status-bar.js";

/** `Stack.entries` is protected in the types (public at runtime); the
 * layout assertions read it through this structural view. */
function stackEntries(stack: VStack | HStack): StackEntry[] {
	return (stack as unknown as { entries: StackEntry[] }).entries;
}

/** A silent terminal stand-in (ProcessTerminal would touch stdin/stdout). */
function fakeTerminal(): Terminal {
	return {
		start: () => {},
		stop: () => {},
		write: () => {},
		hideCursor: () => {},
		showCursor: () => {},
		moveCursor: () => {},
		get columns() {
			return 120;
		},
		get rows() {
			return 40;
		},
		cleanup: () => {},
	} as unknown as Terminal;
}

/** The injected factory: records the construction, returns a real
 * TuiAltScreen over the fake terminal (start() is never called — boot
 * fails at the first refresh before the screen starts). */
function recordingScreen(record: { args: unknown[] | undefined }): TuiScreenFactory {
	return (terminal, showHardwareCursor, logDirectory, options) => {
		record.args = [terminal, showHardwareCursor, logDirectory, options];
		return new TuiAltScreen(terminal, showHardwareCursor, logDirectory, options);
	};
}

/** Boot always fails fast: the fetch seam rejects before `tui.start()`. */
const failingFetch = (): Promise<never> =>
	Promise.reject(new Error("no server in tests"));

describe("launchTuiShell (C1b fullscreen shell)", () => {
	test("constructs a TuiAltScreen with mouse + copyOnSelect enabled", async () => {
		const record: { args: unknown[] | undefined } = { args: undefined };
		await expect(
			launchTuiShell({
				baseUrl: "http://tui-launch-test.example",
				terminal: fakeTerminal(),
				screen: recordingScreen(record),
				fetchFn: failingFetch,
			}),
		).rejects.toThrow("no server in tests");
		expect(record.args).toBeDefined();
		const [, showHardwareCursor, logDirectory, options] = record.args as [
			unknown,
			boolean,
			unknown,
			{ mouse?: boolean; copyOnSelect?: boolean },
		];
		expect(showHardwareCursor).toBe(false);
		expect(logDirectory).toBeUndefined();
		expect(options.mouse).toBe(true);
		expect(options.copyOnSelect).toBe(true);
	});

	test("mounts the layout root: gated sidebar, primary ScrollView, composer, status bar at basis 1", async () => {
		let root: VStack | undefined;
		const screen: TuiScreenFactory = (terminal, hw, log, options) => {
			const tui = new TuiAltScreen(terminal, hw, log, options);
			tui.setLayoutRoot = (component) => {
				root = component as VStack;
			};
			return tui;
		};
		await expect(
			launchTuiShell({
				baseUrl: "http://tui-launch-test.example",
				terminal: fakeTerminal(),
				screen,
				fetchFn: failingFetch,
			}),
		).rejects.toThrow("no server in tests");
		expect(root).toBeInstanceOf(VStack);
		const entries = stackEntries(root as unknown as VStack);
		// body grow 1, interactions auto, ambient auto, composer auto, status bar 1.
		expect(entries).toHaveLength(5);
		const [body, interactions, ambient, composer, status] = entries;
		expect(body?.component).toBeInstanceOf(HStack);
		expect(body?.grow).toBe(1);
		expect(interactions?.basis).toBe("auto");
		expect(ambient?.basis).toBe("auto");
		expect(composer?.basis).toBe("auto");
		expect(status?.component).toBeInstanceOf(StatusBar);
		expect(status?.basis).toBe(1);

		const bodyEntries = stackEntries(body?.component as HStack);
		const [sidebar, scroll] = bodyEntries;
		expect(sidebar?.basis).toBe(28);
		expect(sidebar?.visible?.({ width: 79, height: 24 })).toBe(false);
		expect(sidebar?.visible?.({ width: 80, height: 24 })).toBe(true);
		expect(scroll?.component).toBeInstanceOf(ScrollView);
		expect(scroll?.grow).toBe(1);
	});
});

describe("launchTuiShell token threading (Task 7)", () => {
	test("a token rides every boot request as authorization: Bearer", async () => {
		const headers: Record<string, string>[] = [];
		const captureThenFail = (
			_input: string,
			init?: { headers?: Record<string, string> },
		): Promise<never> => {
			if (init?.headers !== undefined) headers.push(init.headers);
			return Promise.reject(new Error("stop after capture"));
		};
		await expect(
			launchTuiShell({
				baseUrl: "http://tui-launch-test.example",
				user: "alice",
				token: "sgr_shell_token",
				terminal: fakeTerminal(),
				screen: recordingScreen({ args: undefined }),
				fetchFn: captureThenFail,
			}),
		).rejects.toThrow("stop after capture");
		expect(headers.length).toBeGreaterThanOrEqual(1);
		expect(headers[0]?.authorization).toBe("Bearer sgr_shell_token");
	});
});
