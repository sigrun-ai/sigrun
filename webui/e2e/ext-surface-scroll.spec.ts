/**
 * Extension views scroll: a view whose content outgrows the window must
 * scroll inside the main pane (the app root clips with overflow:hidden,
 * so a surface that never gets a definite height can't scroll at all).
 *
 * Drives the core Skills view with a long skill body: the page main
 * region must be the scroll container, and scrolling it must bring the
 * body's last line into the viewport while the page header stays put.
 */

import { expect, test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer();
});

test.afterAll(async () => {
	await server.cleanup();
});

test("a long skill body scrolls inside the page main region", async ({ browser }) => {
	const context = await browser.newContext({
		extraHTTPHeaders: { "x-sigrun-user": "tester" },
		viewport: { width: 1280, height: 720 },
	});
	const page = await context.newPage();
	try {
		await page.goto(server.url);
		await page.locator('[data-rail-section="skills"]').click();
		await expect(page).toHaveURL(/#\/ext\/core\/skills/);

		const lines = Array.from({ length: 150 }, (_, index) => `Line ${index + 1} of the long body.`);
		lines.push("THE-LAST-LINE");
		await page.getByRole("button", { name: "New skill" }).click();
		await page.getByRole("textbox", { name: "Name" }).fill("acme-long-skill");
		await page.getByRole("textbox", { name: "Description" }).fill("a long skill");
		await page.getByRole("textbox", { name: "Body" }).fill(lines.join("\n\n"));
		await page.getByRole("button", { name: "Create" }).click();

		// The Create button sits below the long textarea: reaching it at all
		// needs a scrolling form (before the fix the click landed nowhere).
		await expect(page).toHaveURL(/acme-long-skill/);
		const main = page.locator('[data-page-region="main"]');
		await expect(main.getByText("THE-LAST-LINE")).toHaveCount(1);

		const metrics = await main.evaluate((element) => ({
			client: element.clientHeight,
			scroll: element.scrollHeight,
			overflowY: getComputedStyle(element).overflowY,
		}));
		expect(metrics.overflowY).toBe("auto");
		expect(metrics.client).toBeLessThanOrEqual(720);
		expect(metrics.scroll).toBeGreaterThan(metrics.client);

		const last = main.getByText("THE-LAST-LINE");
		await expect(last).not.toBeInViewport();
		await main.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await expect(last).toBeInViewport();
		// The page header stays on screen while main scrolls.
		await expect(page.locator(".blk-page-header").first()).toBeInViewport();
	} finally {
		await context.close();
	}
});
