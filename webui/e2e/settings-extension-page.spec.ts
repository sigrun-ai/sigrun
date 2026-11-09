import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";

let server: E2EServer;

test.beforeAll(async () => {
	const fixture = fileURLToPath(new URL("../../test/fixtures/fixture-settings-extension-page/index.js", import.meta.url));
	server = await bootE2EServer({ extensionSpecifiers: [pathToFileURL(fixture).href], auth: { claimed: true } });
});

test.afterAll(async () => {
	await server.cleanup();
});

test("an extension table entry keeps its secret set across save, reload, and rename", async ({ page }) => {
	const secret = "acme-e2e-secret-value";
	const login = await server.opened.identity.tokens.create("settings-page-e2e", "tester");
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
	await page.goto(`${server.url}/#/settings/acme-settings-page`);
	const pageRoot = page.locator("[data-extension-page=acme-settings-page]");
	await expect(pageRoot).toBeVisible();
	await pageRoot.getByRole("button", { name: "+ Add" }).click();
	await pageRoot.locator("[data-name='$key'] input").fill("first");
	await pageRoot.locator("[data-name='url'] input").fill("https://acme.example.invalid");
	await pageRoot.locator("[data-name='headers']").getByRole("button", { name: "+ Add" }).click();
	await pageRoot.locator("[data-name='headers'] [data-name='$key'] input").fill("Authorization");
	await pageRoot.locator("[data-name='headers'] [data-name='value'] input").fill(secret);
	await pageRoot.locator("[data-extension-part='settings']").getByRole("button", { name: "Save" }).click();
	await page.reload();
	await expect(pageRoot).toBeVisible();
	await expect(pageRoot.locator(".blk-entry-summary")).toContainText("set");
	await expect(pageRoot).not.toContainText(secret);
	expect(await page.locator("body").textContent()).not.toContain(secret);
	expect((await server.opened.extensionStores.secretKeys("acme-settings-page")).map((entry) => entry.key)).toContain("servers/first/headers/Authorization");

	await pageRoot.getByRole("button", { name: "Edit entry first" }).click();
	await pageRoot.locator("[data-name='$key'] input").fill("renamed");
	await pageRoot.locator("[data-extension-part='settings']").getByRole("button", { name: "Save" }).click();
	await expect(pageRoot).toContainText("renamed");
	await expect(pageRoot.getByRole("button", { name: "Edit entry renamed" })).toContainText("set");
	await expect(pageRoot).not.toContainText(secret);
	expect(await page.locator("body").textContent()).not.toContain(secret);
	expect((await server.opened.extensionStores.secretKeys("acme-settings-page")).map((entry) => entry.key)).toContain("servers/renamed/headers/Authorization");

	await expect(pageRoot.locator("[data-surface='error']")).toHaveCount(0);
	await mkdir("test-results", { recursive: true });
	await pageRoot.getByRole("button", { name: "Edit entry renamed" }).click();
	await expect(pageRoot.getByRole("button", { name: "Edit entry renamed" })).toContainText("set");
	await page.screenshot({ path: join("test-results", "settings-extension-page-desktop.png"), fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	const extensionNav = page.locator(".settings-nav-extension[data-ext=acme-settings-page]");
	await extensionNav.scrollIntoViewIfNeeded();
	const navBox = await page.locator(".settings-nav").boundingBox();
	const extensionBox = await extensionNav.boundingBox();
	expect(navBox).not.toBeNull();
	expect(extensionBox).not.toBeNull();
	expect(extensionBox!.width).toBeGreaterThanOrEqual(130);
	expect(extensionBox!.x).toBeGreaterThanOrEqual(navBox!.x);
	expect(extensionBox!.x + extensionBox!.width).toBeLessThanOrEqual(navBox!.x + navBox!.width);
	await expect(extensionNav).toHaveText("acme-settings-page");
	await page.screenshot({ path: join("test-results", "settings-extension-page-mobile.png"), fullPage: true });
});
