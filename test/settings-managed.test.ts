/**
 * Deployment-managed settings (0.4.0 follow-up Task 3).
 *
 * The chart seeder records the top-level keys it owns in
 * managed-settings.json. Reads are deliberately fresh: a deployment can
 * change that file without restarting sigrun. Managed keys lock every
 * matching form field by its first dotted segment and refuse whole writes.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
	managedKeysTouched,
	markManagedFields,
	readManagedKeys,
} from "../src/settings/managed.js";

describe("readManagedKeys", () => {
	test("an absent file manages nothing, silently", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-managed-absent-"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(readManagedKeys(dir)).toEqual([]);
			expect(error).not.toHaveBeenCalled();
		} finally {
			error.mockRestore();
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("garbage manages nothing and names the path in one process-wide error", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-managed-garbage-"));
		const path = join(dir, "managed-settings.json");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await writeFile(path, "not-json", "utf8");
			expect(readManagedKeys(dir)).toEqual([]);
			expect(readManagedKeys(dir)).toEqual([]);
			expect(error).toHaveBeenCalledTimes(1);
			expect(error.mock.calls[0]?.[0]).toContain(path);
		} finally {
			error.mockRestore();
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a non-string array manages nothing; a valid file reads fresh", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sigrun-managed-fresh-"));
		const path = join(dir, "managed-settings.json");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await writeFile(path, '["server", 1]', "utf8");
			expect(readManagedKeys(dir)).toEqual([]);
			expect(error).toHaveBeenCalledTimes(1);
			await writeFile(path, '["defaultModel"]', "utf8");
			expect(readManagedKeys(dir)).toEqual(["defaultModel"]);
			await writeFile(path, '["server"]', "utf8");
			expect(readManagedKeys(dir)).toEqual(["server"]);
		} finally {
			error.mockRestore();
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("managedKeysTouched", () => {
	test("returns managed top-level keys in patch order", () => {
		expect(
			managedKeysTouched(
				{ namingModel: "acme/namer-1", defaultModel: "acme/model-2" },
				["defaultModel"],
			),
		).toEqual(["defaultModel"]);
		expect(
			managedKeysTouched(
				{ namingModel: "acme/namer-1", server: { port: 3000 }, defaultModel: null },
				["server", "defaultModel"],
			),
		).toEqual(["server", "defaultModel"]);
	});

	test("an explicit null still touches a managed key", () => {
		expect(managedKeysTouched({ defaultModel: null }, ["defaultModel"])).toEqual([
			"defaultModel",
		]);
	});
});

describe("markManagedFields", () => {
	test("marks fields by first dotted segment without mutating the input", () => {
		const tree = {
			v: 1,
			root: {
				type: "form",
				children: [
					{
						type: "section",
						children: [
							{
								type: "text",
								name: "server.port",
								label: "Listen port",
								help: "The HTTP listen port",
							},
							{
								type: "text",
								name: "namingModel",
								label: "Naming model",
								help: "The auto-namer model",
							},
						],
					},
				],
			},
		};
		const before = structuredClone(tree);
		const marked = markManagedFields(tree, ["server"]);

		expect(tree).toEqual(before);
		expect(marked).not.toBe(tree);
		expect(marked.root).not.toBe(tree.root);
		const port = marked.root.children[0].children[0];
		expect(port).toMatchObject({
			disabled: true,
			help: "Managed by deployment. The HTTP listen port",
		});
		const naming = marked.root.children[0].children[1];
		expect(naming).toEqual(tree.root.children[0].children[1]);
		expect(naming).not.toBe(tree.root.children[0].children[1]);
	});

	test("replaces non-string help with the managed note", () => {
		const tree = {
			root: {
				type: "form",
				children: [
					{ type: "text", name: "defaultModel", label: "Model", help: { $: "/help" } },
				],
			},
		};
		expect(markManagedFields(tree, ["defaultModel"]).root.children[0]).toMatchObject({
			disabled: true,
			help: "Managed by deployment",
		});
	});
});
