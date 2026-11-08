/**
 * Phone-width layout (Pixel 7 emulation): the chat column never scrolls
 * sideways, a wide markdown table scrolls inside its own card, and the
 * composer's controls stay on one row even with a long model name.
 *
 * The drift regression: a long URL in a USER message rendered as one
 * unbroken link wider than the bubble, the bubble's 60ch cap was wider
 * than the phone, and the transcript scroller picked up horizontal
 * overflow — the column slid sideways under a vertical swipe.
 */

import { devices, expect, test } from "@playwright/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { bootE2EServer, type E2EServer } from "./harness.js";

const REPLY = [
	"| Model | Provider | Context | Max output | Input $/Mtok | Output $/Mtok | Notes |",
	"| --- | --- | --- | --- | --- | --- | --- |",
	"| acme-model-1 | acme | 1,000,000 | 393,216 | 0.015 | 0.06 | fast, cheap, good at tools |",
	"| acme-model-2 | acme | 1,000,000 | 32,000 | 0.20 | 1.00 | strong reasoning, slower |",
].join("\n");

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer({ responses: [fauxAssistantMessage(REPLY)] });
});

test.afterAll(async () => {
	await server.cleanup();
});

test("touch inputs are at least 16px", async ({ browser }) => {
	const context = await browser.newContext({
		...devices["Pixel 7"],
		extraHTTPHeaders: { "x-sigrun-user": "tester" },
	});
	const page = await context.newPage();
	await page.goto(server.url);
	const input = page.locator("textarea.composer-input");
	await expect(input).toBeVisible();
	expect(await input.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
	await context.close();
});

test("phone: no sideways drift, tables scroll in their card, one-row composer", async ({
	browser,
}) => {
	const context = await browser.newContext({
		...devices["Pixel 7"],
		extraHTTPHeaders: { "x-sigrun-user": "tester" },
	});
	const page = await context.newPage();
	await page.goto(server.url);
	const input = page.locator("textarea.composer-input");
	await input.fill(`compare https://example.invalid/${"segment/".repeat(30)}`);
	await input.press("Control+Enter");
	await expect(page.locator(".md-tbl table")).toBeVisible();

	// 1. The transcript scroller has no horizontal overflow.
	const column = await page.locator(".chat-center").evaluate((el) => ({
		scroll: el.scrollWidth,
		client: el.clientWidth,
	}));
	expect(column.scroll).toBeLessThanOrEqual(column.client);

	// 2. The table is wider than its card and scrolls inside it; no cell
	//    is crushed below a readable width.
	const table = await page.locator(".md-tbl-scroll").evaluate((el) => ({
		scroll: el.scrollWidth,
		client: el.clientWidth,
		narrowest: Math.min(
			...Array.from(el.querySelectorAll("td")).map((td) => td.getBoundingClientRect().width),
		),
	}));
	expect(table.scroll).toBeGreaterThan(table.client);
	expect(table.narrowest).toBeGreaterThan(40);

	// 3. The composer toolbar is one row with a long model name.
	await page.evaluate(() => {
		const label = document.querySelector('[data-picker="model"] .composer-pill-label');
		if (label !== null) label.textContent = "acme-gateway/acme-model-with-a-long-name";
	});
	const tops = await page
		.locator(".composer-toolbar > *")
		.evaluateAll((els) =>
			els
				.filter((el) => el.getBoundingClientRect().width > 0)
				.map((el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2)),
		);
	expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(4);
	await context.close();
});
