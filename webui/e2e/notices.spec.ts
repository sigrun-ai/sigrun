/**
 * Notices Task 7 e2e: the full desktop + phone + multi-user notices loop
 * against the real server with `fixture-notices-e2e` loaded (an
 * extension HTTP route that posts a notice to the calling principal, and
 * the `ack` notice action answering {ok:true, message:"acked"}).
 *
 * Legs (the task-7 brief, verbatim):
 * - desktop: a notice posts → the peek appears and folds into the bell
 *   count 1 → open the pane → click Ack → "acked" then gone → count 0;
 * - a conversation notice shows inline; sending a prompt in that
 *   conversation clears it;
 * - Pixel 7: the bell is in the header, the pane is a full-height sheet,
 *   the peek is a slim strip;
 * - a second browser context as bob never shows alice's notice (bob is
 *   seeded as a real directory user first — a record-less principal
 *   would pass vacuously; the assertion pins alice's notice ID).
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { devices, expect, test } from "@playwright/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { bootE2EServer, type E2EServer } from "./harness.js";

/** The e2e fixture (the post route + the ack action). */
const FIXTURE = pathToFileURL(
	join(
		import.meta.dirname,
		"..",
		"..",
		"test",
		"fixtures",
		"fixture-notices-e2e",
		"index.js",
	),
).href;

let server: E2EServer;
/** The seeded admin's bearer (tokenAuth boots authenticate per request). */
let testerToken: string;

test.beforeAll(async () => {
	server = await bootE2EServer({
		responses: [fauxAssistantMessage("ok")],
		extensionSpecifiers: [FIXTURE],
		tokenAuth: true,
	});
	testerToken = await server.tokenFor("tester");
});

test.afterAll(async () => {
	await server.cleanup();
});

/** Post a notice to the calling user through the fixture route. */
async function postNotice(
	page: import("@playwright/test").Page,
	input: Record<string, unknown>,
): Promise<{ id: string }> {
	const response = await page.evaluate(async (body) => {
		const reply = await fetch("/v1/ext/fixture-notices-e2e/post", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return { status: reply.status, body: await reply.json() };
	}, input);
	expect(response.status).toBe(200);
	return response.body as { id: string };
}

test("desktop: a notice peeks, folds into the bell, and Ack clears it", async ({
	browser,
}) => {
	const context = await browser.newContext({
		extraHTTPHeaders: { authorization: `Bearer ${testerToken}` },
	});
	const page = await context.newPage();
	await page.setViewportSize({ width: 1600, height: 900 });
	await page.goto(server.url);
	await expect(page.locator("li.session-item-active")).toHaveCount(1);

	// Post an app-wide notice with the fixture's ack action.
	await postNotice(page, {
		title: "Alice reminder",
		body: "drink water",
		actions: [{ id: "ack", label: "Ack", kind: "extension", name: "ack" }],
	});

	// The peek slides in (the notice.changed frame bumps the refetch).
	const peek = page.locator(".notice-peek");
	await expect(peek).toBeVisible();
	await expect(peek).toContainText("Alice reminder");

	// It folds after 6 s (no hover) — the bell carries the count. The
	// DESKTOP bell is the rail's copy (the chat header's bell is
	// CSS-hidden at this width but still in the DOM — scope to the rail).
	await expect(peek).not.toBeVisible({ timeout: 10_000 });
	const bell = page.locator('.rail [data-rail-section="notices"]');
	await expect(bell.locator('[data-bell-count="1"]')).toBeVisible();

	// Open the pane (the Chats tab docks it in the right panel).
	await bell.click();
	const pane = page.locator(".notices-pane");
	await expect(pane).toBeVisible();
	await expect(pane).toContainText("Alice reminder");

	// Click Ack → the card flashes "acked", then the notice is gone.
	await pane.getByRole("button", { name: "Ack" }).click();
	await expect(pane.locator(".notice-card-result")).toContainText("acked");
	await expect(pane).not.toContainText("Alice reminder", { timeout: 10_000 });
	await expect(pane).toContainText("No notices");
	await expect(bell.locator(".rail-bell-badge")).toHaveCount(0);

	await context.close();
});

test("a conversation notice shows inline and a prompt in it clears it", async ({
	browser,
}) => {
	const context = await browser.newContext({
		extraHTTPHeaders: { authorization: `Bearer ${testerToken}` },
	});
	const page = await context.newPage();
	await page.setViewportSize({ width: 1600, height: 900 });
	await page.goto(server.url);
	await expect(page.locator("li.session-item-active")).toHaveCount(1);

	// The active conversation's id: the harness hands the root
	// conversation's id (the sidebar's selected row).
	const conversationId = server.conversationId;

	// A conversation notice: NO peek (the conversation is on screen) —
	// it renders in the inline strip above the composer.
	await postNotice(page, {
		title: "About this chat",
		conversationId,
	});
	const inline = page.locator(".inline-notices");
	await expect(inline).toBeVisible();
	await expect(inline).toContainText("About this chat");
	await expect(page.locator(".notice-peek")).toHaveCount(0);

	// Sending a prompt in that conversation clears its notices.
	await expect(page.locator(".composer-input")).toBeEnabled();
	await page.locator(".composer-input").fill("hello");
	await page.locator(".composer-send").click();
	await expect(page.locator(".chat-center")).toContainText("ok", {
		timeout: 20_000,
	});
	await expect(inline).not.toBeVisible({ timeout: 10_000 });

	await context.close();
});

test("pixel 7: bell in the header, pane a full-height sheet, peek a strip", async ({
	browser,
}) => {
	const context = await browser.newContext({
		...devices["Pixel 7"],
		extraHTTPHeaders: { authorization: `Bearer ${testerToken}` },
	});
	const page = await context.newPage();
	await page.goto(server.url);
	await expect(page.locator("li.session-item-active")).toHaveCount(1);

	// The desktop rail is hidden on phones; the bell lives in the chat
	// header instead.
	await expect(page.locator(".rail")).not.toBeVisible();
	const headerBell = page.locator(
		'.chat-header [data-rail-section="notices"]',
	);
	await expect(headerBell).toBeVisible();

	// Post → the peek is a slim strip under the header.
	const { id } = await postNotice(page, { title: "Phone notice" });
	const peek = page.locator(".notice-peek");
	await expect(peek).toBeVisible();
	await expect(peek).toContainText("Phone notice");
	const viewport = page.viewportSize();
	expect(viewport).not.toBeNull();
	const peekBox = await peek.boundingBox();
	expect(peekBox).not.toBeNull();
	// A slim strip: full width under the header, no floating card.
	expect(peekBox?.x).toBeLessThanOrEqual(1);
	expect((peekBox?.x ?? 0) + (peekBox?.width ?? 0)).toBeGreaterThanOrEqual(
		(viewport?.width ?? 0) - 1,
	);
	await page.screenshot({ path: "/tmp/notices-shots/pixel7-peek.png" });

	// Fold it (hover is a desktop affordance — wait out the 6 s window).
	await expect(peek).not.toBeVisible({ timeout: 10_000 });

	// The header bell carries the count; tapping it opens the pane as a
	// full-height sheet (below the header, above the bottom bar).
	await expect(headerBell.locator('[data-bell-count="1"]')).toBeVisible();
	await headerBell.click();
	const pane = page.locator(".notices-pane");
	await expect(pane).toBeVisible();
	await expect(pane).toContainText("Phone notice");
	const paneBox = await pane.boundingBox();
	expect(paneBox).not.toBeNull();
	// Full height: the sheet spans from the header down to the bottom bar
	// (the viewport minus both bars' heights, generous bounds).
	expect((paneBox?.height ?? 0) >= (viewport?.height ?? 0) - 120).toBe(true);
	await page.screenshot({ path: "/tmp/notices-shots/pixel7-pane.png" });

	// The sheet is FULL WIDTH at this viewport — there is no "outside"
	// to tap. The phone's close affordance is the bell toggle: tapping
	// the bell again closes the sheet.
	await headerBell.click();
	await expect(pane).not.toBeVisible();
	// The posted notice is untouched by the pane chrome: the bell still
	// carries it (the count is the pile's size).
	await expect(headerBell.locator('[data-bell-count="1"]')).toBeVisible();
	await expect(
		page.locator(`[data-notice-id="${id}"]`),
	).toHaveCount(0);

	// The bell is in the shell on EVERY tab (spec §6): Settings carries
	// the phone-header bell too (the rail hides at this width).
	await page.goto(`${server.url}/#/settings`);
	await expect(
		page.locator('.phone-header [data-rail-section="notices"]'),
	).toBeVisible();
	// …and the Settings bell opens the overlay sheet with the notice.
	await page.locator('.phone-header [data-rail-section="notices"]').click();
	await expect(
		page.locator(`.notices-pane [data-notice-id="${id}"]`),
	).toBeVisible();

	await context.close();
});

test("bob never sees alice's notice", async ({ browser }) => {
	// Seed bob BEFORE his context loads — a record-less principal would
	// pass the never-assertion vacuously.
	await server.opened.identity.users.add({
		user: "bob",
		admin: false,
		source: "cli",
	});

	const aliceContext = await browser.newContext({
		extraHTTPHeaders: { authorization: `Bearer ${testerToken}` },
	});
	const bobContext = await browser.newContext({
		extraHTTPHeaders: {
			"x-sigrun-user": "bob",
			authorization: `Bearer ${await server.tokenFor("bob")}`,
		},
	});
	const alice = await aliceContext.newPage();
	const bob = await bobContext.newPage();
	await alice.setViewportSize({ width: 1600, height: 900 });
	await bob.setViewportSize({ width: 1600, height: 900 });
	await alice.goto(server.url);
	await bob.goto(server.url);
	await expect(alice.locator("li.session-item-active")).toHaveCount(1);

	// Alice posts herself a notice; its id is the assertion's anchor.
	const { id } = await postNotice(alice, { title: "For alice only" });
	await expect(alice.locator(".notice-peek")).toContainText("For alice only");

	// Bob's pile is empty: no peek, no badge, and the pane (opened via
	// the bell) shows the empty state — and never alice's notice id.
	await expect(bob.locator(".notice-peek")).toHaveCount(0);
	await expect(
		bob.locator('.rail [data-rail-section="notices"] .rail-bell-badge'),
	).toHaveCount(0);
	await bob.locator('.rail [data-rail-section="notices"]').click();
	await expect(bob.locator(".notices-pane")).toContainText("No notices");
	await expect(bob.locator(`[data-notice-id="${id}"]`)).toHaveCount(0);

	await aliceContext.close();
	await bobContext.close();
});
