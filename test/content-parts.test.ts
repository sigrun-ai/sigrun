import { Buffer } from "node:buffer";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv, Result } from "@earendil-works/pi-durable/env";
import { FileError } from "@earendil-works/pi-durable/env";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	MAX_IMAGE_BYTES,
	resolveParts,
	type SubmissionPart,
} from "../src/server/content-parts.js";
import { resolvePartsLazy } from "../src/server/content-parts-lazy.js";

function workspaceEnv(
	files: Readonly<Record<string, Uint8Array>>,
	failures: Readonly<Record<string, FileError>> = {},
): ExecutionEnv {
	return {
		readBinaryFile: async (
			path: string,
			_context: typeof BACKGROUND_CONTEXT,
		): Promise<Result<Uint8Array, FileError>> => {
			const failure = failures[path];
			if (failure !== undefined) return { ok: false, error: failure };
			const bytes = files[path];
			if (bytes === undefined) {
				return {
					ok: false,
					error: new FileError("not_found", "synthetic missing file", path),
				};
			}
			return { ok: true, value: bytes };
		},
	} as ExecutionEnv;
}

const OPTIONS = { maxInlineFileBytes: 8, acceptsImages: false } as const;

async function resolve(
	parts: readonly SubmissionPart[],
	files: Readonly<Record<string, Uint8Array>>,
	options: { maxInlineFileBytes?: number; acceptsImages?: boolean } = {},
) {
	return await resolveParts(parts, workspaceEnv(files), BACKGROUND_CONTEXT, {
		...OPTIONS,
		...options,
	});
}

function textAt(content: readonly (TextContent | ImageContent)[], index: number): string {
	const part = content[index];
	expect(part?.type).toBe("text");
	return (part as TextContent).text;
}

describe("attachment delivery by kind", () => {
	test("a text file exactly at the inline cap is delivered as a marked inline body", async () => {
		// Catches an off-by-one boundary and a missing attachment envelope.
		const result = await resolve(
			[{ type: "file", path: "uploads/7/notes.md", mime: "text/markdown" }],
			{ "uploads/7/notes.md": new TextEncoder().encode("12345678") },
		);
		expect(result.content).toHaveLength(1);
		expect(textAt(result.content, 0)).toBe(
			'<attachment path="uploads/7/notes.md" type="text/markdown" size="8 B">\n' +
				"12345678\n</attachment>",
		);
		expect(result.attachments).toEqual([
			{
				path: "uploads/7/notes.md",
				name: "notes.md",
				mime: "text/markdown",
				bytes: 8,
				delivery: "inline",
				parts: [0],
			},
		]);
	});

	test("one byte over the inline cap becomes a workspace note with no body bytes", async () => {
		// Catches truncation leaking the old head-and-pointer representation.
		const result = await resolve(
			[{ type: "file", path: "uploads/7/big.md", mime: "text/markdown" }],
			{ "uploads/7/big.md": new TextEncoder().encode("123456789") },
		);
		expect(textAt(result.content, 0)).toBe(
			'<attachment path="uploads/7/big.md" type="text/markdown" size="9 B" delivery="workspace"/>\n' +
				"The file is in your workspace. Use `read` (with offset/limit), `grep`, `bash`, or codemode to inspect it.",
		);
		expect(textAt(result.content, 0)).not.toContain("123456789");
		expect(result.attachments[0]).toMatchObject({
			delivery: "workspace",
			bytes: 9,
			parts: [0],
		});
	});

	test("a non-UTF8 archive becomes a workspace note rather than a part error", async () => {
		// Catches binary files being decoded into mojibake or mislabeled errors.
		const result = await resolve(
			[{ type: "file", path: "uploads/7/a.zip" }],
			{ "uploads/7/a.zip": new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]) },
		);
		expect(textAt(result.content, 0)).toContain(
			'<attachment path="uploads/7/a.zip" type="application/zip" size="5 B" delivery="workspace"/>',
		);
		expect(textAt(result.content, 0)).not.toContain("[part error]");
		expect(result.attachments[0]).toMatchObject({
			mime: "application/zip",
			delivery: "workspace",
			bytes: 5,
			parts: [0],
		});
	});

	test("an accepted image produces adjacent marker and image parts", async () => {
		// Catches dropping the image marker or indexing input instead of output parts.
		const bytes = new Uint8Array(1024).fill(7);
		const result = await resolve(
			[{ type: "image", path: "uploads/7/pixel.png" }],
			{ "uploads/7/pixel.png": bytes },
			{ acceptsImages: true },
		);
		expect(result.content).toHaveLength(2);
		expect(textAt(result.content, 0)).toBe(
			'<attachment path="uploads/7/pixel.png" type="image/png" size="1.0 KB" delivery="image"/>',
		);
		expect(result.content[1]).toEqual({
			type: "image",
			data: Buffer.from(bytes).toString("base64"),
			mimeType: "image/png",
		});
		expect(result.attachments).toEqual([
			{
				path: "uploads/7/pixel.png",
				name: "pixel.png",
				mime: "image/png",
				bytes: 1024,
				delivery: "image",
				parts: [0, 1],
			},
		]);
	});

	test("an image for a text-only model becomes a workspace note", async () => {
		// Catches sending image content to a model that cannot consume it.
		const result = await resolve(
			[{ type: "image", path: "uploads/7/pixel.png" }],
			{ "uploads/7/pixel.png": new Uint8Array(1024) },
			{ acceptsImages: false },
		);
		expect(result.content).toHaveLength(1);
		expect(textAt(result.content, 0)).toContain('delivery="workspace"');
		expect(result.attachments[0]).toMatchObject({
			delivery: "workspace",
			parts: [0],
		});
	});

	test("an image one byte over the 5 MiB cap becomes a workspace note", async () => {
		// Catches a cap measured against the inline limit rather than MAX_IMAGE_BYTES.
		expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
		const result = await resolve(
			[{ type: "image", path: "uploads/7/huge.png" }],
			{ "uploads/7/huge.png": new Uint8Array(MAX_IMAGE_BYTES + 1) },
			{ acceptsImages: true },
		);
		expect(result.content).toHaveLength(1);
		expect(textAt(result.content, 0)).toContain('delivery="workspace"');
		expect(textAt(result.content, 0)).toContain('size="5.0 MB"');
		expect(result.attachments[0]).toMatchObject({
			bytes: MAX_IMAGE_BYTES + 1,
			delivery: "workspace",
		});
	});

	test("a missing file records not_found alongside its explicit error part", async () => {
		// Catches silent drops and losing the null byte count on read failures.
		const result = await resolve(
			[{ type: "file", path: "uploads/7/gone.txt" }],
			{},
		);
		expect(textAt(result.content, 0)).toBe(
			"[part error] uploads/7/gone.txt: not_found",
		);
		expect(result.attachments).toEqual([
			{
				path: "uploads/7/gone.txt",
				name: "gone.txt",
				mime: "text/plain",
				bytes: null,
				delivery: "error",
				parts: [0],
				error: "not_found",
			},
		]);
	});

	test("marker attributes escape ampersands and quotes while records retain the raw path", async () => {
		// Catches malformed model-facing markup and lossy path normalization.
		const path = 'uploads/7/Ranges & Reviews "2026".html';
		const result = await resolve(
			[{ type: "file", path }],
			{ [path]: new TextEncoder().encode("report") },
		);
		expect(textAt(result.content, 0)).toContain(
			'path="uploads/7/Ranges &amp; Reviews &quot;2026&quot;.html"',
		);
		expect(result.attachments[0]?.path).toBe(path);
		expect(result.attachments[0]?.name).toBe('Ranges & Reviews "2026".html');
	});

	test("text-only input is unchanged and carries no attachment records", async () => {
		// Catches unnecessary env access or metadata on ordinary text submissions.
		const parts: readonly SubmissionPart[] = [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		];
		const result = await resolve(parts, {});
		expect(result.content).toEqual(parts);
		expect(result.attachments).toEqual([]);
	});

	test("attachment part indexes point into returned content for mixed input", async () => {
		// Catches image expansion shifting later records' indexes.
		const result = await resolve(
			[
				{ type: "file", path: "uploads/7/a.txt" },
				{ type: "text", text: "between" },
				{ type: "image", path: "uploads/7/b.png" },
			],
			{
				"uploads/7/a.txt": new TextEncoder().encode("a"),
				"uploads/7/b.png": new Uint8Array([1, 2, 3]),
			},
			{ acceptsImages: true },
		);
		expect(result.content.map((part) => part.type)).toEqual([
			"text",
			"text",
			"text",
			"image",
		]);
		expect(textAt(result.content, 1)).toBe("between");
		expect(result.attachments.map((attachment) => attachment.parts)).toEqual([
			[0],
			[2, 3],
		]);
	});

	test("a file with image mime follows image delivery rules", async () => {
		// Catches dispatching only on the wire part type instead of resolved mime.
		const result = await resolve(
			[{ type: "file", path: "uploads/7/photo.bin", mime: "image/png" }],
			{ "uploads/7/photo.bin": new Uint8Array([1, 2, 3]) },
			{ acceptsImages: true },
		);
		expect(result.content.map((part) => part.type)).toEqual(["text", "image"]);
		expect(result.attachments[0]?.delivery).toBe("image");
	});

	test("an unknown image mime uses the binary wire fallback but records null mime", async () => {
		// Catches conflating transport fallback metadata with resolved mime metadata.
		const result = await resolve(
			[{ type: "image", path: "uploads/7/pixel.unknown" }],
			{ "uploads/7/pixel.unknown": new Uint8Array([1]) },
			{ acceptsImages: true },
		);
		expect(result.content[1]).toMatchObject({
			type: "image",
			mimeType: "application/octet-stream",
		});
		expect(textAt(result.content, 0)).toBe(
			'<attachment path="uploads/7/pixel.unknown" size="1 B" delivery="image"/>',
		);
		expect(result.attachments[0]?.mime).toBeNull();
	});

	test("non-not_found workspace failures fail the resolution loudly", async () => {
		// Catches converting a permission problem into a model-visible attachment error.
		const failure = new FileError(
			"permission_denied",
			"synthetic denied read",
			"uploads/7/private.txt",
		);
		await expect(
			resolveParts(
				[{ type: "file", path: "uploads/7/private.txt" }],
				workspaceEnv({}, { "uploads/7/private.txt": failure }),
				BACKGROUND_CONTEXT,
				OPTIONS,
			),
		).rejects.toBe(failure);
	});

	test("lazy text-only resolution does not await the workspace env", async () => {
		// Catches answer/text submissions depending on an unavailable sandbox env.
		const envPromise = new Promise<ExecutionEnv>(() => {});
		const result = await resolvePartsLazy(
			[{ type: "text", text: "answer" }],
			envPromise,
			BACKGROUND_CONTEXT,
			OPTIONS,
		);
		expect(result).toEqual({
			content: [{ type: "text", text: "answer" }],
			attachments: [],
		});
	});
});
