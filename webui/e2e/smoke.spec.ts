/**
 * Task 26b-i (refreshed B7): the harness smoke test — proves the E2E fixture
 * end to end.
 *
 * Boots the real M1 server (bootE2EServer) serving the built bundle, loads
 * it in a real browser, and asserts the B2+ app shell renders: the schema
 * gate PASSES (no `.app-refused` — the served schemaVersion matches the
 * bundle's pin), the rail + chat header show, and the conversation sidebar
 * lists the root conversation. Screenshots to the gitignored
 * webui/test-results/ directory (local evidence, not committed).
 *
 * Selectors ride the B2-B6 stable hooks: the section rail, the chat header
 * (the old `header.top-bar`/`.brand` are gone), and the session list.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";

/** The screenshot path (gitignored webui/test-results/). */
const SCREENSHOT_PATH = fileURLToPath(
	new URL("../test-results/task-26b-i-smoke.png", import.meta.url),
);

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer();
});

test.afterAll(async () => {
	await server.cleanup();
});

test("the bundle serves and the app shell renders", async ({ page }) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (cause) => pageErrors.push(String(cause)));

	await page.goto(server.url);

	// The schema gate passed: the app did not refuse to render.
	await expect(page.locator(".app-refused")).toHaveCount(0);

	// The B2+ shell: the section rail (brand + Chats) + the chat header
	// (the old top bar with its brand text is gone).
	await expect(page.locator("nav.rail")).toBeVisible();
	await expect(page.locator(".rail-brand")).toHaveAttribute("title", "sigrun");
	await expect(
		page.locator('[data-rail-section="chats"]'),
	).toBeVisible();
	await expect(page.locator("header.chat-header")).toBeVisible();

	// The conversations sidebar lists the root conversation.
	await expect(page.locator("nav.session-list")).toBeVisible();
	await expect(page.locator(".session-select").first()).toBeVisible();

	// No uncaught page errors during boot + render.
	expect(pageErrors).toEqual([]);

	await mkdir(dirname(SCREENSHOT_PATH), { recursive: true });
	await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
});
