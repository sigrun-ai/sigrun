/**
 * Notices Task 3 (loader half): the `noticeActions` factory-result field.
 *
 * The loader validates the field fail-loud — it must be a plain object
 * whose keys satisfy the handler-name grammar and whose values are
 * functions; anything else quarantines the extension (the message names
 * the offending entry). A validated record binds under the extension's
 * slug on `OpenedHarness.noticeActionBindings` — the notices service's
 * handler registry and its declared-handler post gate.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadConfig } from "../src/config.js";
import { openHarness, type OpenedHarness } from "../src/harness/boot.js";
import { seededIdentity } from "./helpers/identity.js";

/** The valid fixture (`acme-notes` + handlers `ping`/`hold`). */
const NOTICE_ACTIONS_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-notice-actions", "index.js"),
).href;

/** The non-function-entry fixture. */
const BAD_ENTRY_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-notice-actions-bad-entry", "index.js"),
).href;

/** The bad-handler-name fixture. */
const BAD_NAME_SPECIFIER = pathToFileURL(
	join(import.meta.dirname, "fixtures", "fixture-notice-actions-bad-name", "index.js"),
).href;

function configWith(dir: string) {
	return loadConfig({
		SIGRUN_MODEL: "openai/gpt-4o",
		SIGRUN_STORAGE_PATH: join(dir, "sigrun.db"),
		SIGRUN_WORKSPACE_PATH: dir,
	});
}

/** Boot the harness with the fixture specifiers; close + clean up after. */
async function withOpenedHarness(
	specifiers: readonly string[],
	run: (opened: OpenedHarness) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-loader-notice-actions-"));
	let opened: OpenedHarness | undefined;
	try {
		opened = await openHarness(configWith(dir), {
			env: {},
			identity: await seededIdentity(dir),
			// Hermetic: this suite pins the noticeActions pathway's outcomes
			// for its FIXTURE specifiers, not the built-in surface.
			builtins: false,
			extensionSpecifiers: specifiers,
		});
		await run(opened);
	} finally {
		await opened?.harness.close(BACKGROUND_CONTEXT);
		await rm(dir, { recursive: true, force: true });
	}
}

test("valid noticeActions bind under the slug", async () => {
	await withOpenedHarness([NOTICE_ACTIONS_SPECIFIER], async (opened) => {
		expect(opened.extensionOutcomes).toEqual([
			{ name: "acme-notes", status: "ok" },
		]);
		const binding = opened.noticeActionBindings.find(
			(entry) => entry.extension === "acme-notes",
		);
		expect(binding).toBeDefined();
		expect(Object.keys(binding?.actions ?? {})).toEqual([
			"ping",
			"hold",
			"fail",
			"slow",
		]);
		expect(typeof binding?.actions.ping).toBe("function");
		expect(typeof binding?.actions.hold).toBe("function");
	});
});

test("a non-function entry quarantines", async () => {
await withOpenedHarness([BAD_ENTRY_SPECIFIER], async (opened) => {
const outcome = opened.extensionOutcomes[0];
expect(outcome?.status).toBe("quarantined");
expect(outcome?.status === "quarantined" && outcome.error).toMatch(
/noticeActions entry/,
);
expect(opened.noticeActionBindings).toEqual([]);
});
});

test("a bad handler name quarantines", async () => {
await withOpenedHarness([BAD_NAME_SPECIFIER], async (opened) => {
const outcome = opened.extensionOutcomes[0];
expect(outcome?.status).toBe("quarantined");
expect(outcome?.status === "quarantined" && outcome.error).toMatch(
/noticeActions entry/,
);
expect(opened.noticeActionBindings).toEqual([]);
});
});
