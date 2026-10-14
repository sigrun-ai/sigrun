/**
 * The ambient seam (spec: docs/approval-ux-seams.md, "Ambient surfaces"):
 * core-owned, channel-neutral records for persistent read-mostly state —
 * statusline slots and panel widgets — written by extensions through the
 * host context and rendered by channels generically.
 *
 * Lifecycle difference from interactions: an ambient surface is replaced
 * repeatedly (write = FULL state replacement, never a delta) and never
 * blocks. One slot key is owned by exactly one extension (allocation,
 * not silent composition — the pi-zentui chrome-skin lesson).
 *
 * Layering mirrors the interaction seam: strict envelope (key, place,
 * budget, refresh, expires) around a body composed only from the closed
 * ambient primitives (line, rows, gauge, ledger), with opaque `details`.
 */

import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { JsonObject } from "@earendil-works/pi-durable";

/** Where a channel places the surface. */
export type AmbientPlace = "status" | "footer" | "panel";

/** One widget row (primitive B). */
export type AmbientRow = {
	readonly id: string;
	readonly label: string;
	/** Channel-schemed glyph state (todo statuses, agent run states). */
	readonly status?: string;
	/** Severity ordering/color: 0 = severe .. 2 = quiet. */
	readonly severity?: 0 | 1 | 2;
	/** Folded away by default (warden's quiet verdicts). */
	readonly quiet?: boolean;
	readonly detail?: string;
	/** Nesting depth for tree rendering (pi-goal-x task tree). */
	readonly depth?: number;
	/** Dependency ids for marker rendering (rpiv-todo blockedBy). */
	readonly deps?: string[];
	/** Present-continuous spinner label while the row is active. */
	readonly spinnerLabel?: string;
	readonly metrics?: AmbientMetrics;
}

/** Numeric metrics with an optional derived-format hint. */
export type AmbientMetrics = {
	readonly tokens?: number;
	readonly cost?: number;
	readonly current?: number;
	readonly total?: number;
	readonly completed?: number;
	/** Derived display hint for numeric fields ("2.5k", currency) — the
	 * host-reuse lesson from every footer extension. */
	readonly format?: "compact" | "usd" | "percent";
}

/** The `line` primitive: one keyed statusline/footer line, optionally segmented. */
export type AmbientLine = {
	readonly text: string;
	/** Segmented composition for powerline-style slots (pi-powerline,
	 * pi-zentui): sub-segments with placement zones. */
	readonly segments?: {
		readonly id: string;
		readonly text: string;
		readonly place?: "left" | "middle" | "right";
	}[];
}

/** The `gauge` primitive: live progress with optional check rows. */
export type AmbientGauge = {
	readonly label: string;
	readonly percent?: number;
	readonly phase?: string;
	readonly elapsedMs?: number;
	readonly recentOutput?: string[];
	/** Check rows (pi-goal-x auditor): row-shaped, same schema as rows[]. */
	readonly checks?: AmbientRow[];
}

/** One ledger entry (primitive D): append-style feed with per-entry amend. */
export type AmbientLedgerEntry = {
	readonly id: string;
	readonly at: number;
	readonly kind: string;
	readonly summary: string;
	readonly detail?: string[];
}

/** The ambient body: ONLY these keys, each from the closed primitives. */
export type AmbientBody = {
	readonly line?: AmbientLine;
	readonly rows?: AmbientRow[];
	readonly gauge?: AmbientGauge;
	readonly ledger?: AmbientLedgerEntry[];
}

/** The strict envelope + closed-primitive body of one ambient surface. */
export type AmbientRecord = {
	/** The keyed slot id ("goal", "rpiv-todos", "fabric"). */
	readonly key: string;
	/** Which extension owns this key (set by the host context, not the author). */
	readonly owner: string;
	readonly place: AmbientPlace;
	/** Panel row budget / line-slot width guidance (channel advisory). */
	readonly maxRows?: number;
	/** Overflow policy for panels (rpiv-todo's drop-completed-first rule). */
	readonly overflow?: "drop" | "wrap" | "summarize";
	/** Channel re-render hint between data writes (countdowns, clocks), ms. */
	readonly refreshMs?: number;
	/** Auto-clear rule: "never" stays until replaced with an empty body. */
	readonly expires: "never" | "idle";
	readonly updatedAt: number;
	readonly body?: AmbientBody;
	/** Opaque extension-owned payload; rendered collapsed, never interpreted. */
	readonly details?: JsonObject;
}

/**
 * The ambient record family: one record per surface key, per conversation.
 * (Session-scoped statuslines that outlive one conversation are a v2
 * concern; channels today render conversation-scoped state.)
 */
export const AmbientDoc = defineDocFamily<AmbientRecord, string>({
	kind: "sigrun.ambient",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	family: true,
	initial: (key: string) => ({
		key,
		owner: "",
		place: "status",
		expires: "never",
		updatedAt: 0,
	}),
});

/**
 * The ambient slot registry (session singleton): surface key -> owning
 * extension name. One owner per key; a second claimant fails loud (the
 * host context refuses the write) — allocation, not silent composition.
 */
export type AmbientOwners = {
	readonly owners: Record<string, string>;
}

export const AmbientOwnersDoc = defineDoc<AmbientOwners>({
	kind: "sigrun.ambient.owners",
	version: 1,
	scope: "session",
	initial: () => ({ owners: {} }),
});

const PLACES: ReadonlySet<string> = new Set(["status", "footer", "panel"]);
const OVERFLOWS: ReadonlySet<string> = new Set(["drop", "wrap", "summarize"]);
const FORMATS: ReadonlySet<string> = new Set(["compact", "usd", "percent"]);
const ZONES: ReadonlySet<string> = new Set(["left", "middle", "right"]);

/** Structural validation of one ambient record. Returns the error text or null. */
export function validateAmbient(value: unknown): string | null {
	if (typeof value !== "object" || value === null) {
		return "ambient record must be an object";
	}
	const r = value as Record<string, unknown>;
	if (typeof r.key !== "string" || r.key.length === 0) {
		return "key must be a non-empty string";
	}
	if (typeof r.place !== "string" || !PLACES.has(r.place)) {
		return `place must be one of status|footer|panel (got ${String(r.place)})`;
	}
	if (r.maxRows !== undefined && typeof r.maxRows !== "number") {
		return "maxRows must be a number";
	}
	if (r.overflow !== undefined && !OVERFLOWS.has(String(r.overflow))) {
		return `overflow must be one of drop|wrap|summarize (got ${String(r.overflow)})`;
	}
	if (r.refreshMs !== undefined && typeof r.refreshMs !== "number") {
		return "refreshMs must be a number";
	}
	if (r.expires !== "never" && r.expires !== "idle") {
		return `expires must be "never" or "idle" (got ${String(r.expires)})`;
	}
	if (typeof r.updatedAt !== "number") {
		return "updatedAt must be a number";
	}
	const body = r.body;
	if (body === undefined) return null; // an empty write clears the surface
	if (typeof body !== "object" || body === null) {
		return "body must be an object";
	}
	const b = body as Record<string, unknown>;
	const known = new Set(["line", "rows", "gauge", "ledger"]);
	const unknownKey = Object.keys(b).find((k) => !known.has(k));
	if (unknownKey !== undefined) {
		return `body.${unknownKey} is outside the closed primitives (move it to details)`;
	}
	if (b.line !== undefined) {
		const problem = validateLine(b.line);
		if (problem !== null) return problem;
	}
	if (b.rows !== undefined) {
		if (!Array.isArray(b.rows)) return "body.rows must be an array";
		for (const row of b.rows) {
			const problem = validateRow(row);
			if (problem !== null) return problem;
		}
	}
	if (b.gauge !== undefined) {
		const problem = validateGauge(b.gauge);
		if (problem !== null) return problem;
	}
	if (b.ledger !== undefined) {
		if (!Array.isArray(b.ledger)) return "body.ledger must be an array";
		for (const e of b.ledger) {
			const problem = validateLedgerEntry(e);
			if (problem !== null) return problem;
		}
	}
	return null;
}

function validateLine(value: unknown): string | null {
	if (typeof value !== "object" || value === null) return "line must be an object";
	const l = value as Record<string, unknown>;
	if (l.text === undefined && l.segments === undefined) {
		return "line needs text or segments";
	}
	if (l.text !== undefined && typeof l.text !== "string") {
		return "line.text must be a string";
	}
	if (l.segments !== undefined) {
		if (!Array.isArray(l.segments)) return "line.segments must be an array";
		for (const s of l.segments) {
			if (typeof s !== "object" || s === null) return "segment must be an object";
			const seg = s as Record<string, unknown>;
			if (typeof seg.id !== "string" || seg.id.length === 0) {
				return "segment.id must be a non-empty string";
			}
			if (typeof seg.text !== "string") return "segment.text must be a string";
			if (seg.place !== undefined && !ZONES.has(String(seg.place))) {
				return `segment.place must be one of left|middle|right (got ${String(seg.place)})`;
			}
		}
	}
	return null;
}

function validateRow(value: unknown): string | null {
	if (typeof value !== "object" || value === null) return "row must be an object";
	const r = value as Record<string, unknown>;
	if (typeof r.id !== "string" || r.id.length === 0) {
		return "row.id must be a non-empty string";
	}
	if (typeof r.label !== "string") return "row.label must be a string";
	if (r.status !== undefined && typeof r.status !== "string") {
		return "row.status must be a string";
	}
	if (
		r.severity !== undefined &&
		r.severity !== 0 &&
		r.severity !== 1 &&
		r.severity !== 2
	) {
		return "row.severity must be 0, 1, or 2";
	}
	if (r.quiet !== undefined && typeof r.quiet !== "boolean") {
		return "row.quiet must be a boolean";
	}
	if (r.detail !== undefined && typeof r.detail !== "string") {
		return "row.detail must be a string";
	}
	if (r.depth !== undefined && typeof r.depth !== "number") {
		return "row.depth must be a number";
	}
	if (r.deps !== undefined && !Array.isArray(r.deps)) {
		return "row.deps must be an array of ids";
	}
	if (Array.isArray(r.deps) && r.deps.some((d) => typeof d !== "string")) {
		return "row.deps must be an array of ids";
	}
	if (r.spinnerLabel !== undefined && typeof r.spinnerLabel !== "string") {
		return "row.spinnerLabel must be a string";
	}
	if (r.metrics !== undefined) {
		const problem = validateMetrics(r.metrics);
		if (problem !== null) return problem;
	}
	return null;
}

function validateMetrics(value: unknown): string | null {
	if (typeof value !== "object" || value === null) return "metrics must be an object";
	const m = value as Record<string, unknown>;
	for (const k of ["tokens", "cost", "current", "total", "completed"]) {
		if (m[k] !== undefined && typeof m[k] !== "number") {
			return `metrics.${k} must be a number`;
		}
	}
	if (m.format !== undefined && !FORMATS.has(String(m.format))) {
		return `metrics.format must be one of compact|usd|percent (got ${String(m.format)})`;
	}
	return null;
}

function validateGauge(value: unknown): string | null {
	if (typeof value !== "object" || value === null) return "gauge must be an object";
	const g = value as Record<string, unknown>;
	if (typeof g.label !== "string") return "gauge.label must be a string";
	if (g.percent !== undefined && typeof g.percent !== "number") {
		return "gauge.percent must be a number";
	}
	if (g.phase !== undefined && typeof g.phase !== "string") {
		return "gauge.phase must be a string";
	}
	if (g.elapsedMs !== undefined && typeof g.elapsedMs !== "number") {
		return "gauge.elapsedMs must be a number";
	}
	if (g.recentOutput !== undefined && !Array.isArray(g.recentOutput)) {
		return "gauge.recentOutput must be an array of strings";
	}
	if (Array.isArray(g.recentOutput) && g.recentOutput.some((l) => typeof l !== "string")) {
		return "gauge.recentOutput must be an array of strings";
	}
	if (g.checks !== undefined && !Array.isArray(g.checks)) {
		return "gauge.checks must be row-shaped";
	}
	if (Array.isArray(g.checks)) {
		for (const row of g.checks) {
			const problem = validateRow(row);
			if (problem !== null) return `gauge.checks: ${problem}`;
		}
	}
	return null;
}

function validateLedgerEntry(value: unknown): string | null {
	if (typeof value !== "object" || value === null) return "ledger entry must be an object";
	const e = value as Record<string, unknown>;
	if (typeof e.id !== "string" || e.id.length === 0) {
		return "ledger.id must be a non-empty string";
	}
	if (typeof e.at !== "number") return "ledger.at must be a number";
	if (typeof e.kind !== "string") return "ledger.kind must be a string";
	if (typeof e.summary !== "string") return "ledger.summary must be a string";
	if (e.detail !== undefined && !Array.isArray(e.detail)) {
		return "ledger.detail must be an array of strings";
	}
	if (Array.isArray(e.detail) && e.detail.some((d) => typeof d !== "string")) {
		return "ledger.detail must be an array of strings";
	}
	return null;
}
