import { mkdir } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";

const SEAM_FIXTURE = new URL("../../test/fixtures/fixture-seam-visual/index.js", import.meta.url).href;
let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer({ extensionSpecifiers: [SEAM_FIXTURE] });
});
test.afterAll(async () => { await server.cleanup(); });

test("the rendered DOM carries all primitive renderings", async ({ page }) => {
	const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
	const host = server.opened.seamHosts.get("sigrun-fixture-visual");
	if (host === undefined) throw new Error("seam host missing");
	const root = server.conversationId;

	await host.seedInteraction(root, {
		kind: "gating.confirm", callId: "a1", status: "pending", createdAt: Date.now(),
		body: { text: "gate prompt", options: [
			{ id: "ok", label: "Allow", tone: "ok", recommended: true },
			{ id: "no", label: "Deny", tone: "danger", description: "blocks the run" },
		] } }, BACKGROUND_CONTEXT);
	await host.seedInteraction(root, {
		kind: "questions.form", callId: "a2", status: "pending", createdAt: Date.now(),
		details: { multi: true } as never,
		body: { text: "multi question", options: [
			{ id: "a", label: "A" }, { id: "b", label: "B" }] } }, BACKGROUND_CONTEXT);
	await host.seedInteraction(root, {
		kind: "questions.form", callId: "a3", status: "pending", createdAt: Date.now(),
		body: { fields: [{ name: "key", type: "secret", required: true }] } }, BACKGROUND_CONTEXT);
	await host.seedInteraction(root, {
		kind: "gating.confirm", callId: "a4", status: "pending", createdAt: Date.now(),
		body: { text: "diff", diff: { before: "rm -rf x", after: "rm -r x" } } }, BACKGROUND_CONTEXT);

	await host.setAmbient(root, {
		key: "goal", place: "panel", expires: "never", updatedAt: 1,
		body: { line: { text: "active 18k/100k" }, rows: [
			{ id: "r1", label: "done task", status: "completed" },
			{ id: "r2", label: "running task", status: "running", spinnerLabel: "parsing", deps: ["r1"], metrics: { completed: 2, total: 5, format: "compact" } },
			{ id: "r3", label: "quiet", status: "ok", quiet: true }] } }, BACKGROUND_CONTEXT);
	await host.setAmbient(root, {
		key: "audit", place: "panel", expires: "never", updatedAt: 1,
		body: { gauge: { label: "audit", percent: 40, phase: "running", elapsedMs: 1200 } } }, BACKGROUND_CONTEXT);

	await page.goto(`${server.url}/`);
	await page.waitForSelector(".interaction-card", { timeout: 30_000 });

	// Interaction cards: all four primitives present.
	await expect(page.locator(".interaction-card")).toHaveCount(4);
	await expect(page.locator(".interaction-card", { hasText: "gate prompt" })).toBeVisible();
	await expect(page.locator('input[type="password"]')).toHaveCount(1);
	await expect(page.locator(".interaction-diff")).toHaveCount(1);
	const checkboxes = page.locator('input[type="checkbox"]');
	await expect(checkboxes).toHaveCount(2);
	// recommended pre-selected:
	await expect(page.locator('input[type="radio"]:checked')).toHaveCount(1);

	// Ambient panels: line, rows with deps + spinner + metrics, quiet fold, gauge.
	await expect(page.locator(".ambient-surface")).toHaveCount(2);
	await expect(page.locator(".ambient-line", { hasText: "active 18k/100k" })).toBeVisible();
	await expect(page.locator(".ambient-row")).toHaveCount(3); // 2 visible + 1 quiet summary? (quiet folded = count 2 + summary) — assert below
	await expect(page.locator(".ambient-row", { hasText: "parsing" })).toBeVisible();
	await expect(page.locator(".ambient-row-deps")).toHaveCount(1);
	await expect(page.locator(".ambient-metrics", { hasText: "2/5" })).toBeVisible();
	await expect(page.locator(".ambient-gauge-fill")).toBeVisible();
	// quiet summary:
	await expect(page.locator(".ambient-quiet-summary", { hasText: "+1 quiet" })).toHaveCount(1);
});
