/**
 * Magic-byte MIME sniffing (UI-blocks U3 Task 3, spec §7.1): the upload
 * and asset routes report the type sniffed from the BYTES, never a
 * client-supplied filename or content-type. Covers the image types the
 * spec admits (§11.1: PNG, JPEG, GIF, WebP) plus the generic text and
 * JSON an extension form field accepts; anything unrecognized is
 * `application/octet-stream`.
 */

/** Sniff one buffer's MIME type from its leading bytes. */
export function sniffMime(bytes: Uint8Array): string {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 && // P
		bytes[2] === 0x4e && // N
		bytes[3] === 0x47 // G
	) {
		return "image/png";
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "image/jpeg";
	}
	if (
		bytes.length >= 6 &&
		bytes[0] === 0x47 && // G
		bytes[1] === 0x49 && // I
		bytes[2] === 0x46 // F
	) {
		return "image/gif";
	}
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 && // R
		bytes[1] === 0x49 && // I
		bytes[2] === 0x46 && // F
		bytes[3] === 0x46 && // F
		bytes[8] === 0x57 && // W
		bytes[9] === 0x45 && // E
		bytes[10] === 0x42 && // B
		bytes[11] === 0x50 // P
	) {
		return "image/webp";
	}
	if (
		bytes.length >= 4 &&
		bytes[0] === 0x25 && // %
		bytes[1] === 0x50 && // P
		bytes[2] === 0x44 && // D
		bytes[3] === 0x46 // F
	) {
		return "application/pdf";
	}
	// Strictly valid UTF-8 text (no NUL) reads as text; a JSON-shaped
	// text body reports as JSON.
	if (bytes.length > 0 && isUtf8Text(bytes)) {
		const trimmed = new TextDecoder().decode(bytes).trimStart();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			return "application/json";
		}
		return "text/plain";
	}
	return "application/octet-stream";
}

/** True when the bytes are valid UTF-8 with no NULs (a text file). */
function isUtf8Text(bytes: Uint8Array): boolean {
	for (const byte of bytes) {
		if (byte === 0) return false;
	}
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return true;
	} catch {
		return false;
	}
}
