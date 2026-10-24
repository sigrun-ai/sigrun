/**
 * U4 Task 2 (spec §13.3), browser-level: the restart surface.
 *
 * Unit tests (App.test.tsx) cover the state machine; this spec drives
 * the REAL action path in a REAL browser: the app boots through the new
 * App wrapper, `POST /v1/admin/restart` 409s on the unsupervised harness,
 * then — over a faked restart wire (202 + /readyz held down, then up) —
 * the app's own `restart()` action renders "Restarting…" and the shell
 * recovers (remounts) when /readyz answers. The action handle is the
 * app's window-exposed actions registry (`__sigrunAppActions`, the same
 * object `onExposeActions` hands tests).
 */

import { expect, test } from "@playwright/test";
import { bootE2EServer } from "./harness.js";

test("restart surface: 409 gate, Restarting… state, recovery on readyz", async ({
	page,
}) => {
	const server = await bootE2EServer();
	try {
		// Fake ONLY the restart wire: POST 202; /readyz held down until the
		// test flips it. Meta/conversations/streams stay the real server.
		await page.route("**/v1/admin/restart", (route) =>
			route.fulfill({
				status: 202,
				contentType: "application/json",
				body: JSON.stringify({ restarting: true }),
			}),
		);
		let readyzUp = true;
		await page.route("**/readyz", (route) =>
			route.fulfill({
				status: readyzUp ? 200 : 503,
				contentType: "application/json",
				body: "{}",
			}),
		);

		// The action registry publishes only under the e2e flag (a prod
		// page never carries the window global).
		await page.addInitScript(() => {
			(globalThis as { __sigrunE2E?: boolean }).__sigrunE2E = true;
		});
		await page.goto(server.url);
		await page.waitForSelector(".chat-header", { timeout: 15_000 });

		// The REAL route, unfaked (request context bypasses page.route):
		// the harness is unsupervised → 409 not_supervised.
		const gate = await page.context().request.post(
			`${server.url}/v1/admin/restart`,
		);
		expect(gate.status()).toBe(409);
		expect(await gate.json()).toEqual({ error: "not_supervised" });

		// The app's own restart action over the faked wire: hold /readyz
		// down, invoke, and the "Restarting…" state replaces the shell.
		readyzUp = false;
		await page.evaluate(() => {
			const actions = (
				globalThis as {
					__sigrunAppActions?: { restart(): Promise<void> };
				}
			).__sigrunAppActions;
			if (actions === undefined) {
				throw new Error("app actions registry missing");
			}
			// Long-running by design (resolves after recovery) — do not await.
			void actions.restart();
		});
		await expect(page.getByText("sigrun — Restarting…")).toBeVisible({
			timeout: 5_000,
		});
		// The shell is GONE while restarting (not an overlay — the boot
		// state replaced it).
		await expect(page.locator(".chat-header")).toHaveCount(0);
		await page.screenshot({
			path: "test-results/restart-surface-restarting.png",
			fullPage: true,
		});

		// Recovery: /readyz answers → the wrapper remounts the shell (the
		// boot gate re-runs its meta fetch against the REAL server) and the
		// chat header is back.
		readyzUp = true;
		await page.waitForSelector(".chat-header", { timeout: 15_000 });
		await expect(page.getByText("sigrun — Restarting…")).toHaveCount(0);
	} finally {
		// Close the page FIRST: its SSE streams would otherwise hold
		// app.close()'s drain (the harness cleanup doesn't run the
		// serve-time SSE shutdown).
		await page.close();
		await server.cleanup();
	}
});
