/**
 * W3 Task 7: the Extensions settings section in a real browser — the
 * browser check for the panel change the vitest suite cannot make (does
 * the section actually RENDER and behave against the real server?).
 *
 * Boots the ship-gate server (e2e/harness.ts) with one extension
 * package loaded (the stores fixture — its manifest carries a version),
 * opens the settings page's Extensions section, asserts the row, the
 * settings editor round-trip, and the write-only secret input, and
 * leaves a screenshot in the gitignored webui/test-results/.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { bootE2EServer } from "./harness.js";

let server: Awaited<ReturnType<typeof bootE2EServer>>;

test.beforeAll(async () => {
	// The stores fixture: an arity-1 factory that captures its host; the
	// declared extension name is "acme-tool". A package manifest with a
	// version rides beside it so the row shows one (the fixture dir is
	// read-only-ish in git — copy to a tmp spot and add the manifest).
	const fixtureDir = fileURLToPath(new URL(".", import.meta.url));
	server = await bootE2EServer({
		extensionSpecifiers: [
			join(fixtureDir, "..", "e2e-extensions", "acme-ext", "index.js"),
		],
	});
});

test.afterAll(async () => {
	await server.cleanup();
});

test("an undeclared extension's page shows its status and read-only stored JSON", async ({
	page,
}) => {
	await page.goto(server.url);
	await page.getByRole("button", { name: "settings" }).click();
	// 0.4.0 Task 4: settings is a main-pane PAGE (no dialog) at
	// #/settings; the section nav lives in its left column.
	const settings = page.locator(".settings-page");
	await expect(settings).toBeVisible();

	// The loaded extension has one page in the Extensions group.
	await settings.getByRole("button", { name: "acme-tool", exact: true }).click();

	// One row per loaded extension: name + status + manifest version.
	const row = settings.locator("[data-extension-page=acme-tool]");
	await expect(row).toBeVisible();
	await expect(row.locator(".settings-extension-header")).toContainText("acme-tool");
	await expect(row.locator(".settings-extension-header")).toContainText("v0.2.0");

	// An undeclared extension has no generated form; Advanced carries its
	// read-only stored JSON instead of the retired raw-JSON editor.
	await row.getByText("Advanced", { exact: true }).click();
	await expect(row).toContainText("This extension doesn't describe its settings.");
	await expect(row.locator("pre")).toContainText("{}");
	await expect(row.locator(".settings-ext-settings")).toHaveCount(0);


	// Visual evidence (gitignored webui/test-results/).
	await mkdir("test-results", { recursive: true });
	await page.screenshot({
		path: join("test-results", "settings-extensions.png"),
		fullPage: true,
	});

	// The API never returns the value either (the sweep, over the wire).
	const secrets = await page.evaluate(async () => {
		const res = await fetch("/v1/extensions/acme-tool/secrets");
		return JSON.stringify(await res.json());
	});
	expect(secrets).not.toContain("s3cr3t-e2e");
	// The e2e cleanup helper: remove the value again (leave no residue).
	await page.evaluate(async () => {
		await fetch("/v1/extensions/acme-tool/secrets/api-key", {
			method: "DELETE",
		});
	});
	await writeFile(
		join("test-results", "settings-extensions-secrets.json"),
		secrets,
	);
});
