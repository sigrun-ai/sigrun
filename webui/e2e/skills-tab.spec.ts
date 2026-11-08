/**
 * Tabs+skills Task 12 (e2e): the Skills TAB end to end in a real
 * browser — the `core/skills` view on the `#/ext/core/skills` tab.
 *
 * The flow: open Skills → *New skill* → Workspace → save → the skill
 * appears and its history shows ONE commit by `tester`; edit it → the
 * history shows TWO and a diff opens; on a Pixel 7 viewport the list
 * shows first and the back arrow returns to it.
 */

import { expect, test, devices } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer();
});

test.afterAll(async () => {
	await server.cleanup();
});

test("Skills tab: create a workspace skill, see it + its one-commit history, edit it, see two + a diff", async ({
	browser,
}) => {
	const context = await browser.newContext({
		extraHTTPHeaders: { "x-sigrun-user": "tester" },
	});
	const page = await context.newPage();
	try {
		await page.goto(server.url);
		const railTab = page.locator('[data-rail-section="skills"]');
		await expect(railTab).toBeVisible();
		await railTab.click();
		await expect(page).toHaveURL(/#\/ext\/core\/skills/);

		// New skill → the form (params {edit:true}).
		await page.getByRole("button", { name: "New skill" }).click();
		await expect(page).toHaveURL(/edit/);
		// No Where choice (new skills land in the workspace; learned is the
		// curator's), then name/description/body (aria-labels are labels).
		await expect(page.getByRole("radio", { name: "Learned" })).toHaveCount(0);
		await page.getByRole("textbox", { name: "Name" }).fill("acme-e2e-skill");
		await page.getByRole("textbox", { name: "Description" }).fill("the e2e skill");
		await page.getByRole("textbox", { name: "Body" }).fill("The e2e body.");
		await page.getByRole("button", { name: "Create" }).click();

		// The skill appears, selected, with its body and ONE history row by tester.
		const main = page.locator('[data-page-region="main"]');
		await expect(main).toContainText("acme-e2e-skill");
		await expect(main).toContainText("The e2e body.");
		await expect(page).toHaveURL(/acme-e2e-skill/);
		// The history section's rows (a section's DOM id is not its block
		// id — scope by the heading text instead).
		const historySection = main.locator("section", { has: page.locator(".blk-section-title", { hasText: "History" }) });
		const historyRows = historySection.locator(".blk-list-card");
		await expect(historyRows).toHaveCount(1);
		await expect(historyRows.first()).toContainText("create acme-e2e-skill");
		await expect(historyRows.first()).toContainText("tester");
		// Every row carries at most its own Review button; these workspace
		// commits have no curator review, so the bound button hides.
		await expect(historyRows.first().getByRole("button", { name: "Review" })).toHaveCount(0);

		// Edit it: the form pre-fills (name read-only), save, TWO history rows.
		await page.getByRole("button", { name: "Edit" }).click();
		await expect(page.getByRole("textbox", { name: "Name" })).toBeDisabled();
		await page.getByRole("textbox", { name: "Body" }).fill("The e2e body, edited.");
		await page.getByRole("button", { name: "Save" }).click();
		await expect(historyRows).toHaveCount(2);
		await expect(historyRows.first()).toContainText("edit acme-e2e-skill");
		await expect(historyRows.nth(1).getByRole("button", { name: "Review" })).toHaveCount(0);

		// Open the newest commit: its diff is immediately below that row,
		// before the remaining history collection (not below the full list).
		await historyRows.first().click();
		const diff = main.locator(".blk-diff");
		await expect(diff.first()).toBeVisible();
		await expect(diff.first()).toContainText("edited");
		await expect(historySection.locator(".blk-diff")).toHaveCount(1);
		const historyOrder = await historySection.locator(".blk-list-card, .blk-diff").evaluateAll((nodes) =>
			nodes.map((node) => (node.classList.contains("blk-diff") ? "diff" : "row")),
		);
		expect(historyOrder).toEqual(["row", "diff", "row"]);
		await expect(historySection.locator(".blk-section-title", { hasText: /^Commit / })).toHaveCount(0);
	} finally {
		await context.close();
	}
});

test("Skills tab on Pixel 7: the list shows first and the back arrow returns", async ({
	browser,
}) => {
	const context = await browser.newContext({
		...devices["Pixel 7"],
		extraHTTPHeaders: { "x-sigrun-user": "tester" },
	});
	const page = await context.newPage();
	try {
		await page.goto(`${server.url}/#/ext/core/skills`);
		// Compact: the list (sidebar) shows first.
		const sidebar = page.locator('[data-page-region="sidebar"]');
		await expect(sidebar).toBeVisible();
		// Activate the e2e skill (created in the previous test — the boot
		// is shared): main drills in (selection.selected).
		const row = sidebar.locator(".blk-list-card", { hasText: "acme-e2e-skill" }).first();
		await expect(row).toBeVisible();
		await row.click();
		const main = page.locator('[data-page-region="main"]');
		await expect(main).toContainText("acme-e2e-skill");
		// The back arrow returns to the list.
		await main.getByRole("button").first().click();
		await expect(sidebar).toBeVisible();
	} finally {
		await context.close();
	}
});
