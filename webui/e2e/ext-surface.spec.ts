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
	// The card now sits in the "doing" lane: switch the compact lane
	// switcher to "doing" to confirm.
	await alice.locator('select[aria-label="Lane"]').selectOption("doing");
	await expect(
		alice.locator('[data-lane="doing"] [data-drag-item="c1"]'),
	).toBeVisible();

	// Bob's context reflects the move within 2 s: the surface.changed
	// event reached his stream, the since fetch returned the shared
	// board with c1 moved.
	await bob.locator('select[aria-label="Lane"]').selectOption("doing");
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

test("the stats panel registers one right-panel tab", async ({ page }) => {
	await page.goto(server.url);
	// The panel tabs render on the right panel (one per declared panel).
	const tab = page.locator('[data-panel-tab="ext:fixture-surfaces-e2e/stats"]');
	await expect(tab).toBeVisible();
});
