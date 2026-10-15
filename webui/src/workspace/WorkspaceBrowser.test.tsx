/**
 * WorkspaceBrowser (Task 24): the right-panel file tree for the active
 * conversation's workspace. `client.listFiles(id, path)` lists a directory;
 * a directory expands lazily (children fetched on first expand, cached); a
 * file select opens the read-only FilePreview below the tree.
 *
 * The stub fetch routes `.../files?path=` against a directory map and
 * `.../files/content?path=` against a content map.
 */

import { act } from "react";
import type TestRenderer from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";
import {
	createClient,
	type FetchLike,
	type FileContentResponseWire,
	type FileEntryWire,
} from "../api";
import { renderAsync, textContent } from "../test-utils";
import { WorkspaceBrowser } from "./WorkspaceBrowser";

function makeHarness(init?: {
	readonly dirs?: Record<string, readonly FileEntryWire[]>;
	readonly contents?: Record<string, FileContentResponseWire>;
}) {
	const dirs = init?.dirs ?? {};
	const contents = init?.contents ?? {};
	const calls: { input: string }[] = [];
	const fetchImpl: FetchLike = (input) => {
		calls.push({ input });
		const listMatch = /^\/v1\/conversations\/\d+\/files\?path=(.+)$/.exec(
			input,
		);
		const contentMatch =
			/^\/v1\/conversations\/\d+\/files\/content\?path=(.+)$/.exec(input);
		let body: unknown;
		if (listMatch !== null) {
			body = {
				entries: dirs[decodeURIComponent(listMatch[1] as string)] ?? [],
			};
		} else if (contentMatch !== null) {
			body = contents[decodeURIComponent(contentMatch[1] as string)];
			if (body === undefined) {
				return Promise.resolve({
					ok: false,
					status: 404,
					json: () => Promise.resolve({ error: "not_found" }),
					text: () => Promise.resolve(String({ error: "not_found" })),
				});
			}
		} else {
			throw new Error(`unexpected fetch ${input}`);
		}
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve(body),
			text: () => Promise.resolve(String(body)),
		});
	};
	const client = createClient({ fetch: fetchImpl });
	return { calls, client };
}

function dirEntry(path: string): FileEntryWire {
	return {
		name: path.split("/").pop() as string,
		path,
		kind: "directory",
		size: 0,
		mtimeMs: 1,
	};
}

function fileEntry(path: string, size = 10): FileEntryWire {
	return {
		name: path.split("/").pop() as string,
		path,
		kind: "file",
		size,
		mtimeMs: 1,
	};
}

function fileButtons(renderer: TestRenderer.ReactTestRenderer) {
	return renderer.root.findAllByProps({ className: "workspace-file" });
}

function dirButtons(renderer: TestRenderer.ReactTestRenderer) {
	return renderer.root.findAllByProps({ className: "workspace-dir" });
}

describe("WorkspaceBrowser", () => {
	test("no conversation selected renders the empty state and fetches nothing", async () => {
		const { calls, client } = makeHarness();
		const renderer = await renderAsync(
			<WorkspaceBrowser client={client} conversationId={null} />,
		);
		expect(calls).toEqual([]);
		expect(textContent(renderer.toJSON())).toContain(
			"Select a conversation to browse its workspace",
		);
	});

	test("lists the root directory, directories sorted before files", async () => {
		const { calls, client } = makeHarness({
			dirs: {
				".": [fileEntry("b.txt"), dirEntry("a-dir"), fileEntry("a.txt")],
			},
		});
		const renderer = await renderAsync(
			<WorkspaceBrowser client={client} conversationId={7} />,
		);
		expect(calls.map((c) => c.input)).toEqual([
			"/v1/conversations/7/files?path=.",
		]);
		const rows = [
			...dirButtons(renderer).map((b) => b.props["data-path"]),
			// files render after directories in tree order
		];
		expect(rows).toEqual(["a-dir"]);
		const filePaths = fileButtons(renderer).map((b) => b.props["data-path"]);
		expect(filePaths).toEqual(["a.txt", "b.txt"]);
		// Directories come first in the rendered tree order.
		const allInOrder = renderer.root
			.findAllByProps({ "data-tree-row": "true" })
			.map((n) => n.props["data-path"]);
		expect(allInOrder).toEqual(["a-dir", "a.txt", "b.txt"]);
	});

	test("a directory expands lazily (one fetch on first expand) and collapses", async () => {
		const { calls, client } = makeHarness({
			dirs: {
				".": [dirEntry("src")],
				src: [fileEntry("src/main.ts"), dirEntry("src/lib")],
				"src/lib": [fileEntry("src/lib/util.ts")],
			},
		});
		const renderer = await renderAsync(
			<WorkspaceBrowser client={client} conversationId={7} />,
		);
		expect(fileButtons(renderer)).toHaveLength(0);

		// First expand: the children fetch fires once and the rows render.
		await act(async () => {
			await dirButtons(renderer)[0]?.props.onClick();
		});
		expect(
			calls.filter((c) => c.input.endsWith("files?path=src")),
		).toHaveLength(1);
		expect(fileButtons(renderer).map((b) => b.props["data-path"])).toEqual([
			"src/main.ts",
		]);
		// src/lib sorts first (directories before files).
		expect(dirButtons(renderer).map((b) => b.props["data-path"])).toEqual([
			"src",
			"src/lib",
		]);

		// Nested expand: one level deeper. DFS order: src/lib sorts BEFORE
		// src/main.ts (directories first), so util.ts leads.
		await act(async () => {
			await dirButtons(renderer)[1]?.props.onClick();
		});
		expect(
			calls.filter((c) => c.input.endsWith("files?path=src%2Flib")),
		).toHaveLength(1);
		expect(fileButtons(renderer).map((b) => b.props["data-path"])).toEqual([
			"src/lib/util.ts",
			"src/main.ts",
		]);

		// Collapse the parent: descendants hide; re-expand uses the cache (no
		// new fetch).
		await act(async () => {
			await dirButtons(renderer)[0]?.props.onClick();
		});
		expect(fileButtons(renderer)).toHaveLength(0);
		await act(async () => {
			await dirButtons(renderer)[0]?.props.onClick();
		});
		expect(
			calls.filter((c) => c.input.endsWith("files?path=src")),
		).toHaveLength(1);
		expect(fileButtons(renderer).map((b) => b.props["data-path"])).toEqual([
			"src/lib/util.ts",
			"src/main.ts",
		]);
	});

	test("selecting a file shows the preview (readFile fires, content renders)", async () => {
		const { calls, client } = makeHarness({
			dirs: { ".": [fileEntry("README.md")] },
			contents: {
				"README.md": {
					encoding: "text",
					content: "the readme words",
					size: 16,
				},
			},
		});
		const renderer = await renderAsync(
			<WorkspaceBrowser client={client} conversationId={7} />,
		);
		await act(async () => {
			await fileButtons(renderer)[0]?.props.onClick();
		});
		expect(calls.map((c) => c.input)).toContain(
			"/v1/conversations/7/files/content?path=README.md",
		);
		const preview = renderer.root.findByProps({ className: "file-preview" });
		expect(preview.props["data-path"]).toBe("README.md");
		expect(textContent(renderer.toJSON())).toContain("the readme words");
	});

	test("switching the conversation reloads the root and clears the selection", async () => {
		const { calls, client } = makeHarness({
			dirs: { ".": [fileEntry("README.md")] },
			contents: {
				"README.md": { encoding: "text", content: "words", size: 5 },
			},
		});
		const renderer = await renderAsync(
			<WorkspaceBrowser client={client} conversationId={7} />,
		);
		await act(async () => {
			await fileButtons(renderer)[0]?.props.onClick();
		});
		expect(
			renderer.root.findAllByProps({ className: "file-preview" }),
		).toHaveLength(1);
		await act(async () => {
			renderer.update(
				<WorkspaceBrowser client={client} conversationId={8} />,
			);
		});
		expect(calls.map((c) => c.input)).toContain(
			"/v1/conversations/8/files?path=.",
		);
		expect(
			renderer.root.findAllByProps({ className: "file-preview" }),
		).toHaveLength(0);
	});
});

describe("WorkspaceBrowser close affordance (2026-10-15 drawer fix)", () => {
	test("an onClose prop renders the ✕ in the title; clicking closes", async () => {
		const onClose = vi.fn();
		const { client } = makeHarness();
		const renderer = await renderAsync(
			<WorkspaceBrowser client={client} conversationId={1} onClose={onClose} />,
		);
		const button = renderer.root.findByProps({
			className: "workspace-close",
		});
		await act(async () => {
			button.props.onClick();
		});
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	test("without onClose the ✕ does not render (desktop static column)", async () => {
		const { client } = makeHarness();
		const renderer = await renderAsync(
			<WorkspaceBrowser client={client} conversationId={1} />,
		);
		expect(
			renderer.root.findAllByProps({ className: "workspace-close" }),
		).toHaveLength(0);
	});
});
