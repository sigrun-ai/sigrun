/**
 * Ask-user plan Task 10: the REAL @sigrun/ask-user extension end to end
 * in a browser against the real server — the final task of the plan.
 * The extension loads from the sibling repo's built `dist/` (the
 * escalations-inbox.spec.ts pattern), the faux provider is scripted to
 * call `ask_user_question`, and the browser answers / declines through
 * the REAL card chrome (stepper, review, Decline button, composer
 * decline-by-message).
 *
 * Cases (the brief's Step 1):
 *
 * 1. A two-question ask (q1 single with a `(Recommended)` option and a
 *    `preview`; q2 multi): the stepper shows "Step 1 of 2", the
 *    recommended badge and the preview pane; the review shows
 *    "Not answered yet" until q2 is answered; Submit sends; the tool
 *    result in the transcript carries the `<header>: <label>` answer
 *    lines — the TEXT assertion (Task 9 review P2, binding): the real
 *    guard against a hand-built nested-vs-plain answer literal passing
 *    unit tests while the wire event carries a different shape.
 * 2. Typing `neither, use sqlite` while a question waits: the composer
 *    placeholder reads "Sending a message declines the open question"
 *    first; the card settles away (settled records leave the pending
 *    list — core Task 1 design; the "Declined — replied in chat"
 *    chrome text is pinned by the Task 5 component unit tests); the
 *    tool result carries the message-decline sentence; the user bubble
 *    FOLLOWS it.
 * 3. The Decline button settles the card away (same pending-list
 *    rule) and the tool result carries the button-decline sentence.
 * 4. RESTART (Review Focus 1): while a question waits,
 *    `E2EServer.restart()` re-boots on the SAME storage (post-restart
 *    faux responses passed in); the card is still pending after the
 *    restart and answering it completes the run — this proves the
 *    harness.ts teardown change (`eventBus.shutdownSequence`) fires
 *    `harnessShutdown`, without which the tool's abort path would
 *    cancel the record instead of leaving it pending.
 * 5. No quarantine: `/v1/meta` lists no load error for `ask-user`, and
 *    the seeded card passed core tree validation (case 1 failing would
 *    cover the latter).
 *
 * Synthetic content only (the fixture's own literals).
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { bootE2EServer, siblingRepo, type E2EServer } from "./harness.js";

/** The real extension's built entry (sibling repo's committed dist). */
const ASK_USER = pathToFileURL(
	join(siblingRepo("sigrun-ask-user"), "dist", "index.js"),
).href;

/** The ask the first three cases drive. q1 is single-select with one
 *  recommended option carrying a preview; q2 is multi-select. */
const ASK_ARGS = {
	questions: [
		{
			question: "Which storage engine should the demo use?",
			header: "Engine",
			options: [
				{
					label: "sqlite (Recommended)",
					description: "zero-setup, file-backed",
					preview: "**sqlite**: one file, no server process.",
				},
				{ label: "postgres", description: "needs a running server" },
			],
		},
		{
			question: "Which features go in the first cut?",
			header: "Features",
			multiSelect: true,
			options: [
				{ label: "search", description: "full-text lookup" },
				{ label: "export", description: "jsonl dump" },
			],
		},
	],
} as unknown as import("@sigrun/shared/blocks").JsonObject;

/** The `<header>: <label>` answer lines the tool result must carry
 *  (Task 9 review P2 — assert the RENDERED text, never just status). */
const ANSWER_LINES = ["Engine: sqlite", "Features: search, export"];

/** Script: call ask_user_question, then (after the answer lands) reply. */
function askThenReply(reply: string, callId: string) {
	return [
		fauxAssistantMessage(
			[
				{ type: "text" as const, text: "asking" },
				fauxToolCall("ask_user_question", ASK_ARGS, { id: callId }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(reply),
	];
}

/** Settle the boot default selection and send one message (the
 *  ship-gate pattern: fill() then click once enabled). */
async function sendMessage(
	page: import("@playwright/test").Page,
	text: string,
): Promise<void> {
	await expect(page.locator("li.session-item-active")).toHaveCount(1);
	await expect(page.locator(".composer-input")).toBeEnabled();
	await page.locator(".composer-input").fill(text);
	await expect(page.locator(".composer-send")).toBeEnabled();
	await page.locator(".composer-send").click();
}

/** The pending ask card (exactly one while a question waits). */
function askCard(page: import("@playwright/test").Page) {
	return page.locator('.interaction-card[data-kind="ask.questions"]');
}

/** Expand the LATEST `ask_user_question` tool row and return its output.
 *  Cases 1-3 share one conversation, so several ask rows exist — `.last()`
 *  is the current case's. */
async function toolOutput(
	page: import("@playwright/test").Page,
): Promise<import("@playwright/test").Locator> {
	// Grouped view folds tools under the ActivityLine; expand every fold
	// (the ship-gate pattern). Timeline mode has no fold — the toggle is
	// absent there, so this helper is timeline-safe.
	for (const toggle of await page.locator(".activity-toggle").all()) {
		if (await toggle.isVisible()) await toggle.click();
	}
	const row = page
		.locator(".tool-row")
		.filter({
			has: page.locator(".tool-row-toggle", { hasText: "ask_user_question" }),
		})
		.last();
	await expect(row).toBeVisible({ timeout: 15_000 });
	await row.locator(".tool-row-toggle").click();
	const output = row.locator(".tool-row-output");
	await expect(output).toBeVisible({ timeout: 15_000 });
	return output;
}

test.describe("ask_user_question end to end", () => {
	let server: E2EServer;

	test.beforeAll(async () => {
		server = await bootE2EServer({
			extensionSpecifiers: [ASK_USER],
			responses: [
				// Case 1: the two-question ask, then the wrap-up reply.
				...askThenReply("ok", "call-ask-1"),
				// Case 2: a second ask; the user's message declines it.
				...askThenReply("ok", "call-ask-2"),
				// Case 3: a third ask; the Decline button settles it.
				...askThenReply("ok", "call-ask-3"),
			],
		});
	});

	test.afterAll(async () => {
		await server.cleanup();
	});

	test("no quarantine: /v1/meta lists ask-user with no load error", async () => {
		const meta = (await (
			await fetch(`${server.url}/v1/meta`)
		).json()) as {
			extensions: { name: string; status: string; error?: string }[];
		};
		const entry = meta.extensions.find((one) => one.name === "ask-user");
		expect(entry, "ask-user must be listed in /v1/meta").toBeDefined();
		expect(entry?.status).toBe("ok");
		expect(entry?.error).toBeUndefined();
	});

	test("case 1: two questions — stepper, recommended badge, preview, review guard, submit", async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (cause) => errors.push(String(cause)));

		await page.goto(server.url);
		await sendMessage(page, "set up the demo");
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 15_000 });

		// Step 1 of 2; the section title is the header; the full question
		// text is the choice label.
		await expect(card.locator(".blk-stepper-progress")).toHaveText(
			"Step 1 of 2",
		);
		await expect(card).toContainText(
			"Which storage engine should the demo use?",
		);
		// The recommended badge (data-recommended on the option row; the
		// label is the SUFFIX-STRIPPED text) and the preview pane (focusing
		// the recommended option shows its markdown beside the options).
		const recommended = card.locator('[data-recommended="true"]');
		await expect(recommended).toHaveCount(1);
		await expect(recommended).toContainText("sqlite");
		await card
			.locator('input[type="radio"][value="o1"]')
			.focus();
		await expect(
			card.locator(".blk-choice-preview"),
		).toContainText("one file, no server process.");
		// The recommended option pre-selects (the §9.1 presentation rule),
		// so step 1 is already answered; advance with Next.
		await expect(
			card.locator('input[type="radio"][value="o1"]'),
		).toBeChecked();
		await card.getByRole("button", { name: "Next" }).click();

		// Step 2 of 2 (multi): pick both options with their checkboxes.
		await expect(card.locator(".blk-stepper-progress")).toHaveText(
			"Step 2 of 2",
		);
		await expect(card).toContainText("Which features go in the first cut?");
		await card.locator('input[type="checkbox"][value="o1"]').check();
		await card.locator('input[type="checkbox"][value="o2"]').check();
		await card.getByRole("button", { name: "Review" }).click();

		// The review lists the labels; q2 answered means no guard remains.
		// (The guard itself is exercised in the restart case below, where
		// q2 starts unanswered.)
		await expect(card.locator(".blk-stepper-review")).toContainText(
			"sqlite",
		);
		await expect(card.locator(".blk-stepper-review")).toContainText(
			"search, export",
		);
		await expect(card).not.toContainText("Not answered yet");

		// Submit once; the card settles (drains from the pending strip)
		// and the wrap-up reply lands.
		await card.getByRole("button", { name: "Submit answers" }).click();
		await expect(
			page.locator('[data-turn-kind="assistant"]').filter({ hasText: "ok" }),
		).toBeVisible({ timeout: 15_000 });

		// The BINDING assertion (Task 9 review P2): the tool result's
		// rendered text carries the `<header>: <label>` answer lines —
		// the wire shape end to end, not a hand-built nested literal.
		const output = await toolOutput(page);
		for (const line of ANSWER_LINES) {
			await expect(output).toContainText(line);
		}

		expect(errors).toEqual([]);
	});

	test("case 2: typing a message declines the open question", async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (cause) => errors.push(String(cause)));

		await page.goto(server.url);
		await sendMessage(page, "ask again");
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 15_000 });

		// The composer placeholder warns before typing (spec §5.3).
		await expect(page.locator(".composer-input")).toHaveAttribute(
			"placeholder",
			"Sending a message declines the open question",
		);

		// Typing the answer-in-prose declines the question. Settled cards
		// leave the pending list (core Task 1 design: a settled record is
		// absent from the per-conversation pending list the composer
		// polls), so the card settles AWAY — the decline story is carried
		// by the transcript: the tool result carries the message-decline
		// sentence, and the user bubble FOLLOWS it (the decline commit
		// lands before the message's own turn).
		await page.locator(".composer-input").fill("neither, use sqlite");
		await page.locator(".composer-send").click();
		await expect(card).toHaveCount(0, { timeout: 15_000 });
		const output = await toolOutput(page);
		await expect(output).toContainText(
			"The user declined to answer and replied in chat instead; their message follows.",
		);
		// The bubble is visible (order: the tool result's assistant turn
		// precedes the user's own turn in the transcript).
		const bubble = page
			.locator('[data-turn-kind="user"]')
			.filter({ hasText: "neither, use sqlite" });
		await expect(bubble).toBeVisible({ timeout: 15_000 });

		expect(errors).toEqual([]);
	});

	test("case 3: the Decline button settles the card", async ({ page }) => {
		const errors: string[] = [];
		page.on("pageerror", (cause) => errors.push(String(cause)));

		await page.goto(server.url);
		await sendMessage(page, "one more question");
		const card = askCard(page);
		await expect(card).toBeVisible({ timeout: 15_000 });

		// Decline sits in the card chrome (present on every stepper step).
		const decline = card.getByRole("button", { name: "Decline" });
		await expect(decline).toBeVisible();
		await decline.click();
		// Settled cards leave the pending list (core Task 1 design), so
		// the card settles away. The settled-card chrome text ("Declined")
		// stays pinned by the Task 5 InteractionCards component unit tests
		// — asserting it here would race the refetch that drains the card.
		await expect(card).toHaveCount(0, { timeout: 15_000 });
		const output = await toolOutput(page);
		await expect(output).toContainText("The user declined to answer.");

		expect(errors).toEqual([]);
	});

	test("case 4: restart while a question waits — the card stays pending and answering completes the run", async ({
		browser,
	}) => {
		const context = await browser.newContext();
		const page = await context.newPage();
		const errors: string[] = [];
		page.on("pageerror", (cause) => errors.push(String(cause)));

		// A SEPARATE server (the shared one's faux queue is consumed by
		// the cases above): boot on its own tmpdir, then restart it.
		let own = await bootE2EServer({
			extensionSpecifiers: [ASK_USER],
			responses: [
				...askThenReply("ok after restart", "call-ask-restart"),
			],
		});
		try {
			await page.goto(own.url);
			await sendMessage(page, "set up the demo");
			const card = askCard(page);
			await expect(card).toBeVisible({ timeout: 15_000 });

			// Leave both questions untouched so the review guard is
			// observable after the restart (q2 unanswered → "Not answered
			// yet" + Submit disabled). The fresh render's recommended
			// pre-select answers q1 (Engine: sqlite) on its own.

			// RESTART: close the page first (its SSE watch stream would
			// hold the old server's close() open — the ship-gate pattern),
			// then re-boot on the same storage with a fresh faux queue.
			await page.close();
			own = await own.restart({
				responses: [fauxAssistantMessage("ok after restart")],
			});

			const page2 = await context.newPage();
			page2.on("pageerror", (cause) => errors.push(String(cause)));
			await page2.goto(own.url);
			await expect(page2.locator("li.session-item-active")).toHaveCount(1);

			// The card is STILL pending (the clean-shutdown path left the
			// record open; the rerun re-seeded idempotently and snapshotted
			// — this is the assertion the harness.ts shutdownSequence change
			// makes meaningful).
			const card2 = askCard(page2);
			await expect(card2).toBeVisible({ timeout: 15_000 });
			await expect(card2.locator(".interaction-status")).toHaveCount(0);

			// q1 renders pre-selected (the recommended option); advance to
			// q2 and open the review WITHOUT answering: the guard names the
			// unanswered section and Submit stays disabled.
			await expect(
				card2.locator('input[type="radio"][value="o1"]'),
			).toBeChecked();
			await card2.getByRole("button", { name: "Next" }).click();
			await card2.getByRole("button", { name: "Review" }).click();
			await expect(card2).toContainText("Not answered yet: Features");
			await expect(
				card2.getByRole("button", { name: "Submit answers" }),
			).toBeDisabled();

			// Back to q2, answer it, review again: the guard clears and the
			// labels render.
			await card2.getByRole("button", { name: "Back" }).click();
			await card2
				.locator('input[type="checkbox"][value="o1"]')
				.check();
			await card2.getByRole("button", { name: "Review" }).click();
			await expect(card2).not.toContainText("Not answered yet");
			await expect(card2.locator(".blk-stepper-review")).toContainText(
				"sqlite",
			);

			// Finish: Submit answers, the run completes.
			await card2
				.getByRole("button", { name: "Submit answers" })
				.click();
			await expect(
				page2
					.locator('[data-turn-kind="assistant"]')
					.filter({ hasText: "ok after restart" }),
			).toBeVisible({ timeout: 20_000 });
			const output = await toolOutput(page2);
			await expect(output).toContainText("Engine: sqlite");
			await expect(output).toContainText("Features: search");

			await page2.close();
		} finally {
			await own.cleanup();
			await context.close();
		}
		expect(errors).toEqual([]);
	});
});
