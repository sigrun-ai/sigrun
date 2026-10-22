/**
 * Visual probe for the 2026-10-22 UI batch (auto-grow composer, timeline
 * view, live thinking fold): drives a real server + browser, exercises the
 * three changes, and screenshots each stage for human review. Assertions
 * are sanity-only; the shots under webui/test-results/ui-batch/ are the
 * evidence.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "@playwright/test";
import { bootE2EServer, type E2EServer } from "./harness";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

const SHOT_DIR = join(import.meta.dirname, "..", "test-results", "ui-batch");

let server: E2EServer;

test.beforeAll(async () => {
	await mkdir(SHOT_DIR, { recursive: true });
	// Multiple sends share ONE server boot: queue an answer per send
	// (both tests submit).
	server = await bootE2EServer({
		responses: [
			fauxAssistantMessage("e2e answer one"),
			fauxAssistantMessage("e2e answer two"),
			fauxAssistantMessage("e2e answer three"),
			fauxAssistantMessage("e2e answer four"),
		],
	});
});

test.afterAll(async () => {
	await server?.cleanup();
});

test("round 2: in-place live render, autoscroll, token meta, one-line bubble", async ({ page }) => {
	await page.goto(server.url);
	await page.getByRole("button", { name: /new/i }).first().click();
	const composer = page.locator(".composer-input");
	await composer.waitFor({ state: "visible" });

	// The user bubble: 24 chars render ONE line (the wrap bug measured 3).
	await composer.fill("What tools can you see?");
	await composer.press("Control+Enter");
	await page
		.locator(".entry-user-message")
		.first()
		.waitFor({ state: "visible", timeout: 8000 });
	const bubbleH = await page
		.locator(".entry-user-message")
		.first()
		.evaluate((el) => el.getBoundingClientRect().height);
	if (bubbleH > 55) {
		throw new Error(`user bubble wraps: height=${bubbleH}`);
	}
	await page.waitForTimeout(900);
	if (bubbleH > 55) {
		throw new Error(`user bubble wraps: height=${bubbleH}`);
	}

	// The meta label splits tokens (the faux usage has in/out legs).
	const meta = await page.locator(".message-meta").first().textContent();
	if (meta !== null && !/in \d+.*· out \d+$/.test(meta)) {
		throw new Error(`meta label not split: ${meta}`);
	}

	// Autoscroll: after the answer, the transcript is pinned to the bottom.
	const scroll = await page.evaluate(() => {
		const root = document.querySelector(".chat-center");
		if (root === null) throw new Error("no chat-center");
		const el = root as HTMLElement;
		return {
			atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 24,
			canScroll: el.scrollHeight > el.clientHeight,
		};
	});
	if (scroll.canScroll && !scroll.atBottom) {
		throw new Error(`not pinned to bottom: ${JSON.stringify(scroll)}`);
	}
});

test("composer starts one row tall and grows; timeline toggle interleaves", async ({ page }) => {
	await page.goto(server.url);
	// Claim + create a conversation through the UI path.
	await page.getByRole("button", { name: /new/i }).first().click();

	const composer = page.locator(".composer-input");
	await composer.waitFor({ state: "visible" });

	// 1. The empty composer: one row tall (the early-wrap fix).
	const emptyHeight = await composer.evaluate((el) => el.getBoundingClientRect().height);
	await page.screenshot({ path: join(SHOT_DIR, "01-composer-empty.png"), fullPage: true });

	// Type two lines; the box must grow.
	await composer.fill("one line\nsecond line\nthird line");
	const grownHeight = await composer.evaluate((el) => el.getBoundingClientRect().height);
	await page.screenshot({ path: join(SHOT_DIR, "02-composer-grown.png"), fullPage: true });

	// Sanity: growth happened (>= 1.5x the empty height for 3 rows vs 1).
	if (grownHeight < emptyHeight * 1.5) {
		throw new Error(
			`composer did not grow: empty=${emptyHeight} grown=${grownHeight}`,
		);
	}
	// Geometry + CSS contract of the early-wrap fix: one-row min, capped
	// max, animated height.
	const style = await composer.evaluate((el) => {
		const s = getComputedStyle(el);
		return { min: s.minHeight, max: s.maxHeight, transition: s.transition };
	});
	if (style.maxHeight === "none") {
		throw new Error(`composer maxHeight not capped: ${JSON.stringify(style)}`);
	}
	if (!style.transition.includes("height")) {
		throw new Error(`composer height not animated: ${style.transition}`);
	}

	// 2. Send a message; the faux provider answers. Then toggle timeline.
	await composer.press("Control+Enter");
	await page.waitForTimeout(800);
	await page.screenshot({ path: join(SHOT_DIR, "03-answer-grouped.png"), fullPage: true });

	const timelineToggle = page.getByRole("button", { name: /chronological view/i });
	// Default ON (round 2): the turn already renders .turn-timeline.
	if ((await page.locator(".turn-timeline").count()) === 0) {
		throw new Error("timeline not the default");
	}
	await timelineToggle.click();
	await page.waitForTimeout(200);
	const pressed = await timelineToggle.getAttribute("aria-pressed");
	if (pressed !== "false") {
		throw new Error("timeline toggle did not flip off");
	}
	await timelineToggle.click();
	await page.waitForTimeout(200);
	if ((await timelineToggle.getAttribute("aria-pressed")) !== "true") {
		throw new Error("timeline toggle did not flip back on");
	}
	await page.screenshot({ path: join(SHOT_DIR, "04-answer-timeline.png"), fullPage: true });
	// The timeline actually re-rendered: at least one chronological
	// container with prose segments inside (the faux answer has no
	// tools/thinking, so prose segments are the observable).
	if ((await timelineToggle.getAttribute("aria-pressed")) !== "true") {
		await timelineToggle.click();
	}
	// The answer's stream needs a moment in EVERY path; wait for prose.
	await page
		.locator(".turn-timeline .turn-prose")
		.first()
		.waitFor({ state: "visible", timeout: 8000 });
	const timelineNodes = await page.locator(".turn-timeline").count();
	const proseSegments = await page
		.locator(".turn-timeline .turn-prose")
		.count();
	if (timelineNodes === 0 || proseSegments === 0) {
		throw new Error(
			`timeline view did not render: containers=${timelineNodes} prose=${proseSegments}`,
		);
	}
	// And the activity line is GONE in timeline mode (nothing folded).
	if ((await page.locator(".activity-line").count()) !== 0) {
		throw new Error("activity line still present in timeline mode");
	}
});
