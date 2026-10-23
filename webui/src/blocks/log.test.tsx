/**
 * The log block (UI-blocks U1 Task 2, spec §5.3): bound `{at?, level?,
 * text}[]` lines with per-level tones (defaults `error`→bad, `warn`→warn,
 * `info`→neutral, `debug`→subtle) and follow semantics — stick to the
 * bottom on append, stop the moment the user scrolls up, resume when
 * they return to the bottom (the useStickToBottom convention).
 *
 * Follow is tested against a `createNodeMock` scroll container: the
 * renderer has no DOM, so the mock carries `scrollTop`/`scrollHeight`/
 * `clientHeight` and the test fires `onScroll` itself.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
	.IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement as h, type ReactElement, type ReactNode } from "react";
import TestRenderer from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";
import type { Block, JsonObject, JsonValue } from "@sigrun/shared/blocks";
import { render, textContent } from "../test-utils";
import { BlockView } from "./BlockView";
import { LogBlockView } from "./log";
import { SurfaceActionsContext, SurfaceDataContext } from "./context";

/** The dispatch spy + access the tests drive SurfaceActions with. */
function makeActions(): {
	dispatch: ReturnType<typeof vi.fn>;
	provider(children: ReactNode): ReactElement;
} {
	const dispatch = vi.fn();
	return {
		dispatch,
		provider: (children): ReactElement =>
			h(SurfaceActionsContext.Provider, {
				value: { dispatch, access: "write", viewState: {} as JsonObject },
			}, children),
	};
}

/** Render `block` with surface data (write access). */
function renderBlock(block: Block, data?: JsonObject): ReturnType<typeof render> {
	const { provider } = makeActions();
	return render(
		h(SurfaceDataContext.Provider, {
			value: { data: data ?? {}, locale: "en-US" },
		}, provider(h(BlockView, { block }))),
	);
}

/** The line shape the tests build (LogLine, spelled locally for the
 *  readonly-array -> JsonValue handoff below). */
interface LogLineShape {
	readonly at?: number | string;
	readonly level?: string;
	readonly text: string;
}

/** A `createNodeMock` scroll container the test drives by hand. */
interface MockScroll {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
}

/** Render a log with lines `lines`, controlled from outside. */
function renderLog(lines: readonly LogLineShape[], follow: boolean): {
	renderer: TestRenderer.ReactTestRenderer;
	scroll: MockScroll;
	scroller: { props: { onScroll(): void } };
	update(next: readonly LogLineShape[]): void;
} {
	const scroll: MockScroll = { scrollHeight: 300, scrollTop: 0, clientHeight: 100 };
	const block = { type: "log", lines: { $: "/lines" }, follow } as const;
	const element = (lines: readonly LogLineShape[]): ReactElement =>
		h(SurfaceDataContext.Provider, {
			value: { data: { lines: lines as unknown as JsonValue }, locale: "en-US" },
		}, h(LogBlockView, { block }));
	let renderer: TestRenderer.ReactTestRenderer | undefined;
	act(() => {
		renderer = TestRenderer.create(element(lines), {
			createNodeMock: (): MockScroll => scroll,
		});
	});
	if (renderer === undefined) throw new Error("renderer not created");
	const scroller = renderer.root.findByProps({ className: "blk-log-lines" }) as unknown as {
		props: { onScroll(): void };
	};
	return {
		renderer,
		scroll,
		scroller,
		update(next: readonly LogLineShape[]): void {
			act(() => {
				renderer!.update(element(next));
			});
		},
	};
}

describe("log: rendering", () => {
	test("renders each line's level and text", () => {
		const renderer = renderBlock(
			{ type: "log", lines: { $: "/lines" } },
			{ lines: [
				{ at: "2026-10-19T01:02:03Z", level: "info", text: "acme started" },
				{ text: "no level line" },
			] },
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("acme started");
		expect(text).toContain("no level line");
		renderer.unmount();
	});

	test("a binding to a missing path renders empty, never an error", () => {
		const renderer = renderBlock({ type: "log", lines: { $: "/missing" } });
		expect(renderer.toJSON()).not.toBeNull();
		const scroller = renderer.root.findByProps({ className: "blk-log-lines" });
		expect(scroller.children).toHaveLength(0);
		renderer.unmount();
	});

	test("wrap rides the data-wrap attribute", () => {
		const renderer = renderBlock(
			{ type: "log", lines: { $: "/lines" }, wrap: true },
			{ lines: [{ text: "x" }] },
		);
		expect(
			renderer.root.findByProps({ "data-block": "log" }).props["data-wrap"],
		).toBe(true);
		renderer.unmount();
	});
});

describe("log: level tones", () => {
	test("default tones map error→bad, warn→warn, info→neutral, debug→subtle", () => {
		const renderer = renderBlock(
			{ type: "log", lines: { $: "/lines" } },
			{ lines: [
				{ level: "error", text: "boom" },
				{ level: "warn", text: "careful" },
				{ level: "info", text: "fyi" },
				{ level: "debug", text: "trace" },
				{ text: "plain" },
			] },
		);
		const toneOf = (index: number): string =>
			(renderer.root.findAllByProps({ className: "blk-log-line" })[index]!.props as {
				"data-tone": string;
			})["data-tone"];
		expect(toneOf(0)).toBe("bad");
		expect(toneOf(1)).toBe("warn");
		expect(toneOf(2)).toBe("neutral");
		expect(toneOf(3)).toBe("info"); // subtle — the muted info token
		expect(toneOf(4)).toBe("neutral");
		renderer.unmount();
	});

	test("a tones prop overrides the defaults per level", () => {
		const renderer = renderBlock(
			{ type: "log", lines: { $: "/lines" }, tones: { info: "accent", error: "bad" } },
			{ lines: [{ level: "info", text: "x" }, { level: "warn", text: "y" }] },
		);
		const lines = renderer.root.findAllByProps({ className: "blk-log-line" });
		expect((lines[0]!.props as { "data-tone": string })["data-tone"]).toBe("accent");
		// Unlisted levels keep their defaults.
		expect((lines[1]!.props as { "data-tone": string })["data-tone"]).toBe("warn");
		renderer.unmount();
	});
});

describe("log: follow (spec §5.3)", () => {
	test("follow scrolls to bottom on append and stops when the user scrolls up", () => {
		const log = renderLog([{ text: "one" }], true);
		// Mounted with follow: bottom already reached.
		expect(log.scroll.scrollTop).toBe(300);
		// Appended lines grow the scroll area; still following → pinned.
		log.scroll.scrollHeight = 600;
		log.update([{ text: "one" }, { text: "two" }]);
		expect(log.scroll.scrollTop).toBe(600);
		// The user scrolls up: following stops.
		log.scroll.scrollTop = 100;
		act(() => {
			log.scroller.props.onScroll();
		});
		log.scroll.scrollHeight = 900;
		log.update([{ text: "one" }, { text: "two" }, { text: "three" }]);
		expect(log.scroll.scrollTop).toBe(100);
		// Back at the bottom: following resumes on the next append.
		log.scroll.scrollTop = 800;
		act(() => {
			log.scroller.props.onScroll();
		});
		log.scroll.scrollHeight = 1200;
		log.update([
			{ text: "one" }, { text: "two" }, { text: "three" }, { text: "four" },
		]);
		expect(log.scroll.scrollTop).toBe(1200);
		log.renderer.unmount();
	});

	test("follow: false never scrolls", () => {
		const log = renderLog([{ text: "one" }], false);
		expect(log.scroll.scrollTop).toBe(0);
		log.scroll.scrollHeight = 600;
		log.update([{ text: "one" }, { text: "two" }]);
		expect(log.scroll.scrollTop).toBe(0);
		log.renderer.unmount();
	});
});
