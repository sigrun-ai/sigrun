import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.js";
import { openHarness } from "../src/harness/boot.js";

test("harness reopens persisted root conversation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-harness-"));
	try {
		const config = loadConfig({
			SIGRUN_MODEL: "openai/gpt-4o",
			SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		});

		const first = await openHarness(config);
		const root = await first.harness.root(BACKGROUND_CONTEXT);
		expect(root.id).toBeTruthy();
		await first.harness.close(BACKGROUND_CONTEXT);

		const second = await openHarness(config);
		// The root id is a reserved constant, so `reopened.id === root.id` cannot
		// prove persistence. Assert the conversation row actually survived the
		// close/reopen by reading it back from storage before root() re-creates it.
		expect(
			await second.harness.conversation(root.id, BACKGROUND_CONTEXT),
		).toBeDefined();
		const reopened = await second.harness.root(BACKGROUND_CONTEXT);
		expect(reopened.id).toBe(root.id);
		await second.harness.close(BACKGROUND_CONTEXT);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
