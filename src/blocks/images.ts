/**
 * Image source rules (spec §11.1): `asset:` paths, `data:` URLs of the
 * four accepted MIME types (capped at 192 KiB of base64 text), and
 * `https:` URLs. SVG and AVIF are never accepted (script payload; no
 * TUI decoder), and `http:` URLs are rejected. The proxy that rewrites
 * and fetches is U7; this module only validates.
 */

/** A source that passed the §11.1 rules. */
export type ImageSourceOk = { ok: true; kind: "asset" | "data" | "https" };

/** A source the §11.1 rules reject. */
export type ImageSourceErr = { ok: false; message: string };

/** The result of checking one `src` value. */
export type ImageSourceResult = ImageSourceOk | ImageSourceErr;

/** Max base64 characters in a `data:` image URL (spec §11.1: 192 KiB). */
const MAX_DATA_URL_CHARS = 192 * 1024;

/** MIME types a `data:` URL may carry. */
const DATA_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Check one image `src` against the §11.1 source rules. Bindings
 * (`{$: …}` objects) are not checked here — their resolved string is,
 * where the data model holds one (the data-size limit already covers
 * the byte cost).
 */
export function checkImageSource(src: string): ImageSourceResult {
	if (src.startsWith("asset:")) {
		const path = src.slice("asset:".length);
		if (path.length === 0) return { ok: false, message: "asset: path is empty" };
		return { ok: true, kind: "asset" };
	}
	if (src.startsWith("data:")) {
		const comma = src.indexOf(",");
		if (comma === -1) return { ok: false, message: "data: URL has no payload" };
		const meta = src.slice("data:".length, comma);
		const payload = src.slice(comma + 1);
		const [type, ...params] = meta.split(";");
		const normalized = type.toLowerCase();
		if (!DATA_MIME_TYPES.has(normalized)) {
			return {
				ok: false,
				message: `data: URL type ${type || "(empty)"} is not one of png, jpeg, gif, webp (svg and avif are never accepted)`,
			};
		}
		if (!params.includes("base64")) {
			return { ok: false, message: "data: URL must be base64" };
		}
		if (payload.length > MAX_DATA_URL_CHARS) {
			return {
				ok: false,
				message: `data: URL payload is ${payload.length} base64 characters, over the 192 KiB cap`,
			};
		}
		return { ok: true, kind: "data" };
	}
	if (/^https:\/\//.test(src)) {
		return { ok: true, kind: "https" };
	}
	if (/^http:\/\//.test(src)) {
		return { ok: false, message: "http: image URLs are rejected; use https" };
	}
	return { ok: false, message: "image src must be asset:, data: (png/jpeg/gif/webp) or https:" };
}
