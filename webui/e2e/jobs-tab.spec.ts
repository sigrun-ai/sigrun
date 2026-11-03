/**
 * Tabs+skills Task 6: the Jobs TAB end to end in a real browser — the
 * JobsPanel is gone; the jobs surface is the `core/jobs` blocks view
 * (Task 5's server side) on the `#/ext/core/jobs` tab.
 *
 * The spec creates a job over the REST API (`POST /v1/jobs`), opens the
 * Jobs tab, selects the row (the collection's `openJob` activation
 * navigates to `?params={"job":id}`), fires *Run now*, and sees the new
 * run row — the surface refreshes through the server-side
 * `job.changed → bumpAllInstances("core", "jobs")` contract (Task 4's
 * bump), delivered to the page over the shared `/v1/events` stream.
 */

import { expect, test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer();
});

test.afterAll(async () => {
	await server.cleanup();
});

test("Jobs tab: create a job via POST /v1/jobs, select it, Run now, see the run row", async ({
	browser,
}) => {
	// An identified caller (SIGRUN_AUTH=none is header-typed): the jobs
	// view is principal-owned — an anonymous principal gets access none.
	const context = await browser.newContext({
		extraHTTPHeaders: { "x-sigrun-user": "tester" },
	});
	const page = await context.newPage();
	try {
	await page.goto(server.url);
	// The Jobs tab renders on the rail (the booted server attaches the
	// core/jobs view, so /v1/meta's coreViews lists it).
	const railTab = page.locator('[data-rail-section="jobs"]');
	await expect(railTab).toBeVisible();

	// Create the job over the REST API (the page's fetch is
	// cookie-authenticated — same origin as the app).
	const jobId: string = await page.evaluate(async () => {
		const response = await fetch("/v1/jobs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "acme-tick",
				schedule: { every: "1h" },
				action: {
					kind: "prompt",
					prompt: "say tick",
					conversation: "new",
				},
			}),
		});
		if (!response.ok) {
			throw new Error(`POST /v1/jobs failed: ${response.status}`);
		}
		const body = (await response.json()) as { job: { id: string } };
		return body.job.id;
	});

	// Open the Jobs tab (the rail tab routes to #/ext/core/jobs).
	await railTab.click();
	await expect(page).toHaveURL(/#\/ext\/core\/jobs/);

	// The sidebar lists the created job; clicking the row activates the
	// collection's `openJob` edit — the accepted result navigates the
	// page's params to {job: <id>} (the hash carries the selection).
	const row = page
		.locator('[data-page-region="sidebar"] .blk-list-card', {
			hasText: "acme-tick",
		})
		.first();
	await expect(row).toBeVisible();
	await row.click();
	await expect(page).toHaveURL(
		new RegExp(`#/ext/core/jobs\\?params=.*${encodeURIComponent(jobId)}`),
	);

	// The selected job's summary lands (the page re-renders at the
	// navigated params), and the write caller sees the Run now action.
	const main = page.locator('[data-page-region="main"]');
	await expect(main).toContainText("acme-tick");
	const runNow = main.getByRole("button", { name: "Run now" });
	await expect(runNow).toBeVisible();

	// Run now: the server fires the prompt action against the faux
	// provider, `job.changed` bumps every core/jobs instance, and the
	// run row lands in the Runs section (outcome "succeeded" — the
	// faux provider answers the prompt immediately).
	await runNow.click();
	const runs = main.locator(".blk-list-card").filter({ hasText: "succeeded" });
	await expect(runs.first()).toBeVisible({ timeout: 30_000 });
	} finally {
		await context.close();
	}
});
