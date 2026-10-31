/**
 * Task 8c (pi parity) → 0.4.0 Task 4: the settings PAGE in a real
 * browser — #/settings/<section> on the app's hash router, with a left
 * section column, back/forward support, and the path-form deep link
 * (the server's post-account-link returnTo) rewriting to the hash at
 * boot.
 *
 * Boots the real M1 server (the ship-gate harness), opens the webui, and
 * exercises: gear click navigates to #/settings (the transcript column
 * replaced), an edit + save PATCHes and the reopened page reflects the
 * persisted state, browser back returns to the conversation, and a
 * fresh load of /settings?section=accounts lands on account links.
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

test.afterAll(async ({ browser }) => {
	await Promise.all(browser.contexts().map((context) => context.close()));
	await server.cleanup();
});

test("gear opens the settings page; edit + save persists", async ({ page }) => {
	await page.goto(server.url);
	await page.getByRole("button", { name: "settings" }).click();

	// The settings PAGE replaces the transcript column (a hash route —
	// no dialog, no composer).
	const settings = page.locator(".settings-page");
	await expect(settings).toBeVisible();
	await expect(page.locator("[role=dialog]")).toHaveCount(0);
	await expect(page.locator(".composer-slot")).toHaveCount(0);
	await expect(page).toHaveURL(/#\/settings$/);

	// The page reflects the served settings (the steering-mode choice,
	// a radiogroup under the sections renderer — General opens first).
	const steering = settings.getByRole("radiogroup", { name: "Steering mode" });
	await expect(steering).toBeVisible();

	// Flip the steering mode to a concrete option and save.
	await steering.getByRole("radio", { name: "All" }).check();
	await settings.getByRole("button", { name: /save/i }).click();

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

	// Navigating away and back shows the persisted value.
	await page.goBack();
	await expect(page.locator(".settings-page")).toHaveCount(0);
	await page.getByRole("button", { name: "settings" }).click();
	await expect(
		page
			.locator(".settings-page")
			.getByRole("radiogroup", { name: "Steering mode" })
			.getByRole("radio", { name: "All" }),
	).toBeChecked();

	// Zero page errors.
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	expect(errors).toEqual([]);
});

test("back returns to the conversation", async ({ page }) => {
	await page.goto(server.url);
	// The transcript column is live (the boot default selects the root).
	await expect(page.locator(".composer-slot")).toBeVisible();
	await page.getByRole("button", { name: "settings" }).click();
	await expect(page).toHaveURL(/#\/settings$/);
	await expect(page.locator(".composer-slot")).toHaveCount(0);
	// Browser back walks the hash history: the conversation returns (the
	// boot entry is the BARE root URL — no hash — so back leaves the
	// settings route entirely).
	await page.goBack();
	await expect(page).not.toHaveURL(/#\/settings/);
	await expect(page.locator(".settings-page")).toHaveCount(0);
	await expect(page.locator(".composer-slot")).toBeVisible();
	// Forward returns to the settings page (the history entry survives).
	await page.goForward();
	await expect(page).toHaveURL(/#\/settings$/);
	await expect(page.locator(".settings-page")).toBeVisible();
});

test("a section nav click lands its id in the hash", async ({ page }) => {
	await page.goto(server.url);
	await page.getByRole("button", { name: "settings" }).click();
	await page.locator(".settings-nav-item", { hasText: "Advanced" }).click();
	await expect(page).toHaveURL(/#\/settings\/advanced$/);
	// The section actually rendered (the Server group's port field).
	await expect(
		page.getByRole("spinbutton", { name: /listen port/i }),
	).toBeVisible();
});

test("/settings?section=accounts on a fresh load lands on account links", async ({ page }) => {
	// The server's post-account-link returnTo is PATH-form; the app
	// rewrites it to the hash route at boot and renders the section.
	await page.goto(`${server.url}/settings?section=accounts`);
	const settings = page.locator(".settings-page");
	await expect(settings).toBeVisible();
	// The rewrite landed: the hash carries the section id.
	await expect(page).toHaveURL(/#\/settings\/accounts$/);
	// The accounts cove rendered (its intro note; the naive boot lists
	// no linkable providers, so the empty state shows).
	await expect(settings).toContainText("External identities linked");
});

test("a deployment-managed key renders locked", async ({ page }) => {
	const managed = await bootE2EServer({ managedSettings: ["defaultModel"] });
	try {
		await page.goto(managed.url);
		await page.getByRole("button", { name: "settings" }).click();
		const settings = page.locator(".settings-page");
		await expect(settings).toBeVisible();
		await settings.getByRole("button", { name: "General" }).click();
		const input = settings.getByRole("textbox", { name: "Default model" });
		await expect(input).toBeDisabled();
		await expect(settings).toContainText("Managed by deployment");
	} finally {
		await managed.cleanup();
	}
});

test("the Providers section lists readiness and saves a credential write-only", async ({
	page,
}) => {
	await page.goto(server.url);
	await page.getByRole("button", { name: "settings" }).click();
	const settings = page.locator(".settings-page");
	await expect(settings).toBeVisible();

	// The section opens from the nav (the naive boot session is admin).
	await settings.getByRole("button", { name: "Providers" }).click();

	// One row per catalog provider: the faux contributor's provider with
	// its readiness badge and its model count.
	const row = settings.locator(".settings-provider[data-provider=faux]");
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

test("the settings callout: the naming-model save needs no restart; the port save lists it pending with the restart copy", async ({
	browser,
}) => {
	// A FRESH page per test: the gear test's `expect(errors).toEqual([])`
	// teardown runs its pageerror handler against a still-open dialog, and
	// the shared page's prior settings state (steeringMode "all") would
	// ride into this test's form (the sections renderer re-renders per
	// section open, but the poll's namingModel read must see THIS test's
	// write — a stale shared page would observe the gear test's state).
	const page = await browser.newPage();
	await page.goto(server.url);
	await page.getByRole("button", { name: "settings" }).click();
	const settings = page.locator(".settings-page");
	await expect(settings).toBeVisible();

	// General is the nav's first section (core first).
	await settings.getByRole("button", { name: "General" }).click();

	// namingModel is a live key: the save applies with no callout. The
	// save rides the surface actions route (the panel's ONE renderer);
	// the settings file reflects it via the surface save.
	const naming = settings.getByRole("textbox", { name: /naming model/i });
	await expect(naming).toBeVisible();
	await naming.fill("faux/m-renamed");
	const saved = page.waitForResponse((response) =>
		response.url().includes("/v1/ext/core/surfaces/general/actions") &&
		response.request().method() === "POST",
	);
	await settings.getByRole("button", { name: /^save$/i }).click();
	const actionResponse = await saved;
	expect(actionResponse.ok()).toBe(true);
	await expect
		.poll(async () => {
			const res = await page.evaluate(async () => {
				const r = await fetch("/v1/settings");
				return (await r.json()) as Record<string, unknown>;
			});
			return res.namingModel;
		})
		.toBe("faux/m-renamed");
	await expect(settings.locator(".settings-restart-callout")).toHaveCount(0);

	// server.port is a restart key (Advanced's Server group): the save
	// lands it in the callout; the server boots UNSUPERVISED in the e2e
	// harness, so the copy is the plain "Restart sigrun to apply" text
	// with no Restart button (the button is the supervised admin's).
	await settings.getByRole("button", { name: "Advanced" }).click();
	const port = settings.getByRole("spinbutton", { name: /listen port/i });
	await expect(port).toBeVisible();
	await port.fill("5313");
	await settings.getByRole("button", { name: /save/i }).click();
	const callout = settings.locator(".settings-restart-callout");
	await expect(callout).toBeVisible();
	await expect(callout).toContainText("server.port");
	await expect(callout).toContainText("Restart sigrun to apply");
	await expect(
		callout.getByRole("button", { name: /restart/i }),
	).toHaveCount(0);
	await page.close();
});
