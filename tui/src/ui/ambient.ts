/**
 * The ambient seam's TUI renderer (Task 8 — the parity rule): ambient
 * surfaces placed in the TUI's chrome per the seam's `place` field. Spec
 * §8 leaves the place→chrome mapping to the builder; the TUI's mapping:
 *
 * - `status` → the statusline: one row, directly above the composer (the
 *   last row of the app body). Multiple status records join with " · ".
 * - `footer` → the footer zone: one summary line per record, above the
 *   statusline.
 * - `panel` → the panel zone: the full rendering (line, rows, gauge,
 *   ledger), above the footer.
 *
 * Genericity (the seam's whole point): the chrome renders the closed
 * primitives and knows NOTHING about what a surface means — no "todo",
 * no "goal". `details` renders as one collapsed JSON line, never
 * interpreted. The rendering mirrors the webui's AmbientPanel: rows are
 * severity-sorted (0 severe .. 2 quiet, ties by id) with quiet rows
 * folded into a "+N quiet" summary; metrics format via the record's
 * `format` hint; gauges render label/phase/elapsed plus a text percent
 * bar; ledgers render newest-first. Ambient surfaces are read-only (the
 * seam routes actions through interaction records).
 *
 * Fetching (W3 Task 4 — the timer cadence is RETIRED): on conversation
 * connect, and on `ambient.changed` host events for the live
 * conversation (the app wires `watchEvents` to {@link kick}; an event
 * for another conversation is ignored). A record's declared `refreshMs`
 * no longer drives a poll — the extension that declares it owns its
 * writes, and each write emits the event. Fetch failures are QUIET
 * (best-effort chrome; stream transport health is reported separately by
 * the watcher's error/open transition notices — the launcher's
 * stream-health wiring).
 *
 * Expiry: `expires: "idle"` surfaces render only while the conversation
 * has a live run ({@link setBusy}, driven by the stream's `steer.busy`);
 * they disappear when the conversation goes idle and reappear on the next
 * busy frame while the record is still served. `expires: "never"` records
 * stay until the server stops serving them (replacement-state reads).
 *
 * Segments: a line's `segments` render as their texts joined with spaces
 * in AUTHORED order — the segment `place` zones (left/middle/right) are
 * ignored in the statusline join (the TUI chrome has no zone layout; the
 * webui owns zoned placement).
 */

import type { Component } from "@earendil-works/pi-tui";
import type { AmbientWire, SigrunClient } from "../api.js";

/** One widget row, derived from the wire record (the api module's export
 * surface stays at AmbientWire/AmbientList — no new cross-package import). */
type AmbientRow = NonNullable<NonNullable<AmbientWire["body"]>["rows"]>[number];

/** The gauge bar width (text cells). */
const GAUGE_CELLS = 10;

export class AmbientChrome implements Component {
	readonly #client: SigrunClient;

	#conversationId: number | undefined;
	/** Monotonic per-conversation generation: stale fetches never land. */
	#gen = 0;
	/** The latest served surfaces, keyed by slot key (fetch order). */
	#records: readonly AmbientWire[] = [];
	/** Whether the conversation has a live run (stream `steer.busy`). */
	#busy = false;

	/** Rendered-state changes (the app requests a repaint). */
	onChanged?: () => void;

	constructor(client: SigrunClient) {
		this.#client = client;
	}

	/** The latest served surfaces (before the idle filter). */
	get records(): readonly AmbientWire[] {
		return this.#records;
	}

	/**
	 * Retarget the chrome: reset state and fetch immediately (the brief's
	 * "fetch on connect"). `undefined` clears the chrome. (W3 Task 4: no
	 * timer cadence — `ambient.changed` host events own the refreshes.)
	 */
	setConversation(id: number | undefined): void {
		this.#gen += 1;
		this.#conversationId = id;
		this.#records = [];
		if (id === undefined) {
			this.#changed();
			return;
		}
		void this.#refresh();
	}

	/**
	 * Refetch when an `ambient.changed` host event names the LIVE
	 * conversation (the app's events wiring calls this; other
	 * conversations' events are ignored).
	 */
	kick(conversationId: number): void {
		if (conversationId !== this.#conversationId) return;
		void this.#refresh();
	}

	/**
	 * The conversation's run state (the app feeds it from stream frames).
	 * `expires: "idle"` surfaces render only while busy.
	 */
	setBusy(busy: boolean): void {
		if (busy === this.#busy) return;
		this.#busy = busy;
		this.#changed();
	}

	/** The statusline: the status records' summaries joined " · ". */
	statusline(): string {
		return this.#visible("status").map(summaryOf).join(" · ");
	}

	/** The footer zone: one summary line per footer record. */
	footerLines(): readonly string[] {
		return this.#visible("footer").map(summaryOf);
	}

	/** The panel zone: the full per-record rendering, blocks joined. */
	panelLines(): readonly string[] {
		const lines: string[] = [];
		for (const record of this.#visible("panel")) {
			if (lines.length > 0) lines.push("");
			lines.push(...panelBlock(record));
		}
		return lines;
	}

	/** Visible records in one place zone (fetch order preserved). */
	#visible(place: AmbientWire["place"]): readonly AmbientWire[] {
		return this.#records.filter(
			(record) =>
				record.place === place &&
				(record.expires !== "idle" || this.#busy) &&
				hasContent(record),
		);
	}

	/** Generation-guarded fetch (quiet failures keep the last surfaces). */
	async #refresh(): Promise<void> {
		const id = this.#conversationId;
		const gen = this.#gen;
		if (id === undefined) return;
		let list;
		try {
			list = await this.#client.getAmbient(id);
		} catch {
			return; // quiet: keep the last surfaces
		}
		if (gen !== this.#gen) return; // stale — a switch happened
		this.#records = list.ambient;
		this.#changed();
	}

	#changed(): void {
		this.onChanged?.();
	}

	/** Detach (the app calls this on dispose): stale fetches never land. */
	dispose(): void {
		this.#gen += 1;
	}

	/** The chrome: panel blocks, then footer lines, then the statusline. */
	render(_width: number): string[] {
		const lines = [...this.panelLines(), ...this.footerLines()];
		const status = this.statusline();
		if (status !== "") lines.push(status);
		return lines;
	}

	invalidate(): void {
		// Stateless render: lines assemble from the current records.
	}
}

// ─── Rendering helpers (the webui's AmbientPanel, mirrored in text) ─────

/** A surface with no body primitives and no details renders nothing. */
function hasContent(record: AmbientWire): boolean {
	const body = record.body;
	if (body === undefined) return record.details !== undefined;
	return (
		body.line !== undefined ||
		(body.rows !== undefined && body.rows.length > 0) ||
		body.gauge !== undefined ||
		(body.ledger !== undefined && body.ledger.length > 0) ||
		record.details !== undefined
	);
}

/** The one-line summary (status/footer zones). */
function summaryOf(record: AmbientWire): string {
	const body = record.body;
	if (body?.line !== undefined) return lineText(body.line);
	if (body?.rows !== undefined && body.rows.length > 0) {
		const visible = body.rows.filter((row) => row.quiet !== true);
		if (visible.length === 0) return record.key;
		return `${record.key}: ${visible.map((row) => row.label).join(", ")}`;
	}
	if (body?.gauge !== undefined) {
		const percent =
			body.gauge.percent === undefined ? "" : ` ${body.gauge.percent}%`;
		return `${body.gauge.label}${percent}`;
	}
	if (body?.ledger !== undefined && body.ledger.length > 0) {
		return body.ledger[body.ledger.length - 1]?.summary ?? record.key;
	}
	return `[${record.key}]`;
}

function lineText(line: {
	readonly text?: string;
	readonly segments?: readonly { readonly text: string }[];
}): string {
	if (line.segments !== undefined && line.segments.length > 0) {
		return line.segments.map((segment) => segment.text).join(" ");
	}
	return line.text ?? "";
}

/** The full panel-zone rendering of one record. */
function panelBlock(record: AmbientWire): string[] {
	const body = record.body;
	const lines: string[] = [];
	lines.push(
		record.owner === "" ? `[${record.key}]` : `[${record.key}] ${record.owner}`,
	);
	if (body?.line !== undefined) lines.push(lineText(body.line));
	if (body?.rows !== undefined && body.rows.length > 0) {
		lines.push(...rowLines(body.rows));
	}
	if (body?.gauge !== undefined) {
		const gauge = body.gauge;
		let header = gauge.label;
		if (gauge.phase !== undefined) header += ` · ${gauge.phase}`;
		if (gauge.elapsedMs !== undefined) {
			header += ` · ${(gauge.elapsedMs / 1000).toFixed(1)}s`;
		}
		lines.push(header);
		if (gauge.percent !== undefined) {
			const filled = Math.max(
				0,
				Math.min(GAUGE_CELLS, Math.round(gauge.percent / GAUGE_CELLS)),
			);
			lines.push(
				`[${"#".repeat(filled)}${"-".repeat(GAUGE_CELLS - filled)}] ${gauge.percent}%`,
			);
		}
		if (gauge.checks !== undefined && gauge.checks.length > 0) {
			lines.push(...rowLines(gauge.checks));
		}
		if (gauge.recentOutput !== undefined && gauge.recentOutput.length > 0) {
			lines.push(...gauge.recentOutput.slice(-3));
		}
	}
	if (body?.ledger !== undefined && body.ledger.length > 0) {
		for (const entry of [...body.ledger].reverse()) {
			const detail =
				entry.detail === undefined || entry.detail.length === 0
					? ""
					: ` — ${entry.detail.join(" · ")}`;
			lines.push(`${entry.kind} ${entry.summary}${detail}`);
		}
	}
	if (record.details !== undefined) {
		lines.push(`[details] ${JSON.stringify(record.details)}`);
	}
	return lines;
}

/** Rows: severity-sorted (ties by id), quiet folded into "+N quiet". */
function rowLines(rows: readonly AmbientRow[]): readonly string[] {
	const sorted = [...rows].sort((a, b) => {
		const severityA = a.severity ?? 2;
		const severityB = b.severity ?? 2;
		if (severityA !== severityB) return severityA - severityB;
		return a.id < b.id ? -1 : 1;
	});
	const visible = sorted.filter((row) => row.quiet !== true);
	const quietCount = sorted.length - visible.length;
	const lines = visible.map(rowLine);
	if (quietCount > 0) lines.push(`+${quietCount} quiet`);
	return lines;
}

function rowLine(row: AmbientRow): string {
	const indent = "  ".repeat(row.depth ?? 0);
	const glyph = row.status ?? "·";
	let line = `${indent}${glyph} ${row.label}`;
	if (row.spinnerLabel !== undefined) line += ` ${row.spinnerLabel}`;
	if (row.detail !== undefined) line += ` — ${row.detail}`;
	if (row.deps !== undefined && row.deps.length > 0) {
		line += ` ⛓ ${row.deps.join(",")}`;
	}
	const metrics = metricsText(row.metrics);
	if (metrics !== "") line += ` ${metrics}`;
	return line;
}

function metricsText(
	metrics: AmbientRow["metrics"],
): string {
	if (metrics === undefined) return "";
	const parts: string[] = [];
	if (metrics.tokens !== undefined) {
		parts.push(`tok ${formatMetric(metrics.tokens, metrics.format)}`);
	}
	if (metrics.cost !== undefined) {
		parts.push(`$${metrics.cost.toFixed(4)}`);
	}
	if (metrics.total !== undefined) {
		parts.push(`${metrics.completed ?? metrics.current ?? 0}/${metrics.total}`);
	} else if (metrics.current !== undefined) {
		parts.push(`cur ${metrics.current}`);
	}
	return parts.join(" · ");
}

/** The webui's metric formatting (compact / usd / percent hints). */
function formatMetric(value: number, format: string | undefined): string {
	if (format === "usd") return `$${value.toFixed(4)}`;
	if (format === "percent") return `${Math.round(value * 100)}%`;
	if (format === "compact" && Math.abs(value) >= 1000) {
		return `${(value / 1000).toFixed(1)}k`;
	}
	return String(value);
}
