/**
 * Task 26b-ii (refreshed B7): the seven simpler ship-gate checklist items
 * (spec §7 M2 items 1, 2, 5, 6, 8, 9, 11), driven against the proven
 * harness (T26b-i). Items 3 (steer), 4 (interactions), 7 (compaction recall),
 * 10 (restart resume) are T26b-iii — they need special server setup.
 *
 * Selectors ride the B2-B6 stable hooks: the sidebar's per-row ⋯ menu (the
 * old `.session-archive` button is gone), the composer's model picker
 * popover (`[data-picker="model"]` + `data-model-id` options — the old
 * `select.composer-model` is gone), the transcript's turn roots
 * (`[data-turn-kind]`) and tool rows (`.tool-row-*`, inside the expanded
 * activity line), the header's panel toggles, and the settings dialog's
 * Interface section (the theme surface the old `.theme-toggle` served).
 * Each spec boots its own E2E server (hermetic tmpdir + ephemeral port).
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

		// Switch back to the root: the active row changes (the newer
		// conversation sorts first in the Today group).
		const items = list.locator(".session-item");
		await items.nth(1).click();
		await expect(items.nth(1)).toHaveClass(/session-item-active/);

		// Archive the newest conversation (not the active root) through its
		// row menu (B3: the ⋯ menu's Archive item — the old one-click
		// .session-archive button is gone). Archived rows leave the default
		// list; the Archived toggle brings them back with their marker.
		const newest = items.nth(0);
		await newest.locator(".session-menu-toggle").click();
		await newest
			.locator('.session-menu [data-menu-action="archive"]')
			.click();
		await expect(list.locator(".session-item")).toHaveCount(1);
		await page.locator(".session-archived-toggle").click();
		await expect(list.locator(".session-item")).toHaveCount(2);
		await expect(items.nth(0)).toHaveClass(/session-item-archived/);
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
			// The spec counts faux responses per submission; A2's background
			// auto-namer would otherwise consume one after the first settled
			// run. Naming has its own vitest coverage (test/naming.test.ts).
			settingsFile: { namingModel: false },
		});
		// The image upload path carries the image buffer in the request (the
		// setInputFiles payload), not a workspace file — no workspace setup
		// needed for this item.
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
			page.locator('[data-turn-kind="assistant"]').filter({
				hasText: "text answer",
			}),
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
			page.locator('[data-turn-kind="assistant"]').filter({
				hasText: "image answer",
			}),
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
		// The picker is visible (multi-model harness). B6: a pill + popover
		// list (the old select.composer-model is gone).
		const picker = page.locator('[data-picker="model"]');
		await expect(picker).toBeVisible();
		await picker.click();
		await page.locator('[data-model-id="faux/m2"]').click();
		// The pill echoes the pick (name or id — both name the model).
		await expect(picker).toContainText("m2");

		// An outside click closes the popover without picking (B7 polish:
		// useDismiss on the pickers/menus).
		await picker.click();
		await expect(page.locator(".composer-picker-menu")).toHaveCount(1);
		await page.locator(".chat-center").click({
			position: { x: 8, y: 8 },
		});
		await expect(page.locator(".composer-picker-menu")).toHaveCount(0);

		await page.locator(".composer-input").fill("on m2");
		await expect(page.locator(".composer-send")).toBeEnabled();
		await page.locator(".composer-send").click();
		await expect(
			page.locator('[data-turn-kind="assistant"]').filter({
				hasText: "picked m2",
			}),
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
		// B4: the tool call renders as the activity line under the assistant
		// turn; expanding it shows the tool row (the old always-rendered
		// tool card is gone), and expanding THAT shows the output.
		const activity = page.locator(".activity-toggle").first();
		await expect(activity).toBeVisible();
		await activity.click();
		const toolRow = page.locator(".tool-row-toggle").first();
		await expect(toolRow).toBeVisible();
		await toolRow.click();
		await expect(page.locator(".tool-row-output").first()).toBeVisible();
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
		// B2: the workspace browser lives in the right panel, opened by the
		// header's workspace toggle (it starts closed). Button-scoped: the
		// open panel's aside carries the same data-panel value.
		await page.locator('button[data-panel="workspace"]').click();
		// The workspace tree lists the root.
		const tree = page.locator(".workspace-tree");
		await expect(
			tree.locator(".workspace-file").filter({ hasText: "readme.md" }),
		).toBeVisible();
		// Click the file → the preview shows its content.
		await tree
			.locator(".workspace-file")
			.filter({ hasText: "readme.md" })
			.click();
		await expect(page.locator(".file-preview-content")).toContainText(
			"workspace readme",
		);
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

	test("pick light mode + a palette + an accent in settings; they apply at once", async ({
		page,
	}) => {
		await page.goto(server.url);
		// B2+B7: the theme surface is the settings dialog's Interface
		// section (the old header .theme-toggle + data-theme attribute are
		// gone). Picks apply immediately via data-mode/palette/accent.
		await page.getByRole("button", { name: "settings" }).click();
		const dialog = page.getByRole("dialog", { name: "settings" });
		await dialog
			.getByRole("button", { name: "Interface" })
			.click();

		const root = page.locator("html");
		// Both explicit modes are exercised — at least one differs from any
		// initial system resolution, so neither assertion is vacuous.
		await dialog.locator('[data-mode-option="dark"]').click();
		await expect(root).toHaveAttribute("data-mode", "dark");
		await dialog.locator('[data-mode-option="light"]').click();
		await expect(root).toHaveAttribute("data-mode", "light");
		await dialog.locator('[data-palette-option="fjord"]').click();
		await expect(root).toHaveAttribute("data-palette", "fjord");
		await expect(root).toHaveAttribute("data-mode", "light");
		await dialog.locator('[data-accent-option="lichen"]').click();
		await expect(root).toHaveAttribute("data-accent", "lichen");

		// The picks persist in localStorage (the reload re-applies them).
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
		await expect(page.locator("html")).toHaveAttribute(
			"data-palette",
			"fjord",
		);
		await expect(page.locator("html")).toHaveAttribute(
			"data-accent",
			"lichen",
		);
	});
});

// ---------------------------------------------------------------------------
// Item 11: degraded surfaces appear in GET /v1/meta.
// ---------------------------------------------------------------------------
test.describe("item 11: degraded surfaces", () => {
	let server: E2EServer;
	test.beforeAll(async () => {
		server = await bootE2EServer(); // no backup config → the meta says so
	});
	test.afterAll(async () => {
		await server.cleanup();
	});

	test("the unconfigured backup surfaces on the rail health dot", async ({
		page,
	}) => {
		await page.goto(server.url);
		// B2: the old header badge row collapsed into the rail's health dot
		// — its title carries the meta's health surfaces (backup status
		// included). An unconfigured backup is reported health, not
		// degraded (v1 has no runtime backup signal).
		const dot = page.locator(".rail-health");
		await expect(dot).toHaveAttribute("data-health", "ok");
		await expect(dot).toHaveAttribute("title", /backup: unconfigured/);
	});
});
