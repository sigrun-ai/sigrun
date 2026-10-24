/**
 * Content sniffing for image-proxy responses (UI-blocks U7, spec
 * §11.2): the body must sniff as PNG, JPEG, GIF or WebP — the
 * `Content-Type` header is never trusted. SVG and AVIF are refused
 * even when the header says `image/png` (SVG can carry script; AVIF
 * has no decoder in pi-tui).
 */

/** The image types the proxy accepts, from magic bytes only. */
export type SniffedImage = "png" | "jpeg" | "gif" | "webp";

/**
 * Sniff `bytes` by magic prefix. Returns `"svg"` / `"avif"` for the
 * refused-but-recognizable types (so callers can name the reason),
 * and `undefined` when nothing matches.
 */
export function sniffImage(
	bytes: Buffer,
): SniffedImage | "svg" | "avif" | undefined {
	if (bytes.length >= 8) {
		// PNG: 89 50 4E 47 0D 0A 1A 0A
		if (
			bytes[0] === 0x89 &&
			bytes[1] === 0x50 &&
			bytes[2] === 0x4e &&
			bytes[3] === 0x47 &&
			bytes[4] === 0x0d &&
			bytes[5] === 0x0a &&
			bytes[6] === 0x1a &&
			bytes[7] === 0x0a
		) {
			return "png";
		}
		// GIF: GIF87a / GIF89a
		if (
			bytes.subarray(0, 3).toString("latin1") === "GIF" &&
			(bytes.subarray(3, 6).toString("latin1") === "87a" ||
				bytes.subarray(3, 6).toString("latin1") === "89a")
		) {
			return "gif";
		}
	}
	// JPEG: FF D8 FF
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "jpeg";
	}
	// WebP: "RIFF" + len + "WEBP"
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
		bytes.subarray(8, 12).toString("latin1") === "WEBP"
	) {
		return "webp";
	}
	// AVIF/HEIF: "ftyp" box at offset 4; the brand at offset 8 is
	// avif/avis (or the heic family — refused all the same, but named
	// avif only for actual avif brands so the reason is honest).
	if (bytes.length >= 12 && bytes.subarray(4, 8).toString("latin1") === "ftyp") {
		const brand = bytes.subarray(8, 12).toString("latin1").toLowerCase();
		if (brand === "avif" || brand === "avis") return "avif";
	}
	// SVG: an XML prolog or an `<svg` opening anywhere in the first
	// 512 bytes (handles BOM, XML decl, comments, and DOCTYPE).
	const head = bytes.subarray(0, 512).toString("utf8");
	if (/^\uFEFF?\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*(!DOCTYPE[\s\S]*?\]\s*)?<svg/i.test(head)) {
		return "svg";
	}
	return undefined;
}

/** True only for the four accepted types (the refused ones reject). */
export function isAcceptedImageType(
	type: SniffedImage | "svg" | "avif" | undefined,
): type is SniffedImage {
	return type === "png" || type === "jpeg" || type === "gif" || type === "webp";
}
