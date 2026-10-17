/**
 * useDismiss (B7 polish): outside-click + Escape dismissal for the popovers,
 * pickers and menus (the header ⋯ menu, the sidebar row menu, the composer
 * pickers). Pass every region a click may land in WITHOUT dismissing (the
 * toggle + its menu — usually one wrapping element's ref); a pointerdown
 * outside all of them, or an Escape keydown anywhere, calls `onDismiss`.
 *
 * DOM-optional like the rest of the suite: with no document (the
 * react-test-renderer environment) no listeners attach at all.
 */

import { useEffect, type RefObject } from "react";

/** The document surface the hook listens on (a test fake or the real one). */
interface DocumentLike {
	addEventListener(type: string, listener: (event: unknown) => void): void;
	removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/** The node surface `contains` needs (DOM nodes and test fakes alike). */
interface NodeLike {
	contains(node: unknown): boolean;
}

function documentOf(): DocumentLike | undefined {
	return (globalThis as { document?: DocumentLike }).document;
}

/** Whether `target` sits inside one of the keep-open regions. */
function insideRegions(
	target: unknown,
	regions: readonly RefObject<NodeLike | null>[],
): boolean {
	return regions.some((region) => {
		const element = region.current;
		return element !== null && element.contains(target);
	});
}

export function useDismiss(
	open: boolean,
	onDismiss: () => void,
	...regions: readonly RefObject<NodeLike | null>[]
): void {
	useEffect(() => {
		if (!open) return;
		const doc = documentOf();
		if (doc === undefined) return;
		const onPointerDown = (event: unknown): void => {
			const target = (event as { target?: unknown }).target;
			if (target === null || target === undefined) return;
			if (!insideRegions(target, regions)) onDismiss();
		};
		const onKeyDown = (event: unknown): void => {
			if ((event as { key?: unknown }).key === "Escape") onDismiss();
		};
		doc.addEventListener("pointerdown", onPointerDown);
		doc.addEventListener("keydown", onKeyDown);
		return () => {
			doc.removeEventListener("pointerdown", onPointerDown);
			doc.removeEventListener("keydown", onKeyDown);
		};
		// The regions are refs — stable containers; the open flag is the
		// listener lifecycle. onDismiss identity changes do not re-attach.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);
}
