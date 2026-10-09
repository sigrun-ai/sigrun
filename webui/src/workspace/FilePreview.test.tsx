/**
 * FilePreview (Task 24): the read-only preview under the workspace tree.
 * `client.readFile(id, path)` → text renders in a `<pre>`; a base64
 * (binary) payload renders a size/type note instead of the payload; a
 * failed read (e.g. 413 file_too_large) surfaces fail-loud.
 */

import { describe, expect, test } from "vitest";
import {
	createClient,
	type FetchLike,
	type FileContentResponseWire,
} from "../api";
import { renderAsync, textContent } from "../test-utils";
import { FilePreview } from "./FilePreview";

function makeHarness(
	contents: Record<string, FileContentResponseWire>,
	init?: { readonly status?: number },
) {
	const calls: { input: string }[] = [];
	const fetchImpl: FetchLike = (input) => {
		calls.push({ input });
		const match = /^\/v1\/conversations\/\d+\/files\/content\?path=(.+)$/.exec(
			input,
		);
		if (match === null) throw new Error(`unexpected fetch ${input}`);
		const path = decodeURIComponent(match[1] as string);
		const body = contents[path];
		if (body === undefined) {
			return Promise.resolve({
				ok: false,
				status: 404,
				json: () => Promise.resolve({ error: "not_found" }),
			});
		}
		const status = init?.status ?? 200;
		return Promise.resolve({
			ok: status >= 200 && status < 300,
			status,
			json: () => Promise.resolve(body),
		});
	};
	const client = createClient({ fetch: fetchImpl });
	return { calls, client };
}

describe("FilePreview", () => {
	test("a text file renders its content", async () => {
		const { calls, client } = makeHarness({
			"src/readme.md": {
				encoding: "text",
				content: "# hello\nsome words",
				size: 16,
			},
		});
		const renderer = await renderAsync(
			<FilePreview client={client} conversationId={1} path="src/readme.md" />,
		);
		expect(calls[0]?.input).toBe(
			"/v1/conversations/1/files/content?path=src%2Freadme.md",
		);
		renderer.root.findByProps({
			className: "file-preview-content",
		});
		expect(textContent(renderer.toJSON())).toContain("# hello\nsome words");
	});

	test("a binary file renders a size/type note, not the payload", async () => {
		const { client } = makeHarness({
			"assets/logo.png": {
				encoding: "base64",
				content: "iVBORw0KGgo=",
				size: 4321,
			},
		});
		const renderer = await renderAsync(
			<FilePreview
				client={client}
				conversationId={1}
				path="assets/logo.png"
			/>,
		);
		const text = textContent(renderer.toJSON());
		expect(text).toContain("binary");
		expect(text).toContain("4321");
		// The base64 payload itself is never rendered inline.
		expect(text).not.toContain("iVBORw0KGgo=");
	});

	test("a failed read surfaces the error (fail loud)", async () => {
		const { client } = makeHarness({});
		const renderer = await renderAsync(
			<FilePreview client={client} conversationId={1} path="gone.txt" />,
		);
		renderer.root.findByProps({ role: "alert" });
		expect(textContent(renderer.toJSON())).toContain("404");
	});
});
