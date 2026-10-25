/**
 * PNG conversion for the image proxy (UI-blocks U7 Task 3, spec §11.2
 * ruling 17): with `as=png`, the server converts the fetched (or
 * source-form) image to PNG with `sharp` (a server dependency) and the
 * route caches the result beside the original variant. The TUI asks for
 * it (pi-tui draws only PNG on Kitty without a registered transcoder);
 * the webui doesn't.
 */

import sharp from "sharp";

/** Convert image bytes (PNG/JPEG/GIF/WebP) to PNG bytes. */
export async function toPng(bytes: Buffer): Promise<Buffer> {
	return await sharp(bytes).png().toBuffer();
}
