/**
 * The `image` block (UI-blocks spec §11.3): pi-tui's `Image` when
 * `getCapabilities().images` is kitty/iterm2 and the bytes arrived;
 * `[image: <alt>]` otherwise (no protocol, a failed or refused fetch,
 * a missing alt). Every non-PNG source is requested with `as=png`
 * (the server-side conversion, ruling 17); TMUX handling is pi-tui's
 * own (`terminal-image.js` turns images off under TMUX unless
 * `PI_IMAGE_PROTOCOL` overrides) — this block adds no detection.
 *
 * The byte-fetch is an injectable seam ({@link FetchImageBytes}): the
 * surface transport that resolves `asset:`/URL sources lands in
 * Task 4; tests fake it. Images size to the block's width in cells,
 * capped at 20 rows.
 */

import { getCapabilities, Image } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ImageBlock } from "@sigrun/shared/blocks";
import { bindText, type BlockCtx } from "./context.js";
import { truncate } from "./width.js";

/** The row cap (spec §11.3). */
const MAX_IMAGE_ROWS = 20;

/**
 * Fetch the bytes for one image source. `asPng` asks the transport
 * for the server-side PNG conversion (ruling 17); rejection or a
 * throw renders the alt fallback.
 */
export type FetchImageBytes = (
	src: string,
	opts: { asPng: boolean },
) => Promise<Uint8Array>;

/** The extra options {@link renderImageBlock} takes (the seams). */
export interface ImageOptions {
	/** The byte transport; absent renders the alt (nothing to fetch with). */
	fetchImage?: FetchImageBytes;
}

/** Does the source name a PNG already (extension or data URL)? */
function isPng(src: string): boolean {
	if (src.startsWith("data:")) return src.startsWith("data:image/png");
	return /\.png($|[?#])/i.test(src);
}

/** The fallback line for `alt` (`[image]` when the alt is missing). */
export function imageFallbackLine(alt: string): string {
	return alt === "" ? "[image]" : `[image: ${alt}]`;
}

/** `image`: fetch-then-render, with the alt as the standing fallback. */
export class ImageComponent implements Component {
	readonly #block: ImageBlock;
	readonly #ctx: BlockCtx;
	readonly #options: ImageOptions;
	/** The fetched component once the bytes are in (one fetch ever). */
	#image: Image | undefined;
	/** "idle" not started; "pending" renders [] while the fetch runs. */
	#state: "idle" | "pending" | "failed" = "idle";

	constructor(block: ImageBlock, ctx: BlockCtx, options: ImageOptions = {}) {
		this.#block = block;
		this.#ctx = ctx;
		this.#options = options;
	}

	render(width: number): string[] {
		const alt = bindText(this.#block.alt, this.#ctx);
		const protocol = getCapabilities().images;
		const src = bindText(this.#block.src, this.#ctx);
		const fetch = this.#options.fetchImage;
		if (protocol !== "kitty" && protocol !== "iterm2") {
			return [truncate(imageFallbackLine(alt), width)];
		}
		if (fetch === undefined || src === "") {
			return [truncate(imageFallbackLine(alt), width)];
		}
		if (this.#state === "idle") {
			this.#state = "pending";
			void fetch(src, { asPng: !isPng(src) })
				.then((bytes) => {
					let binary = "";
					for (const byte of bytes) binary += String.fromCharCode(byte);
					this.#image = new Image(
						btoa(binary),
						"image/png",
						{ fallbackColor: this.#ctx.theme.dim },
						{ maxWidthCells: width, maxHeightCells: MAX_IMAGE_ROWS },
					);
				})
				.catch(() => {
					this.#state = "failed";
				});
		}
		if (this.#state === "failed") {
			return [truncate(imageFallbackLine(alt), width)];
		}
		if (this.#image === undefined) {
			// Bytes pending: render nothing until the fetch resolves
			// (the host re-renders; a transient empty beats a flash of
			// the fallback line).
			return [];
		}
		return this.#image.render(width);
	}

	invalidate(): void {
		this.#image?.invalidate();
	}
}
