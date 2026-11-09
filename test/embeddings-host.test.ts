/**
 * Embedding-providers Task 3: host.embeddings through the live host
 * bridge, including a call fired before extension loading completes.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";
import { createServer } from "../src/server/index.js";
import { seededIdentity } from "./helpers/identity.js";
import {
	callFromCaller,
	pending as callerPending,
	resetEmbeddingCaller,
	results as callerResults,
} from "./fixtures/fixture-embedding-caller/index.js";

const PROVIDER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-embedding-provider", "index.js"),
).href;
const CALLER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-embedding-caller", "index.js"),
).href;
const EARLY_CALLER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-embedding-caller-early", "index.js"),
).href;

const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const close of cleanups.splice(0)) await close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function boot(specifiers: readonly string[], settings: Record<string, unknown> = {}) {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-embeddings-host-"));
	dirs.push(dir);
	await writeFile(join(dir, "settings.json"), JSON.stringify(settings), "utf8");
	const config = loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
		SIGRUN_AUTH: "token",
	});
	const opened = await openHarness(config, {
		identity: await seededIdentity(dir),
		builtins: false,
		settingsDir: dir,
		extensionSpecifiers: specifiers,
		expectHostBridge: true,
	});
	cleanups.push(() => opened.harness.close(BACKGROUND_CONTEXT));
	const app = await createServer(opened, config);
	cleanups.push(() => app.close());
	return { opened, dir };
}

test("host.embeddings.embed reaches the registry with the caller slug", async () => {
	resetEmbeddingCaller();
	const rig = await boot([PROVIDER, CALLER], { embeddingModel: "acme-embed/embed-1" });
	const registrySpy = vi.spyOn(rig.opened.embeddings, "embed");
	const result = await callFromCaller(["one", "two"]);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("unreachable");
	expect(result.model).toBe("acme-embed/embed-1");
	expect(result.dimensions).toBe(3);
	expect(result.vectors).toHaveLength(2);
	expect(registrySpy).toHaveBeenCalledWith(
		"acme-embedding-caller",
		["one", "two"],
		{},
	);
	expect(rig.opened.embeddings.list()).toEqual([
		expect.objectContaining({ model: "acme-embed/embed-1", provider: "acme-embed", default: true }),
		expect.objectContaining({ model: "acme-embed/embed-2", provider: "acme-embed" }),
	]);
});

test("host.embeddings before loading completes waits", async () => {
	resetEmbeddingCaller();
	await boot([PROVIDER, EARLY_CALLER], { embeddingModel: "acme-embed/embed-1" });
	expect(callerPending).toHaveLength(1);
	await Promise.all(callerPending);
	expect(callerResults).toHaveLength(1);
	expect(callerResults[0]?.ok).toBe(true);
	if (callerResults[0]?.ok !== true) throw new Error("unreachable");
	expect(callerResults[0]?.model).toBe("acme-embed/embed-1");
});
