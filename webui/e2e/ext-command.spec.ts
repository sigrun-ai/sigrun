/**
 * Core hardening W5 Task 3 UI evidence: a real-browser pass over the
 * extension-command composer change — the merged `/` menu lists the
 * extension entry (`/hello`, attributed to the fixture extension), the
 * core-collision `new` stays singular, and executing `/hello bob` POSTs
 * the invoke route and renders the returned notice in the transient
 * banner. Screenshot lands in the gitignored webui/test-results/
 * directory (local evidence, not committed). Run with the repo-root
 * `npm run test:e2e` (the script builds the bundle first), or
 * `npx playwright test e2e/ext-command.spec.ts` from webui/ after a
 * build.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";

const SCREENSHOT_PATH = fileURLToPath(
	new URL("../test-results/task-3-ext-command.png", import.meta.url),
);

/** The fixture-commands extension (hello + a core-colliding `new`). */
const FIXTURE_COMMANDS = pathToFileURL(
	join(import.meta.dirname, "..", "..", "test", "fixtures", "fixture-commands", "index.js"),
).href;

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer({
		extensionSpecifiers: [FIXTURE_COMMANDS],
	});
});

test.afterAll(async () => {
	await server.cleanup();
});

test("the merged / menu lists the extension command and /hello renders its notice", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (cause) => pageErrors.push(String(cause)));

	await page.goto(`${server.url}/#/c/${server.conversationId}`);

	// Typing / opens the menu over the MERGED catalog: the extension's
	// /hello is listed after the core set, and the core-colliding `new`
	// was dropped (exactly one /new row).
	const textarea = page.locator("textarea.composer-input");
	await textarea.click();
	await textarea.fill("/");
	const menu = page.locator("ul.composer-command-menu");
	await expect(menu).toBeVisible();
	await expect(menu.locator("li", { hasText: "/hello" })).toBeVisible();
	await expect(menu.locator("li", { hasText: "/new" })).toHaveCount(1);

	// Screenshot of the merged menu, before executing.
	await mkdir(dirname(SCREENSHOT_PATH), { recursive: true });
	await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });

	// Execute the extension command: the composer POSTs the invoke
	// endpoint and renders the returned notice in the transient banner.
	await textarea.fill("/hello bob");
	await page.locator("button.composer-send").click();
	await expect(page.locator(".composer-notice")).toContainText("hi bob");
	// The command line cleared from the composer.
	await expect(textarea).toHaveValue("");

	// A SECOND run with no args (absent body → args "") also lands.
	await textarea.fill("/hello");
	await page.locator("button.composer-send").click();
	await expect(page.locator(".composer-notice")).toContainText("hi ");

	expect(pageErrors).toEqual([]);
});
