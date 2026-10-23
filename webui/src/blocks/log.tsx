/**
 * The log block (UI-blocks U1 Task 2, spec §5.3): bound `{at?, level?,
 * text}[]` lines in a scrollable pane. Per-level tones default
 * `error`→bad, `warn`→warn, `info`→neutral, `debug`→subtle (the
 * `tones` prop overrides per level; unlisted levels keep defaults).
 * `follow` pins the pane to its bottom on append and releases the
 * moment the user scrolls up — the transcript convention
 * (`useStickToBottom`); returning to the bottom re-arms it.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LogBlock, LogLine, Tone } from "@sigrun/shared/blocks";
import { bound, useSurfaceData } from "./context";
import { toneColor } from "./tones";

/** Distance from the bottom still counted as "at the bottom" (px). */
const BOTTOM_TOLERANCE_PX = 24;

/** The default level → tone map (spec §5.3). */
const DEFAULT_LEVEL_TONES: Readonly<Record<string, Tone>> = {
	error: "bad",
	warn: "warn",
	info: "neutral",
	debug: "info", // subtle — rendered through the muted `info` token
};

/** Read a `log.lines` binding: a missing path is an empty array (the
 *  render contract — empty, never an error). */
function readLines(
	raw: unknown,
): readonly LogLine[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(line): line is LogLine =>
			line !== null &&
			typeof line === "object" &&
			typeof (line as LogLine).text === "string",
	);
}

/** A line's tone: the block's override map first, then the default. */
function lineTone(
	level: string | undefined,
	overrides: Readonly<Record<string, Tone>> | undefined,
): Tone {
	if (level === undefined) return "neutral";
	const override = overrides?.[level];
	return override ?? DEFAULT_LEVEL_TONES[level] ?? "neutral";
}

/** A log line's `at` rendered for the aria timestamp (machine form). */
function dateTime(line: LogLine): string | undefined {
	if (line.at === undefined) return undefined;
	return typeof line.at === "number"
		? new Date(line.at).toISOString()
		: line.at;
}

/** A log block. */
export function LogBlockView(props: { block: LogBlock }): ReactNode {
	const ctx = useSurfaceData();
	const block = props.block;
	const lines = readLines(bound(ctx, block.lines));

	const paneRef = useRef<HTMLDivElement | null>(null);
	const followRef = useRef(true);
	const [stuck, setStuck] = useState(true);
	followRef.current = stuck && block.follow === true;

	// Follow: scroll to the bottom whenever lines arrive while stuck.
	useEffect(() => {
		const pane = paneRef.current;
		if (pane === null || !followRef.current) return;
		pane.scrollTop = pane.scrollHeight;
	}, [lines.length]);

	// Release on scroll-up: the at-bottom test runs on every scroll; the
	// pane sticks again only once the user returns to the bottom.
	function onScroll(): void {
		const pane = paneRef.current;
		if (pane === null) return;
		const atBottom =
			pane.scrollHeight - pane.scrollTop - pane.clientHeight <=
			BOTTOM_TOLERANCE_PX;
		setStuck(atBottom);
	}

	return (
		<div
			className="blk blk-log"
			data-block="log"
			data-wrap={block.wrap === true}
		>
			<div
				ref={paneRef}
				className="blk-log-lines"
				onScroll={onScroll}
				role="log"
			>
				{lines.map((line, index) => {
					const tone = lineTone(line.level, block.tones);
					return (
						<div
							key={index}
							className="blk-log-line"
							data-tone={tone}
							data-level={line.level}
							style={toneColor(tone)}
						>
							{line.at !== undefined && (
								<time className="blk-log-time" dateTime={dateTime(line)}>
									{dateTime(line)}
								</time>
							)}
							{line.level !== undefined && (
								<span className="blk-log-level">{line.level}</span>
							)}
							<span className="blk-log-text" dir="auto">{line.text}</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}
