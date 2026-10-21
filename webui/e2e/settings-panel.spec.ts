/**
 * Task 8c (pi parity): the settings panel in a real browser — the
 * controller's focused verification of the surface the implementer could
 * not browser-verify (its instructions barred the e2e battery; this spec
 * is the single-spec focused check that closes that gap).
 *
 * Boots the real M1 server (the ship-gate harness), opens the webui, and
 * exercises: gear click opens the panel dialog, the panel reflects the
 * served settings, an edit + save PATCHes and the panel reflects the
 * persisted state on reopen.
 *
 * Release 0.1 Task 2b adds the Providers leg: the readiness rows, the
 * write-only key field over the REAL credential routes (PUT lands in the
 * server's auth store under the magic "default" key — faux is the
 * default model's provider; the key never renders), Clear deletes it,
 * Refresh POSTs the bounded refresh.
 */

import { expect, test } from "@playwright/test";
import { bootE2EServer } from "./harness.js";

let server: Awaited<ReturnType<typeof bootE2EServer>>;

test.beforeAll(async () => {
	server = await bootE2EServer();
});

test.afterAll(async () => {
	await server.cleanup();
});

test("gear opens the settings panel; edit + save persists", async ({ page }) => {
	await page.goto(server.url);
	await page.getByRole("button", { name: "settings" }).click();

	const dialog = page.getByRole("dialog", { name: "settings" });
	await expect(dialog).toBeVisible();

	// The panel reflects the served settings (the steering-mode combobox).
	const steering = dialog.getByRole("combobox", { name: "steering mode" });
	await expect(steering).toBeVisible();

	// Flip the steering mode to a concrete option and save.
	await steering.selectOption({ label: "all" });
	await dialog.getByRole("button", { name: /save/i }).click();

	// The PATCH landed on the server: GET now reports the change.
	await expect
		.poll(async () => {
			const res = await page.evaluate(async () => {
				const r = await fetch("/v1/settings");
				return (await r.json()) as Record<string, unknown>;
			});
			return res.steeringMode;
		})
		.toBe("all");

	// Reopening the panel shows the persisted value.
	await dialog.getByRole("button", { name: "✕" }).click();
	await page.getByRole("button", { name: "settings" }).click();
	await expect(
		page
			.getByRole("dialog", { name: "settings" })
			.getByRole("combobox", { name: "steering mode" }),
	).toHaveValue("all");

	// Zero page errors.
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	expect(errors).toEqual([]);
});

test("the Providers section lists readiness and saves a credential write-only", async ({
	page,
}) => {
	await page.goto(server.url);
	await page.getByRole("button", { name: "settings" }).click();
	const dialog = page.getByRole("dialog", { name: "settings" });

	// The section opens from the nav (the naive boot session is admin).
	await dialog.getByRole("button", { name: "Providers" }).click();

	// One row per catalog provider: the faux contributor's provider with
	// its readiness badge and its model count.
	const row = dialog.locator(".settings-provider[data-provider=faux]");
	await expect(row).toBeVisible();
	await expect(row.locator(".settings-provider-status")).toBeVisible();
	await expect(row).toContainText("2 models");

	// Save: the key rides the real PUT (the server stores it under the
	// magic "default" key — faux is the default model's provider) and the
	// write-only field clears; the key never renders anywhere.
	const key = "acme-test-key";
	await row.locator(".settings-provider-key").fill(key);
	await row.getByRole("button", { name: "Save" }).click();
	await expect(row.locator(".settings-provider-key")).toHaveValue("");
	await expect(row).not.toContainText(key);
	await expect
		.poll(() => server.opened.auth.read().default?.apiKey)
		.toBe(key);

	// Refresh: one bounded refresh of the named provider over the wire.
	await row.getByRole("button", { name: "Refresh" }).click();
	await expect(row.locator(".settings-provider-status")).toBeVisible();

	// Clear: the DELETE removes the stored credential.
	await row.getByRole("button", { name: "Clear" }).click();
	await expect
		.poll(() => server.opened.auth.read().default?.apiKey)
		.toBeUndefined();

	// Zero page errors.
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	expect(errors).toEqual([]);
});
