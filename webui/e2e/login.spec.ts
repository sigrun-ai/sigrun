/** M3b Task 6: fixture-provider login on a claimed server. */
import { expect, test } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { fixtureLoginProvider, setFixtureLoginProviders } from "../../test/fixtures/fixture-login/index.js";
import { bootE2EServer, type E2EServer } from "./harness.js";

const FIXTURE_LOGIN = pathToFileURL(new URL("../../test/fixtures/fixture-login/index.js", import.meta.url).pathname).href;
let server: E2EServer;

test.beforeAll(async () => {
	setFixtureLoginProviders([{
		...fixtureLoginProvider,
		policy: { autoProvision: true },
		async begin(flow: Parameters<typeof fixtureLoginProvider.begin>[0]) {
			return { redirectUrl: `/fixture-idp?state=${flow.state}` };
		},
	}]);
	server = await bootE2EServer({ auth: { claimed: true }, extensionSpecifiers: [FIXTURE_LOGIN] });
});

test.afterAll(async () => {
	setFixtureLoginProviders([fixtureLoginProvider]);
	await server.cleanup();
});

test("provider sign-in auto-provisions the user and keeps session identity controls", async ({ page }) => {
	const errors: string[] = [];
	page.on("pageerror", (cause) => errors.push(String(cause)));
	await page.goto(`${server.url}/login`);
	await expect(page.locator('[data-auth-screen="login"]')).toBeVisible();
	await expect(page.locator(".auth-provider")).toHaveText("Fixture identity");
	// The same-origin fixture IdP keeps this browser flow independent of
	// external DNS/TLS while the real begin/callback routes own all state.
	const beginUrl = new URL(
		await page.locator(".auth-provider").getAttribute("href") ?? "",
		server.url,
	);
	const beginResponse = await page.goto(beginUrl.toString());
	expect(beginResponse?.url()).toContain("/fixture-idp?state=");
	const state = new URL(page.url()).searchParams.get("state");
	expect(state).not.toBeNull();
	await page.goto(`${server.url}/v1/auth/callback/login:fixture-login:fixture?state=${encodeURIComponent(state!)}`);
	await expect(page.locator("nav.session-list")).toBeVisible({ timeout: 15_000 });
	await expect(page.locator(".rail-user")).toHaveText("fixture-user");
	await expect(page.locator('[data-rail-section="logout"]')).toBeVisible();
	expect(server.opened.identity.users.get("fixture-user")).toMatchObject({ admin: false, source: "login" });
	expect(errors).toEqual([]);
});
