/**
 * The `log` block (UI-blocks spec §5.3): bound `{at?, level?, text}[]`
 * lines in a block-local viewport of {@link LOG_VIEWPORT_ROWS} rows.
 *
 * With `follow` the viewport pins to the tail until the user scrolls
 * up; scrolling back to the bottom re-arms the following (the
 * transcript convention). Per-level tones default `error`→bad,
 * `warn`→warn, `info`→neutral, `debug`→info (the muted token);
 * `tones` overrides per level. `wrap` folds long lines instead of
 * truncating them.
 */

import type { Component } from "@earendil-works/pi-tui";
import { formatValue } from "@sigrun/shared/blocks";
import type { JsonValue, LogBlock, LogLine, Tone } from "@sigrun/shared/blocks";
import { bindRaw, type BlockCtx } from "./context.js";
import { truncate } from "./width.js";
import { toneFg } from "./tones.js";

/** The viewport height in rows. */
export const LOG_VIEWPORT_ROWS = 10;

/** The default per-level tones (spec §5.3's table; `debug` mutes). */
const LEVEL_TONES: Readonly<Record<string, Tone>> = {
	error: "bad",
	warn: "warn",
	info: "neutral",
	debug: "info",
};

/** Read the bound lines, dropping malformed entries. */
function logLines(block: LogBlock, ctx: BlockCtx): LogLine[] {
	const raw = bindRaw(block.lines, ctx);
	if (!Array.isArray(raw)) return [];
	const out: LogLine[] = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record: Record<string, unknown> = entry;
		if (typeof record.text !== "string") continue;
		out.push({
			at: typeof record.at === "number" || typeof record.at === "string" ? record.at : undefined,
			level: typeof record.level === "string" ? record.level : undefined,
			text: record.text,
		});
	}
	return out;
}

/** The head of one line: `time [level] ` (each part optional). */
function lineHead(line: LogLine, ctx: BlockCtx): string {
	const at =
		line.at === undefined
			? ""
			: formatValue(line.at as JsonValue, "time", ctx.locale, ctx.timeZone);
	const level = line.level === undefined ? "" : `[${line.level}]`;
	return [at, level].filter((part) => part !== "").join(" ");
}

/** `log`: the follow-tail viewport. */
export class LogComponent implements Component {
	readonly #block: LogBlock;
	readonly #ctx: BlockCtx;
	/** The first visible row in the stream; `undefined` = the tail. */
	#offset: number | undefined;

	constructor(block: LogBlock, ctx: BlockCtx) {
		this.#block = block;
		this.#ctx = ctx;
	}

	/** Every display row: one source line plus its wrapped folds. */
	#rows(width: number): string[] {
		const rows: string[] = [];
		for (const line of logLines(this.#block, this.#ctx)) {
			const head = lineHead(line, this.#ctx);
			const text = head === "" ? line.text : `${head} ${line.text}`;
			const tone =
				this.#block.tones?.[line.level ?? ""] ??
				(line.level === undefined ? undefined : LEVEL_TONES[line.level]);
			const paint = tone === undefined ? (s: string): string => s : toneFg(this.#ctx.theme, tone);
			if (this.#block.wrap === true) {
				// Hard-fold at the cell budget (logs are not prose).
				for (let at = 0; at < text.length; at += Math.max(1, width)) {
					rows.push(paint(text.slice(at, at + Math.max(1, width))));
				}
			} else {
				rows.push(truncate(paint(text), width));
			}
		}
		return rows;
	}

	render(width: number): string[] {
		const rows = this.#rows(width);
		if (rows.length <= LOG_VIEWPORT_ROWS) return rows;
		const tail = this.#block.follow === true ? rows.length - LOG_VIEWPORT_ROWS : 0;
		const start = Math.max(0, Math.min(this.#offset ?? tail, rows.length - LOG_VIEWPORT_ROWS));
		return rows.slice(start, start + LOG_VIEWPORT_ROWS);
	}

	handleInput(data: string): void {
		// The viewport moves by display rows within the last render's
		// stream; `render` clamps the offset back into range.
		const tail = Math.max(
			0,
			logLines(this.#block, this.#ctx).length - LOG_VIEWPORT_ROWS,
		);
		if (data === "\x1b[A") {
			const current = this.#offset ?? tail;
			this.#offset = Math.max(0, current - 1);
		} else if (data === "\x1b[B") {
			if (this.#offset !== undefined) {
				this.#offset += 1;
				if (this.#offset >= tail) this.#offset = undefined; // re-arm follow
			}
		}
	}

	invalidate(): void {
		// The viewport offset is the only mutable state.
	}
}
