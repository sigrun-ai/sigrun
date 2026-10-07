/**
 * §5 content-part resolution (Task 9b, Review Focus #1).
 *
 * `POST /v1/conversations/:id/submissions` accepts wire parts —
 * `{type:"text",text}` and `{type:"image"|"file",path,mime?}` with
 * workspace-relative `path` — and this module resolves them to the inline
 * `UserInput` content pi-durable stores (`TextContent` / base64
 * `ImageContent`) at SUBMIT time, through the conversation's `ExecutionEnv`
 * (the same `envBuilder` seam tool calls use, so remote workspaces stay
 * correct after the the-work-fabric-scrubbed swap, spec §3.4/§4.5).
 *
 * Resolution never silently drops a part: a `not_found` path becomes an
 * explicit error text part addressed to the model (it stays visible in the
 * transcript, and the model can react), and any other `FileError`
 * (permission denied, aborted, …) fails the whole request loud — the repo
 * rule "fail-loud on workspace read errors except not_found". A binary file
 * part that is not valid UTF-8 also becomes an explicit error part
 * (`invalid_utf8`) rather than mojibake text.
 */

import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv, Result } from "@earendil-works/pi-durable/env";
import type { FileError } from "@earendil-works/pi-durable/env";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

/** One wire part of a submission `input` array. */
export type SubmissionPart =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "image";
			readonly path: string;
			readonly mime?: string;
	  }
	| {
			readonly type: "file";
			readonly path: string;
			readonly mime?: string;
	  };

/** Inline content block after path resolution. */
export type InlinePart = TextContent | ImageContent;

/** The explicit error-part marker for a part that could not be resolved. */
function errorPart(path: string, reason: string): TextContent {
	return { type: "text", text: `[part error] ${path}: ${reason}` };
}

/** Extension → mime type for image parts without an explicit `mime`. */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/**
 * Validate a submission `input` body: the §5 content-part array, or a bare
 * string (upstream `UserInput` also admits a plain string — simple clients
 * submit text without wrapping it in a parts array; the server maps it to
 * one text part). Part paths must be workspace-relative (no absolute paths,
 * no `..` traversal — `NodeExecutionEnv` resolves against its `cwd` but
 * accepts absolute paths as-is, so the server must confine client paths
 * itself).
 */
export function parseSubmissionInput(input: unknown):
	| { ok: true; parts: SubmissionPart[] }
	| { ok: false } {
	if (typeof input === "string") {
		return { ok: true, parts: [{ type: "text", text: input }] };
	}
	if (!Array.isArray(input) || input.length === 0) return { ok: false };
	const parts: SubmissionPart[] = [];
	for (const candidate of input) {
		if (typeof candidate !== "object" || candidate === null) {
			return { ok: false };
		}
		const part = candidate as Record<string, unknown>;
		if (part.type === "text") {
			if (typeof part.text !== "string") return { ok: false };
			parts.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type === "image" || part.type === "file") {
			if (typeof part.path !== "string" || !isConfinedPath(part.path)) {
				return { ok: false };
			}
			if (part.mime !== undefined && typeof part.mime !== "string") {
				return { ok: false };
			}
			parts.push({
				type: part.type,
				path: part.path,
				...(part.mime === undefined ? {} : { mime: part.mime }),
			});
			continue;
		}
		return { ok: false };
	}
	return { ok: true, parts };
}

/**
 * A path the server will hand to the workspace env: relative, and without a
 * `..` segment. `.` and empty are fine (`.` is the workspace root in list
 * calls).
 */
export function isConfinedPath(path: string): boolean {
	if (path.length === 0) return true;
	if (path.startsWith("/") || path.includes("\\")) return false;
	const segments = path.split("/");
	return !segments.includes("..");
}

/** Read one workspace file strictly-UTF-8: `undefined` when not valid UTF-8. */
function decodeStrictUtf8(bytes: Uint8Array): string | undefined {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

/** Resolve one wire part against the conversation's env. */
async function resolvePart(
	part: SubmissionPart,
	env: ExecutionEnv,
	context: Context,
): Promise<InlinePart> {
	if (part.type === "text") return { type: "text", text: part.text };
	const read: Result<Uint8Array, FileError> = await env.readBinaryFile(
		part.path,
		context,
	);
	if (!read.ok) {
		if (read.error.code === "not_found") {
			// Review Focus #1: explicit error part, never a silent drop.
			return errorPart(part.path, "not_found");
		}
		// Every other workspace failure is a server-side fault: fail loud.
		throw read.error;
	}
	if (part.type === "image") {
		const mime =
			part.mime ??
			IMAGE_MIME_BY_EXTENSION[extensionOf(part.path)] ??
			"application/octet-stream";
		return {
			type: "image",
			data: Buffer.from(read.value).toString("base64"),
			mimeType: mime,
		};
	}
	const text = decodeStrictUtf8(read.value);
	if (text === undefined) {
		return errorPart(part.path, "invalid_utf8");
	}
	return { type: "text", text };
}

function extensionOf(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/**
 * Resolve a validated parts array to inline content. Rejects (throws the
 * `FileError`) on any non-`not_found` workspace failure — fail-loud.
 */
export async function resolveParts(
	parts: readonly SubmissionPart[],
	env: ExecutionEnv,
	context: Context,
): Promise<InlinePart[]> {
	const resolved: InlinePart[] = [];
	for (const part of parts) {
		resolved.push(await resolvePart(part, env, context));
	}
	return resolved;
}
