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

import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { bootE2EServer } from "./harness.js";

let server: Awaited<ReturnType<typeof bootE2EServer>>;

test.beforeAll(async () => {
	const fixture = fileURLToPath(new URL("../../test/fixtures/fixture-settings-extension-page/index.js", import.meta.url));
	server = await bootE2EServer({
		extensionSpecifiers: [pathToFileURL(fixture).href],
		// The callout test saves the utility model; the default harness
		// disables auto-naming to protect scripted response queues.
		autoNaming: true,
	});
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

	// The bare route opens Interface (the first My-settings section);
	// steering lives under General's Conversations group (System settings).
	await settings.getByRole("button", { name: "General", exact: true }).click();
	await expect(settings.getByRole("heading", { name: "Conversations" })).toBeVisible();
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

	// General adds a section history entry: walk back through it to the
	// conversation, then reopen General to check the persisted value.
	await page.goBack();
	await expect(page).toHaveURL(/#\/settings$/);
	await page.goBack();
	await expect(page.locator(".settings-page")).toHaveCount(0);
	await page.getByRole("button", { name: "settings" }).click();
	const reopened = page.locator(".settings-page");
	await reopened.getByRole("button", { name: "General", exact: true }).click();
	await expect(
		reopened
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
	// Browser back walks the hash history: the conversation returns.
	// (NOT asserted as `#/c`: the boot entry is the BARE root URL — no
	// hash — so back deterministically lands on the hash-less root; the
	// strong form is no-settings-hash + the chat column restored.)
	await page.goBack();
	await expect(page).not.toHaveURL(/#\//);
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
		await settings
			.getByRole("group", { name: "System settings", exact: true })
			.getByRole("button", { name: "Models", exact: true })
			.click();
		const input = settings.getByRole("combobox", { name: "Chat model", exact: true });
		await expect(input).toBeDisabled();
		await expect(settings).toContainText("Managed by deployment");
	} finally {
		await managed.cleanup();
	}
});

test("the Providers section lists readiness and the credential routes stay write-only", async ({
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

	// The built-in faux contributor has no extension page, so this status
	// row has no link. Its auth.json flow remains the same write-only API.
	await expect(row.locator(".settings-provider-page-link")).toHaveCount(0);
	await expect(row.locator(".settings-provider-key")).toHaveCount(0);
	const key = "acme-test-key";
	await page.evaluate(async (apiKey) => {
		const response = await fetch("/v1/providers/faux/credential", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ apiKey }),
		});
		if (!response.ok) throw new Error(`credential PUT ${response.status}`);
	}, key);
	expect(server.opened.auth.read().default?.apiKey).toBe(key);
	await expect(row).not.toContainText(key);
	await row.getByRole("button", { name: "Refresh" }).click();
	await expect(row.locator(".settings-provider-status")).toBeVisible();
	await page.evaluate(async () => {
		const response = await fetch("/v1/providers/faux/credential", { method: "DELETE" });
		if (!response.ok) throw new Error(`credential DELETE ${response.status}`);
	});
	expect(server.opened.auth.read().default?.apiKey).toBeUndefined();

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

	// Models is a system section; its Utility model is a live key: the
	// save applies with no callout. The save rides the surface actions
	// route (the panel's ONE renderer); the settings file reflects it via
	// the surface save.
	await settings
		.getByRole("group", { name: "System settings", exact: true })
		.getByRole("button", { name: "Models", exact: true })
		.click();
	const naming = settings.getByRole("combobox", { name: "Utility model", exact: true });
	await expect(naming).toBeVisible();
	await naming.selectOption({ label: "faux/m2 · ext-faux" });
	const saved = page.waitForResponse((response) =>
		response.url().includes("/v1/ext/core/surfaces/models/actions") &&
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
		.toBe("faux/m2");
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

test("create a token in Settings → API tokens and authenticate with it", async ({
	page,
}) => {
	// Token-method boot (claimed): the browser needs a session to reach
	// the settings page, so a first token (minted server-side through the
	// harness's identity store) logs it in through the real login route.
	const authed = await bootE2EServer({ auth: { claimed: true } });
	try {
		const login = await authed.opened.identity.tokens.create(
			"e2e-login",
			"tester",
		);
		await page.goto(authed.url);
		const response = await page.evaluate<
			number,
			{ token: string }
		>(async ({ token }) => {
			const res = await fetch("/v1/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token }),
			});
			return res.status;
		}, { token: login.token });
		expect(response).toBe(200);

		// The settings page over the cookie session; the tokens section.
		await page.goto(authed.url);
		await page.getByRole("button", { name: "settings" }).click();
		const settings = page.locator(".settings-page");
		await expect(settings).toBeVisible();
		await settings.getByRole("button", { name: "API tokens" }).click();

		// Mint through the section's create form (the real POST route).
		const name = "e2e-cli";
		await settings.locator(".token-name-input").fill(name);
		await settings.getByRole("button", { name: "Create token" }).click();

		// The once-only display: the secret + the CLI snippet against the
		// page's own origin (the page URL minus its hash route).
		const revealed = (await settings
			.locator(".token-secret")
			.textContent()) as string;
		expect(revealed).toMatch(/^sgr_/);
		const origin = new URL(page.url()).origin;
		await expect(settings.locator(".token-snippet").first()).toContainText(
			`SIGRUN_TOKEN=${revealed} sigrun attach --server ${origin}`,
		);

		// THE authentication leg: the freshly minted token reaches
		// whoami from the page as the user.
		const whoami = await page.evaluate<
			{ user?: string; admin?: boolean },
			{ token: string }
		>(async ({ token }) => {
			const res = await fetch("/v1/auth/whoami", {
				headers: { authorization: `Bearer ${token}` },
			});
			return (await res.json()) as { user?: string; admin?: boolean };
		}, { token: revealed });
		expect(whoami.user).toBe("tester");

		// Dismiss: the secret leaves the DOM (once-only).
		await settings.getByRole("button", { name: "Done" }).click();
		await expect(settings.locator(".token-secret")).toHaveCount(0);
		expect(await settings.textContent()).not.toContain(revealed);

		// The new row lists by name.
		await expect(settings).toContainText(name);
	} finally {
		await authed.cleanup();
	}
});

test("the palette outline clears its label", async ({ page }) => {
	await page.goto(`${server.url}/#/settings/interface`);
	const selected = page.locator('.settings-palette[aria-pressed="true"]');
	await expect(selected).toBeVisible();
	const geometry = await selected.evaluate((swatch) => {
		const legend = swatch.closest("fieldset")?.querySelector("legend");
		if (legend === null || legend === undefined) throw new Error("palette legend missing");
		const style = getComputedStyle(swatch);
		return {
			legendBottom: legend.getBoundingClientRect().bottom,
			swatchTop: swatch.getBoundingClientRect().top,
			outline: Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset),
		};
	});
	expect(geometry.swatchTop - geometry.outline).toBeGreaterThanOrEqual(geometry.legendBottom);
});

// UI feedback 2026-11-05: the section forms read as page content, not
// overlay leftovers — the Save button sizes to its label and fields cap
// at a readable width on a desktop viewport.
test("a settings form's Save is content-width and its fields cap their width", async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${server.url}/#/settings/models`);
	const settings = page.locator(".settings-page");
	const save = settings.getByRole("button", { name: /^save$/i });
	await expect(save).toBeVisible();
	const form = settings.locator(".blk-form").first();
	const saveBox = await save.boundingBox();
	const formBox = await form.boundingBox();
	expect(saveBox).not.toBeNull();
	expect(formBox).not.toBeNull();
	expect(saveBox!.width).toBeLessThan(160);
	expect(saveBox!.width).toBeLessThan(formBox!.width / 3);
	const model = settings.locator('[data-name="defaultModel"] input');
	await expect(model).toBeVisible();
	const modelBox = await model.boundingBox();
	expect(modelBox!.width).toBeLessThanOrEqual(720);
});
