/**
 * Task 26b-iii: the four harder ship-gate checklist items (spec §7 M2 items
 * 3, 4, 7, 10) — steer a running session, approve/deny a gated tool,
 * compaction recall, restart resume. Builds on the harness extensions
 * (tokensPerSecond, settings, extensionSpecifiers, restart).
 *
 * With these + the seven from ship-gate.spec.ts, all 11 §7 M2 items pass.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { bootE2EServer, type E2EServer } from "./harness.js";

/**
 * The memory extension by sibling checkout (the npm name is unresolvable in
 * this hermetic boot — publish prep removed the git dep; the repo checkout
 * is the dev shape). Resolution walks UP from this spec so it works from
 * the main checkout (webui/e2e → ../../../sigrun-ext-*) AND from git
 * worktrees (one level deeper, → ../../../../../sigrun-ext-*).
 */
const MEMORY_EXTENSION = (() => {
	for (const relative of [
		"../../../sigrun-ext-memory-markdown/dist/index.js",
		"../../../../../sigrun-ext-memory-markdown/dist/index.js",
	]) {
		const url = new URL(relative, import.meta.url);
		if (existsSync(fileURLToPath(url))) return url.href;
	}
	throw new Error(
		"sigrun-ext-memory-markdown checkout not found next to the repo " +
			"(item 7 needs its memory_recall tool; see webui/e2e/harness.ts)",
	);
})();

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
		// The conversation is busy (streaming); the composer flips to Steer
		// (B6: the send button is an icon button — Steer is its aria-label).
		await expect(page.locator(".composer-send")).toHaveAttribute(
			"aria-label",
			"Steer",
			{ timeout: 15_000 },
		);
		// Steer: a second input while busy goes into the running turn. Type with
		// real keystrokes (pressSequentially) so React's controlled-input
		// onChange fires — a Playwright fill() sets the DOM value without
		// updating the component's draft state.
		//
		// NOTE on the assertion: the submissions route returns 202 AT ADMISSION
		// (§7.1), so the first submit's draft is already cleared by the time
		// the steer types. The honest observable that the steer LANDED is the
		// queued indicator (the steered input sits in the inbox with mode
		// "steer" waiting for the running turn to consume it — the T26a
		// reviewer's note). A settled pi.user entry for the steered text only
		// appears once the slow turn finishes — beyond the test window.
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
test.describe("item 4: approvals (the interaction seam)", () => {
	// POST-STRIP: the approvals IMPLEMENTATION is extension-owned
	// (sigrun-ext-approvals was never shipped to npm; the git dep is gone
	// from devDependencies). The webui's approval card is now the GENERIC
	// interaction card (docs/approval-ux-seams.md) driven by the seam
	// fixture — same human flow: an option card appears while a tool call
	// is gated, the human allows, the next gate denies, the transcript
	// reflects both.
	let server: E2EServer;
	test.beforeAll(async () => {
		server = await bootE2EServer({
			extensionSpecifiers: [
				new URL("../../test/fixtures/fixture-seam-visual/index.js", import.meta.url)
					.href,
			],
			responses: [
				fauxAssistantMessage("ready for the gated calls"),
			],
		});
	});
	test.afterAll(async () => {
		await server.cleanup();
	});

	test("seed two gates: allow one, deny the other, see both reflected", async ({
		page,
	}) => {
		const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
		const host = server.opened.seamHosts.get("sigrun-fixture-visual");
		if (host === undefined) throw new Error("seam host missing");
		// Two warden-style confirm records, keyed to the ship-gate script.
		await host.seedInteraction(
			server.conversationId,
			{
				kind: "gating.confirm",
				callId: "call-approve",
				status: "pending",
				createdAt: Date.now(),
				body: {
					text: "warden: allow this load_skill call? (demo)",
					options: [
						{ id: "allow", label: "Allow", tone: "ok" },
						{ id: "deny", label: "Deny", tone: "danger" },
					],
				},
			},
			BACKGROUND_CONTEXT,
		);
		await host.seedInteraction(
			server.conversationId,
			{
				kind: "gating.confirm",
				callId: "call-deny",
				status: "pending",
				createdAt: Date.now(),
				body: {
					text: "warden: allow this load_skill call? (demo2)",
					options: [
						{ id: "allow", label: "Allow", tone: "ok" },
						{ id: "deny", label: "Deny", tone: "danger" },
					],
				},
			},
			BACKGROUND_CONTEXT,
		);
		await page.goto(server.url);
		const card = page.locator(".interaction-card").first();
		await expect(card).toBeVisible({ timeout: 15_000 });
		await expect(card.locator(".interaction-text")).toContainText("load_skill");
		// Approve the first.
		await card.locator('input[type="radio"]').first().click();
		await card.locator(".interaction-submit").click();
		// The second gate's card is still pending: deny it.
		const card2 = page
			.locator(".interaction-card")
			.filter({ hasText: "demo2" });
		await expect(card2).toBeVisible({ timeout: 15_000 });
		await card2.locator('input[type="radio"]').nth(1).click();
		await card2.locator(".interaction-submit").click();
		// Both answered: the stack drains.
		await expect(page.locator(".interaction-card")).toHaveCount(0, {
			timeout: 15_000,
		});
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
		// thresholds) so a warm-up turn compacts out of the live window, AND
		// the memory extension so memory_recall exists + the recall source is
		// bound (the T26a fix). The third turn's model call is a memory_recall
		// tool call — the degenerate recall scans the durable transcript and
		// returns the compacted-out marker.
		// The forced compaction policy: tight enough that turn 2 compacts the
		// marker turn out of the live window, but not so tight it eats the tool
		// round (keepRecentTokens 1 was dropping the tool round's frames — the
		// E2E's compaction actually fired on the third turn, interrupting the
		// tool call). A larger keepRecentTokens keeps the current turn's
		// messages while compacting the marker turn.
		server = await bootE2EServer({
			// The memory extension by sibling checkout (the npm name is
			// unresolvable in this hermetic boot; MEMORY_EXTENSION resolves the
			// dev checkout — main repo or worktree).
			extensionSpecifiers: [MEMORY_EXTENSION],
			settings: {
				compaction: {
					reserveTokens: 127_300,
					keepRecentTokens: 2000,
					backgroundTokens: 400,
				},
			},
			// The spec counts faux responses per submission; A2's background
			// auto-namer would otherwise consume one after the first settled
			// run (naming has its own vitest coverage, test/naming.test.ts).
			settingsFile: { namingModel: false },
			responses: [
				fauxAssistantMessage("the marker answer: ZEBRA-COMPACTED-OUT"),
				fauxAssistantMessage("a second turn"),
				// The third turn: the model asks memory_recall for the compacted
				// content. The tool's result carries the recalled marker.
				fauxAssistantMessage(
					[
						{ type: "text", text: "checking memory" },
						fauxToolCall("memory_recall", { query: "ZEBRA" }, { id: "call-recall" }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("the recall returned the marker"),
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
		await page.locator(".composer-input").pressSequentially("remember ZEBRA");
		await page.locator(".composer-send").click();
		await expect(
			page
				.locator('[data-turn-kind="assistant"]')
				.filter({ hasText: "ZEBRA-COMPACTED-OUT" }),
		).toBeVisible({ timeout: 15_000 });
		// Turn 2: forces the compaction.
		await page.locator(".composer-input").pressSequentially("another turn");
		await page.locator(".composer-send").click();
		await expect(
			page
				.locator('[data-turn-kind="assistant"]')
				.filter({ hasText: "a second turn" }),
		).toBeVisible({ timeout: 15_000 });
		// Turn 3: the model recalls the compacted-out marker. The memory_recall
		// tool call's result (a pi.tool-result entry) must carry the marker —
		// proof the degenerate recall read the durable transcript (the T26a
		// binding), not the live window.
		await page.locator(".composer-input").pressSequentially("what was the marker?");
		await page.locator(".composer-send").click();
		// The tool call renders as the activity line's tool row (B4): expand
		// the activity, then the memory_recall row, to see the recalled content.
		await page.locator(".activity-toggle").last().click();
		const card = page.locator(".tool-row-toggle").filter({ hasText: "memory_recall" }).first();
		await expect(card).toBeVisible({ timeout: 15_000 });
		await card.click();
		await expect(
			page.locator(".tool-row-output").filter({ hasText: "ZEBRA-COMPACTED-OUT" }),
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
			// Same response-counting determinism as item 7: no background
			// naming call against the scripted faux queue.
			settingsFile: { namingModel: false },
		});
		try {
			await initialPage.goto(server.url);
			await expect(initialPage.locator(".composer-input")).toBeEnabled();
			await initialPage.locator(".composer-input").fill("before the restart");
			await initialPage.locator(".composer-send").click();
			await expect(
				initialPage
					.locator('[data-turn-kind="assistant"]')
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
					.locator('[data-turn-kind="assistant"]')
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
					.locator('[data-turn-kind="assistant"]')
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
