/**
 * The data blocks (UI-blocks U2 Task 2): the Braille dot canvas and
 * the display ramps (`braille.ts`), the chart (`chart.ts`), the meter
 * (`meter.ts`) and the tree (`treeview.ts`).
 *
 * Focused cases pin the brief's list: the diagonal dot pattern, the
 * 100-column chart (axes, ONE legend line, Braille series), the block
 * ramp bars, stacked bars summing, thresholds as dashed rules in their
 * tone, the sub-30-cell sparkline mode, the meter bar width, and tree
 * expansion dispatching `onExpand` with `{id}`. Chart and meter
 * fixtures are snapshotted at 72/100/160 columns (the visual baseline,
 * plain theme; `timeZone: "UTC"` keeps the time-axis text deterministic).
 */

import { describe, expect, test } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Action, Block, JsonObject } from "@sigrun/shared/blocks";
import { fixture } from "../../test/fixtures/blocks/samples.js";
import { plainTuiTheme } from "../src/theme.js";
import type { TuiTheme, TuiToken } from "../src/theme.js";
import { renderBlock } from "../src/blocks/render.js";
import type { BlockCtx } from "../src/blocks/render.js";
import { BrailleCanvas, sparkline } from "../src/blocks/braille.js";

/** One recorded dispatch. */
interface Recorded {
	action: Action;
	payload: unknown;
}

/** Build a ctx: plain theme, a data object, and a dispatch recorder. */
function makeCtx(
	data: JsonObject = {},
	init?: { unicode?: boolean; theme?: TuiTheme },
): { ctx: BlockCtx; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const ctx: BlockCtx = {
		data,
		theme: init?.theme ?? plainTuiTheme(),
		locale: "en-CA",
		timeZone: "UTC",
		access: "write",
		unicode: init?.unicode ?? true,
		dispatch: (action: Action, payload: unknown) => {
			calls.push({ action, payload });
		},
		view: { values: {} },
	};
	return { ctx, calls };
}

/** A theme that records styling as visible markers (tone assertions without SGR). */
function markingTuiTheme(): TuiTheme {
	const paint =
		(token: string) =>
		(s: string): string =>
			`<${token}>${s}</${token}>`;
	return {
		fg: (token: TuiToken) => paint(token),
		bg: (token: TuiToken) => paint(token),
		bold: (s: string) => `<b>${s}</b>`,
		dim: (s: string) => `<dim>${s}</dim>`,
		italic: (s: string) => `<i>${s}</i>`,
	};
}

/** The gallery data the chart fixture binds (`/series/acme`). */
const CHART_DATA: JsonObject = {
	series: { acme: [[0, 3], [30, 8], [60, 5], [90, 11], [120, 9]] },
};

// ─── The Braille dot canvas (2×4 dots per cell) ───────────────────────────

describe("BrailleCanvas", () => {
	test("a diagonal across one cell plots dots 1,5,3,8", () => {
		const canvas = new BrailleCanvas(1, 1);
		canvas.plot(0, 0); // dot 1
		canvas.plot(1, 1); // dot 5
		canvas.plot(0, 2); // dot 3
		canvas.plot(1, 3); // dot 8
		expect(canvas.rows()).toEqual(["⢥"]);
	});

	test("a dot-grid diagonal across two cells walks the dot centers", () => {
		const canvas = new BrailleCanvas(2, 1);
		canvas.line(0, 0, 3, 3);
		expect(canvas.rows()).toEqual(["⠡⢄"]);
	});

	test("out-of-range dots are ignored, never thrown", () => {
		const canvas = new BrailleCanvas(1, 1);
		canvas.plot(-1, 0);
		canvas.plot(0, -1);
		canvas.plot(9, 9);
		expect(canvas.rows()).toEqual(["⠀"]);
	});

	test("fill covers the dot rectangle inclusive", () => {
		const canvas = new BrailleCanvas(2, 1);
		canvas.fill(0, 0, 1, 1);
		expect(canvas.rows()).toEqual(["⠳⠀"]);
	});

	test("the last plotter owns the cell (over-plot colouring)", () => {
		const canvas = new BrailleCanvas(1, 1);
		canvas.plot(0, 0, 1);
		expect(canvas.cellOwner(0, 0)).toBe(1);
		canvas.plot(1, 1, 2);
		expect(canvas.cellOwner(0, 0)).toBe(2);
		expect(canvas.cellBits(0, 0)).toBe(0x21);
	});
});

// ─── The sparkline ramp ───────────────────────────────────────────────────

describe("sparkline", () => {
	test("maps values onto the eighth-block ramp", () => {
		// floor(t*8) clamped to the 8-glyph ramp: each glyph covers 1/8
		// of the range, the top value is the full block.
		expect(sparkline([30, 42, 38, 51, 44], 5, true)).toBe("▁▅▄█▆");
	});

	test("downsamples to the cell budget keeping both ends (lttb)", () => {
		const ramp = sparkline([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4, true);
		expect(ramp).toBe("▁▁▅█");
	});

	test("the ASCII ramp on a no-Unicode terminal", () => {
		expect(sparkline([30, 42, 38, 51, 44], 5, false)).toBe("_+-*");
	});

	test("empty and flat inputs degrade quietly", () => {
		expect(sparkline([], 5, true)).toBe("");
		expect(sparkline([7, 7, 7], 3, true)).toBe("▄▄▄");
	});
});

// ─── chart: snapshots at 72 / 100 / 160 columns ───────────────────────────

describe("fixture: chart", () => {
	for (const width of [72, 100, 160]) {
		test(`renders at ${width} columns`, () => {
			const { ctx } = makeCtx(CHART_DATA);
			const lines = renderBlock(fixture("chart").root, ctx).render(width);
			for (const line of lines) {
				expect(visibleWidth(line), `"${line}"`).toBeLessThanOrEqual(width);
			}
			expect(lines).toMatchSnapshot();
		});
	}
});

// ─── chart: the 100-column anatomy ────────────────────────────────────────

describe("chart at 100 columns", () => {
	const lines = (): string[] => {
		const { ctx } = makeCtx(CHART_DATA);
		return renderBlock(fixture("chart").root, ctx).render(100);
	};

	test("the title renders", () => {
		expect(lines().join("\n")).toContain("Throughput");
	});

	test("ONE legend line names every series", () => {
		const legend = lines().filter(
			(line: string) => line.includes("acme") && line.includes("Baseline"),
		);
		expect(legend).toHaveLength(1);
	});

	test("the series draw in Braille", () => {
		expect(lines().some((line: string) => /[\u2800-\u28ff]/.test(line))).toBe(true);
	});

	test("the y axis labels the domain bounds with the unit", () => {
		const joined = lines().join("\n");
		expect(joined).toContain("12 req/s");
		expect(joined).toContain("0 req/s");
	});

	test("the x axis labels its ticks", () => {
		const timeish = /\d{1,2}:\d{2}:\d{2}/;
		const ticks = lines().filter((line: string) => timeish.test(line));
		expect(ticks.length).toBeGreaterThanOrEqual(1);
		expect((ticks[0]?.match(new RegExp(timeish, "g")) ?? []).length).toBeGreaterThanOrEqual(2);
	});

	test("plot rows fill the pane exactly (width invariant)", () => {
		const plot = lines().filter((line: string) => /[\u2800-\u28ff]/.test(line));
		expect(plot.length).toBeGreaterThan(0);
		for (const line of plot) expect(visibleWidth(line)).toBe(100);
	});
});

// ─── chart: bars ──────────────────────────────────────────────────────────

describe("chart bars", () => {
	test("bars draw with the block ramp", () => {
		const block: Block = {
			type: "chart",
			x: { kind: "number" },
			series: [{ name: "load", kind: "bar", data: [[0, 1], [1, 5]] }],
		};
		const { ctx } = makeCtx();
		const joined = renderBlock(block, ctx).render(80).join("\n");
		expect(joined).toMatch(/[▁▂▃▄▅▆▇█]/);
	});

	test("stacked bars sum to the full column", () => {
		const block: Block = {
			type: "chart",
			x: { kind: "number" },
			stacked: true,
			series: [
				{ name: "a", kind: "bar", data: [[0, 1]] },
				{ name: "b", kind: "bar", data: [[0, 1]] },
			],
		};
		const { ctx } = makeCtx();
		const lines = renderBlock(block, ctx).render(80);
		// Cumulative 2 over a [0,2] domain: every plot row carries a full cell.
		expect(lines.filter((line: string) => line.includes("█")).length).toBeGreaterThanOrEqual(5);
	});

	test("thresholds render as a dashed rule in their tone with the label", () => {
		const block: Block = {
			type: "chart",
			x: { kind: "number" },
			y: { min: 0, max: 10 },
			series: [{ name: "a", kind: "line", data: [[0, 2], [1, 8]] }],
			thresholds: [{ at: 5, tone: "warn", label: "SLO" }],
		};
		const { ctx } = makeCtx({}, { theme: markingTuiTheme() });
		const lines = renderBlock(block, ctx).render(80);
		const rule = lines.find((line: string) => line.includes("SLO"));
		expect(rule).toBeDefined();
		expect(rule ?? "").toContain("╌");
		expect(rule ?? "").toContain("<warn>");
	});
});

// ─── chart: the narrow fallback (spec §5.4 / §12.3) ───────────────────────

describe("chart narrow fallback", () => {
	test("below 30 cells: a sparkline plus the latest value per series", () => {
		const { ctx } = makeCtx(CHART_DATA);
		const lines = renderBlock(fixture("chart").root, ctx).render(29);
		const joined = lines.join("\n");
		expect(joined).toContain("acme ▁▆▃█▇ 9");
		expect(joined).toContain("Baseline ▁█▅ 11");
		// Sparkline mode draws no axis rows.
		expect(lines.some((line: string) => line.includes("req/s"))).toBe(false);
	});

	test("at exactly 30 cells the full chart still renders", () => {
		const { ctx } = makeCtx(CHART_DATA);
		const lines = renderBlock(fixture("chart").root, ctx).render(30);
		expect(lines.some((line: string) => /[\u2800-\u28ff]/.test(line))).toBe(true);
	});

	test("compact (72) puts the legend below the plot", () => {
		const { ctx } = makeCtx(CHART_DATA);
		const lines = renderBlock(fixture("chart").root, ctx).render(72);
		const legend = lines.findIndex(
			(line: string) => line.includes("acme") && line.includes("Baseline"),
		);
		const plot = lines.findIndex((line: string) => /[\u2800-\u28ff]/.test(line));
		expect(legend).toBeGreaterThan(plot);
	});
});

// ─── chart: the no-Unicode terminal ───────────────────────────────────────

describe("chart ASCII fallback", () => {
	test("no Braille, no block ramp: ASCII markers instead", () => {
		const { ctx } = makeCtx(CHART_DATA, { unicode: false });
		const joined = renderBlock(fixture("chart").root, ctx).render(100).join("\n");
		expect(joined).not.toMatch(/[\u2800-\u28ff]/);
		expect(joined).not.toMatch(/[▁▂▃▄▅▆▇█░]/);
	});

	test("ASCII bars use the ASCII ramp", () => {
		const block: Block = {
			type: "chart",
			x: { kind: "number" },
			series: [{ name: "load", kind: "bar", data: [[0, 1], [1, 5]] }],
		};
		const { ctx } = makeCtx({}, { unicode: false });
		const joined = renderBlock(block, ctx).render(80).join("\n");
		expect(joined).toMatch(/[_.,\-+=*#]/);
		expect(joined).not.toContain("█");
	});

	test("ASCII thresholds dash with '-'", () => {
		const block: Block = {
			type: "chart",
			x: { kind: "number" },
			y: { min: 0, max: 10 },
			series: [{ name: "a", kind: "line", data: [[0, 2], [1, 8]] }],
			thresholds: [{ at: 5, tone: "warn", label: "SLO" }],
		};
		const { ctx } = makeCtx({}, { unicode: false });
		const rule = renderBlock(block, ctx)
			.render(80)
			.find((line: string) => line.includes("SLO"));
		expect(rule ?? "").toContain("-");
		expect(rule ?? "").not.toContain("╌");
	});

	test("the ASCII sparkline mode uses the ASCII ramp", () => {
		const { ctx } = makeCtx(CHART_DATA, { unicode: false });
		const joined = renderBlock(fixture("chart").root, ctx)
			.render(29)
			.join("\n");
		expect(joined).toContain("acme _*,# 9");
	});
});

// ─── meter ────────────────────────────────────────────────────────────────

describe("fixture: meter", () => {
	for (const width of [72, 100, 160]) {
		test(`renders at ${width} columns`, () => {
			const { ctx } = makeCtx({ disk: 0.72 });
			const lines = renderBlock(fixture("meter").root, ctx).render(width);
			for (const line of lines) {
				expect(visibleWidth(line), `"${line}"`).toBeLessThanOrEqual(width);
			}
			expect(lines).toMatchSnapshot();
		});
	}
});

describe("meter", () => {
	test("the bar spans width minus label and value cells", () => {
		const block: Block = {
			type: "meter",
			value: { $: "/disk" },
			min: 0,
			max: 1,
			label: "Disk",
			format: "percent",
		};
		const { ctx } = makeCtx({ disk: 0.5 });
		const [line] = renderBlock(block, ctx).render(40);
		expect(line).toBeDefined();
		expect(visibleWidth(line ?? "")).toBe(40);
		// "Disk 50% " (9 cells) + 31 bar cells = 40; half of 31 floors to 15.
		const filled = [...(line ?? "")].filter((ch: string) => ch === "█").length;
		const empty = [...(line ?? "")].filter((ch: string) => ch === "░").length;
		expect(filled).toBe(15);
		expect(empty).toBe(16);
	});

	test("min/max other than 0..1 scale the fill", () => {
		const block: Block = {
			type: "meter",
			value: { $: "/mem" },
			min: 0,
			max: 10,
			label: "Mem",
		};
		const { ctx } = makeCtx({ mem: 5 });
		const [line] = renderBlock(block, ctx).render(60);
		// "Mem 5 " (6 cells) + 54 bar cells = 60; half of 54 = 27.
		expect([...(line ?? "")].filter((ch: string) => ch === "█").length).toBe(27);
	});

	test("the crossed threshold's tone paints the bar and value", () => {
		const block: Block = {
			type: "meter",
			value: { $: "/disk" },
			min: 0,
			max: 1,
			label: "Disk",
			format: "percent",
			thresholds: [
				{ at: 0.8, tone: "warn" },
				{ at: 0.95, tone: "bad" },
			],
		};
		const { ctx } = makeCtx({ disk: 0.97 }, { theme: markingTuiTheme() });
		const [line] = renderBlock(block, ctx).render(40);
		expect(line ?? "").toContain("<bad>");
		expect(line ?? "").not.toContain("<warn>");
		expect(line ?? "").toContain("97%");
	});

	test("no crossed threshold leaves the bar untoned", () => {
		const block: Block = {
			type: "meter",
			value: { $: "/disk" },
			label: "Disk",
			format: "percent",
			thresholds: [{ at: 0.8, tone: "warn" }],
		};
		const { ctx } = makeCtx({ disk: 0.5 }, { theme: markingTuiTheme() });
		const [line] = renderBlock(block, ctx).render(40);
		expect(line ?? "").not.toContain("<warn>");
	});

	test("the ASCII meter uses '#' and '-'", () => {
		const block: Block = {
			type: "meter",
			value: { $: "/disk" },
			label: "Disk",
			format: "percent",
		};
		const { ctx } = makeCtx({ disk: 0.5 }, { unicode: false });
		const [line] = renderBlock(block, ctx).render(40);
		expect(line ?? "").toContain("#");
		expect(line ?? "").toContain("-");
		expect(line ?? "").not.toMatch(/[█░]/);
	});
});

// ─── tree ─────────────────────────────────────────────────────────────────

describe("tree", () => {
	const NODES: JsonObject = {
		nodes: [
			{ id: "n1", label: "acme services", hasChildren: true },
			{
				id: "n2",
				label: "databases",
				children: [
					{ id: "n2a", label: "pg-primary.example.invalid" },
					{ id: "n2b", label: "pg-replica.example.invalid" },
				],
			},
			{ id: "n3", label: "a leaf" },
		],
	};

	const treeBlock: Block = { type: "tree", nodes: { $: "/nodes" }, onExpand: "expandNode" };

	test("rows show the cursor and the collapsed marker", () => {
		const { ctx } = makeCtx(NODES);
		const lines = renderBlock(treeBlock, ctx).render(72);
		expect(lines[0]).toContain("▸ acme services");
		expect(lines[0]?.startsWith("> ")).toBe(true);
		expect(lines[1]).toContain("databases");
		expect(lines[1]?.startsWith("  ")).toBe(true);
	});

	test("expanding a lazy node dispatches onExpand with {id}", () => {
		const { ctx, calls } = makeCtx(NODES);
		const comp = renderBlock(treeBlock, ctx);
		comp.handleInput?.("\r");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.action).toEqual({ type: "edit", name: "expandNode" });
		expect(calls[0]?.payload).toEqual({ id: "n1" });
	});

	test("inline children render indented once expanded, and collapse again", () => {
		const { ctx, calls } = makeCtx(NODES);
		const comp = renderBlock(treeBlock, ctx);
		comp.handleInput?.("\x1b[B"); // cursor → databases
		expect(comp.render(72).join("\n")).not.toContain("pg-primary.example.invalid");
		comp.handleInput?.("\r");
		const expanded = comp.render(72).join("\n");
		expect(expanded).toContain("▾ databases");
		expect(expanded).toContain("pg-primary.example.invalid");
		expect(expanded).toContain("pg-replica.example.invalid");
		// Inline children never dispatch (they already exist).
		expect(calls).toHaveLength(0);
		comp.handleInput?.("\r");
		expect(comp.render(72).join("\n")).not.toContain("pg-primary.example.invalid");
		expect(comp.render(72).join("\n")).toContain("▸ databases");
	});

	test("Enter on a leaf runs onActivate with {id}", () => {
		const block: Block = {
			type: "tree",
			nodes: { $: "/nodes" },
			onActivate: { type: "navigate", params: { node: "acme" } },
		};
		const { ctx, calls } = makeCtx(NODES);
		const comp = renderBlock(block, ctx);
		comp.handleInput?.("\x1b[B");
		comp.handleInput?.("\x1b[B"); // cursor → the leaf
		comp.handleInput?.("\r");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.action).toEqual({ type: "navigate", params: { node: "acme" } });
		expect(calls[0]?.payload).toEqual({ id: "n3" });
	});

	test("the cursor moves with the arrow keys", () => {
		const { ctx } = makeCtx(NODES);
		const comp = renderBlock(treeBlock, ctx);
		comp.handleInput?.("\x1b[B");
		let rows = comp.render(72);
		expect(rows[0]?.startsWith("  ")).toBe(true);
		expect(rows[1]?.startsWith("> ")).toBe(true);
		comp.handleInput?.("\x1b[A");
		rows = comp.render(72);
		expect(rows[0]?.startsWith("> ")).toBe(true);
	});

	test("the ASCII markers on a no-Unicode terminal", () => {
		const { ctx } = makeCtx(NODES, { unicode: false });
		const comp = renderBlock(treeBlock, ctx);
		expect(comp.render(72)[0]).toContain("> acme services");
		comp.handleInput?.("\x1b[B");
		comp.handleInput?.("\r");
		expect(comp.render(72).join("\n")).toContain("v databases");
	});

	test("node icons render their glyph", () => {
		const data: JsonObject = {
			nodes: [{ id: "n1", label: "workspace", icon: "folder" }],
		};
		const { ctx } = makeCtx(data);
		const lines = renderBlock(treeBlock, ctx).render(72);
		expect(lines[0]).toContain("▸ ▸ workspace");
	});
});
