import { expect, test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer({ builtins: true, auth: { claimed: true } });
});

test.afterAll(async () => {
	await server.cleanup();
});

test("switching extension pages through the nav saves the new page's own values", async ({ page }) => {
	const login = await server.opened.identity.tokens.create("nav-e2e", "tester");
	await page.goto(server.url);
	await page.evaluate(async (token) => {
		const response = await fetch("/v1/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token }),
		});
		if (!response.ok) throw new Error(`login ${response.status}`);
	}, login.token);
	await page.goto(server.url);
	await page.goto(`${server.url}/#/settings/my:sigrun-mcp`);
	const mcpPage = page.locator("[data-extension-page=sigrun-mcp]");
	await expect(
		mcpPage.locator("[data-extension-part='user-settings'] .blk-form"),
	).toBeVisible();
	await expect(page).toHaveURL(/#\/settings\/my:sigrun-mcp$/);

	// Switch to the curator extension's personal page via My-settings nav.
	const personalNav = page.getByRole("group", { name: "My Settings", exact: true });
	await personalNav.locator(".settings-nav-extension[data-ext=curator]").click();
	const curatorPage = page.locator("[data-extension-page=curator]");
	await expect(page).toHaveURL(/#\/settings\/my(?::|%3A)curator$/);
	await expect(curatorPage).toBeVisible();
	await expect(curatorPage.locator("[data-extension-part='user-settings']")).toBeVisible();
	await expect(curatorPage.locator("[data-extension-part='settings']")).toHaveCount(0);
	// `paused` and `idleModel` are overridable: each renders an InheritRow
	// fragment whose <label> holding `.blk-field-inherit` is the immediate
	// previous sibling of the field's FieldRow div. While inherit is checked
	// the field input is disabled and displays the system value; uncheck
	// both toggles so the controls become editable.
	const pausedInherit = curatorPage
		.locator("[data-name='paused']")
		.locator("xpath=preceding-sibling::label[1]")
		.locator(".blk-field-inherit");
	const idleModelInherit = curatorPage
		.locator("[data-name='idleModel']")
		.locator("xpath=preceding-sibling::label[1]")
		.locator(".blk-field-inherit");
	await expect(pausedInherit).toBeChecked();
	await expect(idleModelInherit).toBeChecked();
	await expect(curatorPage.locator("[data-name='paused'] input")).toBeDisabled();
	await expect(curatorPage.locator("[data-name='paused'] input")).not.toBeChecked();
	const idleModel = curatorPage.locator("[data-name='idleModel'] input[role='combobox']");
	await expect(idleModel).toBeDisabled();
	await expect(idleModel).toHaveValue("Use the default (faux/m)");
	await pausedInherit.uncheck();
	await idleModelInherit.uncheck();
	await expect(curatorPage.locator("[data-name='paused'] input")).toBeEnabled();
	await expect(idleModel).toBeEnabled();
	await curatorPage.locator("[data-name='paused'] input").check();
	// Select the existing faux option; the allow-other text input remains
	// empty, so the submitted field is a plain model id.
	await idleModel.fill("faux/m");
	await curatorPage.getByRole("option", { name: "faux/m · ext-faux", exact: true }).click();
	await curatorPage
		.locator("[data-extension-part='user-settings']")
		.getByRole("button", { name: "Save" })
		.click();
	await expect(page.locator(".blk-field-error")).toHaveCount(0);

	const userSettingsResponse = await page.request.fetch(`${server.url}/v1/ext/curator/surfaces/user-settings`);
	expect(userSettingsResponse.ok()).toBe(true);
	const body = (await userSettingsResponse.json()) as { data?: { settings?: { paused?: boolean } } };
	expect(body.data?.settings?.paused).toBe(true);

	// Switch back to sigrun-mcp and save its freshly loaded personal form.
	await personalNav.locator(".settings-nav-extension[data-ext=sigrun-mcp]").click();
	await expect(page).toHaveURL(/#\/settings\/my(?::|%3A)sigrun-mcp$/);
	await expect(
		mcpPage.locator("[data-extension-part='user-settings'] .blk-form"),
	).toBeVisible();
	await mcpPage
		.locator("[data-extension-part='user-settings']")
		.getByRole("button", { name: "Save" })
		.click();
	await expect(page.locator(".blk-field-error")).toHaveCount(0);
});
