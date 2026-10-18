/**
 * The status bar (Task C1, UI refresh): ONE line — mode chip (accent
 * background) + conversation name left, `model · thinking · ctx N%`
 * then hints right; a transient `message` replaces the hints for 4 s.
 * Narrow widths drop hints first, then thinking — model + ctx always
 * stay (the two facts a glance must always answer: what model, how
 * full). Structure assertions: the rendered line contains the state
 * texts, not exact pixel/SGR output.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { StatusBar, type StatusBarState } from "../src/ui/status-bar.js";
import { createTuiTheme } from "../src/theme.js";

function bar(init?: Partial<StatusBarState>): StatusBar {
	return new StatusBar(
		{ theme: createTuiTheme({
			palette: "polar-night",
			accent: "baltic-amber",
			mode: "dark",
			colorMode: "truecolor",
		}) },
		init,
	);
}

const state = (init?: Partial<StatusBarState>): StatusBarState => ({
	conversation: "#12 rebuild auth",
	model: "pi-5-turbo",
	hints: ["ctrl+o pending", "esc abort"],
	...init,
});

const strip = (line: string): string =>
	line.replace(/\u001b\[[0-9;]*m/g, "");

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("StatusBar.render", () => {
	test("wide width: mode+conversation left, right cluster with hints", () => {
		const statusBar = bar(state({ mode: "attach", contextPct: 57 }));
		const line = strip(statusBar.render(100)[0]);
		expect(line).toContain("attach");
		expect(line).toContain("#12 rebuild auth");
		expect(line).toContain("pi-5-turbo");
		expect(line).toContain("ctx 57");
		expect(line).toContain("ctrl+o pending");
	});

	test("renders exactly one line", () => {
		expect(bar(state()).render(100)).toHaveLength(1);
	});

	test("too narrow (width 40): model and ctx kept, hints dropped", () => {
		const statusBar = bar(state({ contextPct: 57 }));
		const line = strip(statusBar.render(40)[0]);
		expect(line).toContain("pi-5-turbo");
		expect(line).toContain("ctx");
		expect(line).toContain("57");
		expect(line).not.toContain("ctrl+o pending");
	});

	test("narrower still: thinking dropped before model/ctx", () => {
		const statusBar = bar(
			state({ mode: "attach", thinking: "thinking", contextPct: 12 }),
		);
		const line = strip(statusBar.render(60)[0]);
		expect(line).toContain("pi-5-turbo");
		expect(line).toContain("ctx 12");
		expect(line).not.toContain("thinking");
		// A wider render still shows thinking (order: hints → thinking).
		expect(strip(statusBar.render(90)[0])).toContain("thinking");
	});

	test("message replaces hints (transient 4 s)", () => {
		const statusBar = bar(state());
		statusBar.set(state({ message: "stream: reconnected" }));
		let line = strip(statusBar.render(100)[0]);
		expect(line).toContain("stream: reconnected");
		expect(line).not.toContain("ctrl+o pending");
		vi.advanceTimersByTime(4000);
		line = strip(statusBar.render(100)[0]);
		expect(line).not.toContain("stream: reconnected");
		expect(line).toContain("ctrl+o pending");
	});

	test("render never exceeds the width in visible cells", () => {
		const statusBar = bar(state({ mode: "attach", thinking: "on", contextPct: 57 }));
		const line = statusBar.render(40)[0];
		expect(strip(line).length).toBeLessThanOrEqual(40);
	});
});

describe("StatusBar.handleMouse", () => {
	function click(x: number, width: number): TuiMouseEvent {
		return {
			type: "click",
			button: "left",
			x,
			y: 0,
			screenX: x,
			screenY: 0,
			width,
			height: 1,
			shift: false,
			alt: false,
			ctrl: false,
		};
	}

	test("the model segment fires onModelClick, thinking fires onThinkingClick", () => {
		const statusBar = bar(
			state({ model: "pi-5-turbo", thinking: "high", contextPct: 57 }),
		);
		const line = strip(statusBar.render(120)[0] ?? "");
		const modelX = line.indexOf("pi-5-turbo") + 1;
		const thinkingX = line.indexOf("high") + 1;
		const ctxX = line.indexOf("ctx 57") + 1;
		const seen: string[] = [];
		statusBar.onModelClick = () => seen.push("model");
		statusBar.onThinkingClick = () => seen.push("thinking");
		expect(statusBar.handleMouse(click(modelX, 120))).toEqual({ handled: true });
		expect(statusBar.handleMouse(click(thinkingX, 120))).toEqual({ handled: true });
		expect(seen).toEqual(["model", "thinking"]);
		// ctx and the left side carry no surface.
		expect(statusBar.handleMouse(click(ctxX, 120))).toBeUndefined();
		expect(statusBar.handleMouse(click(0, 120))).toBeUndefined();
	});

	test("narrow width: thinking is dropped, so it mis-hits nothing", () => {
		const statusBar = bar(
			state({ mode: "attach", thinking: "thinking", contextPct: 12 }),
		);
		const line = strip(statusBar.render(60)[0] ?? "");
		expect(line).not.toContain("thinking"); // compact fallback
		const seen: string[] = [];
		statusBar.onModelClick = () => seen.push("model");
		statusBar.onThinkingClick = () => seen.push("thinking");
		expect(
			statusBar.handleMouse(click(line.indexOf("pi-5-turbo") + 1, 60)),
		).toEqual({ handled: true });
		expect(seen).toEqual(["model"]);
		// The dropped thinking segment has no hit region in the compact layout.
		expect(statusBar.handleMouse(click(line.indexOf("ctx") + 1, 60))).toBeUndefined();
	});

	test("unset sinks pass the click through; non-left clicks pass too", () => {
		const statusBar = bar(state({ model: "pi-5-turbo" }));
		const line = strip(statusBar.render(120)[0] ?? "");
		expect(
			statusBar.handleMouse(click(line.indexOf("pi-5-turbo") + 1, 120)),
		).toBeUndefined();
		statusBar.onModelClick = () => {};
		expect(
			statusBar.handleMouse({ ...click(line.indexOf("pi-5-turbo") + 1, 120), button: "right" }),
		).toBeUndefined();
	});
});
