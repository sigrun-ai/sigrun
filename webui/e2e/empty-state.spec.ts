/**
 * Task 6 (the composer is live with no conversation): the empty-state e2e.
 *
 * A real server ALWAYS ensures the reserved root conversation at boot, so a
 * genuine zero-conversation deployment is not reachable against the real
 * harness. The empty state is driven at the WIRE instead: the browser's
 * FIRST `GET /v1/conversations` (the app boot's list load) is answered with
 * an empty list, which is exactly what a fresh server with no conversations
 * would say — the boot-time default-select finds no row, so the app stays in
 * the empty state. Every later list fetch passes through untouched, so the
 * conversation the first send creates shows up in the sidebar through the
 * real events-stream refetch path.
 *
 * Then the full first-send flow runs against the REAL server: type → send →
 * create + submit → the answer streams into the new conversation → the
 * sidebar lists it.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";

const SCREENSHOT_PATH = fileURLToPath(
	new URL("../test-results/task-6-empty-state.png", import.meta.url),
);

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer();
});

test.afterAll(async () => {
	await server.cleanup();
});

test("first send with no conversation creates one, streams the answer, and lists it", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (cause) => pageErrors.push(String(cause)));

	// The zero-conversation boot: the FIRST list load answers empty (every
	// later one passes through — the created conversation must appear).
	let listLoads = 0;
	await page.route("**/v1/conversations", (route) => {
		if (route.request().method() !== "GET") {
			return route.fallback();
		}
		listLoads += 1;
		if (listLoads === 1) {
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ conversations: [] }),
			});
		}
		return route.fallback();
	});

	await page.goto(server.url);

	// The empty state: the welcome copy + a LIVE composer (no disabled
	// textarea, the normal placeholder).
	await expect(page.locator(".chat-empty")).toHaveText(
		"Start a conversation — type below.",
	);
	const textarea = page.locator("textarea.composer-input");
	await expect(textarea).toBeEnabled();
	await expect(textarea).toHaveAttribute("placeholder", "Message…");

	// Typing "/" opens no slash menu (commands are conversation-scoped).
	await textarea.fill("/");
	await expect(page.locator("ul.composer-command-menu")).toHaveCount(0);
	await textarea.fill("");

	// First send: type → click Send → the conversation is created, the text
	// submitted into it, and the app navigates there.
	await textarea.fill("hello empty world");
	await page.locator("button.composer-send").click();

	// The app navigated into the created conversation and the answer
	// streamed in (the faux provider's canned reply).
	await expect(page.locator(".chat-center")).toContainText("hello empty world", {
		timeout: 15_000,
	});
	await expect(page.locator(".chat-center")).toContainText("e2e answer");
	await expect(textarea).toHaveValue("");

	// The conversation appears in the sidebar (the real list refetch — the
	// route stopped intercepting after the first load): the reserved root
	// (which the real server always creates at boot) plus the NEW row, and
	// the new row is the selected one.
	const created = page.locator("li.session-item-active");
	await expect(created).toHaveCount(1, { timeout: 15_000 });
	const createdId = await created.getAttribute("data-conversation-id");
	expect(createdId).not.toBeNull();
	expect(Number(createdId)).not.toBe(server.conversationId);
	// The row exists in the (now un-intercepted) list with that id.
	await expect(
		page.locator(`li.session-item[data-conversation-id="${createdId}"]`),
	).toHaveCount(1);

	await mkdir(dirname(SCREENSHOT_PATH), { recursive: true });
	await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });

	expect(pageErrors).toEqual([]);
});
