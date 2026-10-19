/**
 * The shared delta-view functions (core hardening W3 Task 3, spec §7.3
 * ruling 11): `diffViews` / `applyDelta` / `isEmptyDelta` from
 * `@sigrun/shared/view-delta`.
 *
 * Shape:
 * - a hand-rolled property test (200 seeded random sequences of
 *   append-suffix / remove / doc-set / doc-unset / steer-change steps)
 *   asserts fold(applyDelta, snapshot, deltas) deep-equals the final view;
 *   when `diffViews` returns `undefined` the generating step was a
 *   non-suffix change (a head insert), and the fold re-bases on a fresh
 *   snapshot — exactly the server's fallback;
 * - named cases pin the prefix rule (a head-marker reorder → `undefined`),
 *   the identical-views empty delta, and `applyDelta`'s never-mutates
 *   contract.
 */

import { describe, expect, it } from "vitest";
import {
	applyDelta,
	diffViews,
	isEmptyDelta,
	type ViewDelta,
} from "@sigrun/shared/view-delta";
import type {
	ConversationViewWire,
	ViewEntry,
} from "@sigrun/shared/views";

// ─── Deterministic RNG (mulberry32 — no new dependency) ──────────────────

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ─── View builder + random-step generator ────────────────────────────────

let entrySeq = 1;

function entry(id: number): ViewEntry {
	return {
		id,
		kind: "pi.user",
		model: [{ role: "user", content: `entry ${id}` }],
	};
}

function baseView(): ConversationViewWire {
	entrySeq = 1;
	return {
		conversation: { id: 1 },
		entries: [entry(entrySeq++)],
		docs: { "pi.agent": { model: { provider: "faux", modelId: "m" } } },
		steer: { busy: false, queued: 0 },
	};
}

type StepKind =
	| "append-suffix"
	| "remove"
	| "doc-set"
	| "doc-unset"
	| "steer-change"
	| "head-insert"; // the non-suffix step: diffViews must return undefined

interface Step {
	readonly kind: StepKind;
	readonly apply: (view: ConversationViewWire) => ConversationViewWire;
}

function randomStep(_view: ConversationViewWire, rand: () => number): Step {
	const kinds: StepKind[] = [
		"append-suffix",
		"append-suffix",
		"remove",
		"doc-set",
		"doc-unset",
		"steer-change",
		"head-insert",
	];
	const kind = kinds[Math.floor(rand() * kinds.length)]!;
	switch (kind) {
		case "append-suffix": {
			const count = 1 + Math.floor(rand() * 3);
			return {
				kind,
				apply: (v) => ({
					...v,
					entries: [
						...v.entries,
						...Array.from({ length: count }, () => entry(entrySeq++)),
					],
				}),
			};
		}
		case "remove": {
			// Remove a random subset of ids (middle removals included — still
			// representable: the survivors stay in order).
			return {
				kind,
				apply: (v) => ({
					...v,
					entries: v.entries.filter(() => rand() > 0.3),
				}),
			};
		}
		case "doc-set": {
			const key = `pi.doc${Math.floor(rand() * 4)}`;
			return {
				kind,
				apply: (v) => ({
					...v,
					docs: {
						...v.docs,
						[key]: { value: Math.floor(rand() * 1000) },
					},
				}),
			};
		}
		case "doc-unset": {
			return {
				kind,
				apply: (v) => {
					const keys = Object.keys(v.docs);
					if (keys.length === 0) return v;
					const drop = keys[Math.floor(rand() * keys.length)]!;
					const docs = { ...v.docs };
					delete docs[drop];
					return { ...v, docs };
				},
			};
		}
		case "steer-change": {
			return {
				kind,
				apply: (v) => ({
					...v,
					steer: { busy: !v.steer.busy, queued: Math.floor(rand() * 4) },
				}),
			};
		}
		case "head-insert": {
			// A compaction-style head marker: a NEW id spliced at the front —
			// the survivors are no longer a prefix of next.
			return {
				kind,
				apply: (v) => ({
					...v,
					entries: [entry(entrySeq++), ...v.entries],
				}),
			};
		}
	}
}

// ─── Named cases ─────────────────────────────────────────────────────────

describe("diffViews named cases", () => {
	it("identical views diff to an empty delta", () => {
		const view = baseView();
		const delta = diffViews(view, view);
		expect(delta).toBeDefined();
		expect(isEmptyDelta(delta!)).toBe(true);
		// …even when the next view is a fresh deep copy (JSON equality).
		const copy = JSON.parse(JSON.stringify(view)) as ConversationViewWire;
		const copyDelta = diffViews(view, copy);
		expect(copyDelta).toBeDefined();
		expect(isEmptyDelta(copyDelta!)).toBe(true);
	});

	it("a head-marker reorder (compaction's new head) is not representable", () => {
		const prev = baseView();
		const next: ConversationViewWire = {
			...prev,
			entries: [entry(900), ...prev.entries],
		};
		expect(diffViews(prev, next)).toBeUndefined();
	});

	it("a mid-list reorder is not representable", () => {
		const prev: ConversationViewWire = {
			...baseView(),
			entries: [entry(1), entry(2), entry(3)],
		};
		const next: ConversationViewWire = {
			...prev,
			entries: [prev.entries[1]!, prev.entries[0]!, prev.entries[2]!],
		};
		expect(diffViews(prev, next)).toBeUndefined();
	});

	it("a suffix append diffs to entries.append only", () => {
		const prev = baseView();
		const appended = entry(entrySeq++);
		const next: ConversationViewWire = {
			...prev,
			entries: [...prev.entries, appended],
		};
		const delta = diffViews(prev, next)!;
		expect(delta).toEqual({ entries: { append: [appended] } });
		expect(isEmptyDelta(delta)).toBe(false);
	});

	it("a removal (middle included) diffs to entries.remove", () => {
		const prev: ConversationViewWire = {
			...baseView(),
			entries: [entry(1), entry(2), entry(3)],
		};
		const next: ConversationViewWire = {
			...prev,
			entries: [prev.entries[0]!, prev.entries[2]!],
		};
		expect(diffViews(prev, next)).toEqual({ entries: { remove: [2] } });
	});

	it("docs diff by reference then JSON: set and unset", () => {
		const prev = baseView();
		const next: ConversationViewWire = {
			...prev,
			docs: { ...prev.docs, "pi.live": { run: {} } },
		};
		const delta = diffViews(prev, next)!;
		expect(delta.docs?.set).toEqual({ "pi.live": { run: {} } });
		expect(delta.docs?.unset).toBeUndefined();
		// The reverse direction unsets.
		const back = diffViews(next, prev)!;
		expect(back.docs?.unset).toEqual(["pi.live"]);
		expect(back.docs?.set).toBeUndefined();
	});

	it("steer and conversation ride the delta only when they differ", () => {
		const prev = baseView();
		const next: ConversationViewWire = {
			...prev,
			steer: { busy: true, queued: 2 },
		};
		const delta = diffViews(prev, next)!;
		expect(delta.steer).toEqual({ busy: true, queued: 2 });
		expect(delta.conversation).toBeUndefined();
		expect(delta.entries).toBeUndefined();
	});
});

describe("applyDelta", () => {
	it("applies entries/docs/steer without mutating the input view", () => {
		const prev: ConversationViewWire = {
			...baseView(),
			entries: [entry(1), entry(2)],
			docs: { "pi.agent": { a: 1 }, "pi.live": { run: {} } },
		};
		const snapshot = JSON.parse(JSON.stringify(prev));
		const delta: ViewDelta = {
			entries: { remove: [1], append: [entry(3)] },
			docs: { set: { "pi.live": { run: { id: 7 } } }, unset: ["pi.agent"] },
			steer: { busy: true, queued: 0 },
		};
		const next = applyDelta(prev, delta);
		expect(next.entries.map((e) => e.id)).toEqual([2, 3]);
		expect(next.docs).toEqual({ "pi.live": { run: { id: 7 } } });
		expect(next.steer).toEqual({ busy: true, queued: 0 });
		expect(next.conversation).toBe(prev.conversation); // untouched slot: same ref
		// The input is untouched.
		expect(prev).toEqual(snapshot);
		expect(prev.entries).toHaveLength(2);
		expect(Object.keys(prev.docs)).toEqual(["pi.agent", "pi.live"]);
	});
});

describe("isEmptyDelta", () => {
	it("empty slots (absent or zero-length) are all empty", () => {
		expect(isEmptyDelta({})).toBe(true);
		expect(isEmptyDelta({ entries: {} })).toBe(true);
		expect(isEmptyDelta({ entries: { append: [], remove: [] } })).toBe(true);
		expect(isEmptyDelta({ docs: { set: {}, unset: [] } })).toBe(true);
		expect(isEmptyDelta({ steer: { busy: false, queued: 0 } })).toBe(false);
		expect(isEmptyDelta({ entries: { remove: [1] } })).toBe(false);
		expect(isEmptyDelta({ docs: { unset: ["pi.live"] } })).toBe(false);
	});
});

// ─── The property test: fold(applyDelta) == final view ───────────────────

describe("property: folding diffs reproduces the final view", () => {
	it("200 seeded random sequences fold to the final view (snapshot fallback on undefined)", () => {
		for (let seed = 1; seed <= 200; seed++) {
			const rand = mulberry32(seed);
			let server = baseView();
			let client = server; // the connect snapshot
			let sawUndefined = false;
			const steps = 5 + Math.floor(rand() * 15);
			for (let stepIndex = 0; stepIndex < steps; stepIndex++) {
				const step = randomStep(server, rand);
				const next = step.apply(server);
				const delta = diffViews(server, next);
				if (delta === undefined) {
					// The ONLY undefined-producing step in the generator is the
					// non-suffix head insert.
					expect(
						step.kind,
						`seed ${seed} step ${stepIndex}: ${step.kind} unexpectedly unrepresentable`,
					).toBe("head-insert");
					sawUndefined = true;
					client = next; // the server sends a fresh snapshot instead
				} else {
					if (!isEmptyDelta(delta)) client = applyDelta(client, delta);
				}
				server = next;
			}
			expect(
				client,
				`seed ${seed}: folded view must deep-equal the final view`,
			).toEqual(server);
			void sawUndefined; // head-inserts are random; not every seed has one
		}
	});

	it("some seed exercises the head-insert → undefined fallback (the generator covers it)", () => {
		let covered = 0;
		for (let seed = 1; seed <= 200; seed++) {
			const rand = mulberry32(seed);
			let view = baseView();
			for (let i = 0; i < 20; i++) {
				const step = randomStep(view, rand);
				const next = step.apply(view);
				if (diffViews(view, next) === undefined) covered++;
				view = next;
			}
		}
		expect(covered).toBeGreaterThan(0);
	});
});
