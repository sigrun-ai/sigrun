import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.js";
import {
	DEFAULT_STREAM_TIMEOUT_MS,
	mergeStreamSettings,
	openHarness,
} from "../src/harness/boot.js";

test("harness reopens persisted root conversation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-harness-"));
	try {
		const config = loadConfig({
			SIGRUN_DEFAULT_MODEL: "openai/gpt-4o",
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

test("mergeStreamSettings: caller over file over the default timeoutMs", async () => {
	// Neither seam: the default lands.
	expect(mergeStreamSettings(undefined, undefined)).toEqual({
		timeoutMs: DEFAULT_STREAM_TIMEOUT_MS,
	});
	// File carries other fields but no timeoutMs: default fills in.
	expect(mergeStreamSettings(undefined, { maxRetries: 2 })).toEqual({
		maxRetries: 2,
		timeoutMs: DEFAULT_STREAM_TIMEOUT_MS,
	});
	// File names a timeoutMs: it wins (no default clobber).
	expect(mergeStreamSettings(undefined, { timeoutMs: 5 })).toEqual({
		timeoutMs: 5,
	});
	// Caller present (even without timeoutMs): caller wins field-wise and
	// the FILE no longer fills the default (the caller seam replaces the
	// file wholesale, matching the pre-hardening precedence).
	expect(mergeStreamSettings({ maxRetries: 1 }, { timeoutMs: 5 })).toEqual({
		maxRetries: 1,
	});
	expect(mergeStreamSettings({ timeoutMs: 1234 }, { timeoutMs: 5 })).toEqual({
		timeoutMs: 1234,
	});
	// Caller empty object: passthrough-undefined (an explicit empty
	// override reads as "nothing set" — matches the pre-hardening shape
	// where `??` fell through to undefined on falsy inputs).
	expect(mergeStreamSettings({}, { timeoutMs: 5 })).toBeUndefined();
});
