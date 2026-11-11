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
	await page.goto(`${server.url}/#/settings/sigrun-mcp`);
	await expect(
		page.locator("[data-extension-page=sigrun-mcp] [data-extension-part='user-settings'] .blk-form"),
	).toBeVisible();

	// Switch to the curator extension page via the nav.
	await page.locator(".settings-nav-extension[data-ext=curator]").click();
	const curatorPage = page.locator("[data-extension-page=curator]");
	await expect(curatorPage).toBeVisible();
	await curatorPage.locator("[data-name='paused'] input").check();
	// The idleModel field has minLength 1; fill it so the save isn't blocked.
	await curatorPage.locator("[data-name='idleModel'] input").fill("faux/m");
	await curatorPage
		.locator("[data-extension-part='user-settings']")
		.getByRole("button", { name: "Save" })
		.click();
	await expect(page.locator(".blk-field-error")).toHaveCount(0);

	const userSettingsResponse = await page.request.fetch(`${server.url}/v1/ext/curator/surfaces/user-settings`);
	expect(userSettingsResponse.ok()).toBe(true);
	const body = (await userSettingsResponse.json()) as { data?: { settings?: { paused?: boolean } } };
	expect(body.data?.settings?.paused).toBe(true);

	// Switch back to sigrun-mcp and save that page's user-settings form.
	await page.locator(".settings-nav-extension[data-ext=sigrun-mcp]").click();
	await expect(
		page.locator("[data-extension-page=sigrun-mcp] [data-extension-part='user-settings'] .blk-form"),
	).toBeVisible();
	await page
		.locator("[data-extension-page=sigrun-mcp] [data-extension-part='user-settings']")
		.getByRole("button", { name: "Save" })
		.click();
	await expect(page.locator(".blk-field-error")).toHaveCount(0);
});
