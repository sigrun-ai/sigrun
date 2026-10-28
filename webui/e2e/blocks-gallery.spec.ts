/**
 * The Blocks gallery visual pass (UI-blocks U1 Task 6, spec §16): every
 * gallery page screenshotted at the three container widths (30/60/90 rem
 * = 480/960/1440 px viewports), plus one real drag across lanes.
 *
 * The server boots with `server.dev: true` so the rail's Blocks entry
 * renders; the gallery itself is fully in-memory (the samples' fixture
 * trees ride the bundle). Screenshots are reviewed BY A PERSON before
 * acceptance as baselines — the assertions only gate presence.
 */

import { test, expect } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";

/** The gallery's sample names (mirrors test/fixtures/blocks/*.json; kept
 *  literal here so a fixture rename fails the e2e loud, not silently
 *  skips). */
const SAMPLES: readonly string[] = [
	"callout",
	"chart",
	"collection-calendar",
	"collection-grid",
	"collection-lanes",
	"collection-list",
	"collection-table",
	"columns",
	"details",
	"diff",
	"field-choice",
	"field-date",
	"field-daterange",
	"field-datetime",
	"field-file",
	"field-list",
	"field-longtext",
	"field-number",
	"field-secret",
	"field-text",
	"field-toggle",
	"fields",
	"form",
	"form-chat",
	"form-inline",
	"form-interaction",
	"form-settings",
	"form-upload",
	"form-view",
	"grid",
	"image",
	"log",
	"markdown",
	"meter",
	"page",
	"page-sidebar",
	"section",
	"stack",
	"stat",
	"tree",
];

/** The container widths (rem → px at the default 16 px base). */
const WIDTHS: readonly { rem: number; px: number }[] = [
	{ rem: 30, px: 480 },
	{ rem: 60, px: 960 },
	{ rem: 90, px: 1440 },
];

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer({
		dev: true,
	});
});

test.afterAll(async () => {
	await server.cleanup();
});

test("the Blocks rail entry renders only in dev mode", async ({ page }) => {
	await page.goto(`${server.url}/`);
	const entry = page.locator('[data-rail-section="blocks"]');
	await expect(entry).toBeVisible();
	await entry.click();
	await expect(page.locator('[data-gallery]')).toBeVisible();
});

for (const name of SAMPLES) {
	test.describe(`gallery sample: ${name}`, () => {
		for (const width of WIDTHS) {
			test(`at ${width.rem}rem`, async ({ page }) => {
				await page.setViewportSize({ width: width.px, height: 800 });
				await page.goto(`${server.url}/#/blocks/${name}`);
				const sample = page.locator(`[data-gallery-sample="${name}"]`);
				await expect(sample).toBeVisible();
				// Let the surface load + first measure settle.
				await expect(sample.locator('[data-surface="ready"]')).toBeAttached();
				// Let the surface paint + the width host measure before the shot.
				await page.waitForTimeout(300);
				await expect(sample).toHaveScreenshot(
					`blocks-${name}-${width.rem}rem.png`,
				);
			});
		}
	});
}

test("drag a card across lanes", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 800 });
	await page.goto(`${server.url}/#/blocks/collection-lanes`);
	const sample = page.locator('[data-gallery-sample="collection-lanes"]');
	await expect(sample.locator('[data-surface="ready"]')).toBeVisible();
	const card = sample.locator('[data-drag-item="card-1"]').first();
	await expect(card).toBeVisible();
	const doing = sample.locator('[data-lane="doing"]').first();
	await expect(doing).toBeVisible();
	const cardBox = await card.boundingBox();
	const laneBox = await doing.boundingBox();
	if (cardBox === null || laneBox === null) {
		throw new Error("drag geometry missing (card or lane not laid out)");
	}
	await page.mouse.move(
		cardBox.x + cardBox.width / 2,
		cardBox.y + cardBox.height / 2,
	);
	await page.mouse.down();
	await page.mouse.move(
		laneBox.x + laneBox.width / 2,
		laneBox.y + Math.min(laneBox.height - 4, 40),
		{ steps: 12 },
	);
	await page.mouse.up();
	// The move is optimistic (the gallery transport accepts every action):
	// the card renders in the doing lane without waiting for the server.
	await expect(
		sample.locator(
			'[data-lane="doing"] [data-drag-item="card-1"]',
		),
	).toBeVisible();
});
