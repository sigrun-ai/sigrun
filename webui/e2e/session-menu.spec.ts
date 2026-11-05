/**
 * The sidebar row menu over the rows beneath it (UI feedback 2026-11-05):
 * an archived row's ⋯ menu must take its own clicks. The row's dimming
 * once made the row a stacking context, so the menu painted UNDER the
 * next rows and a click on "Unarchive" selected the conversation below
 * instead. Playwright's click refuses an element another one covers,
 * so this spec fails on that regression.
 */

import { expect, test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";

test.describe("session row menu", () => {
	let server: E2EServer;
	test.beforeAll(async () => {
		server = await bootE2EServer();
	});
	test.afterAll(async () => {
		await server.cleanup();
	});

	test("an archived row's menu sits above the rows beneath it", async ({ page }) => {
		await page.goto(server.url);
		const list = page.locator(".session-list");
		const items = list.locator(".session-item");
		await expect(items).toHaveCount(1);
		// Two more conversations: the newest sorts first, so rows sit
		// beneath it for its menu to overlap.
		await page.locator(".session-new").click();
		await expect(items).toHaveCount(2);
		await page.locator(".session-new").click();
		await expect(items).toHaveCount(3);

		const newest = items.nth(0);
		const newestId = await newest.getAttribute("data-conversation-id");
		await newest.locator(".session-menu-toggle").click();
		await newest.locator('.session-menu [data-menu-action="archive"]').click();
		await expect(items).toHaveCount(2);
		await page.locator(".session-archived-toggle").click();
		await expect(items).toHaveCount(3);

		const archived = list.locator(`.session-item[data-conversation-id="${newestId}"]`);
		await expect(archived).toHaveClass(/session-item-archived/);
		// Rows lie beneath the archived one (the menu would overlap them).
		const archivedBox = await archived.boundingBox();
		const lastBox = await items.nth(2).boundingBox();
		expect(archivedBox).not.toBeNull();
		expect(lastBox).not.toBeNull();
		expect(lastBox!.y).toBeGreaterThan(archivedBox!.y);

		await archived.locator(".session-menu-toggle").click();
		const unarchive = archived.locator('.session-menu [data-menu-action="archive"]');
		await expect(unarchive).toHaveText("Unarchive");
		// A covered item fails actionability (another element would receive
		// the click) — the short timeout keeps that failure fast.
		await unarchive.click({ timeout: 5_000 });
		await expect(archived).not.toHaveClass(/session-item-archived/);
	});
});
