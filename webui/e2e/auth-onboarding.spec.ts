/**
 * W1 Task 8 (spec §5.4/§5.8/§10): the token-onboarding e2e — the ONE boot
 * that runs the real auth surface in a browser.
 *
 * Boots TOKEN-ONLY and UNCLAIMED (the harness `auth` option: methods
 * ["token"], an empty user directory, the setup code pinned via
 * `SIGRUN_SETUP_CODE`), then walks the real flow:
 *
 * 1. the bundle serves (the browser surface is public) and the AuthGate's
 *    onboarding screen renders — code field present (the bind is
 *    non-loopback, so `codeRequired` is true);
 * 2. the claim posts code + username + `issueToken` — the server sets the
 *    `sigrun_session` cookie, the shell renders under it, and the rail
 *    shows the claimed user + the sign-out action;
 * 3. a submitted message renders its answer through the SSE view stream —
 *    `GET /v1/conversations/:id/stream` is an AUTHENTICATED route whose
 *    only credential in a browser is the same-origin `EventSource` cookie
 *    (spec §10's pinned behavior: the stream renders ⟺ the cookie rode
 *    the EventSource).
 */

import { expect, test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";

/** The pinned setup code (the k8s Secret shape — env-only). */
const SETUP_CODE = "E2E1-C0DE";
/** The username the onboarding claims (the directory's lowercase rule). */
const OWNER = "e2e-owner";

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer({ auth: { setupCode: SETUP_CODE } });
});

test.afterAll(async () => {
	await server.cleanup();
});

test("claimed proxy-only boots to ProxyUnidentified when the browser peer is untrusted", async ({
	page,
}) => {
	const proxyServer = await bootE2EServer({
		auth: { proxy: { trustedProxies: ["10.42.0.0/16"] }, claimed: true },
	});
	try {
		await page.goto(proxyServer.url);
		await expect(
			page.locator('[data-auth-screen="proxy-unidentified"]'),
		).toBeVisible();
		await expect(page.locator('[data-auth-field="token"]')).toHaveCount(0);
		await expect(page.locator('input[type="password"]')).toHaveCount(0);
		await expect(page.locator("input")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
	} finally {
		await proxyServer.cleanup();
	}
});

test("boots token-only, onboards with the setup code, and renders the SSE stream under the session cookie", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (cause) => pageErrors.push(String(cause)));

	await page.goto(server.url);

	// The onboarding screen (the gate's boot probe found an unclaimed
	// server): the code field is present, the shell is not.
	await expect(
		page.locator('[data-auth-screen="onboarding"]'),
	).toBeVisible();
	await expect(page.locator('[data-auth-field="code"]')).toBeVisible();
	await expect(page.locator("nav.session-list")).toHaveCount(0);

	// Claim: the setup code + the username (name/email optional).
	await page.locator('[data-auth-field="code"]').fill(SETUP_CODE);
	await page.locator('[data-auth-field="user"]').fill(OWNER);
	await page.getByRole("button", { name: "Set up sigrun" }).click();

	// The claim set the cookie; the gate re-probed and the shell rendered
	// (every fetch behind it — meta, conversations — rode that cookie).
	await expect(page.locator("nav.session-list")).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.locator("nav.rail")).toBeVisible();

	// The rail's identity: the claimed user + the sign-out action (the
	// token method's browser-side credential affordances).
	await expect(page.locator(".rail-user")).toHaveText(OWNER);
	await expect(page.locator('[data-rail-section="logout"]')).toBeVisible();

	// THE §10 PIN: submit a message and see its answer render through the
	// SSE view stream. The stream route authenticates by cookie only (the
	// browser's EventSource sends same-origin cookies; it cannot carry a
	// header) — if the cookie did not ride it, the transcript would stay
	// empty and the stream would reconnect-loop on 401s.
	await expect(page.locator(".composer-input")).toBeEnabled();
	await page.locator(".composer-input").fill("hello from the authed boot");
	await page.locator(".composer-send").click();
	await expect(page.locator(".chat-center")).toContainText(
		"hello from the authed boot",
		{ timeout: 20_000 },
	);
	await expect(page.locator(".chat-center")).toContainText("e2e answer", {
		timeout: 20_000,
	});

	// No uncaught page errors across the whole flow.
	expect(pageErrors).toEqual([]);
});
