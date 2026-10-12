/**
 * Task 7 (pi parity) UI evidence: a real-browser screenshot of the
 * composer's slash-command menu — typing `/` opens the menu listing the
 * GET /v1/commands catalog, filtering narrows it, and executing `/name`
 * names the session. Not a ship-gate item; this exists to verify the
 * composer change visually. The screenshot lands in the gitignored
 * webui/test-results/ directory (local evidence, not committed). Run
 * with the repo-root `npm run test:e2e` (the script builds the bundle
 * first), or `npx playwright test e2e/slash-menu.spec.ts` from webui/
 * after a build.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";

const SCREENSHOT_PATH = fileURLToPath(
	new URL("../test-results/task-7-slash-menu.png", import.meta.url),
);

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer();
});

test.afterAll(async () => {
	await server.cleanup();
});

test("the slash menu opens, filters, and /name names the session", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (cause) => pageErrors.push(String(cause)));

	await page.goto(server.url);

	// Typing / as the first character opens the menu with the catalog.
	const textarea = page.locator("textarea.composer-input");
	await textarea.click();
	await textarea.fill("/");
	const menu = page.locator("ul.composer-command-menu");
	await expect(menu).toBeVisible();
	for (const name of ["/new", "/fork", "/compact", "/export", "/import", "/name", "/model", "/thinking"]) {
		await expect(menu.locator("li", { hasText: name }).first()).toBeVisible();
	}

	// Filtering: /na narrows to /name.
	await textarea.fill("/na");
	await expect(menu.locator("li")).toHaveCount(1);
	await expect(menu.locator("li", { hasText: "/name" })).toBeVisible();

	// Screenshot of the filtered menu, before executing.
	await mkdir(dirname(SCREENSHOT_PATH), { recursive: true });
	await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });

	// Type the full line and submit (the Send button — a textarea's Enter
	// inserts a newline; the composer has no Enter-to-send binding) — the
	// session gets named (the session meta's name lands server-side) and the
	// notice confirms it.
	await textarea.fill("/name research session");
	await page.locator("button.composer-send").click();
	await expect(page.locator(".composer-notice")).toContainText("research session");
	// The command line cleared from the composer.
	await expect(textarea).toHaveValue("");

	// An unknown command is a clear alert-strip error, never a no-op.
	await textarea.fill("/bogus whatever");
	await page.locator("button.composer-send").click();
	await expect(page.locator(".composer [role='alert']")).toContainText("unknown command: /bogus");

	expect(pageErrors).toEqual([]);
});