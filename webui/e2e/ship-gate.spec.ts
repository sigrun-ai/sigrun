/**
 * Task 26b-ii: the seven simpler ship-gate checklist items (spec §7 M2 items
 * 1, 2, 5, 6, 8, 9, 11), driven against the proven harness (T26b-i).
 * Items 3 (steer), 4 (approvals), 7 (compaction recall), 10 (restart resume)
 * are T26b-iii — they need special server setup.
 *
 * Selectors come from the components (composer-*, session-*, workspace-*,
 * theme-toggle, entry-*, tool-card-*). Each spec boots its own E2E server
 * (hermetic tmpdir + ephemeral port).
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { bootE2EServer, type E2EServer } from "./harness.js";

test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// Item 1: start a second session; switch between sessions; archive one.
// ---------------------------------------------------------------------------
test.describe("item 1: sessions", () => {
	let server: E2EServer;
	test.beforeAll(async () => {
		server = await bootE2EServer();
	});
	test.afterAll(async () => {
		await server.cleanup();
	});

	test("start a second session, switch, archive one", async ({ page }) => {
		await page.goto(server.url);
		// The root conversation is listed.
		const list = page.locator(".session-list");
		await expect(list.locator(".session-item")).toHaveCount(1);

		// New session.
		await page.locator(".session-new").click();
		await expect(list.locator(".session-item")).toHaveCount(2);

		// Switch back to the root: the active row changes.
		const items = list.locator(".session-item");
		await items.first().click();
		await expect(items.first()).toHaveClass(/session-item-active/);

		// Archive the second conversation.
		await items.nth(1).locator(".session-archive").click();
		await expect(items.nth(1)).toHaveClass(/session-item-archived/);
	});
});

// ---------------------------------------------------------------------------
// Item 2: send a text message; send an image.
// ---------------------------------------------------------------------------
test.describe("item 2: send text + image", () => {
	let server: E2EServer;
	test.beforeAll(async () => {
		server = await bootE2EServer({
			responses: [
				fauxAssistantMessage("text answer"),
				fauxAssistantMessage("image answer"),
			],
		});
		// A file in the workspace for the image upload to reference.
		await writeFile(
			join(server.workspaceDir, "dot.png"),
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
				"base64",
			),
		);
	});
	test.afterAll(async () => {
		await server.cleanup();
	});

	test("send a text message and an image", async ({ page }) => {
		await page.goto(server.url);
		// Wait for the boot-time default selection + the draft restore to
		// settle (the composer goes live once a conversation is active).
		await expect(page.locator(".composer-input")).toBeEnabled();
		// Text message.
		await page.locator(".composer-input").fill("hello");
		await expect(page.locator(".composer-send")).toBeEnabled();
		await page.locator(".composer-send").click();
		await expect(
			page.locator(".entry-user").filter({ hasText: "hello" }),
		).toBeVisible();
		await expect(
			page.locator(".entry-assistant").filter({ hasText: "text answer" }),
		).toBeVisible();

		// An image via the upload → attach → submit path. Set the file input.
		const fileInput = page.locator(".composer-file-input");
		await fileInput.setInputFiles({
			name: "dot.png",
			mimeType: "image/png",
			buffer: Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
				"base64",
			),
		});
		// The attachment tray shows the chip.
		await expect(page.locator(".composer-attachment")).toHaveCount(1);
		await page.locator(".composer-input").fill("look");
		await expect(page.locator(".composer-send")).toBeEnabled();
		await page.locator(".composer-send").click();
		await expect(
			page.locator(".entry-assistant").filter({ hasText: "image answer" }),
		).toBeVisible();
	});
});

// ---------------------------------------------------------------------------
// Item 5: pick a model from the catalog.
// ---------------------------------------------------------------------------
test.describe("item 5: model picker", () => {
	let server: E2EServer;
	test.beforeAll(async () => {
		server = await bootE2EServer({
			responses: [fauxAssistantMessage("picked m2")],
		});
	});
	test.afterAll(async () => {
		await server.cleanup();
	});

	test("pick a model and submit on it", async ({ page }) => {
		await page.goto(server.url);
		// The picker is visible (multi-model harness).
		const picker = page.locator(".composer-model");
		await expect(picker).toBeVisible();
		await picker.selectOption("faux/m2");
		await page.locator(".composer-input").fill("on m2");
		await expect(page.locator(".composer-send")).toBeEnabled();
		await page.locator(".composer-send").click();
		await expect(
			page.locator(".entry-assistant").filter({ hasText: "picked m2" }),
		).toBeVisible();
	});
});

// ---------------------------------------------------------------------------
// Item 6: read a tool card (expand, see output).
// ---------------------------------------------------------------------------
test.describe("item 6: tool card", () => {
	let server: E2EServer;
	test.beforeAll(async () => {
		server = await bootE2EServer({
			responses: [
				fauxAssistantMessage(
					[
						{ type: "text", text: "loading a skill" },
						fauxToolCall("load_skill", { name: "demo" }, { id: "call-1" }),
					],
					// toolUse: the run executes the tool (a "stop" message would end
					// the turn without running it).
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("the skill says hello"),
			],
		});
		await writeFile(
			join(server.workspaceDir, "notes.txt"),
			"hello from the workspace",
			"utf8",
		);
	});
	test.afterAll(async () => {
		await server.cleanup();
	});

	test("expand a tool card and see the output", async ({ page }) => {
		await page.goto(server.url);
		// Wait for the boot-time default selection + the draft restore to
		// settle (the composer goes live once a conversation is active).
		await expect(page.locator(".composer-input")).toBeEnabled();
		await page.locator(".composer-input").fill("read notes.txt");
		await expect(page.locator(".composer-send")).toBeEnabled();
		await page.locator(".composer-send").click();
		// The tool card renders; expand it; the output shows.
		const card = page.locator(".tool-card-header").first();
		await expect(card).toBeVisible();
		await card.click();
		await expect(page.locator(".tool-card-output").first()).toBeVisible();
	});
});

// ---------------------------------------------------------------------------
// Item 8: workspace panel — list a directory; read a file.
// ---------------------------------------------------------------------------
test.describe("item 8: workspace browser", () => {
	let server: E2EServer;
	test.beforeAll(async () => {
		server = await bootE2EServer();
		await writeFile(
			join(server.workspaceDir, "readme.md"),
			"# workspace readme",
			"utf8",
		);
	});
	test.afterAll(async () => {
		await server.cleanup();
	});

	test("list a directory and read a file", async ({ page }) => {
		await page.goto(server.url);
		// The workspace tree lists the root.
		const tree = page.locator(".workspace-tree");
		await expect(tree.locator(".workspace-file").filter({ hasText: "readme.md" })).toBeVisible();
		// Click the file → the preview shows its content.
		await tree.locator(".workspace-file").filter({ hasText: "readme.md" }).click();
		await expect(
			page.locator(".file-preview-content"),
		).toContainText("workspace readme");
	});
});

// ---------------------------------------------------------------------------
// Item 9: switch theme.
// ---------------------------------------------------------------------------
test.describe("item 9: theme", () => {
	let server: E2EServer;
	test.beforeAll(async () => {
		server = await bootE2EServer();
	});
	test.afterAll(async () => {
		await server.cleanup();
	});

	test("toggle light/dark", async ({ page }) => {
		await page.goto(server.url);
		const root = page.locator("html");
		const before = await root.getAttribute("data-theme");
		await page.locator(".theme-toggle").click();
		const after = await root.getAttribute("data-theme");
		expect(after).not.toBe(before);
	});
});

// ---------------------------------------------------------------------------
// Item 11: degraded surfaces appear in GET /v1/meta.
// ---------------------------------------------------------------------------
test.describe("item 11: degraded surfaces", () => {
	let server: E2EServer;
	test.beforeAll(async () => {
		server = await bootE2EServer(); // no backup config → the badge shows
	});
	test.afterAll(async () => {
		await server.cleanup();
	});

	test("the unconfigured-backup badge is visible", async ({ page }) => {
		await page.goto(server.url);
		await expect(
			page.locator("header.top-bar .badge").filter({ hasText: "backup" }),
		).toBeVisible();
	});
});
