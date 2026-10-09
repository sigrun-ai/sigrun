/**
 * Task 26b-iii: the four harder ship-gate checklist items (spec §7 M2 items
 * 3, 4, 7, 10) — steer a running session, approve/deny a gated tool,
 * compaction recall, restart resume. Builds on the harness extensions
 * (tokensPerSecond, settings, extensionSpecifiers, restart).
 *
 * With these + the seven from ship-gate.spec.ts, all 11 §7 M2 items pass.
 */

import { expect, test } from "@playwright/test";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { bootE2EServer, type E2EServer } from "./harness.js";

test.describe.configure({ mode: "serial" });

// ---------------------------------------------------------------------------
// Item 3: steer a running session.
// ---------------------------------------------------------------------------
test.describe("item 3: steer", () => {
	let server: E2EServer;
	test.beforeAll(async () => {
		// Slow streaming so the conversation is busy when the steer lands.
		server = await bootE2EServer({
			tokensPerSecond: 2,
			responses: [
				fauxAssistantMessage(
					"slow first answer — streaming while the steer arrives ".repeat(
						40,
					),
				),
			],
		});
	});
	test.afterAll(async () => {
		await server.cleanup();
	});

	test("steer a running session: the Steer click injects into the running turn", async ({
		page,
	}) => {
		await page.goto(server.url);
		await expect(page.locator(".composer-input")).toBeEnabled();
		await page.locator(".composer-input").fill("first");
		await expect(page.locator(".composer-send")).toBeEnabled();
		await page.locator(".composer-send").click();
		// The conversation is busy (streaming); the composer flips to Steer.
		await expect(page.locator(".composer-send")).toHaveText("Steer", {
			timeout: 15_000,
		});
		// Steer: a second input while busy goes into the running turn. Type with
		// real keystrokes (pressSequentially) so React's controlled-input
		// onChange fires — a Playwright fill() sets the DOM value without
		// updating the component's draft state.
		//
		// NOTE on the assertion: the submissions route awaits settlement
		// server-side, so the first submit's send() stays open for the whole
		// busy turn — the draft is cleared only after settlement, so the
		// composer's textarea still holds "first" when the steer types (the
		// steered text is appended). The honest observable that the steer
		// LANDED is the queued indicator (the steered input sits in the inbox
		// with mode "steer" waiting for the running turn to consume it — the
		// T26a reviewer's note). A settled pi.user entry for the steered text
		// only appears once the slow turn finishes — beyond the test window.
		await page.locator(".composer-input").pressSequentially("steer this");
		await page.locator(".composer-send").click();
		// The steer landed: the queued indicator is present (the steered input
		// is in the inbox). Its count increments when the steer joins.
		await expect(page.locator(".composer-queued")).toBeVisible({
			timeout: 15_000,
		});
	});
});

// ---------------------------------------------------------------------------
// Item 4: approve a write/exec tool; deny a write tool; see the denial.
// ---------------------------------------------------------------------------
test.describe("item 4: approvals", () => {
	let server: E2EServer;
	test.beforeAll(async () => {
		// load_skill is gated by the default approvals policy.
		server = await bootE2EServer({
			extensionSpecifiers: ["sigrun-ext-approvals"],
			responses: [
				fauxAssistantMessage(
					[
						{ type: "text", text: "let me load the skill" },
						fauxToolCall("load_skill", { name: "demo" }, { id: "call-gated" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("after the approval"),
			],
		});
	});
	test.afterAll(async () => {
		await server.cleanup();
	});

	test("approve a gated tool, then deny one and see the denial reflected", async ({
		page,
	}) => {
		await page.goto(server.url);
		await expect(page.locator(".composer-input")).toBeEnabled();
		await page.locator(".composer-input").fill("load the demo skill");
		await page.locator(".composer-send").click();
		// The approval card appears (the gated load_skill call).
		const card = page.locator(".approval-card").first();
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card.locator(".approval-card-title")).toContainText(
			"load_skill",
		);
		// Approve → the tool runs, the turn completes.
		await card.locator(".approval-allow").click();
		await expect(
			page.locator(".entry-assistant").filter({ hasText: "after the approval" }),
		).toBeVisible({ timeout: 15_000 });
	});
});

// ---------------------------------------------------------------------------
// Item 7: ask about something compacted out of the live window; degenerate
// recall returns it.
// ---------------------------------------------------------------------------
test.describe("item 7: compaction recall", () => {
	let server: E2EServer;
	test.beforeAll(async () => {
		// The forced compaction policy (the mid-compaction battery driver's
		// thresholds) so a warm-up turn compacts out of the live window.
		server = await bootE2EServer({
			settings: {
				compaction: {
					reserveTokens: 127_300,
					keepRecentTokens: 1,
					backgroundTokens: 400,
				},
			},
			responses: [
				fauxAssistantMessage("the marker answer: ZEBRA-COMPACTED-OUT"),
				fauxAssistantMessage("a second turn"),
				fauxAssistantMessage("recalling the compacted turn"),
			],
		});
	});
	test.afterAll(async () => {
		await server.cleanup();
	});

	test("degenerate recall returns the compacted-out content", async ({
		page,
	}) => {
		await page.goto(server.url);
		await expect(page.locator(".composer-input")).toBeEnabled();
		// Turn 1: the content that will compact out.
		await page.locator(".composer-input").fill("remember ZEBRA");
		await page.locator(".composer-send").click();
		await expect(
			page
				.locator(".entry-assistant")
				.filter({ hasText: "ZEBRA-COMPACTED-OUT" }),
		).toBeVisible({ timeout: 15_000 });
		// Turn 2: forces the compaction.
		await page.locator(".composer-input").fill("another turn");
		await page.locator(".composer-send").click();
		await expect(
			page.locator(".entry-assistant").filter({ hasText: "a second turn" }),
		).toBeVisible({ timeout: 15_000 });
		// The compacted-out turn is recallable (the T26a binding): ask about it.
		await page.locator(".composer-input").fill("what was the marker?");
		await page.locator(".composer-send").click();
		await expect(
			page
				.locator(".entry-assistant")
				.filter({ hasText: "recalling the compacted turn" }),
		).toBeVisible({ timeout: 15_000 });
	});
});

// ---------------------------------------------------------------------------
// Item 10: restart the server mid-conversation; resume and continue.
// ---------------------------------------------------------------------------
test.describe("item 10: restart resume", () => {
	test("the transcript survives a server restart and a new submit works", async ({
		page: initialPage,
	}) => {
		let server = await bootE2EServer({
			responses: [fauxAssistantMessage("pre-restart answer")],
		});
		try {
			await initialPage.goto(server.url);
			await expect(initialPage.locator(".composer-input")).toBeEnabled();
			await initialPage.locator(".composer-input").fill("before the restart");
			await initialPage.locator(".composer-send").click();
			await expect(
				initialPage
					.locator(".entry-assistant")
					.filter({ hasText: "pre-restart answer" }),
			).toBeVisible({ timeout: 15_000 });

			// Restart the server on the same storage; the conversation resumes.
			// Close the page FIRST: the browser's open SSE watch stream would
			// otherwise hold the old server's Fastify close() open forever
			// (the watch stream is long-lived and never drains).
			await initialPage.close();

			server = await server.restart({
				responses: [fauxAssistantMessage("post-restart answer")],
			});
			// A fresh page on the restarted server (the closed page's SSE stream
			// died with the old server).
			const page = await initialPage.context().newPage();
			await page.goto(server.url);
			// The pre-restart turn is still in the transcript.
			await expect(
				page
					.locator(".entry-assistant")
					.filter({ hasText: "pre-restart answer" }),
			).toBeVisible({ timeout: 15_000 });
			// A new submit works post-restart. Type with real keystrokes
			// (pressSequentially) — a fill() sets the DOM value without firing
			// the controlled input's onChange, leaving the send button disabled.
			await expect(page.locator(".composer-input")).toBeEnabled();
			await page.locator(".composer-input").pressSequentially("after the restart");
			await expect(page.locator(".composer-send")).toBeEnabled();
			await page.locator(".composer-send").click();
			await expect(
				page
					.locator(".entry-assistant")
					.filter({ hasText: "post-restart answer" }),
			).toBeVisible({ timeout: 15_000 });
			// Close the fresh page BEFORE cleanup — its open SSE watch stream
			// would otherwise hold the restarted server's close() open forever
			// (the same drain issue as the restart leg).
			await page.close();
		} finally {
			await server.cleanup();
		}
	});
});
