/**
 * useStickToBottom (round 2): the transcript auto-scrolls with new content
 * WHILE the user is at the bottom, and holds position the moment they
 * scroll up to read — the terminal/ChatGPT convention.
 *
 * "At the bottom" is a small tolerance band (sub-pixel rounding + the
 * fading gradient band make exact equality unreliable). The stick flag
 * updates on every scroll event; a content change (the caller's trigger —
 * the view's frame count) scrolls ONLY when stuck.
 */

import { useEffect, useRef, useState } from "react";

/** Distance from the bottom still counted as "at the bottom" (px). */
const BOTTOM_TOLERANCE_PX = 24;

export function useStickToBottom(
	root: HTMLElement | null,
	trigger: number,
): boolean {
	const [stuck, setStuck] = useState(true);
	// The synchronous twin (the effect below may run after multiple frames).
	const stuckRef = useRef(true);

	useEffect(() => {
		if (root === null) return;
		const onScroll = (): void => {
			const atBottom =
				root.scrollHeight - root.scrollTop - root.clientHeight <=
				BOTTOM_TOLERANCE_PX;
			stuckRef.current = atBottom;
			setStuck(atBottom);
		};
		root.addEventListener("scroll", onScroll, { passive: true });
		// Mount/conversation swap: measure once (a tall first render may
		// already be off-bottom through no user action).
		onScroll();
		return () => root.removeEventListener("scroll", onScroll);
	}, [root]);

	useEffect(() => {
		if (root === null || !stuckRef.current) return;
		root.scrollTop = root.scrollHeight;
	}, [root, trigger]);

	return stuck;
}
