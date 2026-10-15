/**
 * Visual verification for the seam rendering (interaction cards + ambient
 * panels): seeds RICH records through the real server's seam hosts and
 * screenshots the rendered surfaces. Screenshots land in
 * webui/test-results/seam-visual/ for human review; the assertions are
 * sanity-only (presence, not pixel judgment — the human reviews the shots).
 */

import { readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness";

const SEAM_FIXTURE = (() => {
	// The fixture lives in the core repo's test/fixtures; resolve from the
	// repo root relative to this file (webui/e2e → ../../test/fixtures).
	const url = new URL("../../test/fixtures/fixture-seam-visual/index.js", import.meta.url);
	return url.href;
})();

let server: E2EServer;

const SHOT_DIR = join(import.meta.dirname, "..", "test-results", "seam-visual");

test.beforeAll(async () => {
	await mkdir(SHOT_DIR, { recursive: true });
	server = await bootE2EServer({
		extensionSpecifiers: [SEAM_FIXTURE],
	});
});

test.afterAll(async () => {
	await server.cleanup();
});

test.describe("seam visual verification", () => {
	test("rich interaction card (options/fields/diff/details)", async ({ page }) => {
		const root = await opened_root();
		const host = server.opened.seamHosts.get("sigrun.fixture-visual");
		if (host === undefined) throw new Error("seam host missing — fixture did not load");

		const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

		// Rich warden-style confirm record.
		await host.seedInteraction(
			root.id,
			{
				kind: "gating.confirm",
				callId: "shot-confirm",
				status: "pending",
				createdAt: Date.now(),
				body: {
					text:
						"warden: allow this bash call?\nrm -rf /tmp/scratch-build\nWhy: destructive, recursive, absolute path · Jev severity 0.82",
					options: [
						{ id: "allow", label: "Allow once", tone: "ok" },
						{ id: "allow-session", label: "Allow for this session", tone: "warn" },
						{ id: "deny", label: "Deny", tone: "danger" },
					],
				},
			},
			BACKGROUND_CONTEXT,
		);

		// Questionnaire record (fields + multi).
		await host.seedInteraction(
			root.id,
			{
				kind: "questions.form",
				callId: "shot-form",
				status: "pending",
				createdAt: Date.now(),
				details: { multi: true } as never,
				body: {
					text: "Which environments should receive the deploy?",
					options: [
						{ id: "staging", label: "Staging", recommended: true },
						{ id: "canary", label: "Canary" },
						{ id: "prod", label: "Production" },
					],
				},
			},
			BACKGROUND_CONTEXT,
		);

		// Secret-field record.
		await host.seedInteraction(
			root.id,
			{
				kind: "questions.form",
				callId: "shot-secret",
				status: "pending",
				createdAt: Date.now(),
				body: {
					text: "Provider credentials needed for the migration.",
					fields: [
						{ name: "apikey", type: "secret", label: "API key", required: true },
						{ name: "account", type: "string", label: "Account" },
					],
				},
			},
			BACKGROUND_CONTEXT,
		);

		// Diff record.
		await host.seedInteraction(
			root.id,
			{
				kind: "gating.confirm",
				callId: "shot-diff",
				status: "pending",
				createdAt: Date.now(),
				body: {
					text: "warden: accept this steering rewrite?",
					diff: {
						before: "rm -rf /tmp/scratch-build",
						after: "rm -r -i /tmp/scratch-build --preserve-root",
					},
					options: [{ id: "accept", label: "Accept rewrite", tone: "ok" }],
				},
			},
			BACKGROUND_CONTEXT,
		);

		// Ambient surfaces: a goal-ish panel, a powerline-ish statusline,
		// a ledger, and a gauge.
		await host.setAmbient(
			root.id,
			{
				key: "goal",
				place: "panel",
				maxRows: 6,
				body: {
					line: { text: "active 18k/100k · automatic 12/25" },
					rows: [
						{ id: "t1", label: "Write the parser", status: "completed", depth: 0 },
						{ id: "t2", label: "Wire the loader", status: "running", depth: 0, spinnerLabel: "wiring the loader" },
						{ id: "t2a", label: "resolution order", status: "running", depth: 1, spinnerLabel: "packages dir first" },
						{ id: "t3", label: "Ship the docs", status: "pending", depth: 0, deps: ["t2"] },
						{ id: "t4", label: "quiet subtask", status: "ok", quiet: true },
					],
				},
			},
			BACKGROUND_CONTEXT,
		);
		await host.setAmbient(
			root.id,
			{
				key: "powerline",
				place: "status",
				refreshMs: 60_000,
				body: {
					line: {
						text: "",
						segments: [
							{ id: "model", text: "glm-5.3-flash", place: "left" },
							{ id: "git", text: " main*", place: "left" },
							{ id: "tokens", text: "18.2k tok", place: "middle" },
							{ id: "cost", text: "$0.0421", place: "right" },
						],
					},
				},
			},
			BACKGROUND_CONTEXT,
		);
		await host.setAmbient(
			root.id,
			{
				key: "audit",
				place: "panel",
				body: {
					gauge: {
						label: "completion audit",
						percent: 62,
						phase: "producing_report",
						elapsedMs: 3400,
						checks: [
							{ id: "c1", label: "tests pass", status: "completed" },
							{ id: "c2", label: "lint clean", status: "running" },
						],
					},
				},
			},
			BACKGROUND_CONTEXT,
		);

		await page.goto(`${server.url}/`);
		await page.waitForSelector(".ambient-surface", { timeout: 30_000 });

		// Full-page shot: sidebar + transcript + both seam zones.
		await page.screenshot({ path: join(SHOT_DIR, "seam-full.png"), fullPage: true });
	});

	test("interaction card answers through the UI (allow)", async ({ page }) => {
		await page.goto(`${server.url}/`);
		await page.waitForSelector(".interaction-card", { timeout: 30_000 });
		// Answer the confirm card: click the first option's radio + submit.
		const card = page.locator('[data-kind="gating.confirm"]').first();
		await card.locator('input[type="radio"]').first().check();
		await card.locator("button.interaction-submit").click();
		await page.waitForTimeout(500);
		await page.screenshot({ path: join(SHOT_DIR, "seam-after-answer.png"), fullPage: true });
	});

	test("final: the interactions list drains as answers land", async ({ page }) => {
		// Re-seed one answerable card (the previous test drained the rest —
		// which is itself the drain behavior under test).
		const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
		const host = server.opened.seamHosts.get("sigrun.fixture-visual");
		if (host === undefined) throw new Error("seam host missing");
		await host.seedInteraction(
			server.conversationId,
			{
				kind: "gating.confirm",
				callId: "shot-final",
				status: "pending",
				createdAt: Date.now(),
				body: {
					text: "final gate: proceed?",
					options: [{ id: "go", label: "Go", tone: "ok" }],
				},
			},
			BACKGROUND_CONTEXT,
		);
		await page.goto(`${server.url}/`);
		await page.waitForSelector(".interaction-card", { timeout: 30_000 });
		// Answer all remaining cards.
		const cards = page.locator(".interaction-card");
		const count = await cards.count();
		for (let i = 0; i < count; i += 1) {
			const card = cards.nth(i);
			const radio = card.locator('input[type="radio"]').first();
			const checkbox = card.locator('input[type="checkbox"]').first();
			const textInput = card.locator('input[type="text"]').first();
			if (await radio.isVisible().catch(() => false)) {
				await radio.click();
			} else if (await checkbox.isVisible().catch(() => false)) {
				await checkbox.click();
			} else if (await textInput.isVisible().catch(() => false)) {
				await textInput.fill("probe-value");
			}
			const submit = card.locator("button.interaction-submit");
			if ((await submit.count()) > 0 && (await submit.isEnabled())) {
				await submit.click();
			}
		}
		await page.waitForTimeout(800);
		await page.screenshot({ path: join(SHOT_DIR, "seam-drained.png"), fullPage: true });
	});
});

/** The reserved root conversation id. */
async function opened_root(): Promise<{ id: number }> {
	return { id: server.conversationId };
}
