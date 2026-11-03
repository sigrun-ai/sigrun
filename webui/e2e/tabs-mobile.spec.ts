/**
 * Phone tabs (tabs+skills Task 2): at a phone viewport the rail hides
 * and a fixed bottom bar carries Chats, the core Skills/Jobs tabs, and
 * More — whose sheet lists the extension views and Settings. The
 * conversation drawer keeps only the conversation list.
 *
 * Pixel 7 emulation per mobile-layout.spec.ts.
 */

import { devices, expect, test } from "@playwright/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { bootE2EServer, type E2EServer } from "./harness.js";

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer({ responses: [fauxAssistantMessage("ok")] });
});

test.afterAll(async () => {
	await server.cleanup();
});

test("phone: the bottom bar shows, the rail hides, and More routes to Settings", async ({
	browser,
}) => {
	const context = await browser.newContext({
		...devices["Pixel 7"],
		extraHTTPHeaders: { "x-sigrun-user": "tester" },
	});
	const page = await context.newPage();
	await page.goto(server.url);

	// The bottom bar is visible; the desktop rail is not.
	await expect(page.locator(".bottom-bar")).toBeVisible();
	await expect(page.locator(".rail")).not.toBeVisible();

	// The bar's always-present slots: Chats and More.
	await expect(page.locator(".bottom-bar [data-tab='chats']")).toBeVisible();
	await expect(page.locator(".bottom-bar [data-tab='more']")).toBeVisible();

	// Tap More → the sheet (a dialog listing the views) → Settings.
	await page.locator(".bottom-bar [data-tab='more']").click();
	const sheet = page.getByRole("dialog", { name: "More views" });
	await expect(sheet).toBeVisible();
	await sheet.getByRole("button", { name: "settings" }).click();
	await expect(page).toHaveURL(/#\/settings/);
	await expect(sheet).not.toBeVisible();

	// Settings is not a bar tab — More stays current for it.
	await expect(page.locator(".bottom-bar [data-tab='more']")).toHaveAttribute(
		"aria-current",
		"page",
	);

	// Back to Chats: the header ☰ opens the conversation drawer — the list,
	// no rail inside it.
	await page.locator(".bottom-bar [data-tab='chats']").click();
	await expect(page).toHaveURL(/#\/c/);
	await page.getByRole("button", { name: "open conversations" }).click();
	await expect(page.locator(".side-drawer[data-open]")).toBeVisible();
	await expect(
		page.locator(".side-drawer .session-list"),
	).toBeVisible();
	await expect(page.locator(".side-drawer .rail")).not.toBeVisible();

	await context.close();
});

// The core-view slots (tabs+skills Task 2): render only while the served
// meta lists them — the core Skills/Jobs defs land in later plan tasks, so
// this test is excludable with --grep-invert "Skills" until they do.
test("phone: the Skills and Jobs slots route to their core views", async ({
	browser,
}) => {
	const context = await browser.newContext({
		...devices["Pixel 7"],
		extraHTTPHeaders: { "x-sigrun-user": "tester" },
	});
	const page = await context.newPage();
	await page.goto(server.url);

	await expect(page.locator(".bottom-bar [data-tab='skills']")).toBeVisible();
	await expect(page.locator(".bottom-bar [data-tab='jobs']")).toBeVisible();

	// Tap Skills → the core skills route.
	await page.locator(".bottom-bar [data-tab='skills']").click();
	await expect(page).toHaveURL(/#\/ext\/core\/skills/);

	// Tap Jobs → the core jobs route.
	await page.locator(".bottom-bar [data-tab='jobs']").click();
	await expect(page).toHaveURL(/#\/ext\/core\/jobs/);

	await context.close();
});
