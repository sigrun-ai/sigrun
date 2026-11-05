/**
 * UI-blocks U3 Task 5 e2e: two-browser extension-surface test against the
 * real server with `fixture-surfaces-e2e` loaded (a shared board view +
 * a stats panel). Alice's drag (the `move` action) lands on the shared
 * data and announces `surface.changed`; Bob's second browser context
 * sees the card in the new lane within the 2 s budget (the
 * surface.changed → since-fetch round trip over TWO `/v1/events`
 * streams, each a registered watcher).
 *
 * Bob's context carries `X-Sigrun-User: bob`, and the fixture's
 * `readOnlyUsers` flips bob's access to "read" — the read-only render
 * hides every drag affordance (spec §6.5), which the third test pins.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";
import { readOnlyUsers, resetBoard } from "../../test/fixtures/fixture-surfaces-e2e/index.js";

/** The e2e fixture extension (mutable sharedData board + stats panel). */
const FIXTURE = pathToFileURL(
	join(import.meta.dirname, "..", "..", "test", "fixtures", "fixture-surfaces-e2e", "index.js"),
).href;

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer({
		extensionSpecifiers: [FIXTURE],
	});
});

test.afterAll(async () => {
	await server.cleanup();
});

test.beforeEach(async () => {
	resetBoard();
});

test("alice drags a card across lanes; bob's context shows it moved within 2s", async ({
	browser,
}) => {
	// Two independent browser contexts (alice + bob), each with its own
	// /v1/events stream — the watcher registry must deliver the
	// surface.changed to BOTH.
	const aliceContext = await browser.newContext();
	const bobContext = await browser.newContext();
	const alice = await aliceContext.newPage();
	const bob = await bobContext.newPage();

	const aliceErrors: string[] = [];
	const bobErrors: string[] = [];
	alice.on("pageerror", (cause) => aliceErrors.push(String(cause)));
	bob.on("pageerror", (cause) => bobErrors.push(String(cause)));

	// A wide viewport renders the lanes display side-by-side (regular
	// width) so the pointer drag has both lanes on screen.
	await alice.setViewportSize({ width: 1600, height: 900 });
	await bob.setViewportSize({ width: 1600, height: 900 });
	// Both open the board surface (the rail entry navigates the hash).
	await alice.goto(`${server.url}/#/ext/fixture-surfaces-e2e/board`);
	await bob.goto(`${server.url}/#/ext/fixture-surfaces-e2e/board`);

	// The board renders its lanes + cards in both contexts (the generic
	// lanes display keys cards by data-drag-item).
	const aliceCard = alice.locator('[data-drag-item="c1"]');
	const bobCard = bob.locator('[data-drag-item="c1"]');
	await expect(aliceCard).toBeVisible();
	await expect(bobCard).toBeVisible();
	// c1 starts in the "todo" lane in both contexts.
	await expect(
		alice.locator('[data-lane="todo"] [data-drag-item="c1"]'),
	).toBeVisible();
	await expect(bob.locator('[data-lane="todo"] [data-drag-item="c1"]')).toBeVisible();

	// Alice moves c1 todo → doing through the keyboard move path
	// (§12.4): `m` picks the card up, ArrowRight moves the placement
	// cursor to the next lane, Enter drops. The keydown bubbles to the
	// lanes container's handler, which dispatches the move action
	// (optimistic local move + the server's accept mutates the shared
	// board and announces surface.changed).
	await aliceCard.dispatchEvent("keydown", { key: "m", bubbles: true });
	await aliceCard.dispatchEvent("keydown", { key: "ArrowRight", bubbles: true });
	await aliceCard.dispatchEvent("keydown", { key: "Enter", bubbles: true });
	// At this wide viewport both lanes are visible; assert the card's
	// actual placement rather than using compact mode's lane selector.
	await expect(
		alice.locator('[data-lane="doing"] [data-drag-item="c1"]'),
	).toBeVisible();

	// Bob's context reflects the move within 2 s: the surface.changed
	// event reached his stream, the since fetch returned the shared
	// board with c1 moved.
	const bobMoved = bob.locator('[data-lane="doing"] [data-drag-item="c1"]');
	await expect(bobMoved).toBeVisible({ timeout: 2000 });

	expect(aliceErrors).toEqual([]);
	expect(bobErrors).toEqual([]);
	await aliceContext.close();
	await bobContext.close();
});

test("a read-access principal sees the board with NO drag handles", async ({
	browser,
}) => {
	readOnlyUsers.add("bob");
	const context = await browser.newContext({
		extraHTTPHeaders: { "x-sigrun-user": "bob" },
	});
	const page = await context.newPage();
	await page.goto(`${server.url}/#/ext/fixture-surfaces-e2e/board`);
	const card = page.locator('[data-lane="todo"] .blk-card-title').first();
	await expect(card).toBeVisible();
	// §6.5's read rule: no drag affordance — a read-access card carries
	// NO data-drag-item hook at all.
	await expect(page.locator('[data-drag-item="c1"]')).toHaveCount(0);
	await context.close();
});

test("the stats panel opens from its header toggle and renders", async ({
	page,
}) => {
	await page.goto(server.url);
	// Panels are header toggles (todo Task 2): an installed panel stays
	// CLOSED until its toggle is clicked — the tab strip is gone.
	const toggle = page.locator('[data-panel="ext:fixture-surfaces-e2e/stats"]');
	await expect(toggle).toBeVisible();
	await toggle.click();
	// The panel host renders the stats surface's content.
	await expect(
		page.locator('[data-ext-panel="fixture-surfaces-e2e/stats"]'),
	).toBeVisible();
});

test("the convo panel follows the open conversation", async ({ page }) => {
	// Create B BEFORE the page boots so the boot lists it; the boot
	// default picks the root row (conversation 1) — that is A.
	const createB = await page.request.post(`${server.url}/v1/conversations`, {
		data: {},
	});
	const b = ((await createB.json()) as { id: number }).id;
	await page.goto(server.url);
	await page.locator('[data-panel="ext:fixture-surfaces-e2e/convo"]').click();
	const panel = page.locator(
		'[data-ext-panel="fixture-surfaces-e2e/convo"]',
	);
	// A is the boot default (the root conversation 1).
	const a = 1;
	await expect(panel).toContainText(`conversation ${a} bump 0`);
	// The real in-app switch: click B's sidebar row (each row carries
	// data-conversation-id). The panel follows the open conversation.
	await page
		.locator(`li[data-conversation-id="${b}"] .session-select`)
		.click();
	await expect(panel).toContainText(`conversation ${b} bump 0`);
	await expect(panel).not.toContainText(`conversation ${a} bump 0`);
});

test("a changed event reaches the open convo panel", async ({ page }) => {
	const create = await page.request.post(`${server.url}/v1/conversations`, {
		data: {},
	});
	const b = ((await create.json()) as { id: number }).id;
	await page.goto(`${server.url}/#/c/${b}`);
	await page.locator('[data-panel="ext:fixture-surfaces-e2e/convo"]').click();
	const panel = page.locator(
		'[data-ext-panel="fixture-surfaces-e2e/convo"]',
	);
	await expect(panel).toContainText(`conversation ${b} bump 0`);
	// POST bump for b: the fixture publishes surface.changed for the
	// {conversationId: b} instance; the open panel refetches WITHOUT a
	// reload and shows the bumped line.
	const bumped = await page.request.post(
		`${server.url}/v1/ext/fixture-surfaces-e2e/bump`,
		{ data: { conversationId: b } },
	);
	expect(bumped.ok()).toBe(true);
	await expect(panel).toContainText(`conversation ${b} bump 1`);
});
