/**
 * Visual verification for the seam rendering (interaction cards + ambient
 * panels): seeds RICH records through the real server's seam hosts and
 * screenshots the rendered surfaces. Screenshots land in
 * webui/test-results/seam-visual/ for human review; the assertions are
 * sanity-only (presence, not pixel judgment — the human reviews the shots).
 *
 * UI-blocks U6: every seeded record is a BLOCK TREE (spec §9.1/§9.2 — the
 * old `text`/`options`/`fields`/`diff`/`line`/`rows`/`gauge` shapes are
 * gone, ruling 16). The trees are built with the host's builders
 * (`@sigrun/sigrun/blocks`, spec §14.1).
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { SeamHost } from "../../src/harness/seam-host.js";
import type { InteractionRecord } from "@sigrun/shared/interactions";
import {
	bind,
	card,
	choice,
	collection,
	columns,
	form,
	markdown,
	meter,
	secret,
	section,
	text,
	tree,
} from "../../src/blocks/index.js";
import { bootE2EServer, type E2EServer } from "./harness.js";

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
		const host = seamHost();

		const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
		const root = server.conversationId;

		// Rich warden-style confirm record: markdown for the command and
		// reasons, and a toned choice (the old `text` + `options` mapped
		// per spec §9.1; tone `ok`/`danger` → `good`/`bad`).
		await seed(host, root, {
			kind: "gating.confirm",
			callId: "shot-confirm",
			status: "pending",
			createdAt: Date.now(),
			body: tree(
				form({
					id: "confirm",
					bind: "/values",
					mode: "submit",
					children: [
						section({
							title: "Prompt",
							children: [
								markdown({
									text: "warden: allow this bash call?\nrm -rf /tmp/scratch-build\nWhy: destructive, recursive, absolute path · Jev severity 0.82",
								}),
							],
						}),
						choice({
							name: "decision",
							label: "Verdict",
							options: [
								{ id: "allow", label: "Allow once", tone: "good" },
								{ id: "allow-session", label: "Allow for this session", tone: "warn" },
								{ id: "deny", label: "Deny", tone: "bad" },
							],
						}),
					],
				}),
			),
		}, BACKGROUND_CONTEXT);

		// Questionnaire record (a multi choice inside a section).
		await seed(host, root, {
			kind: "questions.form",
			callId: "shot-form",
			status: "pending",
			createdAt: Date.now(),
			details: { multi: true } as never,
			body: tree(
				form({
					id: "deploy",
					bind: "/values",
					mode: "submit",
					children: [
						section({
							title: "Deploy",
							children: [
								markdown({ text: "Which environments should receive the deploy?" }),
								choice({
									name: "envs",
									label: "Environments",
									multi: true,
									options: [
										{ id: "staging", label: "Staging", recommended: true },
										{ id: "canary", label: "Canary" },
										{ id: "prod", label: "Production" },
									],
								}),
							],
						}),
					],
				}),
			),
		}, BACKGROUND_CONTEXT);

		// Secret-field record (the migration-credentials shape).
		await seed(host, root, {
			kind: "questions.form",
			callId: "shot-secret",
			status: "pending",
			createdAt: Date.now(),
			body: tree(
				form({
					id: "creds",
					bind: "/values",
					mode: "submit",
					children: [
						section({
							children: [
								markdown({ text: "Provider credentials needed for the migration." }),
							],
						}),
						secret({ name: "apikey", label: "API key", required: true }),
						text({ name: "account", label: "Account" }),
					],
				}),
			),
		}, BACKGROUND_CONTEXT);

		// Diff record (a steering rewrite gate; spec §9.1's `diff` mapping).
		await seed(host, root, {
			kind: "gating.confirm",
			callId: "shot-diff",
			status: "pending",
			createdAt: Date.now(),
			body: tree(
				form({
					id: "rewrite",
					bind: "/values",
					mode: "submit",
					children: [
						section({
							title: "Rewrite",
							children: [
								markdown({ text: "warden: accept this steering rewrite?" }),
								{
									type: "diff",
									before: "rm -rf /tmp/scratch-build",
									after: "rm -r -i /tmp/scratch-build --preserve-root",
								},
							],
						}),
						choice({
							name: "decision",
							label: "Verdict",
							options: [
								{ id: "accept", label: "Accept rewrite", tone: "good" },
							],
						}),
					],
				}),
			),
		}, BACKGROUND_CONTEXT);

		// Ambient surfaces: a goal-ish panel, a powerline-ish statusline,
		// and an audit panel — all mapped per spec §9.2. Ambient
		// collections carry LITERAL rows (the 2026-10-24 ruling: ambient
		// bodies never bind — no "/rows" collections); `segments[]` → a
		// one-line `columns` of one-line blocks, `gauge` → a meter.
		await host.setAmbient(
			idOf(root),
			{
				key: "goal",
				place: "panel",
				maxRows: 6,
				body: tree(
					collection({
						id: "goal",
						items: [
							{ id: "g1", label: "parse the spec", status: "running", deps: [] },
							{ id: "g2", label: "write the plan", status: "pending", deps: ["g1"] },
							{ id: "g3", label: "execute tasks", status: "pending", deps: ["g2"] },
							{ id: "g4", label: "sweep", status: "done", quiet: true, deps: ["g3"] },
						],
						display: "list",
						item: card({
							title: bind("./label"),
							status: { label: bind("./status") },
							quiet: bind("./quiet"),
							deps: bind("./deps"),
						}),
					}),
				),
			},
			BACKGROUND_CONTEXT,
		);
		await host.setAmbient(
			idOf(root),
			{
				key: "powerline",
				place: "status",
				refreshMs: 60_000,
				body: tree(
					columns({
						children: [
							{ block: markdown({ text: "glm-5.3-flash" }) },
							{ block: markdown({ text: " main*" }) },
							{ block: markdown({ text: "18.2k tok" }) },
							{ block: markdown({ text: "$0.0421" }) },
						],
					}),
				),
			},
			BACKGROUND_CONTEXT,
		);
		await host.setAmbient(
			idOf(root),
			{
				key: "audit",
				place: "panel",
				body: tree(meter({ value: 0.4, format: "percent", label: "audit" })),
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
		// Answer the confirm card: pick the first option's radio (the tree
		// form submits through `blk-form-submit` — the Task 3 rewrite).
		const card = page.locator('[data-kind="gating.confirm"]').first();
		await card.locator('input[type="radio"]').first().check();
		await card.locator("button.blk-form-submit").click();
		await page.waitForTimeout(500);
		await page.screenshot({ path: join(SHOT_DIR, "seam-after-answer.png"), fullPage: true });
	});

	test("final: the interactions list drains as answers land", async ({ page }) => {
		// Re-seed one answerable card (the previous test drained the rest —
		// which is itself the drain behavior under test).
		const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
		const host = seamHost();
		await seed(host, server.conversationId, {
			kind: "gating.confirm",
			callId: "shot-final",
			status: "pending",
			createdAt: Date.now(),
			body: tree(
				form({
					id: "final",
					bind: "/values",
					mode: "submit",
					children: [
						section({
							children: [markdown({ text: "final gate: proceed?" })],
						}),
						choice({
							name: "decision",
							label: "Verdict",
							options: [{ id: "go", label: "Go", tone: "good" }],
						}),
					],
				}),
			),
		}, BACKGROUND_CONTEXT);
		await page.goto(`${server.url}/`);
		await page.waitForSelector(".interaction-card", { timeout: 30_000 });
		// Answer all remaining cards (the multi stepper walks its
		// sections before its submit shows; radios before checkboxes
		// before text inputs).
		const cards = page.locator(".interaction-card");
		while ((await cards.count()) > 0) {
			const remaining = await cards.count();
			const card = cards.first();
			for (;;) {
				const next = card.locator(".blk-stepper-nav button", { hasText: /Next|Review/ });
				if ((await next.count()) > 0 && (await next.first().isVisible())) {
					await next.first().click();
					continue;
				}
				const radio = card.locator('input[type="radio"]:not(:checked)').first();
				const checkbox = card.locator('input[type="checkbox"]:not(:checked)').first();
				const textInput = card.locator('input[type="text"]').first();
				const secretInput = card.locator('input[type="password"]').first();
				if (await radio.isVisible().catch(() => false)) {
					await radio.check();
				} else if (await checkbox.isVisible().catch(() => false)) {
					await checkbox.check();
				} else if (await secretInput.isVisible().catch(() => false)) {
					await secretInput.fill("synthetic-secret");
				} else if (await textInput.isVisible().catch(() => false)) {
					await textInput.fill("probe-value");
				}
				const submit = card.locator("button.blk-form-submit");
				if ((await submit.count()) > 0 && (await submit.isVisible())) {
					await submit.click();
					await expect(cards).toHaveCount(remaining - 1);
					break;
				}
				break;
			}
		}
		await expect(page.locator(".interaction-card")).toHaveCount(0);
		await page.screenshot({ path: join(SHOT_DIR, "seam-drained.png"), fullPage: true });
	});
});

/** The visual fixture's seam host (named once, so each test fails loudly). */
function seamHost(): SeamHost {
	const host = server.opened.seamHosts.get("sigrun-fixture-visual");
	if (host === undefined) throw new Error("seam host missing — fixture did not load");
	return host;
}

/**
 * The e2e harness's conversation id as the host's branded id.
 * SAFETY: the harness's plain number is the branded ConversationId's
 * runtime value (the wire type and the storage key are the same).
 */
function idOf(root: number): ConversationId {
	return root as unknown as ConversationId;
}

/** Seed one interaction through the seam host. */
async function seed(
	host: SeamHost,
	root: number,
	record: InteractionRecord,
	context: Context,
): Promise<void> {
	await host.seedInteraction(idOf(root), record, context);
}
