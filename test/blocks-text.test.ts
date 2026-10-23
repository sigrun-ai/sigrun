/**
 * U0 Task 3 — `toText` (spec §14.3) and `formatValue` (spec §5.3): the
 * deterministic plain-text projection of a surface and the one value
 * formatter behind `stat`, `meter`, table columns, chart axes and card
 * time slots.
 *
 * Determinism contract (spec §14.3): the same input and locale give the
 * same bytes — asserted byte-for-byte across two calls and across a
 * `structuredClone` whose object keys are inserted in a different
 * order (object keys are visited in schema order, never insertion
 * order). Every gallery fixture is snapshotted at widths 80 and 160
 * with locale `en-CA` (the extension-unit-test recipe).
 *
 * `formatValue` here runs first (its own RED/GREEN cycle — Task 3's
 * first commit); the `toText` suites join in the second.
 */

import { describe, expect, it } from "vitest";
import { formatValue, toText } from "@sigrun/shared/blocks";
import type { Block, JsonObject, JsonValue, TextOptions, Tree } from "@sigrun/shared/blocks";
import { SAMPLES, fixture } from "./fixtures/blocks/samples.js";

const LOCALE = "en-CA";

// ─── formatValue (spec §5.3 formats) ──────────────────────────────────────

describe("formatValue", () => {
	it("bytes: 1536 → 1.5 KB", () => {
		expect(formatValue(1536, "bytes", LOCALE)).toBe("1.5 KB");
	});

	it("bytes: whole units below the first step stay bytes; larger steps scale", () => {
		expect(formatValue(512, "bytes", LOCALE)).toBe("512 B");
		expect(formatValue(2048, "bytes", LOCALE)).toBe("2 KB");
		expect(formatValue(1024 * 1024, "bytes", LOCALE)).toBe("1 MB");
	});

	it("duration: 11520000 ms → 3h 12m (two most significant units)", () => {
		expect(formatValue(11520000, "duration", LOCALE)).toBe("3h 12m");
	});

	it("duration: smaller spans use their own units", () => {
		expect(formatValue(0, "duration", LOCALE)).toBe("0s");
		expect(formatValue(45000, "duration", LOCALE)).toBe("45s");
		expect(formatValue(1500, "duration", LOCALE)).toBe("1s 500ms");
		expect(formatValue(90061000, "duration", LOCALE)).toBe("1d 1h");
	});

	it("compact: 2500 → 2.5K", () => {
		expect(formatValue(2500, "compact", LOCALE)).toBe("2.5K");
	});

	it("number: groups digits per locale", () => {
		expect(formatValue(1234567, "number", LOCALE)).toBe("1,234,567");
		expect(formatValue(1234567, undefined, LOCALE)).toBe("1,234,567");
	});

	it("percent: 0–1 fractions render as percentages", () => {
		expect(formatValue(0.42, "percent", LOCALE)).toBe("42%");
		expect(formatValue(0.03, "percent", LOCALE)).toBe("3%");
	});

	it("currency:<ISO 4217> formats amounts", () => {
		expect(formatValue(1234.5, "currency:USD", LOCALE)).toBe("US$1,234.50");
	});

	it("datetime / date / time format epoch milliseconds in the locale", () => {
		const at = 1760000000000; // 2025-10-09T08:53:20Z
		expect(formatValue(at, "datetime", LOCALE, "UTC")).toBe("Oct 9, 2025, 8:53 a.m.");
		expect(formatValue(at, "date", LOCALE, "UTC")).toBe("Oct 9, 2025");
		expect(formatValue(at, "time", LOCALE, "UTC")).toBe("8:53:20 a.m.");
	});

	it("datetime formats accept ISO strings too", () => {
		expect(formatValue("2025-10-09T08:53:20Z", "datetime", LOCALE, "UTC")).toBe(
			"Oct 9, 2025, 8:53 a.m.",
		);
	});

	it("relative formats a timestamp against now", () => {
		const fiveMinAgo = Date.now() - 5 * 60_000;
		expect(formatValue(fiveMinAgo, "relative", LOCALE)).toBe("5 minutes ago");
	});

	it("null renders empty; strings pass through; booleans spell out", () => {
		expect(formatValue(null, undefined, LOCALE)).toBe("");
		expect(formatValue("acme", undefined, LOCALE)).toBe("acme");
		expect(formatValue(true, undefined, LOCALE)).toBe("true");
	});

	it("objects and arrays render as sorted-key JSON (deterministic bytes)", () => {
		expect(formatValue({ b: 1, a: [true, null] }, undefined, LOCALE)).toBe(
			'{"a":[true,null],"b":1}',
		);
	});

	it("an unknown format falls back to plain number formatting", () => {
		expect(formatValue(2500, "furlongs", LOCALE)).toBe("2,500");
	});
});

// ─── toText: shared test helpers ─────────────────────────────────────────────────

/** Width/locale pair every fixture is snapshotted at (spec §14.3 recipe). */
const W80: TextOptions = { width: 80, locale: LOCALE };
const W160: TextOptions = { width: 160, locale: LOCALE };

/** The gallery data: one realistic value per fixture, keyed by name. */
const DATA: Record<string, JsonObject> = {
	chart: { series: { acme: [[0, 20], [60, 24], [120, 21]] } },
	"page-sidebar": {
		title: "Board",
		nav: [
			{ id: "n1", label: "Overview", children: [{ id: "n1a", label: "Latency" }] },
			{ id: "n2", label: "Jobs" },
		],
	},
	stat: { latency: 42 },
	meter: { disk: 0.72 },
	log: {
		lines: [
			{ at: 1760000000000, level: "info", text: "acme boot" },
			{ at: 1760000060000, level: "error", text: "acme upstream failed" },
		],
	},
	tree: {
		nodes: [
			{ id: "a", label: "acme", children: [{ id: "a1", label: "edge" }] },
			{ id: "b", label: "forge" },
		],
	},
	"collection-list": {
		cards: [
			{
				id: "c1",
				eyebrow: "ACME-1",
				title: "Fix the pump",
				subtitle: "the impeller screeches",
				body: "A **long** body clamped in lists.",
				badge: "p1",
				when: "today",
				user: "user:ada",
				userName: "Ada",
				at: 1760000000000,
				score: 91,
				state: "running",
				busy: true,
				quiet: false,
				deps: ["ACME-9"],
				done: true,
				subtasks: [{ id: "c1a", title: "Order the gasket", done: false }],
			},
			{ id: "c2", title: "Paint the bracket", done: false, quiet: false, score: 12, state: "queued", busy: false },
		],
	},
	"collection-table": {
		rows: [
			{ id: "r1", name: "edge-01", load: 0.42, state: "running" },
			{ id: "r2", name: "edge-02", load: 0.95, state: "degraded" },
		],
	},
	"collection-lanes": {
		cards: [
			{ id: "t1", title: "Sketch the rail", state: "todo", tone: "neutral" },
			{ id: "t2", title: "Bend the rail", state: "todo", tone: "info" },
			{ id: "d1", title: "Mount the rail", state: "doing", tone: "good" },
		],
	},
	"collection-grid": {
		shots: [
			{ id: "s1", title: "Front", image: "asset:shots/front.png" },
			{ id: "s2", title: "Side", image: "asset:shots/side.png" },
		],
	},
	"collection-calendar": {
		events: [
			{ id: "e1", title: "Rotate keys", startsAt: 1760000000000, endsAt: 1760003600000, allDay: false },
		],
	},
	form: { form: { title: "acme run", notes: "", retries: 2, enabled: true } },
	"form-view": { view: { filter: { state: "all" } } },
	"form-inline": { view: { quick: { title: "" } } },
	"form-chat": { reply: { answer: "yes", reason: "" } },
	"form-settings": {
		settings: { host: "acme.example", plan: "pro", verbose: true, since: "2025-10-01", at: 1760000000000, window: { start: "2025-10-01", end: "2025-10-08" }, hosts: ["a.example", "b.example"] },
	},
	"form-upload": { upload: { avatar: null } },
	"form-interaction": { values: { verdict: "", reason: "", token: null } },
	"interaction-form": { values: { proceed: "", note: "" } },
	"chat-message": {
		songs: [
			{ id: "s1", title: "Nordlys" },
			{ id: "s2", title: "Frost" },
			{ id: "s3", title: "Aske" },
		],
		reply: { confirm: false },
	},
	"ambient-status": { statusLine: "acme: all systems nominal" },
	"ambient-panel": {
		checks: [
			{ id: "k1", name: "acme", state: "ok", busy: false, tone: "good" },
			{ id: "k2", name: "forge", state: "restarting", busy: true, tone: "warn" },
		],
		recentOutput: [{ at: 1760000000000, level: "warn", text: "restarting forge" }],
		gauge: 0.3,
	},
};

/** Snapshot data for a sample (empty object for literal-only fixtures). */
function dataFor(name: string): JsonObject {
	return DATA[name] ?? {};
}

/** Wrap a root block (with the gallery data when present). */
function treeOf(root: Block): Tree {
	return { v: 1, root };
}

// ─── toText: snapshots of every fixture at widths 80 and 160 ───────────────

describe("toText gallery snapshots (every fixture, widths 80 and 160)", () => {
	for (const sample of SAMPLES) {
		it(`${sample.name} @80`, () => {
			expect(toText(sample.tree, dataFor(sample.name), W80)).toMatchSnapshot();
		});
		it(`${sample.name} @160`, () => {
			expect(toText(sample.tree, dataFor(sample.name), W160)).toMatchSnapshot();
		});
	}
});

// ─── toText: explicit structural assertions ─────────────────────────────────

describe("toText lists", () => {
	it("a numbered list renders `1. … 2. …`", () => {
		const tree = treeOf({
			type: "collection",
			id: "rank",
			items: { $: "/songs" },
			display: "list",
			numbered: true,
			item: { title: { $: "./title" } },
		});
		const text = toText(tree, { songs: [{ id: "1", title: "Nordlys" }, { id: "2", title: "Frost" }] }, W80);
		expect(text).toContain("1. Nordlys");
		expect(text).toContain("2. Frost");
	});

	it("a checkable list renders `[x]` for done and `[ ]` for open", () => {
		const tree = treeOf({
			type: "collection",
			id: "checks",
			items: { $: "/cards" },
			display: "list",
			checkable: "done",
			onCheck: "toggle",
			item: { title: { $: "./title" } },
		});
		const text = toText(
			tree,
			{ cards: [{ id: "a", title: "Mount the rail", done: true }, { id: "b", title: "Paint it", done: false }] },
			W80,
		);
		expect(text).toContain("[x] Mount the rail");
		expect(text).toContain("[ ] Paint it");
	});
});

describe("toText lanes", () => {
	it("lanes render as one heading per group with its items", () => {
		const tree = treeOf({
			type: "collection",
			id: "board",
			items: { $: "/cards" },
			display: "lanes",
			groupBy: "state",
			groups: [
				{ id: "todo", title: "To do" },
				{ id: "doing", title: "Doing" },
			],
			item: { title: { $: "./title" } },
		});
		const text = toText(
			tree,
			{ cards: [{ id: "1", title: "Sketch", state: "todo" }, { id: "2", title: "Bend", state: "doing" }] },
			W80,
		);
		expect(text).toContain("To do");
		expect(text).toContain("  Sketch");
		expect(text).toContain("Doing");
		expect(text).toContain("  Bend");
		expect(text.indexOf("To do")).toBeLessThan(text.indexOf("Sketch"));
		expect(text.indexOf("Sketch")).toBeLessThan(text.indexOf("Doing"));
	});
});

describe("toText tables", () => {
	it("a table aligns columns and puts `priority: low` columns last", () => {
		const tree = treeOf({
			type: "collection",
			id: "hosts",
			items: { $: "/rows" },
			display: "table",
			columns: [
				{ field: "name", label: "Name" },
				{ field: "load", label: "Load", format: "percent", priority: "low" },
				{ field: "state", label: "State" },
			],
			item: { title: { $: "./name" } },
		});
		const text = toText(
			tree,
			{ rows: [{ id: "1", name: "edge-01", load: 0.42, state: "running" }] },
			W160,
		);
		const lines: string[] = text.split("\n");
		// header row and one data row, both aligned under the same columns;
		// priority: low moved `Load` after `State` despite its declared order
		expect(lines.some((l) => /^Name\s+State\s+Load\s*$/.test(l))).toBe(true);
		expect(lines.some((l) => /^edge-01\s+running\s+42%\s*$/.test(l))).toBe(true);
		const header = lines.find((l) => l.startsWith("Name"));
		expect(header).toBeDefined();
		expect((header as string).indexOf("Load")).toBeGreaterThan((header as string).indexOf("State"));
	});
});

describe("toText charts", () => {
	it("a chart renders one line per series: min, max, latest, point count", () => {
		const series: [number, number][] = Array.from({ length: 239 }, (_, i) => [i, 3 + (i % 95)]);
		series.push([239, 41]);
		const tree = treeOf({
			type: "chart",
			id: "cpu",
			title: "CPU",
			x: { kind: "number" },
			y: { unit: "%" },
			series: [{ name: "CPU", kind: "line", data: series }],
		});
		const text = toText(tree, {}, W80);
		expect(text).toContain("CPU: min 3%, max 97%, latest 41% (240 points)");
	});
});

describe("toText unknown blocks", () => {
	it("an unknown block type renders its fallback text", () => {
		const tree = treeOf({ type: "carousel", id: "x", fallback: "a photo strip" } as unknown as Block);
		expect(toText(tree, {}, W80)).toContain("a photo strip");
	});

	it("an unknown block type without a fallback renders `[unsupported block: <type>]`", () => {
		const tree = treeOf({ type: "carousel", id: "x" } as unknown as Block);
		expect(toText(tree, {}, W80)).toBe("[unsupported block: carousel]");
	});
});

// ─── toText: determinism (spec §14.3) ─────────────────────────────────────────

describe("toText determinism", () => {
	/** Rebuild a JSON value with every object's keys inserted in a DIFFERENT order. */
	function shuffled(value: JsonValue): JsonValue {
		if (Array.isArray(value)) return value.map(shuffled);
		if (value !== null && typeof value === "object") {
			const keys = Object.keys(value).sort();
			const rotated = [...keys.slice(1), keys[0]];
			const out: { [key: string]: JsonValue } = {};
			for (const key of rotated) out[key] = shuffled(value[key]);
			return out;
		}
		return value;
	}

	it("the same input renders byte-identical output across two calls", () => {
		const tree = fixture("collection-table");
		const data = dataFor("collection-table");
		expect(toText(tree, data, W80)).toBe(toText(tree, data, W80));
	});

	it("a structuredClone with keys inserted in a different order renders identical bytes", () => {
		for (const sample of SAMPLES) {
			const data = dataFor(sample.name);
			const first = toText(sample.tree, data, W160);
			// SAFETY: `shuffled` rebuilds the same structure (only re-ordering
			// object keys), so a JsonObject in stays a JsonObject out.
			const cloned = shuffled(structuredClone(data)) as JsonObject;
			const second = toText(sample.tree, cloned, W160);
			expect(first, `${sample.name} must be key-order independent`).toBe(second);
		}
	});

	it("does not mutate its inputs", () => {
		const tree = fixture("collection-list");
		const data = dataFor("collection-list");
		const treeSnapshot = JSON.stringify(tree);
		const dataSnapshot = JSON.stringify(data);
		toText(tree, data, W80);
		expect(JSON.stringify(tree)).toBe(treeSnapshot);
		expect(JSON.stringify(data)).toBe(dataSnapshot);
	});
});

// ─── toText: the page empty state (spec §5.1) ─────────────────────────────

describe("toText page empty state", () => {
	/** The §5.1 shape under test: a page whose main's FIRST collection is empty. */
	function emptyPage(): Tree {
		return treeOf({
			type: "page",
			id: "page",
			title: "Jobs",
			main: [
				{
					type: "collection",
					id: "jobs",
					items: { $: "/jobs" },
					display: "list",
					item: { title: { $: "./title" } },
				},
				{ type: "markdown", text: "never shown while empty" },
			],
			empty: { icon: "check", title: "All done", hint: "no pending jobs" },
		});
	}

	it("an empty items array shows the empty title and hint instead of main", () => {
		const text = toText(emptyPage(), { jobs: [] }, W80);
		expect(text).toContain("All done");
		expect(text).toContain("no pending jobs");
		expect(text).not.toContain("never shown while empty");
	});

	it("a missing items path and a null one show the empty state too", () => {
		expect(toText(emptyPage(), {}, W80)).toContain("All done");
		expect(toText(emptyPage(), { jobs: null }, W80)).toContain("All done");
	});

	it("a non-empty first collection renders main normally", () => {
		const text = toText(emptyPage(), { jobs: [{ id: "1", title: "Run the pump" }] }, W80);
		expect(text).toContain("Run the pump");
		expect(text).not.toContain("All done");
	});

	it("the empty state replaces main only — sidebar and detail still render", () => {
		// Spec §5.1 says `empty` is "shown instead of main": main is the
		// replaced region; the sidebar and detail slots are separate and
		// keep their content. This test pins that reading.
		const tree = treeOf({
			type: "page",
			id: "page",
			title: "Jobs",
			sidebar: [{ type: "tree", nodes: { $: "/nav" } }],
			main: [
				{
					type: "collection",
					id: "jobs",
					items: { $: "/jobs" },
					display: "list",
					item: { title: { $: "./title" } },
				},
			],
			detail: [{ type: "markdown", text: "detail pane" }],
			empty: { icon: "check", title: "All done", hint: "no pending jobs" },
		});
		const text = toText(tree, { jobs: [], nav: [{ id: "n", label: "Queue" }] }, W80);
		expect(text).toContain("All done");
		expect(text).toContain("Queue");
		expect(text).toContain("detail pane");
	});
});
