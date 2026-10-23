/**
 * The secret and file fields (UI-blocks U2 Task 5, spec §5.6).
 *
 * `secret` is write-only: it NEVER renders a value, only the bound
 * status — `set (stored)` / `set (env)` / `not set` — and a masked
 * editor (`•` per typed character; ASCII `*` with ctx.unicode false).
 *
 * `file` prompts for a path, checks `accept` (MIME patterns) and
 * `maxBytes`, reads the file's bytes, dispatches `onUpload` (a
 * `submit` action, turn false) with the file descriptor plus the base64
 * bytes, and hands the bytes to the surface's upload seam
 * (`uploadBytes`) when the host provides one (§7.2). A failed check
 * shows its error under the field and dispatches nothing.
 */

import { readFileSync, statSync } from "node:fs";
import type { FileField, JsonObject, SecretField } from "@sigrun/shared/blocks";
import { bindRaw, type BlockCtx } from "../context.js";
import { truncate } from "../width.js";

/** The secret status text (spec §5.6's exact strings). */
export function secretStatusText(status: unknown): string {
	if (status === "stored") return "set (stored)";
	if (status === "env") return "set (env)";
	return "not set";
}

/** The status line of a secret field: the bound status (the field's
 *  name resolved against the form's bind, as U1's SecretField does). */
export function secretStatusLine(field: SecretField, formBind: string, ctx: BlockCtx): string {
	const pointer = `${formBind === "" ? "" : formBind}/${field.name}`.replace(/^\/+/, "/");
	const status = bindRaw({ $: pointer }, ctx);
	return secretStatusText(status);
}

/** The masked editor text: one dot per typed character. */
export function maskText(textValue: string, unicode: boolean): string {
	return (unicode ? "•" : "*").repeat(textValue.length);
}

/** Whether a file matches the accept patterns (comma-separated:
 *  `image/*`, `image/png`, `.png`) — U1's `acceptsMime` rule, extended
 *  with an extension fallback when the MIME guess is empty. */
export function acceptsMime(
	accept: string | undefined,
	file: { type: string; name: string },
): boolean {
	if (accept === undefined || accept.trim() === "") return true;
	return accept.split(",").some((raw) => {
		const pattern = raw.trim();
		if (pattern === "") return false;
		if (pattern.startsWith(".")) return file.name.endsWith(pattern);
		if (pattern.endsWith("/*")) {
			return file.type !== "" && file.type.startsWith(pattern.slice(0, -1));
		}
		return file.type === pattern;
	});
}

/** A small extension → MIME map (the TUI has no file picker; the type
 *  is guessed from the name, empty when unknown). */
const EXT_MIME: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".txt": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".pdf": "application/pdf",
};

/** The MIME guess from a file name ("" when unknown). */
export function mimeOf(name: string): string {
	const dot = name.lastIndexOf(".");
	if (dot < 0) return "";
	return EXT_MIME[name.slice(dot).toLowerCase()] ?? "";
}

/** The outcome of a file pick (checks + read + dispatch shape). */
export type FilePick =
	| {
			ok: true;
			descriptor: { name: string; size: number; type: string };
			/** The raw bytes (the upload seam's payload). */
			bytes: Uint8Array;
			/** The descriptor plus base64 bytes (the dispatch payload's file). */
			payloadFile: JsonObject;
	  }
	| { ok: false; error: string };

/**
 * Check `accept`/`maxBytes`, read the file and build the descriptor +
 * payload. A failure answers `{ok: false, error}` and nothing else
 * happens (no dispatch).
 */
export function pickFile(
	field: FileField,
	path: string,
	read: (path: string) => Uint8Array = (p) => new Uint8Array(readFileSync(p)),
	sizeOf: (path: string) => number = (p) => statSync(p).size,
): FilePick {
	const name = path.split("/").pop() ?? path;
	let size: number;
	let bytes: Uint8Array;
	try {
		size = sizeOf(path);
		bytes = read(path);
	} catch {
		return { ok: false, error: `${path}: cannot read the file` };
	}
	const type = mimeOf(name);
	if (!acceptsMime(field.accept, { type, name })) {
		return { ok: false, error: `${name}: not an accepted type` };
	}
	if (field.maxBytes !== undefined && size > field.maxBytes) {
		return { ok: false, error: `${name} is larger than ${field.maxBytes} bytes` };
	}
	return {
		ok: true,
		descriptor: { name, size, type },
		bytes,
		payloadFile: {
			name,
			size,
			type,
			bytesBase64: Buffer.from(bytes).toString("base64"),
		},
	};
}

/** The per-field secret/file editor state (the path/masked buffer). */
export class FileFieldState {
	error: string | undefined;
	uploaded: readonly string[] = [];
}

/** The status line a file field shows after an upload. */
export function fileStatusLine(state: FileFieldState, width: number): string | undefined {
	if (state.uploaded.length === 0) return undefined;
	return truncate(`uploaded: ${state.uploaded.join(", ")}`, width);
}
