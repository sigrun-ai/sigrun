/**
 * The image-source rewriter (UI-blocks U7 Task 1, spec §11.1/§11.2):
 * walks a tree or data JSON value and replaces `https://` image sources
 * with the signer's proxy URL before the value leaves the server:
 *
 * - an `image` block's string `src` (literals only — a binding resolves
 *   client-side against the data, whose own slots are rewritten below);
 * - a card `image` slot (a string `image` prop), in a tree's item
 *   template AND in data items (spec §5.5.1: the slot takes a binding
 *   relative to the item, so the URL usually lives in the data);
 * - `![alt](https://…)` markdown image links in any string (markdown
 *   text, card/callout bodies, and the data strings they bind to).
 *
 * `asset:` and `data:` sources are untouched (§11.1). The walk is pure:
 * the input is never mutated, and a branch is rebuilt only when a
 * descendant changed (copy-on-write, the discipline of
 * `shared/blocks/ops.ts`); an untouched subtree is returned by
 * reference.
 *
 * Scope note (a spec-reading decision): the whole-string rewrite keys
 * on the two shapes the block set defines for image sources — the
 * `image` block's `src` prop and the card `image` prop — plus markdown
 * image links. A binding that resolves to an https URL stored in data
 * under any OTHER prop name is not rewritten (the walk cannot trace
 * bindings); the webui's `img-src 'self' data:` CSP (Task 3) makes such
 * a miss fail closed rather than load.
 */

import type { JsonObject, JsonValue } from "@sigrun/shared/blocks";

/** The signer: one original https URL → one proxy URL. */
export type ImageSign = (u: string) => string;

/** A markdown image link: `![alt](https://…)`. */
const MARKDOWN_IMAGE = /(!\[[^\]]*\]\()(https:\/\/[^)\s]+)(\))/g;

/** Whether `s` is an https image source the rewriter replaces. */
function isHttps(s: string): boolean {
	return s.startsWith("https://");
}

/**
 * Rewrite one string's markdown image links; `null` when nothing
 * matched (so the caller keeps the original reference).
 */
function rewriteMarkdown(text: string, sign: ImageSign): string | null {
	let changed = false;
	const out = text.replace(MARKDOWN_IMAGE, (_all, pre: string, url: string, post: string) => {
		changed = true;
		return `${pre}${sign(url)}${post}`;
	});
	return changed ? out : null;
}

/**
 * Rewrite every https image source in a tree or data value. Pure; see
 * the module docstring for the three rewrite shapes and the scope note.
 */
export function rewriteImages<T extends JsonValue>(
	value: T,
	sign: ImageSign,
): T {
	return rewrite(value, sign) as T;
}

/** The structural walk (copy-on-write: `null`-free, returns a value). */
function rewrite(value: JsonValue, sign: ImageSign): JsonValue {
	if (typeof value === "string") {
		const md = rewriteMarkdown(value, sign);
		return md === null ? value : md;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const out: JsonValue[] = [];
		for (const entry of value) {
			const rewritten = rewrite(entry, sign);
			if (rewritten !== entry) changed = true;
			out.push(rewritten);
		}
		return changed ? out : value;
	}
	if (typeof value === "object" && value !== null) {
		let changed = false;
		const out: JsonObject = {};
		for (const [key, entry] of Object.entries(value)) {
			let rewritten: JsonValue;
			if (
				typeof entry === "string" &&
				(key === "src" || key === "image") &&
				isHttps(entry)
			) {
				// The two whole-string shapes: an image block's `src` and a
				// card's `image` slot. Markdown links inside the string (none
				// in a bare URL) are covered by the string branch below, so
				// rewrite directly.
				rewritten = sign(entry);
			} else {
				rewritten = rewrite(entry, sign);
			}
			if (rewritten !== entry) changed = true;
			out[key] = rewritten;
		}
		return changed ? out : value;
	}
	return value;
}
