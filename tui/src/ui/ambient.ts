/**
 * The ambient seam's TUI renderer (UI-blocks U6 Task 3, the parity
 * rule): ambient surfaces placed in the TUI's chrome per the seam's
 * `place` field, rendered FROM BLOCK TREES (placement `ambient`, spec
 * §9.2):
 *
 * - `status` → the statusline: one row, directly above the composer (the
 *   last row of the app body). Multiple status records join with " · ".
 * - `footer` → the footer zone: the body's `columns` block renders the
 *   left/middle/right zones (three columns), above the statusline.
 * - `panel` → the panel zone: the full tree rendering, above the footer.
 *
 * Genericity (the seam's whole point): the chrome renders blocks and
 * knows NOTHING about what a surface means — no "todo", no "goal".
 * `details` renders as one collapsed JSON line, never interpreted.
 *
 * Ambient bodies carry LITERAL content only (the 2026-10-24 ruling:
 * the envelope has no data document, so validation rejects every
 * binding outside a collection's item template), so the renderer's
 * data document is EMPTY. Ambient surfaces are read-only
 * (actions re-route through interaction records) — the render context's
 * access is `read` and dispatch is a no-op.
 *
 * The envelope's `maxRows`/`overflow` budget applies to a panel's root
 * literal-rows collection (Review Focus 3): `drop` folds the tail behind
 * the collection's own quiet bucket ("N more"), `summarize` replaces
 * the tail with a count line, `wrap` renders as authored.
 *
 * Fetching (W3 Task 4 — the timer cadence is RETIRED): on conversation
 * connect, and on `ambient.changed` host events for the live
 * conversation (the app wires `watchEvents` to {@link kick}). Fetch
 * failures are QUIET (best-effort chrome).
 *
 * Expiry: `expires: "idle"` surfaces render only while the conversation
 * has a live run ({@link setBusy}, driven by the stream's `steer.busy`).
 */

import type { Component } from "@earendil-works/pi-tui";
import type {
	Block,
	CollectionBlock,
	JsonObject,
	JsonValue,
} from "@sigrun/shared/blocks";
import type { AmbientWire, SigrunClient } from "../api.js";
import type { BlockCtx } from "../blocks/context.js";
import { renderBlock } from "../blocks/render.js";
import { truncate } from "../blocks/width.js";
import { plainTuiTheme, type TuiTheme } from "../theme.js";

/** Ambient bodies never bind (the ruling): the data document is empty. */
const EMPTY_DATA: JsonObject = {};

/** The read-only ambient render context (surfaces take no answers; the
 *  dispatch sink is a no-op). */
function ambientCtx(theme: TuiTheme): BlockCtx {
	return {
		data: EMPTY_DATA,
		theme,
		locale: "en",
		access: "read",
		unicode: true,
		dispatch: (): void => {},
		view: { values: {} },
		setView: (): void => {},
		serverErrors: {},
	};
}

export class AmbientChrome implements Component {
	readonly #client: SigrunClient;
	readonly #theme: TuiTheme;

	#conversationId: number | undefined;
	/** Monotonic per-conversation generation: stale fetches never land. */
	#gen = 0;
	/** The latest served surfaces, keyed by slot key (fetch order). */
	#records: readonly AmbientWire[] = [];
	/** Whether the conversation has a live run (stream `steer.busy`). */
	#busy = false;

	/** Rendered-state changes (the app requests a repaint). */
	onChanged?: () => void;

	constructor(client: SigrunClient, options: { theme?: TuiTheme } = {}) {
		this.#client = client;
		this.#theme = options.theme ?? plainTuiTheme();
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

	/** The statusline: the status records' one-line bodies joined " · ".
	 *  `width` bounds each body's render (the app's frame width). */
	statusline(width?: number): string {
		return this.#visible("status")
			.map((record) => this.#bodyText(record, width))
			.filter((line) => line !== "")
			.join(" · ");
	}

	/** The footer zone: one rendered line per footer record. */
	footerLines(width?: number): readonly string[] {
		return this.#visible("footer").map((record) =>
			this.#renderBody(record, width).join(" ").trim(),
		);
	}

	/** The panel zone: the full per-record tree rendering. */
	panelLines(width?: number): readonly string[] {
		const lines: string[] = [];
		for (const record of this.#visible("panel")) {
			if (lines.length > 0) lines.push("");
			lines.push(`[${record.key}]${record.owner === "" ? "" : ` ${record.owner}`}`);
			lines.push(...this.#renderBody(record, width));
			if (record.details !== undefined) {
				lines.push(`[details] ${JSON.stringify(record.details)}`);
			}
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

	/** Render one record's body tree (budgeted per Review Focus 3). */
	#renderBody(record: AmbientWire, width?: number): string[] {
		const body = record.body;
		if (body === undefined) return [];
		const root = budgetTree(record, body.root);
		// The chrome's own frame width bounds the render; a bare read
		// (statusline/footerLines callers without a frame) falls back to
		// the regular-class width.
		return renderBlock(root, ambientCtx(this.#theme)).render(width ?? 120);
	}

	/** The one-line text of a status/footer body (a single markdown or a
	 *  columns of one-line blocks — §9.2's one-line rule). */
	#bodyText(record: AmbientWire, width?: number): string {
		const body = record.body;
		if (body === undefined) return "";
		return this.#renderBody(record, width).join(" ").trim();
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
	render(width: number): string[] {
		const lines = [...this.panelLines(width), ...this.footerLines(width)];
		const status = this.statusline(width);
		if (status !== "") lines.push(status);
		// ANSI-aware clamp (Review fix): a raw UTF-16 slice cuts escape
		// sequences and surrogate pairs mid-unit.
		return lines.map((line) => truncate(line, width));
	}

	invalidate(): void {
		// Stateless render: lines assemble from the current records.
	}
}

/** A surface with no body tree and no details renders nothing. */
function hasContent(record: AmbientWire): boolean {
	return record.body !== undefined || record.details !== undefined;
}

/** The quiet fold for the drop overflow: mark the tail rows quiet so
 *  the collection's own "N more" toggle carries them (the budget never
 *  LOSES rows — the user can still unfold). A template WITHOUT a
 *  `quiet` binding has no fold to ride (its isQuiet is always false),
 *  so the budget falls back to truncating the tail behind a one-line
 *  "<n> more" markdown row (Review fix — a quiet-less template's drop
 *  overflow silently no-op'd). */
function dropTail(
	collection: CollectionBlock,
	items: readonly JsonValue[],
	maxRows: number,
): Block {
	// No quiet binding: truncate + count line (the fold has nothing to
	// key on).
	if (collection.item.quiet === undefined) {
		const visible = items.slice(0, maxRows);
		const dropped = items.length - visible.length;
		// SAFETY: same block with a literal array swapped in (the ambient
		// literal-rows shape the schema now admits).
		const trimmed = { ...collection, items: [...visible] } as CollectionBlock;
		return {
			type: "stack",
			children: [trimmed, { type: "markdown", text: `${dropped} more` }],
		};
	}
	const visible = items.slice(0, maxRows);
	const tail = items.slice(maxRows).map((row) => {
		if (typeof row === "object" && row !== null && !Array.isArray(row)) {
			return { ...(row as JsonObject), quiet: true } as JsonValue;
		}
		return row;
	});
	// SAFETY: `items` is the same block with a literal array swapped in
	// (the ambient literal-rows shape the schema now admits); every other
	// prop is verbatim.
	return { ...collection, items: [...visible, ...tail] } as CollectionBlock;
}

/** Apply the panel row budget (Review Focus 3): only a root
 *  literal-rows collection on a panel surface budgets; anything else
 *  renders as authored. */
function budgetTree(surface: AmbientWire, root: Block): Block {
	if (surface.place !== "panel" || root.type !== "collection") return root;
	if (!Array.isArray(root.items)) return root; // bound elsewhere; ambient rejects these
	const maxRows = surface.maxRows;
	if (maxRows === undefined || root.items.length <= maxRows) return root;
	const dropped = root.items.length - maxRows;
	if (surface.overflow === "summarize") {
		// The count line: one markdown under the trimmed collection.
		return {
			type: "stack",
			children: [
				{ ...root, items: root.items.slice(0, maxRows) },
				{ type: "markdown", text: `${dropped} rows` },
			],
		};
	}
	if (surface.overflow === "wrap") return root; // panels wrap rows — no fold
	return dropTail(root, root.items, maxRows);
}
