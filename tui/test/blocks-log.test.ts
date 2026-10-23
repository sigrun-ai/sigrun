/**
 * The log block (UI-blocks U2 Task 2, spec §5.3): bound `{at?, level?,
 * text}[]` lines in a block-local viewport that follows the tail while
 * `follow` is on and the user stays at the bottom; scrolling up stops
 * the following, returning to the tail re-arms it (the transcript
 * convention). Per-level tones default `error`→bad, `warn`→warn,
 * `info`→neutral, `debug`→subtle (the muted `info` token), overridable
 * per level by the `tones` prop. `wrap` folds long lines instead of
 * truncating them.
 */

import { describe, expect, test, vi } from "vitest";
import type { Block, JsonObject } from "@sigrun/shared/blocks";
import { plainTuiTheme } from "../src/theme.js";
import { renderBlock } from "../src/blocks/render.js";
import type { BlockCtx } from "../src/blocks/render.js";
import { LOG_VIEWPORT_ROWS } from "../src/blocks/log.js";

/** Build a ctx: plain theme, a data object. */
function makeCtx(data: JsonObject): BlockCtx {
	return {
		data,
		theme: plainTuiTheme(),
		locale: "en-CA",
		timeZone: "UTC",
		access: "write",
		unicode: true,
		dispatch: () => {},
		view: { values: {} },
	};
}

/** N synthetic lines: `line 0` … `line N-1`. */
function linesOf(count: number): JsonObject[] {
	return Array.from({ length: count }, (_, i) => ({ text: `line ${i}` }));
}

const LOG: Block = { type: "log", lines: { $: "/lines" }, follow: true };

const UP = "\x1b[A";
const DOWN = "\x1b[B";

// ─── the tail-follow viewport ─────────────────────────────────────────────

describe("log follow", () => {
	test("follow shows the tail: the last viewport rows", () => {
		const ctx = makeCtx({ lines: linesOf(40) });
		const out = renderBlock(LOG, ctx).render(80);
		expect(out).toHaveLength(LOG_VIEWPORT_ROWS);
		expect(out[0]).toContain(`line ${40 - LOG_VIEWPORT_ROWS}`);
		expect(out[out.length - 1]).toContain("line 39");
	});

	test("scrolling up stops the following", () => {
		const ctx = makeCtx({ lines: linesOf(40) });
		const comp = renderBlock(LOG, ctx);
		comp.render(80);
		comp.handleInput?.(UP);
		const out = comp.render(80);
		// One row up from the tail.
		expect(out[out.length - 1]).toContain("line 38");
		expect(out[0]).toContain(`line ${40 - LOG_VIEWPORT_ROWS - 1}`);
	});

	test("returning to the tail re-arms the following", () => {
		const ctx = makeCtx({ lines: linesOf(40) });
		const comp = renderBlock(LOG, ctx);
		comp.render(80);
		comp.handleInput?.(UP);
		comp.handleInput?.(UP);
		expect(comp.render(80).at(-1)).toContain("line 37");
		// A page of downs lands back on the tail.
		for (let i = 0; i < LOG_VIEWPORT_ROWS; i++) comp.handleInput?.(DOWN);
		expect(comp.render(80).at(-1)).toContain("line 39");
		// And it follows again: the view pins to the newest tail.
		comp.handleInput?.(DOWN);
		expect(comp.render(80).at(-1)).toContain("line 39");
	});

	test("scrolling up never passes the first line", () => {
		const ctx = makeCtx({ lines: linesOf(60) });
		const comp = renderBlock(LOG, ctx);
		comp.render(80);
		for (let i = 0; i < 200; i++) comp.handleInput?.(UP);
		const out = comp.render(80);
		expect(out[0]).toContain("line 0");
		expect(out).toHaveLength(LOG_VIEWPORT_ROWS);
	});

	test("without follow the log anchors at its top", () => {
		const block: Block = { type: "log", lines: { $: "/lines" } };
		const ctx = makeCtx({ lines: linesOf(40) });
		const out = renderBlock(block, ctx).render(80);
		expect(out[0]).toContain("line 0");
		expect(out.at(-1)).toContain(`line ${LOG_VIEWPORT_ROWS - 1}`);
	});

	test("fewer lines than the viewport render them all", () => {
		const ctx = makeCtx({ lines: linesOf(3) });
		const out = renderBlock(LOG, ctx).render(80);
		expect(out).toHaveLength(3);
		expect(out[0]).toContain("line 0");
	});

	test("a missing binding renders empty, never an error", () => {
		const ctx = makeCtx({});
		expect(renderBlock(LOG, ctx).render(80)).toEqual([]);
	});
});

// ─── line shape: time, level, tone ────────────────────────────────────────

describe("log lines", () => {
	test("at renders as a time, level as [level]", () => {
		const ctx = makeCtx({
			lines: [{ at: 0, level: "error", text: "connection refused" }],
		});
		const out = renderBlock(LOG, ctx).render(80);
		expect(out[0]).toContain("12:00:00");
		expect(out[0]).toContain("[error]");
		expect(out[0]).toContain("connection refused");
	});

	test("unlevels-levels tones: default map", () => {
		const ctx = makeCtx({
			lines: [
				{ level: "error", text: "e" },
				{ level: "warn", text: "w" },
				{ level: "info", text: "i" },
				{ level: "debug", text: "d" },
				{ text: "plain" },
				{ level: "verbose", text: "v" },
			],
		});
		// The plain theme drops colour; the structure is the assertion.
		const out = renderBlock(LOG, ctx).render(80);
		expect(out).toHaveLength(6);
		expect(out[0]).toContain("[error]");
		expect(out[1]).toContain("[warn]");
		expect(out[2]).toContain("[info]");
		expect(out[3]).toContain("[debug]");
		expect(out[4]).toBe("plain");
		expect(out[5]).toBe("[verbose] v");
	});

	test("the tones prop overrides per level", () => {
		const block: Block = {
			type: "log",
			lines: { $: "/lines" },
			tones: { error: "info", custom: "good" },
		};
		const ctx = makeCtx({
			lines: [
				{ level: "error", text: "quiet error" },
				{ level: "custom", text: "good custom" },
			],
		});
		const out = renderBlock(block, ctx).render(80);
		expect(out[0]).toContain("[error] quiet error");
		expect(out[1]).toContain("[custom] good custom");
	});

	test("wrap folds long text instead of truncating", () => {
		const long = "acme-".repeat(40);
		const wrapping: Block = { type: "log", lines: { $: "/lines" }, wrap: true };
		const ctx = makeCtx({ lines: [{ text: long }] });
		const out = renderBlock(wrapping, ctx).render(30);
		expect(out.length).toBeGreaterThan(1);
		// Every piece of the text survives somewhere.
		expect(out.join("")).toContain(long.slice(0, 25));
	});

	test("wrap off truncates one line", () => {
		const long = "acme-".repeat(40);
		const ctx = makeCtx({ lines: [{ text: long }] });
		const out = renderBlock(LOG, ctx).render(30);
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("…");
	});
});

// ─── env hygiene ──────────────────────────────────────────────────────────

describe("log env", () => {
	test("the viewport constant is a sane block height", () => {
		expect(LOG_VIEWPORT_ROWS).toBeGreaterThan(3);
		expect(LOG_VIEWPORT_ROWS).toBeLessThan(40);
	});

	test("renders under NO_COLOR without SGR escapes", () => {
		vi.stubEnv("NO_COLOR", "1");
		const ctx = makeCtx({ lines: [{ level: "error", text: "boom" }] });
		expect(renderBlock(LOG, ctx).render(80).join("\n")).not.toMatch(/\u001b\[/);
	});
});
