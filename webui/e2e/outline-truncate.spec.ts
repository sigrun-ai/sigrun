/**
 * Task 7 (0.4.0 follow-up): the outline's 2-line clamp moved from the
 * padded button to the INNER .outline-text span, so a clamped prompt ends
 * inside the button's content box (line 3's top used to show through the
 * bottom padding) and overflows fade out. The full text stays on the
 * button's title tooltip. Drives a real server + browser with one long
 * and one short prompt, then asserts the clamp geometry.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

const SHOT_DIR = join(import.meta.dirname, "..", "test-results", "outline");

// Panel is 280px wide; the item's text column fits ~40 chars a line, so
// this comfortably exceeds the 2-line clamp. Tests own their literals.
const LONG_PROMPT =
	"Before we start, please review the rolling deploy policy document in full: it covers canary percentages, soak windows, rollback triggers, the regional bake order, and the escalation path for a failed health probe, and I want your read on whether section four's rollback trigger is too aggressive for the weekend traffic profile we saw last month across the fleet while the canary sat in us-east";
const SHORT_PROMPT = "Summarize that";

let server: E2EServer;

test.beforeAll(async () => {
	await mkdir(SHOT_DIR, { recursive: true });
	// One answer per send (the spec submits twice).
	server = await bootE2EServer({
		responses: [
			fauxAssistantMessage("e2e answer one"),
			fauxAssistantMessage("e2e answer two"),
		],
	});
});

test.afterAll(async () => {
	await server?.cleanup();
});

test("outline items clamp inside the content box and fade long prompts", async ({ page }) => {
	await page.goto(server.url);
	// Settle the boot default selection FIRST, then claim a fresh
	// conversation (same race notes as ui-batch-visual round 2: a fill
	// that lands before the New navigation can be wiped by the switch).
	await expect(page.locator("li.session-item-active")).toHaveCount(1);
	const beforeNew = await page
		.locator("li.session-item-active")
		.getAttribute("data-conversation-id");
	await page.getByRole("button", { name: /new/i }).first().click();
	await expect
		.poll(() =>
			page
				.locator("li.session-item-active")
				.getAttribute("data-conversation-id"),
		)
		.not.toBe(beforeNew);
	const composer = page.locator(".composer-input");
	await composer.waitFor({ state: "visible" });

	// The outline panel ships closed (null default) — open it. (The
	// nav itself renders only once prompts exist, so assert the toggle.)
	const outlineToggle = page.getByRole("button", {
		name: "outline",
		exact: true,
	});
	await outlineToggle.click();
	await expect(outlineToggle).toHaveAttribute("aria-pressed", "true");

	// A clamping (long) prompt, then a one-line (short) one.
	await composer.fill(LONG_PROMPT);
	await composer.press("Control+Enter");
	await page
		.locator(".entry-user-message")
		.first()
		.waitFor({ state: "visible", timeout: 15_000 });
	await expect(page.locator("nav.outline .outline-item")).toHaveCount(1);
	await composer.fill(SHORT_PROMPT);
	await composer.press("Control+Enter");
	await page
		.locator(".entry-user-message")
		.nth(1)
		.waitFor({ state: "visible", timeout: 15_000 });
	await expect(page.locator("nav.outline .outline-item")).toHaveCount(2);
	// The clamp measurement commits with the items — wait for the marker
	// (poll, not assume: the layout effect lands after the row renders).
	await expect
		.poll(async () =>
			page
				.locator(".outline-item")
				.first()
				.getAttribute("data-clamped"),
		)
		.toBe("true");
	await page.screenshot({
		path: join(SHOT_DIR, "outline-clamped.png"),
		fullPage: true,
	});

	const items = await page.evaluate(() => {
		return Array.from(
			document.querySelectorAll(".outline-item"),
			(button) => {
				const btn = button as HTMLButtonElement;
				const span = btn.querySelector(".outline-text") as HTMLElement | null;
				if (span === null) throw new Error("outline item has no .outline-text");
				const b = btn.getBoundingClientRect();
				const s = span.getBoundingClientRect();
				return {
					title: btn.getAttribute("title"),
					clamped: btn.getAttribute("data-clamped"),
					spanHeight: s.height,
					// The line box the clamp budget is measured in.
					lineHeight: Number.parseFloat(getComputedStyle(span).lineHeight),
					// The clamp must end INSIDE the button's content box.
					spanBottom: s.bottom,
					buttonBottom: b.bottom,
					paddingBottom: Number.parseFloat(
						getComputedStyle(btn).paddingBottom,
					),
				};
			},
		);
	});

	const long = items.find((item) => item.title === LONG_PROMPT);
	if (long === undefined) throw new Error("long prompt's outline item missing");
	const short = items.find((item) => item.title === SHORT_PROMPT);
	if (short === undefined) throw new Error("short prompt's outline item missing");

	// Both rows: ≤ 2 lines tall (clamped short OR long), and the text's
	// bottom never past the button's content-box bottom (+0.5 sub-pixel).
	for (const item of items) {
		if (item.spanHeight > 2 * item.lineHeight + 1) {
			throw new Error(
				`outline text taller than 2 lines: ${item.spanHeight} > 2×${item.lineHeight}+1`,
			);
		}
		if (item.spanBottom > item.buttonBottom - item.paddingBottom + 0.5) {
			throw new Error(
				`clamp escapes the content box: spanBottom=${item.spanBottom} buttonBottom=${item.buttonBottom} paddingBottom=${item.paddingBottom}`,
			);
		}
	}
	// The fade marker separates overflowing from fitting prompts.
	if (long.clamped !== "true") {
		throw new Error(`long prompt not marked data-clamped: ${long.clamped}`);
	}
	if (short.clamped !== null) {
		throw new Error(`short prompt marked data-clamped: ${short.clamped}`);
	}
	// The tooltip carries the FULL prompt text.
	if (long.title !== LONG_PROMPT) {
		throw new Error(`title is not the full text: ${long.title}`);
	}
});
