/**
 * W3 Task 7: the Extensions settings section in a real browser — the
 * browser check for the panel change the vitest suite cannot make (does
 * the section actually RENDER and behave against the real server?).
 *
 * Boots the ship-gate server (e2e/harness.ts) with one extension
 * package loaded (the stores fixture — its manifest carries a version),
 * opens the settings panel's Extensions section, asserts the row, the
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

test("the Extensions section renders the loaded extension, edits settings, and sets a secret write-only", async ({
	page,
}) => {
	await page.goto(server.url);
	await page.getByRole("button", { name: "settings" }).click();
	const dialog = page.getByRole("dialog", { name: "settings" });
	await expect(dialog).toBeVisible();

	// The section exists in the nav and opens.
	await dialog.getByRole("button", { name: "Extensions" }).click();

	// One row per loaded extension: name + status + manifest version.
	const row = dialog.locator(".settings-ext[data-ext=acme-tool]");
	await expect(row).toBeVisible();
	await expect(row.locator(".settings-ext-name")).toContainText("acme-tool");
	await expect(row.locator(".settings-ext-name")).toContainText("v0.2.0");

	// The settings textarea round-trips through the server (PUT then GET).
	const textarea = row.locator(".settings-ext-settings");
	await textarea.fill('{"theme":"dark"}');
	await row.getByRole("button", { name: /save settings/i }).click();
	await expect(row.getByRole("status")).toContainText("saved");

	// The server holds the file: settings/acme-tool.json on disk. U4
	// §13.2: the wire carries the object under `settings` plus the
	// pending-restart slot (extension fields default live → []).
	const settingsOnDisk = await page.evaluate(async () => {
		const res = await fetch("/v1/extensions/acme-tool/settings");
		return (await res.json()) as Record<string, unknown>;
	});
	expect(settingsOnDisk).toEqual({
		settings: { theme: "dark" },
		pendingRestart: [],
	});

	// The secret input is write-only (password, empty) and never echoes
	// a value back; setting one lists the key + source only.
	const keyRow = row.locator(".settings-ext-row", {
		has: page.locator(".settings-ext-key"),
	});
	await row.locator(".settings-ext-new-key").fill("api-key");
	await row.locator(".settings-ext-new-value").fill("s3cr3t-e2e");
	await row.getByRole("button", { name: "Set" }).last().click();
	await expect(row.locator(".settings-ext-key")).toContainText("api-key");
	await expect(row.locator(".settings-ext-source")).toContainText("stored");
	// The value never appears anywhere in the rendered section.
	await expect(row).not.toContainText("s3cr3t-e2e");

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
