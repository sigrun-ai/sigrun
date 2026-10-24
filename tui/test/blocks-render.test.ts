/**
 * The TUI block-renderer core (UI-blocks U2 Task 1): `renderBlock`,
 * width classes, and the layout blocks (`stack`, `columns`, `grid`,
 * `section`) plus the simple content blocks (`markdown`, `fields`,
 * `stat`, `callout`, `diff`, `details`) as pi-tui components.
 *
 * Snapshots render every layout/content gallery fixture at 72, 100 and
 * 160 columns (compact / regular / wide panes, spec §12.1) with the
 * PLAIN theme — the bytes a person reviews carry structure, not SGR
 * noise. They are the VISUAL BASELINE awaiting user review.
 *
 * Focused cases pin the brief's binding list: width-class boundaries,
 * `visibleAt` hiding in a compact pane, `columns` stacking when the
 * minimums don't fit, the unknown-type fallback, the NO_COLOR tone
 * marker, the ASCII glyph/marker fallbacks a no-Unicode terminal
 * selects (`ctx.unicode === false`), a `collapsed` section hiding its
 * children at every width, the 40-cell truncation rule (Review Focus
 * 2: every rendered line's display width ≤ the pane), the confirm
 * flow (`y/N`, `N` dispatches nothing), the OSC 52 `copy` path, and
 * read access hiding edit/answer buttons (spec §6.5).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Action, Block, JsonObject } from "@sigrun/shared/blocks";
import { fixture } from "../../test/fixtures/blocks/samples.js";
import { plainTuiTheme } from "../src/theme.js";
import { renderBlock, widthClassOf } from "../src/blocks/render.js";
import { iconGlyph } from "../src/blocks/icons.js";
import type { BlockCtx } from "../src/blocks/render.js";

/** One recorded dispatch. */
interface Recorded {
	action: Action;
	payload: unknown;
}

/** The gallery data: a realistic value per fixture that binds one. */
const DATA: Record<string, JsonObject> = {
	stat: { latency: 42 },
};

/** Build a ctx: plain theme, a data object, and a dispatch recorder. */
function makeCtx(
	name = "markdown",
	init?: {
		access?: "read" | "write";
		data?: JsonObject;
		unicode?: boolean;
		terminal?: { write(data: string): void };
	},
): { ctx: BlockCtx; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const ctx: BlockCtx = {
		data: init?.data ?? DATA[name] ?? {},
		theme: plainTuiTheme(),
		locale: "en-CA",
		access: init?.access ?? "write",
		unicode: init?.unicode ?? true,
		dispatch: (action: Action, payload: unknown) => {
			calls.push({ action, payload });
		},
		view: { values: {} },
		terminal: init?.terminal,
	};
	return { ctx, calls };
}

afterEach(() => {
	vi.unstubAllEnvs();
});

// ─── Width classes (spec §12.1) ───────────────────────────────────────────

describe("widthClassOf", () => {
	test("compact below 80 cells", () => {
		expect(widthClassOf(0)).toBe("compact");
		expect(widthClassOf(79)).toBe("compact");
	});

	test("regular from 80 to 139 cells", () => {
		expect(widthClassOf(80)).toBe("regular");
		expect(widthClassOf(139)).toBe("regular");
	});

	test("wide from 140 cells", () => {
		expect(widthClassOf(140)).toBe("wide");
		expect(widthClassOf(200)).toBe("wide");
	});
});

// ─── Fixture snapshots at 72 / 100 / 160 columns ─────────────────────────

const LAYOUT_AND_CONTENT = [
	"stack",
	"columns",
	"grid",
	"section",
	"markdown",
	"fields",
	"stat",
	"callout",
	"diff",
	"details",
] as const;

for (const name of LAYOUT_AND_CONTENT) {
	describe(`fixture: ${name}`, () => {
		for (const width of [72, 100, 160]) {
			test(`renders at ${width} columns`, () => {
				const { ctx } = makeCtx(name);
				const lines = renderBlock(fixture(name).root, ctx).render(width);
				for (const line of lines) {
					expect(visibleWidth(line), `"${line}"`).toBeLessThanOrEqual(width);
				}
				expect(lines).toMatchSnapshot();
			});
		}
	});
}

// ─── visibleAt (spec §12.2) ───────────────────────────────────────────────

describe("visibleAt", () => {
	test("atLeast:regular hides the block in a compact (72) pane", () => {
		const { ctx } = makeCtx("stack");
		expect(renderBlock(fixture("stack").root, ctx).render(72)).toEqual([]);
	});

	test("atLeast:regular shows the block in a regular (100) pane", () => {
		const { ctx } = makeCtx("stack");
		expect(renderBlock(fixture("stack").root, ctx).render(100).length).toBeGreaterThan(0);
	});
});

// ─── columns stacking (spec §12.3) ────────────────────────────────────────

describe("columns fallback", () => {
	test("stacks at 72 when the minimums don't fit (45 + 30 + gap > 72)", () => {
		const { ctx } = makeCtx("columns");
		const lines = renderBlock(fixture("columns").root, ctx).render(72);
		const joined = lines.join("\n");
		expect(joined).toContain("left");
		expect(joined).toContain("Load");
		// Stacked: no single line carries both columns' content.
		for (const line of lines) {
			expect(line.includes("left") && line.includes("Load")).toBe(false);
		}
	});

	test("renders side by side at 100 where the minimums fit", () => {
		const { ctx } = makeCtx("columns");
		const lines = renderBlock(fixture("columns").root, ctx).render(100);
		const both = lines.find((line: string) => line.includes("left") && line.includes("Load"));
		expect(both).toBeDefined();
	});
});

// ─── Unknown blocks (spec §4.4) ───────────────────────────────────────────

describe("unknown block type", () => {
	test("renders the fallback text plus the not-supported marker", () => {
		const block = { type: "hologram", fallback: "raw readout" } as unknown as Block;
		const { ctx } = makeCtx();
		const joined = renderBlock(block, ctx).render(72).join("\n");
		expect(joined).toContain("raw readout");
		expect(joined).toContain("Not supported in this client");
	});

	test("without a fallback only the marker renders", () => {
		const block = { type: "hologram" } as unknown as Block;
		const { ctx } = makeCtx();
		expect(renderBlock(block, ctx).render(72).join("\n")).toContain("Not supported in this client");
	});
});

// ─── NO_COLOR tone markers (Review Focus 5) ───────────────────────────────

describe("NO_COLOR", () => {
	test("a bad callout starts with !", () => {
		vi.stubEnv("NO_COLOR", "1");
		const block: Block = { type: "callout", tone: "bad", title: "Boom", body: "it broke" };
		const { ctx } = makeCtx();
		expect(renderBlock(block, ctx).render(72)[0]?.startsWith("!")).toBe(true);
	});

	test("a good tone leads with ✓ and a warn tone with ▲", () => {
		const good: Block = { type: "callout", tone: "good", title: "OK" };
		const warn: Block = { type: "callout", tone: "warn", title: "Careful" };
		const { ctx } = makeCtx();
		expect(renderBlock(good, ctx).render(72)[0]?.startsWith("✓")).toBe(true);
		expect(renderBlock(warn, ctx).render(72)[0]?.startsWith("▲")).toBe(true);
	});
});

// ─── 40-cell truncation (Review Focus 2) ─────────────────────────────────

describe("40-cell pane", () => {
	const LONG = "A very long section title that cannot possibly fit in forty cells";
	const block: Block = { type: "section", title: LONG, children: [] };

	test("truncates the long title with … and never overflows", () => {
		const { ctx } = makeCtx();
		const lines = renderBlock(block, ctx).render(40);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines[0] ?? "").toContain("…");
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(40);
	});

	test("every rendered line's display width is at most 40, wide chars included", () => {
		const wide: Block = {
			type: "fields",
			rows: [
				{ label: "サイト", value: "日本語のとても長い値がここに入っています四十字を超える場合切り詰められます" },
				{ label: "emoji", value: "🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀" },
			],
		};
		const { ctx } = makeCtx();
		const lines = renderBlock(wide, ctx).render(40);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line), `"${line}"`).toBeLessThanOrEqual(40);
		}
	});
});

// ─── Confirm flow (spec §6.1) ─────────────────────────────────────────────

describe("action confirm", () => {
	const confirming: Block = {
		type: "callout",
		tone: "warn",
		title: "Deploy",
		body: "ready to ship",
		actions: [
			{
				id: "go",
				label: "Ship it",
				action: {
					type: "submit",
					name: "deploy",
					confirm: { title: "Deploy acme?", body: "This restarts acme", tone: "warn" },
				},
			},
		],
	};

	test("activating the action asks y/N with the confirm title and body", () => {
		const { ctx } = makeCtx();
		const comp = renderBlock(confirming, ctx);
		comp.handleInput?.("1");
		const joined = comp.render(72).join("\n");
		expect(joined).toContain("Deploy acme?");
		expect(joined).toContain("This restarts acme");
		expect(joined).toContain("y/N");
	});

	test("N dispatches nothing and returns to the buttons", () => {
		const { ctx, calls } = makeCtx();
		const comp = renderBlock(confirming, ctx);
		comp.handleInput?.("1");
		comp.handleInput?.("N");
		expect(calls).toEqual([]);
		expect(comp.render(72).join("\n")).not.toContain("y/N");
	});

	test("y dispatches the action", () => {
		const { ctx, calls } = makeCtx();
		const comp = renderBlock(confirming, ctx);
		comp.handleInput?.("1");
		comp.handleInput?.("y");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.action).toEqual({
			type: "submit",
			name: "deploy",
			confirm: { title: "Deploy acme?", body: "This restarts acme", tone: "warn" },
		});
	});

	test("an action without confirm dispatches immediately", () => {
		const plain: Block = {
			type: "callout",
			tone: "info",
			title: "Tidy",
			actions: [{ id: "run", label: "Run", action: { type: "submit", name: "tidy" } }],
		};
		const { ctx, calls } = makeCtx();
		const comp = renderBlock(plain, ctx);
		comp.handleInput?.("1");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.action).toEqual({ type: "submit", name: "tidy" });
	});
});

// ─── copy via OSC 52 (tui/src/clipboard.ts) ───────────────────────────────

describe("copy action", () => {
	function copyCallout(text: string | { $: string }): Block {
		return {
			type: "callout",
			tone: "neutral",
			title: "Copy me",
			actions: [{ id: "c", label: "Copy", action: { type: "copy", text } }],
		};
	}

	test("writes the literal text through OSC 52", () => {
		const written: string[] = [];
		const { ctx } = makeCtx("markdown", { terminal: { write: (s) => void written.push(s) } });
		const comp = renderBlock(copyCallout("acme-42"), ctx);
		comp.handleInput?.("1");
		expect(written).toHaveLength(1);
		expect(written[0]).toContain("\x1b]52;c;");
		expect(written[0]).toContain(Buffer.from("acme-42", "utf8").toString("base64"));
	});

	test("resolves a bound text against the data model and never dispatches", () => {
		const written: string[] = [];
		const { ctx, calls } = makeCtx("markdown", {
			data: { jobId: "job-7" },
			terminal: { write: (s: string) => void written.push(s) },
		});
		const comp = renderBlock(copyCallout({ $: "/jobId" }), ctx);
		comp.handleInput?.("1");
		expect(written[0]).toContain(Buffer.from("job-7", "utf8").toString("base64"));
		// copy is channel-local: it never dispatches to the surface.
		expect(calls).toEqual([]);
	});
});

// ─── No-Unicode terminals (§10.2: ASCII glyph + marker fallbacks) ──────

describe("no-Unicode capability", () => {
	test("iconGlyph answers the ASCII fallback exactly when asked", () => {
		expect(iconGlyph("error", true)).toBe("!!");
		expect(iconGlyph("clock", true)).toBe("o");
		expect(iconGlyph("check", true)).toBe("v");
		expect(iconGlyph("error", false)).toBe("✖");
		expect(iconGlyph("clock", false)).toBe("◷");
	});

	test("icons render their ASCII fallback (fields row and stat head)", () => {
		const fields: Block = {
			type: "fields",
			rows: [{ label: "Errors", value: 2, tone: "bad", icon: "error" }],
		};
		const stat: Block = {
			type: "stat",
			label: "Latency",
			value: 42,
			unit: "ms",
			icon: "clock",
		};
		const { ctx } = makeCtx("markdown", { unicode: false });
		// `error`'s ASCII fallback is `!!`; the Unicode glyph is `✖`.
		expect(renderBlock(fields, ctx).render(72).join("\n")).toContain("Errors  !! 2");
		expect(renderBlock(fields, ctx).render(72).join("\n")).not.toContain("✖");
		expect(renderBlock(stat, ctx).render(72)[0]).toContain("o Latency:");
	});

	test("tone markers use the ASCII forms (callout title line)", () => {
		const good: Block = { type: "callout", tone: "good", title: "OK" };
		const warn: Block = { type: "callout", tone: "warn", title: "Careful" };
		const neutral: Block = { type: "callout", tone: "neutral", title: "Hmm" };
		const info: Block = { type: "callout", tone: "info", title: "FYI" };
		const accent: Block = { type: "callout", tone: "accent", title: "Hey" };
		const { ctx } = makeCtx("markdown", { unicode: false });
		expect(renderBlock(good, ctx).render(72)[0]?.startsWith("v ")).toBe(true);
		expect(renderBlock(warn, ctx).render(72)[0]?.startsWith("^ ")).toBe(true);
		expect(renderBlock(neutral, ctx).render(72)[0]?.startsWith("- ")).toBe(true);
		expect(renderBlock(info, ctx).render(72)[0]?.startsWith(". ")).toBe(true);
		expect(renderBlock(accent, ctx).render(72)[0]?.startsWith("* ")).toBe(true);
		// `bad` is ASCII in both tables (the NO_COLOR marker).
		const bad: Block = { type: "callout", tone: "bad", title: "Boom" };
		expect(renderBlock(bad, ctx).render(72)[0]?.startsWith("! ")).toBe(true);
	});

	test("a toned section header marker is ASCII under the signal", () => {
		const section: Block = { type: "section", title: "Group", tone: "info", children: [] };
		const { ctx } = makeCtx("markdown", { unicode: false });
		expect(renderBlock(section, ctx).render(72)[0]?.startsWith(".")).toBe(true);
	});

	test("Unicode terminals keep the glyphs (the default ctx)", () => {
		const good: Block = { type: "callout", tone: "good", title: "OK" };
		const { ctx } = makeCtx();
		expect(renderBlock(good, ctx).render(72)[0]?.startsWith("✓")).toBe(true);
	});
});

// ─── collapsed sections (§5.2: author's initial state) ───────────────

describe("collapsed section", () => {
	const collapsed: Block = {
		type: "section",
		title: "Secrets",
		subtitle: "collapsed by the author",
		collapsible: true,
		collapsed: true,
		children: [{ type: "markdown", text: "hidden child" }],
	};

	for (const width of [72, 100, 160]) {
		test(`renders only the header at ${width} columns`, () => {
			const { ctx } = makeCtx("markdown");
			const lines = renderBlock(collapsed, ctx).render(width);
			const joined = lines.join("\n");
			expect(joined).toContain("Secrets");
			expect(joined).toContain("collapsed by the author");
			expect(joined).not.toContain("hidden child");
		});
	}

	test("an uncollapsed section still renders its children", () => {
		const open: Block = {
			type: "section",
			title: "Group",
			children: [{ type: "markdown", text: "visible child" }],
		};
		const { ctx } = makeCtx("markdown");
		expect(renderBlock(open, ctx).render(72).join("\n")).toContain("visible child");
	});
});

// ─── read access hides edit/answer actions (spec §6.5) ───────────────────

describe("read access", () => {
	test("edit/submit buttons are hidden; copy stays", () => {
		const block: Block = {
			type: "callout",
			tone: "info",
			title: "Info",
			actions: [
				{ id: "a", label: "Acknowledge", action: { type: "edit", name: "ack" } },
				{ id: "b", label: "Copy id", action: { type: "copy", text: "x" } },
			],
		};
		const { ctx } = makeCtx("markdown", { access: "read" });
		const joined = renderBlock(block, ctx).render(72).join("\n");
		expect(joined).toContain("Copy id");
		expect(joined).not.toContain("Acknowledge");
	});
});
