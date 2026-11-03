/**
 * OutlinePanel (B5, UI refresh): the right panel's outline — one button
 * per user turn. The button keeps the padding/border/hover chrome; the
 * 2-line clamp lives on the INNER `.outline-text` span (unpadded, so a
 * clamped prompt ends inside the content box — the button-padding spot
 * where line 3's top used to bleed through), and an overflow measurement
 * marks clamped items `data-clamped="true"` for a bottom fade. The full
 * text stays reachable as the button's `title` tooltip. Clicking scrolls
 * the matching `[data-entry-id]` turn into view (block start, smooth); an
 * IntersectionObserver over the user-turn elements keeps the TOPMOST
 * visible one `aria-current="true"`. Items are buttons, so the outline
 * is keyboard-reachable (Enter activates the jump).
 *
 * Behaviour adapted from hermes-webui's static/outline.js (see
 * THIRD_PARTY_NOTICES, B7).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface OutlineTurn {
	readonly entryId: number;
	readonly text: string;
}

/** The topmost visible entry id (smallest rect top), when any. */
function topmost(
	visible: ReadonlyMap<number, { isIntersecting: boolean; top: number }>,
): number | null {
	let current: number | null = null;
	let top = Number.POSITIVE_INFINITY;
	for (const [entryId, state] of visible) {
		if (!state.isIntersecting) continue;
		if (state.top < top) {
			top = state.top;
			current = entryId;
		}
	}
	return current;
}

/** Set equality (avoids state churn when a re-measure finds no change). */
function sameIds(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
	if (a.size !== b.size) return false;
	for (const id of a) {
		if (!b.has(id)) return false;
	}
	return true;
}

export function OutlinePanel(props: {
	/** The transcript's scroll root — its `[data-entry-id]` queries feed
	 *  both the jump targets and the IntersectionObserver. */
	readonly scrollRoot: HTMLElement | null;
	/** One item per user turn, in transcript order. */
	readonly turns: readonly OutlineTurn[];
}) {
	const { scrollRoot, turns } = props;
	const [current, setCurrent] = useState<number | null>(null);
	// Entry ids whose `.outline-text` overflows the 2-line clamp — the
	// fade's marker (see the effect below).
	const [clamped, setClamped] = useState<ReadonlySet<number>>(
		() => new Set<number>(),
	);
	const navRef = useRef<HTMLElement | null>(null);
	// The observer tracks the user turns' ELEMENTS: re-arm only when the
	// turn set changes (a text edit or a new view frame with the same
	// prompts keeps the observer — and the current marker — stable).
	const turnIds = turns.map((turn) => turn.entryId).join(",");

	// A conversation switch (or a new prompt) re-derives the items; the
	// current marker resets until the observer speaks again.
	useEffect(() => {
		setCurrent(null);
	}, [scrollRoot, turnIds]);

	// One IntersectionObserver watches every user-turn element; each
	// callback re-marks the topmost visible turn. An absent API (the test
	// runner, ancient browsers) skips the marker — jumps still work.
	useEffect(() => {
		if (scrollRoot === null) return;
		const Observer = (
			globalThis as {
				IntersectionObserver?: new (
					callback: (entries: readonly IntersectionObserverEntry[]) => void,
				) => IntersectionObserver;
			}
		).IntersectionObserver;
		if (Observer === undefined) return;
		const visible = new Map<number, { isIntersecting: boolean; top: number }>();
		const observer = new Observer((entries) => {
			for (const entry of entries) {
				const target = entry.target;
				const entryId = Number(target.getAttribute("data-entry-id"));
				if (!Number.isFinite(entryId)) continue;
				visible.set(entryId, {
					isIntersecting: entry.isIntersecting,
					top: target.getBoundingClientRect().top,
				});
			}
			setCurrent(topmost(visible));
		});
		for (const turn of turns) {
			const element = scrollRoot.querySelector(
				`[data-entry-id="${turn.entryId}"]`,
			);
			if (element !== null) observer.observe(element);
		}
		return () => {
			observer.disconnect();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- turns is
		// keyed by turnIds (same ids ⇒ same elements to observe)
	}, [scrollRoot, turnIds]);

	// Clamp measurement: after the items commit (and again whenever the
	// nav resizes — the panel is a fixed-width sidebar, but the empty →
	// populated transition and future width changes re-flow the text),
	// compare each span's scrollHeight against its clamped clientHeight.
	// The +1 absorbs sub-pixel rounding. An absent nav ref (the test
	// renderer attaches no host refs) or ResizeObserver (ancient
	// browsers) leaves the attribute unset — the clamp itself is pure CSS.
	// The deps carry scrollRoot: a conversation switch with an EQUAL
	// turn-id set remounts the transcript, and the clamped set belongs to
	// the transcript it measured — without the re-run, a stale
	// data-clamped marker survives the switch.
	useLayoutEffect(() => {
		const nav = navRef.current;
		if (nav === null) return;
		const measure = () => {
			const next = new Set<number>();
			for (const span of nav.querySelectorAll<HTMLElement>(".outline-text")) {
				if (span.scrollHeight <= span.clientHeight + 1) continue;
				const item = span.closest(".outline-item");
				const entryId = Number(item?.getAttribute("data-entry-id"));
				if (Number.isFinite(entryId)) next.add(entryId);
			}
			setClamped((prev) => (sameIds(prev, next) ? prev : next));
		};
		measure();
		const Observer = (
			globalThis as {
				ResizeObserver?: new (
					callback: () => void,
				) => ResizeObserver;
			}
		).ResizeObserver;
		if (Observer === undefined) return;
		const observer = new Observer(measure);
		observer.observe(nav);
		return () => {
			observer.disconnect();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- the spans
		// to measure are keyed by turnIds (same ids ⇒ same items)
	}, [scrollRoot, turnIds]);

	if (turns.length === 0) {
		return (
			<div className="right-panel-body outline-body">
				<h4 className="right-panel-title">Outline</h4>
				<p className="outline-empty">No prompts yet</p>
			</div>
		);
	}
	return (
		<div className="right-panel-body outline-body">
			<h4 className="right-panel-title">Outline</h4>
			<nav className="outline" aria-label="conversation outline" ref={navRef}>
				{turns.map((turn) => (
					<button
						type="button"
						key={turn.entryId}
						className="outline-item"
						data-entry-id={turn.entryId}
						data-clamped={
							clamped.has(turn.entryId) ? "true" : undefined
						}
						title={turn.text}
						aria-current={current === turn.entryId ? "true" : undefined}
						onClick={() => {
							scrollRoot
								?.querySelector(`[data-entry-id="${turn.entryId}"]`)
								?.scrollIntoView({ behavior: "smooth", block: "start" });
						}}
					>
						<span className="outline-text">{turn.text}</span>
					</button>
				))}
			</nav>
		</div>
	);
}
