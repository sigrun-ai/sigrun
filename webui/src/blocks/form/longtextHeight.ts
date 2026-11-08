/** Keep in sync with the longtext fill media query in blocks.css. */
export const LONGTEXT_FILL_MIN_HEIGHT = 900;

/** Keep a longtext's inline height out of the CSS fill path. */
export function syncLongtextHeight(
	element: HTMLTextAreaElement,
	fill: boolean,
	tallViewport: boolean,
): void {
	if (fill && tallViewport && element.closest(".blk-page-main") !== null) {
		element.style.height = "";
		return;
	}
	element.style.height = "auto";
	element.style.height = `${element.scrollHeight}px`;
}

/** Track the fill breakpoint and clean up the listener on unmount. */
export function watchLongtextHeight(
	element: HTMLTextAreaElement,
	fill: boolean,
): () => void {
	const query = window.matchMedia(`(min-height: ${LONGTEXT_FILL_MIN_HEIGHT}px)`);
	const sync = (): void => syncLongtextHeight(element, fill, query.matches);
	sync();
	query.addEventListener("change", sync);
	return () => query.removeEventListener("change", sync);
}
