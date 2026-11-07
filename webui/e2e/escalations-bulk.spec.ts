/**
 * The multi-select bulk bar is always shown (select-all, count, actions
 * disabled until a selection), offers per-group select-all, and stays
 * on screen when the list it acts on is scrolled: it rendered at the top of the list, so after scrolling down
 * to tick rows the "Dismiss selected" button sat far above the viewport
 * (checkboxes with no visible action). Real escalations extension, 20
 * raised items, the sidebar scrolled to the bottom.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { bootE2EServer, siblingRepo, type E2EServer } from "./harness.js";
const EXTENSION = pathToFileURL(join(siblingRepo("sigrun-escalations"), "dist", "index.js")).href;
let server: E2EServer;
test.beforeAll(async () => {
	const calls = Array.from({ length: 20 }, (_, i) => fauxToolCall("escalate", { key: `demo:${i}`, title: `Demo ${i}`, body: "b", options: [{ id: "go", label: "Go" }] }, { id: `call-${i}` }));
	server = await bootE2EServer({ extensionSpecifiers: [EXTENSION], responses: [fauxAssistantMessage([{ type: "text", text: "r" }, ...calls], { stopReason: "toolUse" }), fauxAssistantMessage("done")] });
});
test.afterAll(async () => { await server.cleanup(); });
test("bulk actions stay reachable while a long inbox list is scrolled", async ({ browser }) => {
	const context = await browser.newContext({ extraHTTPHeaders: { "x-sigrun-user": "tester" }, viewport: { width: 1400, height: 800 } });
	const page = await context.newPage();
	const create = await fetch(`${server.url}/v1/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "demo-job", schedule: { every: "1h" }, action: { kind: "prompt", prompt: "go", conversation: "new" } }) });
	const jobId = ((await create.json()) as any).job.id;
	await fetch(`${server.url}/v1/jobs/${encodeURIComponent(jobId)}/run`, { method: "POST" });
	await page.waitForTimeout(3000);
	await page.goto(`${server.url}/#/ext/escalations/inbox`);
	await page.getByText("Job demo-job", { exact: true }).first().click();
	await page.waitForTimeout(500);
	const boxes = page.locator('[data-page-region="sidebar"] input.blk-select:not(.blk-select-all)');
	await expect(boxes).toHaveCount(20);
	// The bar is there before anything is ticked (checkboxes with no
	// visible action read as broken), its action disabled.
	const action = page.getByRole("button", { name: "Dismiss selected" });
	await expect(action).toBeVisible();
	await expect(action).toBeDisabled();
	await expect(page.locator(".blk-bulk")).toContainText("0 selected");
	await page.locator('[data-page-region="sidebar"]').evaluate((e) => { e.scrollTop = e.scrollHeight; });
	await boxes.nth(15).check();
	await boxes.nth(16).check();
	await page.waitForTimeout(500);
	// The bar stays reachable while the list is scrolled to the bottom.
	await expect(action).toBeInViewport();
	await expect(page.locator(".blk-bulk")).toContainText("2 selected");
	await action.click();
	await expect(page.getByText("Dismissed 2 escalations").first()).toBeVisible();
	await expect(boxes).toHaveCount(18);
	// A group's select-all takes every remaining item of that source.
	await page.getByRole("checkbox", { name: "Select all in Job demo-job" }).check();
	await expect(page.locator(".blk-bulk")).toContainText("18 selected");
	await action.click();
	await expect(page.getByText("Dismissed 18 escalations").first()).toBeVisible();
	await expect(boxes).toHaveCount(0);
});
