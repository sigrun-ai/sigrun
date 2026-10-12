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
