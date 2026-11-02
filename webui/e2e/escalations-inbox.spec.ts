/**
 * E8 Step 3 (escalations plan): the real @sigrun/escalations Inbox in a
 * browser against the real server — proves A0's generic renderer serves a
 * real extension view end to end. Boots the extension from the sibling repo's
 * built dist, raises an escalation through the real escalate tool (faux model
 * tool-call), then answers it through the rendered form and watches it move
 * to the In-progress tab.
 *
 * No personal data: synthetic job + key + options (tests own their literals).
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { bootE2EServer, type E2EServer } from "./harness.js";

/** The real extension's built entry (committed dist). */
// The extension repo is a SIBLING of the main sigrun checkout (the worktree
// lives under <repo>/.worktrees/escalations — walk up past it).
const EXTENSION = pathToFileURL(
	join(
		import.meta.dirname,
		"..",
		"..",
		"..",
		"..",
		"..",
		"sigrun-escalations",
		"dist",
		"index.js",
	),
).href;

let server: E2EServer;

test.beforeAll(async () => {
	server = await bootE2EServer({
		extensionSpecifiers: [EXTENSION],
		responses: [
			fauxAssistantMessage(
				[
					{ type: "text", text: "raising" },
					fauxToolCall(
						"escalate",
						{
							key: "demo:1",
							title: "Demo",
							body: "Demo body",
							options: [{ id: "go", label: "Go" }],
						},
						{ id: "call-1" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("raised and done"),
		],
	});
});

test.afterAll(async () => {
	await server.cleanup();
});


test("the inbox: raise via tool, answer in the browser, item moves to In progress", async ({
	browser,
}) => {
	// The Inbox is owner-scoped: act as the booted directory user (the
	// loopback naive path derives the principal from the header — the
	// ext-surface.spec precedent).
	const context = await browser.newContext({
		extraHTTPHeaders: { "x-sigrun-user": "tester" },
	});
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (cause) => errors.push(String(cause)));

	// 1. Create + run the job through the API (raises the escalation).
	const create = await fetch(`${server.url}/v1/jobs`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			name: "demo-job",
			schedule: { every: "1h" },
			action: {
				kind: "prompt",
				prompt:
					'Call escalate with key "demo:1", title "Demo", body "Demo body", options [{id:"go",label:"Go"}]',
				conversation: "new",
			},
		}),
	});
	const jobId = ((await create.json()) as any).job.id;
	const run = await fetch(
		`${server.url}/v1/jobs/${encodeURIComponent(jobId)}/run`,
		{ method: "POST" },
	);
	const runBody = (await run.json()) as any;
	expect(runBody.outcome).toBe("running");
	const runConversation = runBody.conversationId as number;

	// The run settles (faux answers immediately; give the settle a beat).
	await page.waitForTimeout(1500);

	// 2. Open the Inbox from the rail (the ext view route renders through
	// the generic block renderer — A0).
	await page.goto(`${server.url}/#/ext/escalations/inbox`);
	// The card button carries eyebrow + title + status + age ("Job demo-job
	// Demo open 2 seconds ago") — match the whole-button text loosely.
	// Cards render under groupBy "source" groups (the "Job demo-job"
	// header) — expand the group first, then the card is visible.
	const group = page.getByText("Job demo-job", { exact: true }).first();
	await expect.poll(async () => group.count(), { timeout: 10_000 }).toBeGreaterThan(0);
	const box = await group.boundingBox();
	const style = await group.evaluate((el) => {
		const cs = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		return {
			display: cs.display, visibility: cs.visibility,
			opacity: cs.opacity, rect: { w: r.width, h: r.height, x: r.x, y: r.y },
			parentChain: (() => {
				const out: string[] = [];
				let n: HTMLElement | null = el.parentElement;
				for (let i = 0; n && i < 10; i++) { out.push(`${n.tagName}.${n.className}|w=${n.getBoundingClientRect().width}|h=${n.getBoundingClientRect().height}|disp=${getComputedStyle(n).display}`); n = n.parentElement; }
				return out.join(" ;; ");
			})(),
		};
	});
	console.log("DIAG group box:", JSON.stringify(box), "style:", JSON.stringify(style));
	await group.click();
	const item = page.locator(".blk-list-card").filter({ hasText: "Demo" }).first();
	await expect(item).toBeVisible({ timeout: 10_000 });

	// 3. Open the item (activation submit) and answer through the form.
	await item.click();
	const choice = page.getByRole("radio", { name: /Go/ });
	await expect(choice).toBeVisible({ timeout: 10_000 });
	await choice.check();
	const actionResults: string[] = [];
	page.on("response", async (response) => {
		if (response.url().includes("/v1/ext/")) {
			actionResults.push(`${response.request().method()} ${response.url().slice(-60)} -> ${response.status()} ${await response.text().catch(() => "")}`.slice(0, 300));
		}
	});
	await page.getByRole("button", { name: "Send answer" }).click();

	// The accepted result carries a toast + navigate (A0 seam). Poll the
	// action route outcome; then expect the toast.
	await page.waitForTimeout(1500);
	console.log("DIAG action responses:", JSON.stringify(actionResults));
	await expect(page.getByText("Answer sent").first()).toBeVisible({
		timeout: 10_000,
	});

	// 4. The answered item now lives under the In-progress tab. The detail
	// page's navigate pinned {id}; a plain hash jump returns to the list.
	await page.goto(`${server.url}/#/ext/escalations/inbox`);
	await page.getByRole("button", { name: "In progress" }).click();
	const group2 = page.getByText("Job demo-job", { exact: true }).first();
	await expect(group2).toBeVisible({ timeout: 10_000 });
	await group2.click();
	const activeCard = page.locator(".blk-list-card").filter({ hasText: "Demo" }).first();
	await expect(activeCard).toBeVisible({ timeout: 10_000 });

	// The source label names the job.
	await expect(page.getByText("Job demo-job").first()).toBeVisible();

	// No client errors through the whole flow.
	expect(errors).toEqual([]);
	await context.close();

	// Cleanup: the conversation id exists (the run) — sanity for the seed.
	expect(runConversation).toBeGreaterThan(0);
});
