/**
 * §5 content-part resolution (Task 9b, Review Focus #1).
 *
 * `POST /v1/conversations/:id/submissions` accepts wire parts —
 * `{type:"text",text}` and `{type:"image"|"file",path,mime?}` with
 * workspace-relative `path` — and this module resolves them to the inline
 * `UserInput` content pi-durable stores (`TextContent` / base64
 * `ImageContent`) at SUBMIT time, through the conversation's `ExecutionEnv`
 * (the same `envBuilder` seam tool calls use, so remote workspaces stay
 * correct, spec §3.4/§4.5).
 *
 * Resolution never silently drops a part: a `not_found` path becomes an
 * explicit error text part addressed to the model (it stays visible in the
 * transcript, and the model can react), and any other `FileError`
 * (permission denied, aborted, …) fails the whole request loud — the repo
 * rule "fail-loud on workspace read errors except not_found". Attachment
 * records identify each resolved part's delivery and its indexes in the
 * returned content, so readers never need to parse model-facing markers.
 */

import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv, Result } from "@earendil-works/pi-durable/env";
import type { FileError } from "@earendil-works/pi-durable/env";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import type { EntryAttachment } from "@sigrun/shared/turns";

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

/** The strictest common provider per-image limit (5 MiB). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export interface ResolveOptions {
	readonly maxInlineFileBytes: number;
	readonly acceptsImages: boolean;
}

export interface ResolvedInput {
	readonly content: InlinePart[];
	readonly attachments: EntryAttachment[];
}

/** The explicit error-part marker for a part that could not be resolved. */
function errorPart(path: string, reason: string): TextContent {
	return { type: "text", text: `[part error] ${path}: ${reason}` };
}

/** Extension → mime type for attachments without an explicit `mime`. */
const MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	txt: "text/plain",
	md: "text/markdown",
	html: "text/html",
	htm: "text/html",
	json: "application/json",
	csv: "text/csv",
	xml: "application/xml",
	yaml: "application/yaml",
	yml: "application/yaml",
	pdf: "application/pdf",
	zip: "application/zip",
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

/** A human byte count for an attachment marker (`4.2 MB`, `812 KB`). */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function attachmentAttributes(
	path: string,
	mime: string | null,
	bytes: number,
): string {
	return (
		`path="${escapeAttribute(path)}"` +
		(mime === null ? "" : ` type="${escapeAttribute(mime)}"`) +
		` size="${formatBytes(bytes)}"`
	);
}

/** A marked section carrying a complete inline text attachment body. */
export function inlineAttachmentText(
	path: string,
	mime: string | null,
	bytes: number,
	body: string,
): string {
	return `<attachment ${attachmentAttributes(path, mime, bytes)}>\n${body}\n</attachment>`;
}

/** A pointer to an attachment the model reads through its workspace tools. */
export function workspaceAttachmentText(
	path: string,
	mime: string | null,
	bytes: number,
): string {
	return (
		`<attachment ${attachmentAttributes(path, mime, bytes)} delivery="workspace"/>\n` +
		"The file is in your workspace. Use `read` (with offset/limit), `grep`, `bash`, or codemode to inspect it."
	);
}

/** The marker immediately preceding a delivered image part. */
export function imageAttachmentText(
	path: string,
	mime: string | null,
	bytes: number,
): string {
	return `<attachment ${attachmentAttributes(path, mime, bytes)} delivery="image"/>`;
}

function extensionOf(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

function fileName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

interface ResolvedAttachment {
	readonly content: readonly InlinePart[];
	readonly attachment: EntryAttachment;
}

function attachmentRecord(
	part: Exclude<SubmissionPart, { readonly type: "text" }>,
	mime: string | null,
	bytes: number | null,
	delivery: EntryAttachment["delivery"],
	partIndexes: readonly number[],
	error?: string,
): EntryAttachment {
	return {
		path: part.path,
		name: fileName(part.path),
		mime,
		bytes,
		delivery,
		parts: partIndexes,
		...(error === undefined ? {} : { error }),
	};
}

/** Resolve one attachment against the conversation's env. */
async function resolveAttachment(
	part: Exclude<SubmissionPart, { readonly type: "text" }>,
	env: ExecutionEnv,
	context: Context,
	options: ResolveOptions,
	firstPartIndex: number,
): Promise<ResolvedAttachment> {
	const mime = part.mime ?? MIME_BY_EXTENSION[extensionOf(part.path)] ?? null;
	const read: Result<Uint8Array, FileError> = await env.readBinaryFile(
		part.path,
		context,
	);
	if (!read.ok) {
		if (read.error.code === "not_found") {
			// Review Focus #1: explicit error part, never a silent drop.
			return {
				content: [errorPart(part.path, "not_found")],
				attachment: attachmentRecord(
					part,
					mime,
					null,
					"error",
					[firstPartIndex],
					"not_found",
				),
			};
		}
		// Every other workspace failure is a server-side fault: fail loud.
		throw read.error;
	}

	const bytes = read.value.byteLength;
	if (
		(part.type === "image" || mime?.startsWith("image/") === true) &&
		options.acceptsImages &&
		bytes <= MAX_IMAGE_BYTES
	) {
		return {
			content: [
				{ type: "text", text: imageAttachmentText(part.path, mime, bytes) },
				{
					type: "image",
					data: Buffer.from(read.value).toString("base64"),
					mimeType: mime ?? "application/octet-stream",
				},
			],
			attachment: attachmentRecord(part, mime, bytes, "image", [
				firstPartIndex,
				firstPartIndex + 1,
			]),
		};
	}

	const text =
		bytes > options.maxInlineFileBytes ||
		part.type === "image" ||
		mime?.startsWith("image/") === true
			? undefined
			: decodeStrictUtf8(read.value);
	if (text !== undefined) {
		return {
			content: [
				{
					type: "text",
					text: inlineAttachmentText(part.path, mime, bytes, text),
				},
			],
			attachment: attachmentRecord(part, mime, bytes, "inline", [firstPartIndex]),
		};
	}

	return {
		content: [
			{ type: "text", text: workspaceAttachmentText(part.path, mime, bytes) },
		],
		attachment: attachmentRecord(part, mime, bytes, "workspace", [firstPartIndex]),
	};
}

/**
 * Resolve a validated parts array to content and attachment records. Rejects
 * (throws the `FileError`) on any non-`not_found` workspace failure.
 */
export async function resolveParts(
	parts: readonly SubmissionPart[],
	env: ExecutionEnv,
	context: Context,
	options: ResolveOptions,
): Promise<ResolvedInput> {
	const content: InlinePart[] = [];
	const attachments: EntryAttachment[] = [];
	for (const part of parts) {
		if (part.type === "text") {
			content.push({ type: "text", text: part.text });
			continue;
		}
		const resolved = await resolveAttachment(
			part,
			env,
			context,
			options,
			content.length,
		);
		content.push(...resolved.content);
		attachments.push(resolved.attachment);
	}
	return { content, attachments };
}
